/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OAuthAccount, OAuthKind } from "./oauth/types";

vi.mock("vscode", () => ({ EventEmitter: class { event = () => ({ dispose() {} }); fire() {} } }));
vi.mock("../stores/featureStore", () => ({ MODEL_CATALOG: [] }));
import { disconnect, getAccountLimits, initOAuth, isConnected, listAccounts, setAccountEnabled, streamOAuthChat } from "./oauth";
import { buildMessages } from "./messages";

const saved = new Map<string, string>();
const sse = (kind: OAuthKind) => new Response(`data: ${JSON.stringify(kind === "codex"
  ? { type: "response.completed", response: { status: "completed" } }
  : kind === "claude-code" ? { type: "message_stop" }
  : { response: { candidates: [{ content: { parts: [{ text: "Done" }] }, finishReason: "STOP" }] } })}\n\n`);
const jwt = (claims: object) => `fixture.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.fixture`;
const headers = (init?: RequestInit) => new Headers(init?.headers);
const body = (init?: RequestInit) => JSON.parse(String(init?.body));

async function seed(kind: OAuthKind = "codex", extra: Partial<OAuthAccount> = {}) {
  const account: OAuthAccount = { id: `transport-${kind}`, kind, accessToken: "old-access", refreshToken: "old-refresh",
    expiresAt: Date.now() + 3_600_000, accountId: "workspace-one", projectId: "project-one", ...extra };
  saved.set(`ocursor.oauth.acct.${account.id}`, JSON.stringify(account));
  initOAuth({ globalState: { get: (_key: string, fallback: unknown) => Array.isArray(fallback) ? [account.id] : fallback, update: vi.fn() },
    secrets: { get: async (key: string) => saved.get(key), store: async (key: string, value: string) => { saved.set(key, value); },
      delete: async (key: string) => { saved.delete(key); } } } as unknown as Parameters<typeof initOAuth>[0]);
  await vi.waitFor(() => expect(isConnected(kind)).toBe(true));
  return account;
}

async function chat(kind: OAuthKind = "codex", signal = new AbortController().signal) {
  const events = [];
  for await (const event of streamOAuthChat(kind, { model: kind === "codex" ? "gpt-5.6-sol" : kind === "claude-code" ? "claude-sonnet-4-6" : "gemini-3-flash",
    messages: [{ role: "user", content: "Hello" }], promptCacheKey: "conversation", signal })) events.push(event);
  return events;
}

beforeEach(async () => {
  for (const account of listAccounts()) await disconnect(account.id);
  saved.clear();
});
afterEach(() => vi.unstubAllGlobals());

describe("OAuth account transport", () => {
  it("preserves a real Gemini call signature through the agent history and next request", async () => {
    await seed("antigravity");
    const sent: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      sent.push(body(init));
      return sent.length === 1 ? new Response(`data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [{
        thoughtSignature: "original-signature", functionCall: { name: "Read", args: { path: "file.ts" } },
      }] }, finishReason: "STOP" }] } })}\n\n`) : sse("antigravity");
    }));
    const first = await chat("antigravity");
    const call = first.find((event) => event.type === "tool-call");
    expect(call?.type).toBe("tool-call");
    if (call?.type !== "tool-call") throw new Error("Missing tool call");
    const messages = buildMessages("system", [{ kind: "user", text: "Read file.ts" },
      { kind: "assistant", text: "", calls: [call.call] },
      { kind: "tool-result", callId: call.call.id, name: "Read", output: "contents", status: "completed" }]);
    for await (const _event of streamOAuthChat("antigravity", { model: "gemini-3-flash", messages, signal: new AbortController().signal })) { /* consume */ }
    const replay = sent[1].request.contents.flatMap((message: any) => message.parts).find((part: any) => part.functionCall);
    expect(replay).toMatchObject({ thoughtSignature: "original-signature", functionCall: { id: call.call.id, name: "Read", args: { path: "file.ts" } } });
  });

  it("provisions and saves a missing Google project before generating", async () => {
    const account = await seed("antigravity", { projectId: undefined });
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      urls.push(url);
      if (url.includes("loadCodeAssist")) return Response.json({ allowedTiers: [{ id: "free-tier", isDefault: true }] });
      if (url.includes("onboardUser")) return Response.json({ done: true, response: { cloudaicompanionProject: { id: "provisioned-project" } } });
      expect(body(init).project).toBe("provisioned-project");
      return sse("antigravity");
    }));
    await chat("antigravity");
    expect(urls.map((url) => url.split(":").at(-1))).toEqual(["loadCodeAssist", "onboardUser", "streamGenerateContent?alt=sse"]);
    expect(JSON.parse(saved.get(`ocursor.oauth.acct.${account.id}`)!)).toMatchObject({ projectId: "provisioned-project" });
  });

  it.each(["codex", "claude-code", "antigravity"] as const)("refreshes a rejected %s token once using its native encoding", async (kind) => {
    const account = await seed(kind);
    const sent: RequestInit[] = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes("/token")) {
        expect(headers(init).get("accept")).toBe("application/json");
        const data = kind === "antigravity" ? Object.fromEntries(new URLSearchParams(String(init?.body))) : body(init);
        expect(data).toMatchObject({ grant_type: "refresh_token", refresh_token: "old-refresh" });
        expect(headers(init).get("content-type")).toBe(kind === "antigravity" ? "application/x-www-form-urlencoded" : "application/json");
        return Response.json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 });
      }
      sent.push(init!);
      return sent.length === 1 ? new Response("expired", { status: 401 }) : sse(kind);
    });
    vi.stubGlobal("fetch", fetchMock);
    await chat(kind);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(headers(sent[0]).get("authorization")).toBe("Bearer old-access");
    expect(headers(sent[1]).get("authorization")).toBe("Bearer new-access");
    expect(sent[1].body).toBe(sent[0].body);
    expect(JSON.parse(saved.get(`ocursor.oauth.acct.${account.id}`)!)).toMatchObject({ accessToken: "new-access", refreshToken: "new-refresh" });
  });

  it("shares a rotated token across simultaneous rejected requests", async () => {
    await seed();
    let refreshes = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/token")) {
        refreshes++;
        await gate;
        return Response.json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 });
      }
      return headers(init).get("authorization") === "Bearer old-access" ? new Response("expired", { status: 401 }) : sse("codex");
    });
    vi.stubGlobal("fetch", fetchMock);
    const requests = [chat(), chat()];
    await vi.waitFor(() => expect(refreshes).toBe(1));
    release();
    await Promise.all(requests);
    expect(refreshes).toBe(1);
  });

  it.each([401, 403])("does not loop or bypass a final HTTP %s", async (status) => {
    await seed();
    const fetchMock = vi.fn(async (url: string) => url.includes("/token")
      ? Response.json({ access_token: "new-access", expires_in: 3600 }) : new Response("rejected", { status }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(chat()).rejects.toMatchObject({ status });
    expect(fetchMock).toHaveBeenCalledTimes(status === 401 ? 3 : 1);
  });

  it("keeps existing credentials when a refresh response is malformed", async () => {
    const account = await seed("codex", { expiresAt: Date.now() - 1 });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ refresh_token: "do-not-save", expires_in: 3600 })));
    await expect(chat()).rejects.toThrow("access token");
    expect(JSON.parse(saved.get(`ocursor.oauth.acct.${account.id}`)!)).toMatchObject({ accessToken: "old-access", refreshToken: "old-refresh" });
  });

  it("refreshes workspace identity and uses it for chat and quota requests", async () => {
    await seed("codex", { expiresAt: Date.now() - 1 });
    const sent: RequestInit[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/token")) return Response.json({ access_token: "new-access", expires_in: 3600,
        id_token: jwt({ email: "fixture@example.invalid", "https://api.openai.com/auth": { chatgpt_account_id: "workspace-two" } }) });
      sent.push(init!);
      return url.includes("/usage") ? Response.json({}) : sse("codex");
    }));
    await chat();
    await getAccountLimits("transport-codex");
    expect(sent).toHaveLength(2);
    expect(sent.every((init) => headers(init).get("chatgpt-account-id") === "workspace-two")).toBe(true);
  });

  it("does not resurrect an account removed during refresh", async () => {
    const account = await seed("codex", { expiresAt: Date.now() - 1 });
    let release!: (response: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { release = resolve; }));
    vi.stubGlobal("fetch", fetchMock);
    const request = chat();
    const rejected = expect(request).rejects.toThrow("no longer connected");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await disconnect(account.id);
    release(Response.json({ access_token: "new-access", expires_in: 3600 }));
    await rejected;
    expect(listAccounts()).toEqual([]);
    expect(saved.has(`ocursor.oauth.acct.${account.id}`)).toBe(false);
  });

  it("cancels a waiting chat while allowing a shared refresh to persist safely", async () => {
    const account = await seed("codex", { expiresAt: Date.now() - 1 });
    let release!: (response: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { release = resolve; }));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const request = chat("codex", controller.signal);
    const rejected = expect(request).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await setAccountEnabled(account.id, false);
    controller.abort();
    await rejected;
    release(Response.json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 }));
    await vi.waitFor(() => expect(JSON.parse(saved.get(`ocursor.oauth.acct.${account.id}`)!)).toMatchObject({ accessToken: "new-access", disabled: true }));
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
