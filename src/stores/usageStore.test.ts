/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { beforeEach, expect, it, vi } from "vitest";
vi.mock("vscode", () => ({}));
import { getUsage, initUsage, recordUsage, resetUsage, flushUsage, onUsageChanged } from "./usageStore";
import { UsageTracker } from "../agent/provider/usage";
beforeEach(async () => {
  const state = new Map();
  initUsage({ globalState: { get: (key: string) => structuredClone(state.get(key)), update: async (key: string, value: unknown) => {
    await new Promise(resolve => setTimeout(resolve, 1)); state.set(key, structuredClone(value));
  } } } as any);
  await resetUsage();
});
it("preserves concurrent parent/child/summary traffic and counts each streaming request once", async () => {
  await Promise.all([
    recordUsage("parent", 20, 1, { requestId: "p", cachedReadTokens: 10 }),
    recordUsage("parent", 0, 9, { requestId: "p" }),
    recordUsage("child", 5, 2, { requestId: "c", cachedWriteTokens: 3 }),
    recordUsage("parent", 7, 3, { requestId: "summary" }),
  ]);
  expect(getUsage().parent).toMatchObject({ promptTokens: 27, completionTokens: 13, requests: 2, cachedReadTokens: 10 });
  expect(getUsage().child).toMatchObject({ promptTokens: 5, completionTokens: 2, requests: 1, cachedWriteTokens: 3 });
});

it("keeps unreported cache usage absent instead of inventing zeros", async () => {
  await recordUsage("unknown", 100, 5, { requestId: "unknown" });
  const saved = JSON.parse(JSON.stringify(getUsage().unknown));
  expect(saved).not.toHaveProperty("cachedReadTokens");
  expect(saved).not.toHaveProperty("cachedWriteTokens");
  expect(saved).not.toHaveProperty("cacheReadInputTokens");
  expect(saved).not.toHaveProperty("cacheWriteReported");
  await recordUsage("zero", 10, 0, { requestId: "zero", cachedWriteTokens: 0 });
  expect(getUsage().zero).toMatchObject({ cachedWriteTokens: 0, cacheWriteReported: true });
});

it("separates unknown inputs, late zero-cache details, and independently billed retry attempts", async () => {
  const tracker = new UsageTracker();
  for (const event of [tracker.update(100, 5)!, tracker.update(100, 6, 0)!]) {
    await recordUsage("model", event.promptTokens, event.completionTokens, { ...event, requestId: "first-attempt" });
  }
  await recordUsage("model", 50, 1, { requestId: "retry-attempt" });
  await recordUsage("model", 40, 1, { requestId: "other-attempt", cachedReadTokens: 30, cacheReadInputTokens: 40 });
  expect(getUsage().model).toMatchObject({ promptTokens: 190, completionTokens: 8, requests: 3, cachedReadTokens: 30, cacheReadInputTokens: 140 });
  expect(getUsage().model.cachedWriteTokens).toBeUndefined();
  expect(getUsage().model.promptTokens - getUsage().model.cacheReadInputTokens!).toBe(50);
});


it("refresh waits for queued records and reset preserves only subsequent activity", async () => {
  const previous = recordUsage("before-reset", 100, 5, { requestId: "first" });
  await flushUsage();
  expect(getUsage()["before-reset"].promptTokens).toBe(100);
  await previous;
  const clearing = resetUsage();
  const next = recordUsage("after-reset", 10, 2, { requestId: "next" });
  await Promise.all([clearing, next]);
  expect(getUsage()).toEqual({ "after-reset": expect.objectContaining({ promptTokens: 10, completionTokens: 2, requests: 1 }) });
});

it("broadcasts committed records and resets, and stops after unsubscribe", async () => {
  const listener = vi.fn();
  const unsubscribe = onUsageChanged(listener);
  try {
    const writing = recordUsage("model", 25, 2);
    expect(listener).not.toHaveBeenCalled();
    await writing;
    expect(listener).toHaveBeenLastCalledWith({ model: expect.objectContaining({ promptTokens: 25 }) });
    await resetUsage();
    expect(listener).toHaveBeenLastCalledWith({});
    unsubscribe();
    await recordUsage("model", 5, 1);
    expect(listener).toHaveBeenCalledTimes(2);
  } finally { unsubscribe(); }
});

it("does not mutate persisted usage or broadcast success when saving fails", async () => {
  const saved = { model: { promptTokens: 100, completionTokens: 5, requests: 1, lastUsed: 1 } };
  initUsage({ globalState: { get: () => saved, update: async () => { throw new Error("Disk unavailable"); } } } as any);
  const listener = vi.fn();
  const unsubscribe = onUsageChanged(listener);
  try {
    await expect(recordUsage("model", 5, 2)).rejects.toThrow("Disk unavailable");
    expect(saved.model.promptTokens).toBe(100);
    await expect(resetUsage()).rejects.toThrow("Disk unavailable");
    expect(getUsage()).toBe(saved);
    expect(listener).not.toHaveBeenCalled();
  } finally { unsubscribe(); }
});
