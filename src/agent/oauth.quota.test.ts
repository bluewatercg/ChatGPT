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
import { consumeCodexResetCredit, disconnect, getAccountLimits, initOAuth, listAccounts } from "./oauth";

const saved = new Map<string, string>();

async function seed(kind: OAuthKind = "codex", extra: Partial<OAuthAccount> = {}): Promise<OAuthAccount> {
  const account: OAuthAccount = { id: `quota-${kind}`, kind, accessToken: "fixture-access", refreshToken: "fixture-refresh",
    accountId: "fixture-workspace", projectId: "fixture-project", expiresAt: Date.now() + 3_600_000, ...extra };
  saved.set(`ocursor.oauth.acct.${account.id}`, JSON.stringify(account));
  initOAuth({
    globalState: { get: (key: string, fallback: unknown) => key === "ocursor.oauth.accountIds" ? [account.id] : fallback, update: async () => {} },
    secrets: { get: async (key: string) => saved.get(key), store: async (key: string, value: string) => { saved.set(key, value); }, delete: async (key: string) => { saved.delete(key); } },
  } as unknown as Parameters<typeof initOAuth>[0]);
  await vi.waitFor(() => expect(listAccounts().some(item => item.id === account.id)).toBe(true));
  return account;
}

beforeEach(async () => {
  for (const account of listAccounts()) await disconnect(account.id);
  saved.clear();
});

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("bounded OAuth quota operations", () => {
  it("rejects unknown refresh accounts instead of showing an empty successful snapshot", async () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    await expect(getAccountLimits("unknown")).rejects.toThrow("not connected");
    await expect(consumeCodexResetCredit("unknown")).resolves.toMatchObject({ ok: false, message: "This account is no longer connected" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("times out an unresponsive quota transport and aborts its signal after 20 seconds", async () => {
    const account = await seed();
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      requestSignal = init?.signal as AbortSignal;
      return new Promise<Response>(() => {});
    });
    vi.stubGlobal("fetch", fetchMock);
    const rejected = expect(getAccountLimits(account.id)).rejects.toMatchObject({ name: "TimeoutError", message: "Quota refresh timed out after 20 seconds" });
    await vi.advanceTimersByTimeAsync(20_000);
    await rejected;
    expect(requestSignal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses the same deadline for a response body that never finishes", async () => {
    const account = await seed();
    vi.useFakeTimers();
    const cancel = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"rate_limit":'));
          init?.signal?.addEventListener("abort", () => { cancel(); controller.error(init.signal!.reason); }, { once: true });
        },
      });
      return new Response(stream);
    }));
    const rejected = expect(getAccountLimits(account.id)).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(20_000);
    await rejected;
    expect(cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels a quota wait during shared refresh without cancelling token rotation", async () => {
    const account = await seed("codex", { expiresAt: Date.now() - 1 });
    let release!: (value: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>(resolve => { release = resolve; }));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const rejected = expect(getAccountLimits(account.id, controller.signal)).rejects.toMatchObject({ name: "AbortError", message: "Quota refresh cancelled" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    controller.abort();
    await rejected;
    release(Response.json({ access_token: "rotated-fixture", expires_in: 3600 }));
    await vi.waitFor(() => expect(JSON.parse(saved.get(`ocursor.oauth.acct.${account.id}`)!).accessToken).toBe("rotated-fixture"));
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("cancels while resolving an Antigravity project and never sends the quota request", async () => {
    const account = await seed("antigravity", { projectId: undefined });
    let release!: (value: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>(resolve => { release = resolve; }));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const rejected = expect(getAccountLimits(account.id, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    controller.abort(); await rejected;
    release(Response.json({ cloudaicompanionProject: "resolved-fixture-project" }));
    await vi.waitFor(() => expect(JSON.parse(saved.get(`ocursor.oauth.acct.${account.id}`)!).projectId).toBe("resolved-fixture-project"));
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("rejects a completed refresh response after its account was disconnected", async () => {
    const account = await seed();
    let release!: (value: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>(resolve => { release = resolve; }));
    vi.stubGlobal("fetch", fetchMock);
    const rejected = expect(getAccountLimits(account.id)).rejects.toThrow("no longer connected");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await disconnect(account.id);
    release(Response.json({ rate_limit: { primary_window: { used_percent: 25 } } }));
    await rejected;
  });

  it.each(["codex", "claude-code", "antigravity"] as const)("reports malformed %s quota JSON and cleans its deadline", async kind => {
    const account = await seed(kind);
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>not JSON</html>")));
    await expect(getAccountLimits(account.id)).rejects.toThrow("invalid JSON response");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the deadline and parent abort listener after a successful quota refresh", async () => {
    const account = await seed();
    vi.useFakeTimers();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return Response.json({ rate_limit: { primary_window: { used_percent: 25, reset_at: 1_900_000_000 } }, rate_limit_reset_credits: { available_count: 2 } });
    }));
    await expect(getAccountLimits(account.id, controller.signal)).resolves.toMatchObject({ limits: [{ remaining: 75 }], resetCredits: 2 });
    expect(vi.getTimerCount()).toBe(0);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });
});

describe("Codex reset credit is sent once", () => {
  it("keeps the existing endpoint, method, account header, and redemption body", async () => {
    const account = await seed();
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume");
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("chatgpt-account-id")).toBe("fixture-workspace");
      expect(Object.keys(JSON.parse(String(init?.body)))).toEqual(["redeem_request_id"]);
      expect(JSON.parse(String(init?.body)).redeem_request_id).toMatch(/^[a-f\d-]{36}$/);
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return Response.json({ code: "reset", windows_reset: 1 });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(consumeCodexResetCredit(account.id)).resolves.toMatchObject({ ok: true });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not replay or refresh after a rejected consume request", async () => {
    const account = await seed();
    const fetchMock = vi.fn(async () => new Response("unauthorized", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(consumeCodexResetCredit(account.id)).resolves.toMatchObject({ ok: false, message: "Codex reset credit HTTP 401" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("bounds reset requests and reports that a timed-out dispatched request may have consumed a credit", async () => {
    const account = await seed();
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => { requestSignal = init?.signal as AbortSignal; return new Promise<Response>(() => {}); });
    vi.stubGlobal("fetch", fetchMock);
    const rejected = expect(consumeCodexResetCredit(account.id)).rejects.toMatchObject({ name: "TimeoutError", message: expect.stringContaining("may have consumed a credit") });
    await vi.advanceTimersByTimeAsync(20_000); await rejected;
    expect(requestSignal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports malformed success bodies as ambiguous and never retries", async () => {
    const account = await seed();
    const fetchMock = vi.fn(async () => new Response("malformed"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(consumeCodexResetCredit(account.id)).rejects.toThrow("invalid JSON response. The request may have consumed a credit");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("cancels before dispatch without sending a credit request", async () => {
    const account = await seed();
    const controller = new AbortController(); controller.abort();
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    await expect(consumeCodexResetCredit(account.id, controller.signal)).rejects.toMatchObject({ name: "AbortError", message: "Codex reset credit cancelled" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
