/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { createHash } from "node:crypto";
import type { Step, ToolCall } from "./types";

const ARCHIVE_THRESHOLD = 8000;
const PREVIEW_CHARS = 4000;
const READ_BODY_CHARS = 5400;
const READ_LINES = 120;

interface ArchiveEntry {
  text: string;
  label: string;
  lineOffsets?: number[];
}

export interface ContextReadInput {
  id: string;
  start_line?: number;
  end_line?: number;
  /** One-based character position, for continuing exceptionally long lines. */
  start_column?: number;
  /** Literal, case-sensitive text to locate at or after the requested position. */
  pattern?: string;
}

/**
 * A run-local index of full context already retained in chat history. Only the
 * model's history copy is abbreviated; no files are created or read. Stable
 * content IDs allow the index to be rebuilt from persisted, lossless history.
 */
export class ContextArchive {
  private readonly entries = new Map<string, ArchiveEntry>();

  store(text: string, label: string): string {
    // Length-framing separates label and body, including embedded nulls. UTF-16
    // keeps even isolated surrogate code units distinct, as JavaScript does.
    const hash = createHash("sha256")
      .update(`${label.length}:`)
      .update(label, "utf16le")
      .update(text, "utf16le")
      .digest("hex");
    const base = `ctx_${hash}`;
    let id = base;
    let collision = 0;
    for (;;) {
      const existing = this.entries.get(id);
      if (!existing) {
        this.entries.set(id, { text, label });
        return id;
      }
      if (existing.text === text && existing.label === label) return id;
      // Do not return someone else's text even in the event of a hash collision.
      id = `${base}_${++collision}`;
    }
  }

  /** Return an exact, bounded slice, with positions to retrieve the next page. */
  read(input: ContextReadInput): string {
    if (!input || typeof input.id !== "string" || !/^ctx_[a-f0-9]{64}(?:_[1-9]\d*)?$/.test(input.id)) {
      return "Error: provide a valid archived context id from a ReadContext reference.";
    }
    const entry = this.entries.get(input.id);
    if (!entry) return `Error: archived context ${input.id} is unavailable in this conversation.`;
    for (const key of ["start_line", "end_line", "start_column"] as const) {
      const value = input[key];
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
        return `Error: ${key} must be a positive integer.`;
      }
    }
    if (input.pattern !== undefined && (typeof input.pattern !== "string" || !input.pattern.length)) {
      return "Error: pattern must be a nonempty literal string.";
    }

    const offsets = this.lineOffsets(entry);
    const startLine = input.start_line ?? 1;
    const lastLine = input.end_line ?? offsets.length;
    if (startLine > offsets.length) return `Error: start_line exceeds total_lines: ${offsets.length}.`;
    if (lastLine < startLine) return "Error: end_line must be at least start_line.";
    const column = input.start_column ?? 1;
    const lineEnd = offsets[startLine] ?? entry.text.length;
    if (column > lineEnd - offsets[startLine - 1] + 1) {
      return `Error: start_column exceeds the length of line ${startLine}.`;
    }
    let start = offsets[startLine - 1] + column - 1;
    const requestedEnd = offsets[Math.min(lastLine, offsets.length)] ?? entry.text.length;
    let match: { line: number; column: number } | undefined;
    if (input.pattern !== undefined) {
      const found = entry.text.indexOf(input.pattern, start);
      if (found < 0 || found + input.pattern.length > requestedEnd) {
        return `id: ${input.id}\ntotal_lines: ${offsets.length}\nNo literal match in the requested range.`;
      }
      match = this.position(offsets, found);
      // Include the start of a normal line, or a little leading context if the
      // match is deep inside a minified file or a large JSON argument.
      start = Math.max(start, offsets[match.line - 1], found - 160);
    }
    const from = this.position(offsets, start);
    const lineLimit = offsets[from.line - 1 + READ_LINES] ?? entry.text.length;
    let end = Math.min(requestedEnd, start + READ_BODY_CHARS, lineLimit);
    // Keep a Unicode surrogate pair on one page so concatenating excerpts is lossless.
    if (end > start && end < entry.text.length && /[\uD800-\uDBFF]/.test(entry.text[end - 1])) end--;
    const to = this.position(offsets, Math.max(start, end - 1));
    const next = end < entry.text.length ? this.position(offsets, end) : undefined;
    const escapedLabel = JSON.stringify(entry.label.slice(0, 120));
    const label = escapedLabel.length > 160 ? `${escapedLabel.slice(0, 156)}…\"` : escapedLabel;
    const header = [
      `id: ${input.id}`,
      `label: ${label}`,
      `total_lines: ${offsets.length}; total_characters: ${entry.text.length}`,
      `start_line: ${from.line}; start_column: ${from.column}; end_line: ${to.line}`,
      ...(match ? [`match_line: ${match.line}; match_column: ${match.column}`] : []),
      next ? `next_line: ${next.line}; next_column: ${next.column}` : "End of archived context.",
    ];
    return `${header.join("\n")}\n\n${entry.text.slice(start, end)}`;
  }

  /**
   * Abbreviate completed history deterministically without touching originals.
   * A pending or failed call retains its arguments for execution and diagnosis.
   * Small outputs and deliberate ReadContext excerpts retain their full text.
   */
  prepareSteps(steps: Step[]): Step[] {
    const completed = new Map<string, Set<string>>();
    for (const step of steps) {
      if (step.kind !== "tool-result" || step.status !== "completed") continue;
      const names = completed.get(step.callId) ?? new Set<string>();
      names.add(step.name);
      completed.set(step.callId, names);
    }
    return steps.map((step): Step => {
      if (step.kind === "tool-result" && step.name !== "ReadContext" && step.output.length > ARCHIVE_THRESHOLD) {
        const id = this.store(step.output, `${step.name} result (${step.callId})`);
        const marker = `\n\n[Large output abbreviated; full ${step.output.length} characters archived. Use ReadContext {"id":"${id}"} with line ranges or pattern to retrieve omitted content.]\n\n`;
        const available = PREVIEW_CHARS - marker.length;
        const head = Math.ceil(available * 0.6);
        const tail = available - head;
        return { ...step, output: `${step.output.slice(0, head)}${marker}${step.output.slice(-tail)}` };
      }
      if (step.kind !== "assistant") return step;
      return {
        ...step,
        thinking: undefined,
        calls: step.calls.map((call) => completed.get(call.id)?.has(call.name) ? this.prepareCall(call) : call),
      };
    });
  }

  private prepareCall(call: ToolCall): ToolCall {
    if (call.name === "ReadContext" || call.arguments.length <= ARCHIVE_THRESHOLD) return call;
    let parsed: unknown;
    try { parsed = JSON.parse(call.arguments); } catch { return call; }
    const id = this.store(call.arguments, `${call.name} arguments (${call.id})`);
    const description = {
      id,
      original_characters: call.arguments.length,
      note: "Historical arguments abbreviated after successful execution. Use ReadContext to retrieve the exact original JSON.",
    };
    // Keep useful paths, flags, queries and field names. Payload markers are
    // explicitly historical: they must never be mistaken for executable edits.
    const result: Record<string, unknown> = Object.create(null);
    const fields = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? Object.entries(parsed) : [];
    let used = 0;
    for (const [key, value] of fields.slice(0, 24)) {
      if (key.length > 120) continue;
      const json = JSON.stringify(value);
      const size = json?.length ?? 0;
      if (size <= 512 && used + key.length + size < 2300) {
        result[key] = value;
        used += key.length + size;
      } else if (used + key.length < 2000) {
        result[key] = `[Archived ${size} JSON characters; ReadContext {"id":"${id}"}]`;
        used += key.length + 160;
      }
    }
    // Select an unused metadata key so an original argument is never overwritten.
    let metadataKey = "_context_archive";
    while (Object.hasOwn(result, metadataKey)) metadataKey = `_${metadataKey}`;
    result[metadataKey] = description;
    let summary = JSON.stringify(result);
    if (summary.length > PREVIEW_CHARS) {
      summary = JSON.stringify({ _context_archive: description, fields: fields.slice(0, 16).map(([key]) => key.slice(0, 80)) });
    }
    return { ...call, arguments: summary };
  }

  private lineOffsets(entry: ArchiveEntry): number[] {
    if (!entry.lineOffsets) {
      const offsets = [0];
      for (let i = 0; i < entry.text.length; i++) if (entry.text[i] === "\n") offsets.push(i + 1);
      entry.lineOffsets = offsets;
    }
    return entry.lineOffsets;
  }

  private position(offsets: number[], offset: number): { line: number; column: number } {
    let low = 0;
    let high = offsets.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (offsets[mid] > offset) high = mid - 1;
      else low = mid;
    }
    return { line: low + 1, column: offset - offsets[low] + 1 };
  }
}
