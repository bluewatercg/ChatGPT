/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderEvent, Step, WireMessage } from "../types";
import type { StreamChatOpts } from "./types";
import { applyGoogleOpenAIOptions, googleThoughtSignature, isGoogleOpenAIEndpoint, prepareGoogleMessages } from "./google";

vi.mock("vscode", () => ({ EventEmitter: class { event = () => ({ dispose() {} }); fire() {} } }));
vi.mock("../../stores/featureStore", () => ({ MODEL_CATALOG: [] }));
vi.mock("../oauth", () => ({ streamOAuthChat: vi.fn() }));
import { streamChat } from "../provider";
import { buildMessages } from "../messages";

const googleBase = "https://generativelanguage.googleapis.com/v1beta/openai";
const sse = (...frames: unknown[]) => new Response(frames.map((frame) => `data: ${typeof frame === "string" ? frame : JSON.stringify(frame)}\n\n`).join(""));
const success = () => sse({ choices: [{ delta: { content: "Done." }, finish_reason: "stop" }] }, "[DONE]");
afterEach(() => vi.unstubAllGlobals());

async function collect(options: Partial<StreamChatOpts> = {}) {
  const events: ProviderEvent[] = [];
  for await (const event of streamChat({ apiBaseUrl: googleBase, apiKey: "fixture", model: "gemini-3.8-flash",
    messages: [{ role: "user", content: "Compare these files." }], signal: new AbortController().signal,
    maxRetries: 1, ...options })) events.push(event);
  return events;
}

describe("Google endpoint and parameter contracts", () => {
  it.each([
    [googleBase, true], ["https://GENERATIVELANGUAGE.GOOGLEAPIS.COM:443/v1beta/openai/", true],
    ["https://generativelanguage.googleapis.com.evil.invalid/v1beta/openai", false],
    ["https://evil.invalid/?next=https://generativelanguage.googleapis.com", false],
    ["https://generativelanguage.googleapis.com@evil.invalid/v1beta/openai", false],
    ["https://account@generativelanguage.googleapis.com/v1beta/openai", false],
    ["http://generativelanguage.googleapis.com/v1beta/openai", false],
    ["https://generativelanguage.googleapis.com:8443/v1beta/openai", false],
    ["https://daily-cloudcode-pa.googleapis.com", false], ["not a URL", false],
  ])("scopes Google protocol options to the actual host: %s", (url, expected) => {
    expect(isGoogleOpenAIEndpoint(url)).toBe(expected);
  });

  it.each([
    ["gemini-3.8-flash", "none", "low"], ["gemini-3.8-flash", "minimal", "low"],
    ["gemini-3.7-flash", "minimal", "low"], ["gemini-3.7-flash", "none", "low"],
    ["gemini-3.6-flash", "none", "minimal"], ["gemini-3.5-flash-lite", "none", "minimal"],
    ["gemini-3.1-pro-preview", "none", "low"], ["gemini-3.1-pro-preview-customtools", "minimal", "low"],
    ["gemini-3.1-flash-lite", "minimal", "minimal"], ["gemini-2.5-pro", "none", "low"],
    ["gemini-2.5-flash", "none", "none"], ["gemini-2.5-flash-lite", "none", "none"],
    ["gemini-3.8-flash", "xhigh", "high"], ["gemini-3.8-flash", "auto", undefined],
    ["gemini-3.8-flash", "default", undefined], ["gemini-3.8-flash", "invalid", undefined],
  ])("normalizes saved %s effort %s to %s", (model, selected, expected) => {
    const body: Record<string, unknown> = { reasoning_effort: selected };
    applyGoogleOpenAIOptions(body, model);
    expect(body.reasoning_effort).toBe(expected);
  });

  it("leaves the provider's default reasoning unset and respects explicit thinking-disabled migration", () => {
    const defaultBody = {};
    applyGoogleOpenAIOptions(defaultBody, "gemini-3.8-flash");
    expect(defaultBody).toEqual({});
    const disabled: Record<string, unknown> = { reasoning_effort: "high" };
    applyGoogleOpenAIOptions(disabled, "gemini-3.8-flash", { thinking: "disabled" });
    expect(disabled.reasoning_effort).toBe("low");
  });

  it("filters unsupported 3.8 controls at the production HTTP boundary", async () => {
    const requests: { url: string; body: any }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init) => { requests.push({ url: String(url), body: JSON.parse(init.body) }); return success(); }));
    await collect({ modelParams: { reasoningEffort: "minimal" }, maxTokens: 5000, temperature: 0.5,
      sampling: { topP: 0.8, topK: 10, frequencyPenalty: 0.3, presencePenalty: 0.4, seed: 42, stopSequences: ["END"] } });
    expect(requests[0].url).toBe(`${googleBase}/chat/completions`);
    expect(requests[0].body).toMatchObject({ reasoning_effort: "low", max_tokens: 5000, seed: 42, stop: ["END"], stream: true });
    for (const key of ["temperature", "top_p", "top_k", "frequency_penalty", "presence_penalty"]) expect(requests[0].body).not.toHaveProperty(key);
  });

  it("preserves ordinary compatible-provider parameters even for a Gemini-named model", async () => {
    let body: any;
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => { body = JSON.parse(init.body); return success(); }));
    await collect({ apiBaseUrl: "https://compatible.invalid/v1", temperature: 0.5, sampling: { topP: 0.8, presencePenalty: 0.4 }, modelParams: { reasoningEffort: "none" } });
    expect(body).toMatchObject({ temperature: 0.5, top_p: 0.8, presence_penalty: 0.4, reasoning_effort: "none" });
  });
});

describe("Google tool signature persistence", () => {
  it("streams delayed metadata, persists it through buildMessages, and replays signed parallel calls with images", async () => {
    const requests: any[] = [];
    const fetch = vi.fn(async (_url, init) => {
      requests.push(JSON.parse(init.body));
      if (requests.length > 1) return success();
      return sse(
        { choices: [{ delta: { tool_calls: [
          { index: 0, id: "google-first", function: { name: "Read", arguments: '{"path":' } },
          { index: 1, id: "google-second", function: { name: "Read", arguments: '{"path":"second.png"}' } },
        ] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"first.png"}' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, extra_content: { google: { thought_signature: "original-opaque-signature" } } }] }, finish_reason: "tool_calls" }],
          usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 50 } } },
        "[DONE]",
      );
    });
    vi.stubGlobal("fetch", fetch);
    const events = await collect();
    const calls = events.filter((event) => event.type === "tool-call").map((event) => event.call);
    expect(calls).toEqual([
      { id: "google-first", name: "Read", arguments: '{"path":"first.png"}', thoughtSignature: "original-opaque-signature" },
      { id: "google-second", name: "Read", arguments: '{"path":"second.png"}' },
    ]);
    const steps: Step[] = [
      { kind: "user", text: "Compare these files." }, { kind: "assistant", text: "", calls },
      ...calls.map((call, index): Step => ({ kind: "tool-result", callId: call.id, name: call.name, output: `Image ${index}`, status: "completed", image: { mime: "image/png", base64: `IMAGE_${index}` } })),
    ];
    const messages = buildMessages("You are OpenCursor.", steps);
    const before = structuredClone(messages);
    await collect({ messages });
    const replay = requests[1].messages;
    const assistant = replay.find((message: any) => message.role === "assistant");
    expect(assistant.tool_calls[0]).toEqual({ id: "google-first", type: "function", function: { name: "Read", arguments: '{"path":"first.png"}' }, extra_content: { google: { thought_signature: "original-opaque-signature" } } });
    expect(assistant.tool_calls[1]).not.toHaveProperty("extra_content");
    expect(replay.filter((message: any) => message.role === "tool").map((message: any) => message.tool_call_id)).toEqual(["google-first", "google-second"]);
    expect(replay.slice(-3).map((message: any) => message.role)).toEqual(["tool", "tool", "user"]);
    expect(JSON.stringify(replay)).toContain("IMAGE_0");
    expect(JSON.stringify(replay)).toContain("IMAGE_1");
    expect(messages).toEqual(before);
    expect(events.find((event) => event.type === "usage")).toMatchObject({ promptTokens: 100, completionTokens: 20, cachedReadTokens: 50 });
  });

  it("does not retain or transmit Google-only metadata for third-party hosts", async () => {
    let body: any;
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      body = JSON.parse(init.body);
      return sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "new", function: { name: "Read", arguments: "{}" }, extra_content: { google: { thought_signature: "foreign" } } }] }, finish_reason: "tool_calls" }] }, "[DONE]");
    }));
    const events = await collect({ apiBaseUrl: "https://compatible.invalid/v1", messages: [
      { role: "assistant", content: null, tool_calls: [{ id: "old", type: "function", function: { name: "Read", arguments: "{}" }, thoughtSignature: "google-only" }] },
      { role: "tool", tool_call_id: "old", content: "contents" },
    ] });
    expect(body.messages[0].tool_calls[0]).toEqual({ id: "old", type: "function", function: { name: "Read", arguments: "{}" } });
    expect(events.find((event) => event.type === "tool-call")?.call).toEqual({ id: "new", name: "Read", arguments: "{}" });
  });

  it("preserves unsigned legacy observations and images without replaying invalid function calls", async () => {
    let body: any;
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => { body = JSON.parse(init.body); return success(); }));
    const messages: WireMessage[] = [
      { role: "assistant", content: "Previously read files.", tool_calls: [
        { id: "first", type: "function", function: { name: "Read", arguments: '{"path":"a.png"}' } },
        { id: "second", type: "function", function: { name: "Read", arguments: '{"path":"b.ts"}' }, thoughtSignature: "second-only-signature" },
      ] },
      { role: "tool", tool_call_id: "first", content: [{ type: "text", text: "Image loaded." }, { type: "image_url", image_url: { url: "data:image/png;base64,IMAGE" } }] },
      { role: "tool", tool_call_id: "second", content: "Second file contents." },
      { role: "user", content: "Continue." },
    ];
    const before = structuredClone(messages);
    await collect({ messages });
    expect(body.messages.some((message: any) => message.tool_calls || message.role === "tool")).toBe(false);
    expect(JSON.stringify(body.messages)).toContain("Image loaded.");
    expect(JSON.stringify(body.messages)).toContain("Second file contents.");
    expect(JSON.stringify(body.messages)).toContain("data:image/png;base64,IMAGE");
    expect(JSON.stringify(body.messages)).toContain("a.png");
    expect(JSON.stringify(body.messages)).toContain("b.ts");
    expect(messages).toEqual(before);
  });

  it("matches legacy reused call ids to their nearest preceding group", () => {
    const prepared = prepareGoogleMessages([
      { role: "assistant", content: null, tool_calls: [{ id: "call_0", type: "function", function: { name: "Read", arguments: "{}" }, thoughtSignature: "earlier" }] },
      { role: "tool", tool_call_id: "call_0", content: "Earlier result." },
      { role: "assistant", content: null, tool_calls: [{ id: "call_0", type: "function", function: { name: "Grep", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_0", content: "Later unsigned result." },
    ], "gemini-3.8-flash");
    expect(prepared[1].role).toBe("tool");
    expect(prepared[3]).toEqual({ role: "user", content: "[Previous tool result Grep, call call_0]\nLater unsigned result." });
  });

  it("keeps native unsigned calls for Gemini 2.5 and ignores malformed signature metadata", () => {
    const messages: WireMessage[] = [{ role: "assistant", content: null, tool_calls: [{ id: "a", type: "function", function: { name: "Read", arguments: "{}" } }] }];
    expect(prepareGoogleMessages(messages, "gemini-2.5-pro")).toBe(messages);
    for (const value of [null, "invalid", {}, { extra_content: { google: { thought_signature: 42 } } }]) expect(googleThoughtSignature(value)).toBeUndefined();
  });
});
