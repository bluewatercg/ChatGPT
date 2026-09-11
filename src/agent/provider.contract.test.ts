/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderEvent, Step, WireMessage } from "./types";
import type { StreamChatOpts } from "./provider/types";

vi.mock("vscode", () => ({ EventEmitter: class { event = () => ({ dispose() {} }); fire() {} } }));
vi.mock("../stores/featureStore", () => ({ MODEL_CATALOG: [] }));
import { generateTitle, pickModel, streamChat } from "./provider";
import { initOAuth, isConnected } from "./oauth";
import { buildMessages, snapshotUserContext } from "./messages";

const sse = (...frames: unknown[]) => new Response(frames.map((frame) => `data: ${typeof frame === "string" ? frame : JSON.stringify(frame)}\n\n`).join(""), { status: 200 });
const success = () => sse({ choices: [{ delta: { content: "Done" }, finish_reason: "stop" }] }, "[DONE]");
let requests: { url: string; body: any }[];
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(async () => {
  requests = [];
  const kinds = ["claude-code", "codex", "antigravity"] as const;
  initOAuth({
    globalState: { get: (key: string, fallback: unknown) => key === "ocursor.oauth.accountIds" ? kinds.map((kind) => `contract-${kind}`) : fallback },
    secrets: { get: async (key: string) => JSON.stringify({ id: key.replace("ocursor.oauth.acct.", ""), kind: kinds.find((kind) => key.endsWith(kind)), accessToken: "fixture", refreshToken: "fixture", expiresAt: Date.now() + 3_600_000, projectId: "fixture" }) },
  } as unknown as Parameters<typeof initOAuth>[0]);
  await vi.waitFor(() => expect(kinds.every(isConnected)).toBe(true));
  fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    requests.push({ url, body: JSON.parse(String(init.body)) });
    if (url.includes("/messages")) return sse({ type: "message_delta", delta: { stop_reason: "end_turn" } }, { type: "message_stop" });
    if (url.includes("/responses")) return sse({ type: "response.completed", response: {} });
    if (url.includes("streamGenerateContent")) return sse({ response: { candidates: [{ content: { parts: [{ text: "Done" }] }, finishReason: "STOP" }] } });
    return success();
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

async function collect(options: Partial<StreamChatOpts> = {}, events: ProviderEvent[] = []) {
  for await (const event of streamChat({ apiBaseUrl: "https://contract.example.invalid/v1", apiKey: "fixture", model: "fixture", messages: [{ role: "user", content: "hi" }], maxRetries: 1, signal: new AbortController().signal, ...options })) events.push(event);
  return events;
}

it("does not send Google replay signatures to an OpenAI-compatible endpoint", async () => {
  await collect({ messages: [{ role: "assistant", content: null, tool_calls: [{ id: "call", type: "function", function: { name: "Read", arguments: "{}" }, thoughtSignature: "google-only" }] },
    { role: "tool", tool_call_id: "call", content: "contents" }] });
  expect(requests[0].body.messages[0].tool_calls[0]).toEqual({ id: "call", type: "function", function: { name: "Read", arguments: "{}" } });
});

describe("complete provider request contracts", () => {
  it.each([undefined, "claude-code"] as const)("caches successive completed tool batches through %s without changing source messages", async (oauthKind) => {
    const history: Step[] = [{ kind: "user", text: "Inspect project", context: snapshotUserContext({ userInfo: "Keep public APIs", openFiles: "app.ts", timestamp: "fixed" }) }];
    for (let turn = 1; turn <= 3; turn++) {
      const ids = Array.from({ length: turn === 3 ? 25 : 1 }, (_, i) => `read-${turn}-${i}`);
      history.push({ kind: "assistant", text: "", calls: ids.map(id => ({ id, name: "Read", arguments: '{"path":"app.ts"}' })) },
        ...ids.map(id => ({ kind: "tool-result" as const, callId: id, name: "Read", output: `Result ${id}`, status: "completed" as const })));
      const messages = buildMessages("OpenCursor", history);
      const source = JSON.stringify(messages);
      await collect({ messages, anthropic: true, oauthKind, model: "claude-sonnet-4-6" });
      const body = requests[requests.length - 1].body;
      const cached = body.messages.flatMap((message: any) => Array.isArray(message.content)
        ? message.content.filter((block: any) => block.type === "tool_result" && block.cache_control).map((block: any) => block.tool_use_id) : []);
      expect(cached).toEqual(turn === 1 ? [ids[0]] : [`read-${turn - 1}-0`, ids[ids.length - 1]]);
      expect(JSON.stringify(body).match(/cache_control/g)).toHaveLength(4);
      expect(JSON.stringify(messages)).toBe(source);
    }
  });

  it.each([undefined, "claude-code", "codex"] as const)("preserves serialized prior content across saved user turns through %s", async (oauthKind) => {
    const context = snapshotUserContext({ userInfo: "Workspace rules", openFiles: "app.ts", timestamp: "first" });
    const history: Step[] = [{ kind: "user", text: "First request", context }, { kind: "assistant", text: "First answer", calls: [] }];
    const options = { oauthKind, ...(oauthKind === "claude-code" ? { model: "claude-sonnet-4-6", anthropic: true } : {}) };
    await collect({ ...options, messages: buildMessages("OpenCursor", history) });
    const restored: Step[] = JSON.parse(JSON.stringify(history));
    restored.push({ kind: "user", text: "Follow-up", context: snapshotUserContext({ ...context, timestamp: "second" }, context) });
    await collect({ ...options, messages: buildMessages("OpenCursor", restored) });
    // Anthropic's four supported cache markers roll forward independently of
    // content. Their positions are provider metadata, not instruction changes.
    const contentOnly = (value: unknown) => JSON.parse(JSON.stringify(value, (key, item) => key === "cache_control" ? undefined : item));
    const first = requests[0].body.input ?? requests[0].body.messages;
    const second = requests[1].body.input ?? requests[1].body.messages;
    expect(contentOnly(second.slice(0, first.length))).toEqual(contentOnly(first));
    expect(JSON.stringify(second).match(/Workspace rules/g)).toHaveLength(1);
  });

  it.each([undefined, "claude-code"] as const)("honors Sonnet 5 disabled thinking through %s", async (oauthKind) => {
    await collect({ anthropic: true, oauthKind, model: "claude-sonnet-5", modelParams: { thinking: "disabled", reasoningEffort: "max" } });
    expect(requests[0].body.thinking).toEqual({ type: "disabled" });
    expect(requests[0].body.output_config).toEqual({ effort: "max" });
  });

  it.each([undefined, "claude-code"] as const)("limits Anthropic cache breakpoints for %s without modifying history", async (oauthKind) => {
    const messages = buildMessages("System", [{ kind: "user", text: "Previous request" }, { kind: "assistant", text: "Previous answer", calls: [] }, { kind: "user", text: "Follow-up" }], { userInfo: "Workspace", openFiles: "src/example.ts", timestamp: "fixture" });
    const original = JSON.stringify(messages);
    expect(original.match(/cache_control/g)).toHaveLength(5);
    await collect({ messages, anthropic: true, oauthKind, model: "claude-sonnet-4-6" });
    const serialized = JSON.stringify(requests[0].body);
    expect(serialized.match(/cache_control/g)).toHaveLength(4);
    expect(serialized).toContain("Previous answer");
    expect(JSON.stringify(messages)).toBe(original);
  });

  it.each([undefined, "claude-code", "codex", "antigravity"] as const)("preserves tool images and sibling tool results through %s", async (oauthKind) => {
    const messages: WireMessage[] = [
      { role: "user", content: "Inspect these images" },
      { role: "assistant", content: null, tool_calls: ["one", "two"].map((id) => ({ id, type: "function", function: { name: "Read", arguments: "{}" } })) },
      ...["one", "two"].map((id): WireMessage => ({ role: "tool", tool_call_id: id, content: [{ type: "text", text: `image ${id}` }, { type: "image_url", image_url: { url: `data:image/png;base64,IMAGE_${id}` } }] })),
    ];
    await collect({ messages, oauthKind });
    const serialized = JSON.stringify(requests[0].body);
    expect(serialized).toContain("IMAGE_one");
    expect(serialized).toContain("IMAGE_two");
    if (!oauthKind) {
      const messages = requests[0].body.messages;
      expect(messages.map((message: any) => message.role)).toEqual(["user", "assistant", "tool", "tool", "user"]);
    }
    if (oauthKind === "codex") {
      const input = requests[0].body.input;
      expect(input.filter((item: any) => item.type === "function_call_output")).toHaveLength(2);
      expect(input.at(-1).content).toHaveLength(2);
      expect(input.at(-2).type).toBe("function_call_output");
    }
  });

  it("requests OpenAI streaming usage, deduplicates counters and identifies the request", async () => {
    fetchMock.mockImplementationOnce(async (_url: string, init: RequestInit) => {
      expect(JSON.parse(String(init.body)).stream_options).toEqual({ include_usage: true });
      return sse({ usage: { prompt_tokens: 100, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 60 } } }, { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 60 } } }, "[DONE]");
    });
    const usage = (await collect()).filter((event) => event.type === "usage");
    expect(usage.reduce((n, event) => n + (event.promptTokens ?? 0), 0)).toBe(100);
    expect(usage.reduce((n, event) => n + (event.completionTokens ?? 0), 0)).toBe(4);
    expect(usage.reduce((n, event) => n + (event.cachedReadTokens ?? 0), 0)).toBe(60);
    expect(new Set(usage.map((event) => event.requestId)).size).toBe(1);
    expect(usage[0].model).toBe("fixture");
  });

  it("remembers only explicit unsupported-usage errors as a compatibility fallback", async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"error":{"message":"Unsupported parameter: stream_options"}}', { status: 400 }));
    await collect({ apiBaseUrl: "https://compat.example.invalid/v1" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[1][1].body)).stream_options).toBeUndefined();
    await collect({ apiBaseUrl: "https://compat.example.invalid/v1" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(JSON.parse(String(fetchMock.mock.calls[2][1].body)).stream_options).toBeUndefined();
  });

  it("does not replay an unrelated 400", async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"error":{"message":"context length exceeded"}}', { status: 400 }));
    await expect(collect()).rejects.toThrow("context length exceeded");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("stream failures and accounting", () => {
  it("accounts failed and retried requests with distinct identities", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(sse({ type: "message_start", message: { usage: { input_tokens: 2, cache_read_input_tokens: 10 } } }, { type: "error", error: { type: "overloaded_error", message: "retry fixture" } }));
    fetchMock.mockResolvedValueOnce(sse({ type: "message_start", message: { usage: { input_tokens: 3, cache_read_input_tokens: 20 } } }, { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }));
    const result = collect({ anthropic: true, maxRetries: 2 });
    await vi.runAllTimersAsync();
    const usage = (await result).filter((event) => event.type === "usage");
    expect(new Set(usage.map((event) => event.requestId)).size).toBe(2);
    expect(usage.reduce((sum, event) => sum + (event.promptTokens ?? 0), 0)).toBe(35);
    expect(usage.reduce((sum, event) => sum + (event.cachedReadTokens ?? 0), 0)).toBe(30);
  });
  it("keeps reported usage but rejects an in-band error instead of reporting success", async () => {
    fetchMock.mockResolvedValueOnce(sse({ choices: [{ delta: { content: "Partial answer" } }] }, { usage: { prompt_tokens: 50, completion_tokens: 10 }, error: { message: "overloaded", code: 503 } }));
    const events: ProviderEvent[] = [];
    await expect(collect({}, events)).rejects.toThrow("overloaded");
    expect(events).toContainEqual({ type: "text-delta", text: "Partial answer" });
    expect(events.find((event) => event.type === "usage")).toMatchObject({ promptTokens: 50, completionTokens: 10, requestId: expect.any(String) });
    expect(events.some((event) => event.type === "done")).toBe(false);
  });

  it("rejects a prematurely closed stream and never emits a partial tool as executable", async () => {
    fetchMock.mockResolvedValueOnce(sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "one", function: { name: "Write", arguments: '{"path":"unfinished' } }] } }] }));
    const events: ProviderEvent[] = [];
    await expect(collect({}, events)).rejects.toThrow("before completion");
    expect(events.some((event) => event.type === "tool-call" || event.type === "done")).toBe(false);
  });

  it("reads the final completion record when the stream omits its final newline", async () => {
    fetchMock.mockResolvedValueOnce(new Response('data: {"choices":[{"delta":{"content":"Done"},"finish_reason":"stop"}]}'));
    expect((await collect()).at(-1)).toEqual({ type: "done", finishReason: "stop" });
  });

  it.each(["claude-code", "codex", "antigravity"] as const)("rejects missing terminal events from %s", async (oauthKind) => {
    fetchMock.mockResolvedValueOnce(sse(oauthKind === "claude-code" ? { type: "content_block_delta", delta: { type: "text_delta", text: "Partial" } } : oauthKind === "codex" ? { type: "response.output_text.delta", delta: "Partial" } : { response: { candidates: [{ content: { parts: [{ text: "Partial" }] } }] } }));
    await expect(collect({ oauthKind })).rejects.toThrow("before completion");
  });
});

describe("title and model-routing costs", () => {
  it("reports direct title usage and attaches an abortable deadline", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: '{"title":"Fix context accounting"}' } }], usage: { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 25 } } })));
    const onUsage = vi.fn();
    const abort = new AbortController();
    expect(await generateTitle("https://title.example.invalid/v1", "fixture", "title-model", "Fix usage", false, undefined, { signal: abort.signal, onUsage })).toBe("Fix context accounting");
    expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({ model: "title-model", promptTokens: 100, completionTokens: 10, cachedReadTokens: 25, requestId: expect.any(String) }));
    const sentSignal = fetchMock.mock.calls[0][1].signal as AbortSignal;
    abort.abort();
    expect(sentSignal.aborted).toBe(true);
  });

  it("accounts both a rejected structured-title request and its compatible fallback", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "Unsupported response_format" }, usage: { prompt_tokens: 20, completion_tokens: 1 } }), { status: 400 }));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: "Context fixes" } }], usage: { prompt_tokens: 30, completion_tokens: 2 } })));
    const onUsage = vi.fn();
    expect(await generateTitle("https://title.example.invalid/v1", "fixture", "title-model", "Fix", false, undefined, { onUsage })).toBe("Context fixes");
    expect(onUsage).toHaveBeenCalledTimes(2);
    expect(new Set(onUsage.mock.calls.map(([event]) => event.requestId)).size).toBe(2);
    expect(onUsage.mock.calls.reduce((sum, [event]) => sum + event.promptTokens, 0)).toBe(50);
  });

  it("reports model-judge usage including Anthropic cache buckets", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ content: [{ type: "text", text: "candidate" }], usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 50, cache_creation_input_tokens: 20 } })));
    const onUsage = vi.fn();
    expect(await pickModel("https://judge.example.invalid/v1", "fixture", "judge-model", ["candidate"], "Fix", true, undefined, { onUsage })).toBe("candidate");
    expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({ model: "judge-model", promptTokens: 80, completionTokens: 4, cachedReadTokens: 50, cachedWriteTokens: 20, requestId: expect.any(String) }));
  });

  it("counts OAuth auxiliary usage through the same streaming request identity", async () => {
    fetchMock.mockResolvedValueOnce(sse({ type: "response.output_text.delta", delta: "candidate" }, { type: "response.completed", response: { usage: { input_tokens: 40, output_tokens: 4 } } }));
    const onUsage = vi.fn();
    expect(await pickModel("", "", "judge-model", ["candidate"], "Fix", false, "codex", { onUsage })).toBe("candidate");
    expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({ model: "judge-model", promptTokens: 40, completionTokens: 4, requestId: expect.any(String) }));
  });

  it("does not start title or judge work after cancellation", async () => {
    const abort = new AbortController(); abort.abort();
    await expect(generateTitle("", "", "fixture", "Fix", false, undefined, { signal: abort.signal })).rejects.toThrow();
    await expect(pickModel("", "", "fixture", ["candidate"], "Fix", false, undefined, { signal: abort.signal })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
