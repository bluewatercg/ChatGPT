/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { describe, expect, it } from "vitest";
import { AnthropicUsageTracker } from "./anthropicUsage";

describe("Anthropic streamed usage", () => {
  it("includes all three disjoint input buckets in prompt occupancy", () => {
    const tracker = new AnthropicUsageTracker();
    expect(tracker.update({ input_tokens: 12, cache_creation_input_tokens: 5000, cache_read_input_tokens: 20000, output_tokens: 1 }))
      .toEqual({ type: "usage", promptTokens: 25012, completionTokens: 1, promptTokensTotal: 25012, completionTokensTotal: 1, cacheReadInputTokens: 25012, cachedReadTokens: 20000, cachedWriteTokens: 5000 });
  });

  it("merges partial cumulative deltas and accounts every token once", () => {
    const tracker = new AnthropicUsageTracker();
    const events = [
      tracker.update({ input_tokens: 10, cache_creation_input_tokens: 500, cache_read_input_tokens: 4000, output_tokens: 1 }),
      tracker.update({ output_tokens: 30 }),
      tracker.update({ output_tokens: 30 }),
      tracker.update({ input_tokens: 10, cache_creation_input_tokens: 500, cache_read_input_tokens: 4000, output_tokens: 42 }),
    ];
    expect(events[1]).toEqual({ type: "usage", completionTokens: 29, promptTokensTotal: 4510, completionTokensTotal: 30 });
    expect(events[2]).toBeUndefined();
    expect(events.reduce((sum, event) => sum + (event?.promptTokens ?? 0), 0)).toBe(4510);
    expect(events.reduce((sum, event) => sum + (event?.completionTokens ?? 0), 0)).toBe(42);
    expect(events[3]?.completionTokensTotal).toBe(42);
  });

  it("accounts later input growth without confusing its delta with context occupancy", () => {
    const tracker = new AnthropicUsageTracker();
    tracker.update({ input_tokens: 10, cache_read_input_tokens: 1000 });
    expect(tracker.update({ input_tokens: 35, output_tokens: 15 }))
      .toEqual({ type: "usage", promptTokens: 25, completionTokens: 15, cacheReadInputTokens: 25, promptTokensTotal: 1035, completionTokensTotal: 15 });
  });

  it("reports zero initial usage while ignoring invalid counters and empty updates", () => {
    const tracker = new AnthropicUsageTracker();
    expect(tracker.update({ input_tokens: 0, output_tokens: 0 }))
      .toEqual({ type: "usage", promptTokens: 0, completionTokens: 0, promptTokensTotal: 0, completionTokensTotal: 0 });
    expect(tracker.update({ input_tokens: NaN, cache_read_input_tokens: "500", output_tokens: -1 })).toBeUndefined();
    expect(tracker.update(null)).toBeUndefined();
    expect(tracker.update({})).toBeUndefined();
  });

  it("does not subtract previously counted tokens when a provider repeats stale counters", () => {
    const tracker = new AnthropicUsageTracker();
    tracker.update({ input_tokens: 100, output_tokens: 40 });
    expect(tracker.update({ input_tokens: 50, output_tokens: 20 })).toBeUndefined();
    expect(tracker.update({ input_tokens: 105, output_tokens: 45 }))
      .toEqual({ type: "usage", promptTokens: 5, completionTokens: 5, promptTokensTotal: 105, completionTokensTotal: 45 });
  });

  it("does not bill cache buckets again after a stale cumulative frame", () => {
    const tracker = new AnthropicUsageTracker();
    tracker.update({ input_tokens: 100, cache_read_input_tokens: 500 });
    expect(tracker.update({ cache_read_input_tokens: 250 })).toBeUndefined();
    expect(tracker.update({ cache_read_input_tokens: 550 })).toMatchObject({ promptTokens: 50, cachedReadTokens: 50 });
  });

  it("starts independent accounting for every request and leaves raw usage untouched", () => {
    const raw = { input_tokens: 50, cache_read_input_tokens: 500, output_tokens: 15 };
    const original = { ...raw };
    const first = new AnthropicUsageTracker().update(raw);
    expect(new AnthropicUsageTracker().update(raw)).toEqual(first);
    expect(raw).toEqual(original);
  });
});
