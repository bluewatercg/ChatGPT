/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { describe, expect, it } from "vitest";
import { computeHunks, makeDiff } from "./lineDiff";

function restore(before: string, after: string) {
  const lines = after.length ? after.split("\n") : [];
  for (const h of [...computeHunks(before, after)].reverse()) lines.splice(h.startLine, h.afterLines.length, ...h.beforeLines);
  return lines.join("\n");
}
describe("bounded production diff", () => {
  it("round-trips insertions, deletions, replacements, repeated lines and empty files", () => {
    const samples = ["", "a", "a\n", "a\nb\nc", "x\nx\nx", "one\ntwo\nthree\nfour"];
    for (const before of samples) for (const after of samples) expect(restore(before, after)).toBe(before);
  });
  it("preserves individual separated hunks", () => {
    expect(computeHunks("a\nb\nc\nd\ne", "A\nb\nc\nd\nE").map((h) => h.startLine)).toEqual([0, 4]);
  });
  it("handles a 50,000-line file with a one-line change without a quadratic allocation", () => {
    const before = Array.from({ length: 50_000 }, (_, i) => `line ${i}`).join("\n");
    const after = before.replace("line 25000\n", "changed\n");
    const hunks = computeHunks(before, after);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].beforeLines).toEqual(["line 25000"]);
    expect(restore(before, after)).toBe(before);
  });
  it("bounded fallback still provides an exact reversible diff for adversarial data", () => {
    const before = "old\n".repeat(2_000), after = "new\n".repeat(2_000);
    expect(restore(before, after)).toBe(before);
    expect(makeDiff("large.txt", before, after).length).toBeLessThan(25_000);
  });
  it("anchors many distributed changes without merging unrelated lines", () => {
    const before = Array.from({ length: 3000 }, (_, i) => `line ${i}`).join("\n");
    const after = before.replace("line 0\n", "first\n").replace("line 1500\n", "middle\n").replace("line 2999", "last");
    expect(computeHunks(before, after)).toHaveLength(3);
    expect(restore(before, after)).toBe(before);
  });
});
