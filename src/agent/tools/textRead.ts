/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { createReadStream } from "node:fs";

export const DEFAULT_READ_LINES = 200;
export const READ_PAGE_CHARS = 20_000;

export interface TextPage {
  output: string;
  startLine?: number;
  endLine?: number;
}

function integer(value: unknown, fallback: number, name: string, minimum?: number): number {
  if (value === undefined || value === null) return fallback;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || (minimum !== undefined && n < minimum)) throw new Error(`invalid ${name}: ${String(value)}`);
  return n;
}

/** Two bounded-memory passes permit exact totals and negative offsets even for large text files. */
export async function readTextPage(file: string, input: { offset?: unknown; limit?: unknown; start_column?: unknown }, signal?: AbortSignal): Promise<TextPage> {
  const offset = integer(input.offset, 1, "offset");
  const limit = integer(input.limit, DEFAULT_READ_LINES, "limit", 1);
  const column = integer(input.start_column, 1, "start_column", 1);
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) onAbort();
  signal?.addEventListener("abort", onAbort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 12_000);
  try {
    let bytes = 0;
    let newlines = 0;
    for await (const chunk of createReadStream(file, { signal: controller.signal, highWaterMark: 64 * 1024 })) {
      const buf = chunk as Buffer;
      if (bytes === 0) {
        const probe = buf.subarray(0, 8192);
        let controls = 0;
        for (const b of probe) {
          if (b === 0) throw new Error("binary content detected — cannot display as text");
          if (b < 7 || (b > 13 && b < 32 && b !== 27)) controls++;
        }
        if (controls > probe.length * 0.3) throw new Error("binary content detected — cannot display as text");
      }
      bytes += buf.length;
      for (let i = buf.indexOf(10); i !== -1; i = buf.indexOf(10, i + 1)) newlines++;
    }
    if (bytes === 0) return { output: "[Read total_lines=0 start_line=0 end_line=0 next_line=none]\nFile is empty." };
    const total = newlines + 1;
    const start = offset < 0 ? Math.max(1, total + offset + 1) : Math.max(1, offset);
    if (start > total) throw new Error(`offset ${start} past end of file (${total} lines)`);
    const requestedEnd = Math.min(total, start + limit - 1);
    const rows: string[] = [];
    let used = 0;
    let line = 1;
    let sourceColumn = 1;
    let text = "";
    let nextLine: number | undefined;
    let nextColumn: number | undefined;
    let end = start;
    let firstChunk = true;
    const capacity = () => Math.max(0, READ_PAGE_CHARS - used - String(line).length - 2);
    const finishLine = (complete: boolean, newline = false) => {
      if (line < start) return;
      if (newline && text.endsWith("\r")) text = text.slice(0, -1);
      const fromColumn = line === start ? column : 1;
      if (complete && fromColumn > sourceColumn) throw new Error(`start_column ${column} past end of line ${line}`);
      let available = capacity();
      if (text.length > available) {
        // Never split a surrogate pair between successive pages.
        const last = text.charCodeAt(available - 1);
        if (last >= 0xd800 && last <= 0xdbff) available--;
        text = text.slice(0, available);
        nextLine = line;
        nextColumn = fromColumn + text.length;
      } else if (!complete) {
        nextLine = line;
        nextColumn = fromColumn + text.length;
      }
      rows.push(`${line}|${text}`);
      used += String(line).length + 2 + text.length;
      end = line;
      text = "";
    };

    // The stream decoder preserves UTF-8 sequences split across byte chunks.
    outer: for await (const chunk of createReadStream(file, { signal: controller.signal, encoding: "utf8", highWaterMark: 64 * 1024 })) {
      let data = chunk as string;
      if (firstChunk) { firstChunk = false; if (data.charCodeAt(0) === 0xfeff) data = data.slice(1); }
      let pos = 0;
      while (pos < data.length) {
        const newline = data.indexOf("\n", pos);
        const stop = newline < 0 ? data.length : newline;
        const length = stop - pos;
        if (line >= start) {
          if (capacity() <= 0) { nextLine = line; break outer; }
          const skip = Math.max(0, (line === start ? column : 1) - sourceColumn);
          text += data.slice(pos + Math.min(skip, length), Math.min(stop, pos + skip + capacity() + 1 - text.length));
        }
        sourceColumn += length;
        const capturedAll = sourceColumn - (line === start ? column : 1) === text.length;
        const possibleCRLF = capturedAll && text.length === capacity() + 1 && text.endsWith("\r");
        if (line >= start && text.length > capacity() && !possibleCRLF) {
          finishLine(false);
          break outer;
        }
        if (newline < 0) break;
        finishLine(true, true);
        if (line === requestedEnd || nextLine !== undefined) break outer;
        line++;
        sourceColumn = 1;
        pos = newline + 1;
      }
    }
    if (nextLine === undefined && (end < requestedEnd || rows.length === 0)) {
      // EOF can be an empty trailing line, which follows the existing Read line numbering.
      finishLine(true);
    }
    if (nextLine === undefined && end < total) nextLine = end + 1;
    const continuation = nextLine === undefined ? "next_line=none" : `next_line=${nextLine}${nextColumn ? ` next_column=${nextColumn}` : ""}`;
    const header = `[Read total_lines=${total} start_line=${start} end_line=${end} start_column=${column} ${continuation}]`;
    return { output: `${header}\n${rows.join("\n")}`, startLine: start, endLine: end };
  } catch (e) {
    if (timedOut) throw new Error("timeout: text read exceeded 12s; narrow the file or use a local search command for this source");
    if (controller.signal.aborted) throw new Error("aborted: Read");
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}
