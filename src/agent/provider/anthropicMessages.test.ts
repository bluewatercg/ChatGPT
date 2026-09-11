/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { expect, it } from "vitest";
import { toAnthropic } from "./anthropicMessages";
import { buildMessages, snapshotUserContext } from "../messages";
import type { Step, WireMessage } from "../types";

function exchange(ids: string[]): Step[] {
  return [
    { kind: "assistant", text: "Inspecting", calls: ids.map(id => ({ id, name: "Read", arguments: JSON.stringify({ path: `${id}.ts` }) })) },
    ...ids.map(id => ({ kind: "tool-result" as const, name: "Read", callId: id, output: `Contents of ${id}`, status: "completed" as const })),
  ];
}
function cachedResults(payload: ReturnType<typeof toAnthropic>): string[] {
  return payload.messages.flatMap(message => Array.isArray(message.content)
    ? message.content.filter(block => block.type === "tool_result" && block.cache_control).map(block => block.tool_use_id!) : []);
}
const stripMarkers = (value: unknown) => JSON.parse(JSON.stringify(value, (key, item) => key === "cache_control" ? undefined : item));

it("advances completed tool-result cache boundaries over four turns and retains the previous batch", () => {
  const context = snapshotUserContext({ userInfo: "Project rules", openFiles: "app.ts", timestamp: "first" });
  const history: Step[] = [{ kind: "user", text: "Inspect", context }];
  let previous = toAnthropic(buildMessages("OpenCursor", history));
  for (let turn = 1; turn <= 4; turn++) {
    const ids = Array.from({ length: turn === 3 ? 25 : 1 }, (_, index) => `turn-${turn}-${index}`);
    history.push(...exchange(ids));
    const wire = buildMessages("OpenCursor", history);
    const original = JSON.stringify(wire);
    const payload = toAnthropic(wire);
    const previousId = turn === 4 ? "turn-3-24" : `turn-${turn - 1}-0`;
    expect(cachedResults(payload)).toEqual(turn === 1 ? [ids[ids.length - 1]] : [previousId, ids[ids.length - 1]]);
    expect(JSON.stringify(payload).match(/cache_control/g)?.length).toBeLessThanOrEqual(4);
    expect(payload.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(Array.isArray(payload.messages[0].content) && payload.messages[0].content[0].cache_control).toEqual({ type: "ephemeral" });
    expect(stripMarkers(payload.messages.slice(0, previous.messages.length))).toEqual(stripMarkers(previous.messages));
    expect(JSON.stringify(wire)).toBe(original);
    previous = payload;
  }
  history.push({ kind: "assistant", text: "Finished", calls: [] }, { kind: "user", text: "Follow-up", context: snapshotUserContext({ ...context, timestamp: "later" }, context) });
  const followUp = toAnthropic(buildMessages("OpenCursor", history));
  expect(cachedResults(followUp)).toEqual(["turn-4-0"]);
  const latest = followUp.messages[followUp.messages.length - 1].content;
  expect(Array.isArray(latest) && latest[latest.length - 1].cache_control).toEqual({ type: "ephemeral" });
  expect(JSON.stringify(latest)).toContain("Follow-up");
});

it("normalizes generic string user turns consistently when older cache boundaries age out", () => {
  const wire: WireMessage[] = [{ role: "system", content: "OpenCursor" }, { role: "user", content: "First" }];
  let previous = toAnthropic(wire);
  for (let i = 0; i < 4; i++) {
    wire.push({ role: "assistant", content: "Answer" }, { role: "user", content: `Next ${i}` });
    const saved = JSON.stringify(wire);
    const payload = toAnthropic(wire);
    expect(stripMarkers(payload.messages.slice(0, previous.messages.length))).toEqual(stripMarkers(previous.messages));
    expect(JSON.stringify(payload).match(/cache_control/g)?.length).toBeLessThanOrEqual(4);
    expect(JSON.stringify(wire)).toBe(saved);
    previous = payload;
  }
});

it("caches the complete tool-result block without changing nested image content or call pairing", () => {
  const wire: WireMessage[] = [
    { role: "system", content: "OpenCursor" }, { role: "user", content: "Inspect" },
    { role: "assistant", content: null, tool_calls: [{ id: "image", type: "function", function: { name: "Read", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "image", content: [{ type: "text", text: "Image data" }, { type: "image_url", image_url: { url: "data:image/png;base64,YQ==" } }] },
  ];
  const saved = JSON.stringify(wire);
  const payload = toAnthropic(wire);
  expect(cachedResults(payload)).toEqual(["image"]);
  const last = payload.messages[payload.messages.length - 1].content;
  expect(Array.isArray(last) && last[0]).toMatchObject({ type: "tool_result", tool_use_id: "image", cache_control: { type: "ephemeral" }, content: [
    { type: "text", text: "Image data" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "YQ==" } },
  ] });
  expect(JSON.stringify(wire)).toBe(saved);
});
