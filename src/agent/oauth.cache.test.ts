/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  EventEmitter: class {
    event = () => ({ dispose() {} });
    fire() {}
  },
}));
vi.mock("../stores/featureStore", () => ({ MODEL_CATALOG: [] }));

import { initOAuth, isConnected } from "./oauth";
import { streamChat } from "./provider";

const requests: { body: Record<string, unknown>; headers: Record<string, string> }[] = [];

beforeEach(async () => {
  requests.length = 0;
  // Seed the real OAuth account loader using an in-memory extension context.
  // The future expiry prevents refresh; HTTP is replaced below.
  initOAuth({
    globalState: { get: (key: string, fallback: unknown) => key === "ocursor.oauth.accountIds" ? ["fixture-account"] : fallback },
    secrets: { get: async () => JSON.stringify({
      id: "fixture-account", kind: "codex", accessToken: "fixture-access", refreshToken: "fixture-refresh",
      expiresAt: Date.now() + 3_600_000,
    }) },
  } as unknown as Parameters<typeof initOAuth>[0]);
  await vi.waitFor(() => expect(isConnected("codex")).toBe(true));
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    requests.push({ body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string> });
    return new Response([
      'data: {"type":"response.output_text.delta","delta":"Done"}',
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":12,"output_tokens":3}}}',
      "",
    ].join("\n\n"), { status: 200 });
  }));
});

afterEach(() => vi.unstubAllGlobals());

async function request(promptCacheKey?: string): Promise<void> {
  for await (const _event of streamChat({
    apiBaseUrl: "", apiKey: "", oauthKind: "codex", model: "gpt-5.6",
    messages: [{ role: "user", content: "Complete the current task" }],
    promptCacheKey, signal: new AbortController().signal,
  })) { /* consume the real provider/OAuth transport and SSE parser */ }
}

describe("Codex prompt-cache routing", () => {
  it("keeps the conversation cache key and session stable across model requests", async () => {
    await request("conversation-one");
    await request("conversation-one");
    expect(requests).toHaveLength(2);
    for (const sent of requests) {
      expect(sent.body.prompt_cache_key).toBe("conversation-one");
      expect(sent.headers.session_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(sent.body.store).toBe(false);
    }
    expect(requests[0].headers.session_id).toBe(requests[1].headers.session_id);
  });

  it("isolates cache routing for different conversations and summaries", async () => {
    await request("conversation-one");
    await request("conversation-two");
    await request("conversation-one/summary");
    expect(new Set(requests.map((sent) => sent.body.prompt_cache_key)).size).toBe(3);
    expect(new Set(requests.map((sent) => sent.headers.session_id)).size).toBe(3);
    expect(requests.every((sent) => /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(sent.headers.session_id))).toBe(true);
  });

  it("uses independent UUID sessions when no caller key is supplied", async () => {
    await request();
    await request();
    for (const sent of requests) {
      expect(sent.body.prompt_cache_key).toMatch(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/);
      expect(sent.headers.session_id).toBe(sent.body.prompt_cache_key);
    }
    expect(requests[0].body.prompt_cache_key).not.toBe(requests[1].body.prompt_cache_key);
  });
});
