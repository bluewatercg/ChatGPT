/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("vscode", () => ({ EventEmitter: class { event = () => ({ dispose() {} }); fire() {} } }));
vi.mock("../oauth", () => ({ streamOAuthChat: vi.fn() }));
import { generateTitle, pickModel, streamChat } from "../provider";
import { streamOAuthChat } from "../oauth";

const sse = (...frames: unknown[]) => new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("flagship auxiliary requests", () => {
  it("uses non-reasoning GPT-5.6 titles with the supported completion limit", async () => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ choices: [{ message: { content: '{"title":"Fix context accounting"}' } }] })));
    vi.stubGlobal("fetch", fetch);
    expect(await generateTitle("https://api.openai.com/v1", "fixture", "gpt-5.6-sol", "Fix token counts")).toBe("Fix context accounting");
    const body = JSON.parse(String(fetch.mock.calls[0][1].body));
    expect(body).toMatchObject({ max_completion_tokens: 200, reasoning_effort: "none", stream: false });
    expect(body.max_tokens).toBeUndefined();
  });

  it("preserves the main GPT-5 response cap while removing unsupported sampling", async () => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => sse({ choices: [{ delta: { content: "Done" }, finish_reason: "stop" }] }));
    vi.stubGlobal("fetch", fetch);
    const events = [];
    for await (const event of streamChat({ apiBaseUrl: "https://api.openai.com/v1", apiKey: "fixture", model: "gpt-5.6-sol", messages: [{ role: "user", content: "Fix it" }], modelParams: { reasoningEffort: "high" }, temperature: 0.5, sampling: { topP: 0.8, topK: 10 }, maxTokens: 8192, signal: new AbortController().signal, maxRetries: 1 })) events.push(event);
    const body = JSON.parse(String(fetch.mock.calls[0][1].body));
    expect(body).toMatchObject({ max_completion_tokens: 8192, reasoning_effort: "high", stream: true });
    for (const key of ["max_tokens", "temperature", "top_p", "top_k"]) expect(body[key]).toBeUndefined();
    expect(events).toContainEqual({ type: "text-delta", text: "Done" });
  });

  it.each(["claude-fable-5-1", "claude-opus-5", "claude-sonnet-5"])("generates titles with supported thinking and no forced tool on %s", async (model) => {
    const fetch = vi.fn(async () => sse(
      { type: "message_start", message: { usage: { input_tokens: 20 } } },
      { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "Considering the topic" } },
      { type: "content_block_delta", delta: { type: "text_delta", text: "Fix context accounting" } },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 8 } },
      { type: "message_stop" },
    ));
    vi.stubGlobal("fetch", fetch);
    const onUsage = vi.fn();
    expect(await generateTitle("https://api.anthropic.com/v1", "fixture", model, "Fix token counts", true, undefined, { onUsage })).toBe("Fix context accounting");
    const body = JSON.parse(String((fetch.mock.calls as unknown as [string, RequestInit][])[0][1].body));
    expect(body).toMatchObject({ stream: true, max_tokens: 4096, output_config: { effort: "low" } });
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
    expect(body.thinking.type).toBe(model.includes("fable") ? "adaptive" : "disabled");
    expect(onUsage.mock.calls.reduce((total, [event]) => total + (event.completionTokens ?? 0), 0)).toBe(8);
  });

  it("extracts the judge answer after thinking on Fable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sse(
      { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "Compare the candidates" } },
      { type: "content_block_delta", delta: { type: "text_delta", text: "candidate" } },
      { type: "message_stop" },
    )));
    expect(await pickModel("https://api.anthropic.com/v1", "fixture", "claude-fable-5-1", ["candidate"], "Fix it", true)).toBe("candidate");
  });

  it("uses supported Gemini 3.8 options and leaves room for title reasoning", async () => {
    const fetch = vi.fn(async () => sse({ choices: [{ delta: { content: "Fix context accounting" }, finish_reason: "stop" }] }));
    vi.stubGlobal("fetch", fetch);
    expect(await generateTitle("https://generativelanguage.googleapis.com/v1beta/openai", "fixture", "gemini-3.8-flash", "Fix token counts")).toBe("Fix context accounting");
    const body = JSON.parse(String((fetch.mock.calls as unknown as [string, RequestInit][])[0][1].body));
    expect(body).toMatchObject({ model: "gemini-3.8-flash", reasoning_effort: "low", max_tokens: 4096, stream: true });
    expect(body.temperature).toBeUndefined();
  });

  it("gives Claude OAuth titles the same bounded reasoning settings", async () => {
    vi.mocked(streamOAuthChat).mockImplementation(async function* () {
      yield { type: "thinking-delta", text: "Title reasoning" };
      yield { type: "text-delta", text: "Fix context accounting" };
      yield { type: "done", finishReason: "stop" };
    });
    expect(await generateTitle("", "", "claude-fable-5-1", "Fix token counts", false, "claude-code")).toBe("Fix context accounting");
    expect(streamOAuthChat).toHaveBeenCalledWith("claude-code", expect.objectContaining({ maxTokens: 4096, modelParams: { thinking: "disabled", reasoningEffort: "low" } }));
  });
});
