/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { describe, expect, it } from "vitest";
import { ContextArchive } from "./contextArchive";
import { stepsTokens } from "./contextEconomy";
import type { Step } from "./types";

function body(page: string): string { return page.slice(page.indexOf("\n\n") + 2); }

function readAll(archive: ContextArchive, id: string): string {
  let start_line = 1;
  let start_column = 1;
  let content = "";
  for (let i = 0; i < 1000; i++) {
    const page = archive.read({ id, start_line, start_column });
    expect(page.length).toBeLessThanOrEqual(6000);
    content += body(page);
    const next = page.match(/^next_line: (\d+); next_column: (\d+)$/m);
    if (!next) return content;
    start_line = Number(next[1]);
    start_column = Number(next[2]);
  }
  throw new Error("Archive pagination did not finish");
}

function largeSteps(output = "header\n" + "large log entry\n".repeat(15000) + "final error detail"): Step[] {
  return [
    { kind: "user", text: "Fix the build." },
    { kind: "assistant", text: "", thinking: "private reasoning", calls: [{ name: "Shell", id: "log", arguments: '{"command":"pnpm build"}' }] },
    { kind: "tool-result", name: "Shell", callId: "log", status: "completed", output },
    { kind: "assistant", text: "", calls: [{ name: "Write", id: "write", arguments: JSON.stringify({ path: "src/fix.ts", content: "export const value = 1;\n".repeat(1000) }) }] },
    { kind: "tool-result", name: "Write", callId: "write", status: "completed", output: "Wrote src/fix.ts" },
  ];
}

describe("ContextArchive", () => {
  it("round-trips full content across bounded pages, including long lines and Unicode", () => {
    const archive = new ContextArchive();
    const text = "first\r\n" + "a".repeat(5392) + "🌟".repeat(6000) + "\n" + "next\n".repeat(350);
    expect(readAll(archive, archive.store(text, "long output"))).toBe(text);
  });

  it("uses stable opaque ids across rebuilt archives without prefix or label collisions", () => {
    const archive = new ContextArchive();
    const prefix = "x".repeat(20000);
    const id = archive.store(prefix + "a", "label");
    expect(id).toMatch(/^ctx_[a-f0-9]{64}$/);
    expect(archive.store(prefix + "a", "label")).toBe(id);
    expect(new ContextArchive().store(prefix + "a", "label")).toBe(id);
    expect(archive.store(prefix + "b", "label")).not.toBe(id);
    expect(archive.store(prefix + "a", "other label")).not.toBe(id);
    expect(archive.store("b\0c", "a")).not.toBe(archive.store("c", "a\0b"));
    expect(archive.store("\uD800", "label")).not.toBe(archive.store("\uD801", "label"));
  });

  it("preserves the original history and small results while reducing large input tokens", () => {
    const archive = new ContextArchive();
    const history = largeSteps();
    const original = JSON.stringify(history);
    const prepared = archive.prepareSteps(history);
    expect(JSON.stringify(history)).toBe(original);
    expect(prepared).not.toBe(history);
    expect(prepared[4]).toEqual(history[4]);
    expect(stepsTokens(prepared)).toBeLessThan(stepsTokens(history) * 0.04);
    expect(archive.prepareSteps(history)).toEqual(prepared);
    expect(new ContextArchive().prepareSteps(history)).toEqual(prepared);
    expect(prepared.map((step) => step.kind)).toEqual(history.map((step) => step.kind));
    const call = prepared[3];
    if (call.kind !== "assistant") throw new Error("Missing prepared call");
    expect(call.calls[0]).toMatchObject({ id: "write", name: "Write" });
    const args = JSON.parse(call.calls[0].arguments);
    expect(args.path).toBe("src/fix.ts");
    expect(args.content).toContain("Archived");
    expect(readAll(archive, args._context_archive.id)).toBe(history[3].kind === "assistant" ? history[3].calls[0].arguments : "");
    const result = prepared[2];
    if (result.kind !== "tool-result") throw new Error("Missing prepared result");
    expect(result).toMatchObject({ callId: "log", name: "Shell", status: "completed" });
    expect(result.output.length).toBeLessThanOrEqual(4000);
    expect(result.output.startsWith("header\n")).toBe(true);
    expect(result.output.endsWith("final error detail")).toBe(true);
    const id = result.output.match(/ReadContext \{"id":"([^"]+)"\}/)?.[1];
    expect(id).toBeDefined();
    expect(readAll(archive, id!)).toBe(history[2].kind === "tool-result" ? history[2].output : "");
  });

  it("retains pending, failed, malformed and mismatched tool arguments", () => {
    const args = JSON.stringify({ content: "x".repeat(9000) });
    const pending: Step = { kind: "assistant", text: "", calls: [{ id: "pending", name: "Write", arguments: args }] };
    const failed: Step[] = [pending, { kind: "tool-result", callId: "pending", name: "Write", status: "error", output: "bad input" }];
    const mismatch: Step[] = [pending, { kind: "tool-result", callId: "pending", name: "Shell", status: "completed", output: "ok" }];
    const malformed: Step[] = [{ ...pending, calls: [{ id: "invalid", name: "Write", arguments: "{" + "x".repeat(9000) }] }, { kind: "tool-result", callId: "invalid", name: "Write", status: "completed", output: "ok" }];
    const archive = new ContextArchive();
    for (const history of [[pending], failed, mismatch, malformed]) {
      const prepared = archive.prepareSteps(history);
      const call = prepared[0];
      expect(call.kind === "assistant" ? call.calls : []).toEqual(history[0].kind === "assistant" ? history[0].calls : []);
    }
  });

  it("bounds huge JSON objects and retains valid JSON without overwriting metadata-shaped arguments", () => {
    const history = largeSteps();
    if (history[3].kind !== "assistant") throw new Error("Missing call");
    history[3].calls[0].arguments = JSON.stringify({ _context_archive: "original", path: "important.ts", ...Object.fromEntries(Array.from({ length: 200 }, (_, i) => ["key_" + i, "x".repeat(1000)])) });
    const prepared = new ContextArchive().prepareSteps(history);
    if (prepared[3].kind !== "assistant") throw new Error("Missing call");
    const args = prepared[3].calls[0].arguments;
    expect(args.length).toBeLessThanOrEqual(4000);
    expect(JSON.parse(args)).toMatchObject({ _context_archive: "original", path: "important.ts", __context_archive: { original_characters: history[3].calls[0].arguments.length } });
  });

  it("does not abbreviate deliberate ReadContext results again", () => {
    const result: Step = { kind: "tool-result", callId: "context", name: "ReadContext", status: "completed", output: "selected content".repeat(1000) };
    expect(new ContextArchive().prepareSteps([result])).toEqual([result]);
  });

  it("bounds line ranges to 120 lines and supplies continuation positions", () => {
    const archive = new ContextArchive();
    const id = archive.store(Array.from({ length: 400 }, (_, i) => `line ${i + 1}`).join("\n"), "lines");
    const first = archive.read({ id });
    expect(first).toContain("total_lines: 400");
    expect(first).toContain("next_line: 121; next_column: 1");
    expect(body(first).trimEnd().split("\n")).toHaveLength(120);
    expect(body(archive.read({ id, start_line: 150, end_line: 152 }))).toBe("line 150\nline 151\nline 152\n");
  });

  it("finds literal matches in omitted content, including deep inside long lines", () => {
    const archive = new ContextArchive();
    const id = archive.store("prefix\n" + "x".repeat(18000) + "find [this].* text\nlast line", "searchable");
    const result = archive.read({ id, pattern: "[this].*" });
    expect(result).toContain("match_line: 2; match_column: 18006");
    expect(body(result)).toContain("find [this].* text");
    expect(result.length).toBeLessThanOrEqual(6000);
    expect(archive.read({ id, pattern: "[this].*", end_line: 1 })).toContain("No literal match");
    expect(archive.read({ id, pattern: "[THIS].*" })).toContain("No literal match");
  });

  it("rejects missing ids, paths and malformed ranges without filesystem access", () => {
    const archive = new ContextArchive();
    const id = archive.store("one\ntwo", "label");
    for (const input of [{ id: "../../secret" }, { id: "ctx_" + "f".repeat(64) }, { id, start_line: 0 }, { id, start_line: 3 }, { id, start_column: 100 }, { id, end_line: -1 }, { id, start_line: 2, end_line: 1 }, { id, start_line: NaN }, { id, start_column: 1.5 }, { id, pattern: "" }]) {
      expect(archive.read(input)).toMatch(/^Error:/);
    }
  });

  it("reads empty content without getting stuck in pagination", () => {
    const archive = new ContextArchive();
    const id = archive.store("", "empty");
    expect(archive.read({ id })).toContain("total_lines: 1");
    expect(readAll(archive, id)).toBe("");
  });

  it("keeps reads bounded even when labels require long JSON escapes", () => {
    const archive = new ContextArchive();
    const id = archive.store("x".repeat(10000), "\u0000".repeat(1000));
    expect(archive.read({ id }).length).toBeLessThanOrEqual(6000);
  });
});
