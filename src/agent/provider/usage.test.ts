/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { expect, it } from "vitest";
import { UsageTracker } from "./usage";
import { AnthropicUsageTracker } from "../anthropicUsage";

it("distinguishes missing cache counters from reported zero across all generic adapters", () => {
  const missing = new UsageTracker().update(100, 10)!;
  expect(missing).not.toHaveProperty("cachedReadTokens");
  expect(missing).not.toHaveProperty("cachedWriteTokens");
  expect(missing).not.toHaveProperty("cacheReadInputTokens");
  expect(new UsageTracker().update(100, 10, 0, 0)).toMatchObject({ cachedReadTokens: 0, cachedWriteTokens: 0, cacheReadInputTokens: 100 });
});

it("backfills cache coverage when zero cache details arrive after input usage", () => {
  const tracker = new UsageTracker();
  const first = tracker.update(100, 10)!;
  const final = tracker.update(100, 10, 0)!;
  expect(first).not.toHaveProperty("cacheReadInputTokens");
  expect(final).toMatchObject({ promptTokens: 0, completionTokens: 0, cachedReadTokens: 0, cacheReadInputTokens: 100 });
  expect(tracker.update(100, 10, 0)).toBeUndefined();
});

it("counts additional input and delayed cache reads without double billing", () => {
  const tracker = new UsageTracker();
  const events = [tracker.update(100, 5), tracker.update(110, 5, 60), tracker.update(110, 6), tracker.update(130, 8, 80)];
  expect(events.reduce((n, event) => n + (event?.promptTokens ?? 0), 0)).toBe(130);
  expect(events.reduce((n, event) => n + (event?.cacheReadInputTokens ?? 0), 0)).toBe(130);
  expect(events.reduce((n, event) => n + (event?.cachedReadTokens ?? 0), 0)).toBe(80);
});

it("does not turn invalid counters or cache writes alone into known cache-read coverage", () => {
  const event = new UsageTracker().update(100, 2, NaN, 20)!;
  expect(event).toMatchObject({ cachedWriteTokens: 20 });
  expect(event).not.toHaveProperty("cachedReadTokens");
  expect(event).not.toHaveProperty("cacheReadInputTokens");
  expect(new UsageTracker().update(100, 2, -1)).not.toHaveProperty("cachedReadTokens");
});

it("preserves zero, missing, and delayed cache coverage for Anthropic's disjoint buckets", () => {
  const tracker = new AnthropicUsageTracker();
  expect(tracker.update({ input_tokens: 100, output_tokens: 10 })).not.toHaveProperty("cachedReadTokens");
  expect(tracker.update({ cache_read_input_tokens: 0 })).toMatchObject({ cachedReadTokens: 0, cacheReadInputTokens: 100 });
  expect(tracker.update({ cache_read_input_tokens: 0 })).toBeUndefined();
  expect(tracker.update({ cache_creation_input_tokens: 10 })).toMatchObject({ promptTokens: 10, cacheReadInputTokens: 10, cachedWriteTokens: 10 });
});
