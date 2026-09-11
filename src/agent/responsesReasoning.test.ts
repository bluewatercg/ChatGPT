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
import { economizeHistory } from "./contextEconomy";
import { restoreContext, saveContext, type ContextState } from "./contextState";
import { buildMessages, fitStepsToBudget, splitForCompaction, stepsToTranscript } from "./messages";
import type { ResponsesReasoning, Step } from "./types";

function reasoning(id: string): ResponsesReasoning {
  return {
    model: "gpt-5.4", provider: "codex",
    items: [{ type: "reasoning", id, summary: [], encrypted_content: `opaque-${id}` }],
  };
}

function exchange(id: string, output = "file contents"): Step[] {
  return [
    { kind: "assistant", text: "", thinking: "display-only thinking", calls: [{ id, name: "Read", arguments: '{"path":"file.ts"}' }], responsesReasoning: reasoning(id) },
    { kind: "tool-result", callId: id, name: "Read", status: "completed", output },
  ];
}

describe("Responses reasoning context storage", () => {
  it("keeps opaque tool-turn state through archival, emergency fitting, and UI-thinking removal", () => {
    const original: Step[] = [{ kind: "user", text: "Inspect this file" }, ...exchange("current", "source contents\n".repeat(12_000))];
    const snapshot = structuredClone(original);
    const prepared = new ContextArchive().prepareSteps(original);
    economizeHistory(prepared);
    const fitted = fitStepsToBudget(prepared, 0, 400);
    const assistant = fitted.find((step) => step.kind === "assistant");
    expect(assistant).toMatchObject({ kind: "assistant", responsesReasoning: reasoning("current") });
    expect(assistant?.thinking).toBeUndefined();
    const wire = buildMessages("system", fitted);
    expect(wire).toContainEqual(expect.objectContaining({ role: "assistant", content: null, responsesReasoning: reasoning("current") }));
    expect(wire).toContainEqual(expect.objectContaining({ role: "tool", tool_call_id: "current" }));
    expect(JSON.stringify(wire)).not.toContain("display-only thinking");
    expect(original).toEqual(snapshot);
  });

  it("retains current reasoning in a persisted checkpoint without retaining compacted reasoning", () => {
    const original: Step[] = [{ kind: "user", text: "Inspect the project" }, ...exchange("old", "old details ".repeat(100)), ...exchange("current")];
    const { prefix, tail } = splitForCompaction(original, 80);
    expect(prefix).toContainEqual(expect.objectContaining({ responsesReasoning: reasoning("old") }));
    expect(tail).not.toContainEqual(expect.objectContaining({ responsesReasoning: reasoning("old") }));
    expect(tail).toContainEqual(expect.objectContaining({ responsesReasoning: reasoning("current") }));
    const state: ContextState = {};
    saveContext(original, [{ kind: "user", synthetic: true, text: "The previous file was inspected." }, ...tail], state);
    const restored = restoreContext(JSON.parse(JSON.stringify(original)), JSON.parse(JSON.stringify(state)));
    const wire = buildMessages("system", restored);
    expect(JSON.stringify(wire)).toContain("opaque-current");
    expect(JSON.stringify(wire)).not.toContain("opaque-old");
    expect(original).toContainEqual(expect.objectContaining({ responsesReasoning: reasoning("old") }));
  });

  it("keeps encrypted contents and reasoning summaries out of summarizer transcripts", () => {
    const steps = exchange("private");
    if (steps[0].kind !== "assistant") throw new Error("Fixture must start with an assistant");
    steps[0].responsesReasoning!.items[0].summary = [{ type: "summary_text", text: "private provider summary" }];
    const transcript = stepsToTranscript(steps);
    expect(transcript).toContain("file contents");
    expect(transcript).toContain("Read");
    expect(transcript).not.toContain("opaque-private");
    expect(transcript).not.toContain("private provider summary");
    expect(transcript).not.toContain("display-only thinking");
  });
});
