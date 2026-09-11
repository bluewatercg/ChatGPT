/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderEvent } from "./types";

// Exercise actual HTTP request construction and SSE parsing without loading
// the OAuth account store or a VS Code extension host.
vi.mock("./oauth", () => ({ streamOAuthChat: vi.fn() }));
vi.mock("../stores/featureStore", () => ({ MODEL_CATALOG: [] }));

import { streamChat } from "./provider";

afterEach(() => vi.unstubAllGlobals());

async function readStream(frames: unknown[]) {
  const payload = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("");
  const fetch = vi.fn(async () => new Response(payload, { status: 200 }));
  vi.stubGlobal("fetch", fetch);
  const events: ProviderEvent[] = [];
  for await (const event of streamChat({
    apiBaseUrl: "https://api.anthropic.com/v1", apiKey: "test-key", model: "claude-opus-5",
    messages: [{ role: "user", content: "Hello" }], modelParams: { reasoningEffort: "xhigh" },
    signal: new AbortController().signal,
  })) events.push(event);
  return { events, fetch };
}

describe("Anthropic HTTP streamed usage", () => {
  it("accounts cached input and cumulative output exactly once through the real SSE parser", async () => {
    const { events } = await readStream([
      { type: "message_start", message: { usage: { input_tokens: 12, cache_creation_input_tokens: 5000, cache_read_input_tokens: 20000, output_tokens: 1 } } },
      { type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } },
      { type: "message_delta", usage: { output_tokens: 30 } },
      { type: "message_delta", usage: { output_tokens: 30 } },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 45 } },
      { type: "message_stop" },
    ]);
    const usage = events.filter((event) => event.type === "usage");
    expect(usage).toHaveLength(3);
    expect(usage.reduce((sum, event) => sum + (event.promptTokens ?? 0), 0)).toBe(25012);
    expect(usage.reduce((sum, event) => sum + (event.completionTokens ?? 0), 0)).toBe(45);
    expect(usage.at(-1)).toMatchObject({ promptTokensTotal: 25012, completionTokensTotal: 45 });
    expect(events).toContainEqual({ type: "text-delta", text: "Hello" });
    expect(events.at(-1)).toEqual({ type: "done", finishReason: "end_turn" });
  });

  it("merges later input usage while retaining cache buckets omitted from a partial frame", async () => {
    const { events, fetch } = await readStream([
      { type: "message_start", message: { usage: { input_tokens: 10, cache_read_input_tokens: 1000, output_tokens: 1 } } },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 35, output_tokens: 20 } },
    ]);
    const usage = events.filter((event) => event.type === "usage");
    expect(usage.at(-1)).toMatchObject({ type: "usage", promptTokens: 25, completionTokens: 19, promptTokensTotal: 1035, completionTokensTotal: 20, model: "claude-opus-5", requestId: expect.any(String) });
    // Reservation defaults and actual request construction share the same helper.
    const init = (fetch.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.parse(String(init.body)).max_tokens).toBe(65536);
  });
});
