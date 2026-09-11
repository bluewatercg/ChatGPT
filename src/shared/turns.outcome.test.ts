/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { expect, it } from "vitest";
import { applyEvent, applyToBlocks, type AgentEvent, type ToolBlock, type Turn } from "./turns";

const started: AgentEvent = { type: "tool-call-started", callId: "shell", name: "Shell", input: { command: "example" } };
const completed: Extract<AgentEvent, { type: "tool-call-completed" }> = {
  type: "tool-call-completed", callId: "shell", name: "Shell", status: "error", result: "Process exited 1",
  outcome: { status: "failed", exitCode: 1, jobId: "job", outputRef: { id: "shell_ref", available: true, truncated: false, bytes: 120, expiresAt: 1234 } },
};

it("preserves structured shell outcomes across production event reduction, save/reload, and late progress", () => {
  let turns = applyEvent([], started);
  turns = applyEvent(turns, completed);
  const saved: Turn[] = JSON.parse(JSON.stringify(turns));
  turns = applyEvent(saved, { type: "tool-call-progress", callId: "shell", text: "Late output" });
  turns = applyEvent(turns, { ...completed, outcome: undefined });
  const last = turns[turns.length - 1];
  expect(last.role).toBe("assistant");
  if (last.role === "assistant") expect(last.blocks[0]).toMatchObject({ result: "Process exited 1", outcome: completed.outcome });
});

it("retains structured outcomes in nested child tool blocks", () => {
  const startedBlocks = applyToBlocks([], started);
  const completedBlocks = applyToBlocks(startedBlocks, completed);
  const repeated = applyToBlocks(completedBlocks, { ...completed, outcome: undefined });
  expect((repeated[0] as ToolBlock).outcome).toEqual(completed.outcome);
  expect((startedBlocks[0] as ToolBlock).outcome).toBeUndefined();
});
