/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OAuthStatus } from "../agent/oauth/types";

const fixture = vi.hoisted(() => ({
  status: { accounts: [], errors: {}, balanceStrategy: "first" } as OAuthStatus,
  receive: undefined as ((message: Record<string, unknown>) => Promise<void>) | undefined,
  onStatus: undefined as ((status: OAuthStatus) => void) | undefined,
  postMessage: vi.fn(),
  writeText: vi.fn(async (_text: string) => {}),
  login: vi.fn(async (_kind: string) => {}),
  reopen: vi.fn(async (_kind: string) => {}),
  manual: vi.fn(async (_kind: string, _url: string) => {}),
  cancel: vi.fn(),
  usage: {} as Record<string, unknown>,
  onUsage: undefined as ((usage: Record<string, unknown>) => void) | undefined,
  flushUsage: vi.fn(async () => {}),
  resetUsage: vi.fn(async () => {}),
  confirm: vi.fn(async (): Promise<string | undefined> => undefined),
  limits: vi.fn(async (_id: string, _signal?: AbortSignal) => ({ limits: [{ label: "Session", remaining: 75, limit: 100 }], resetCredits: 1 })),
  resetQuota: vi.fn(async (_id: string, _signal?: AbortSignal) => ({ ok: true })),
}));

vi.mock("vscode", () => ({
  ViewColumn: { One: 1 },
  Uri: { joinPath: () => "icon" },
  env: { clipboard: { writeText: fixture.writeText } },
  window: { showWarningMessage: fixture.confirm, createWebviewPanel: () => ({
    webview: { html: "", postMessage: fixture.postMessage, onDidReceiveMessage: (callback: typeof fixture.receive) => { fixture.receive = callback; return { dispose() {} }; } },
    onDidDispose: () => ({ dispose() {} }), dispose() {}, reveal() {},
  }) },
}));
vi.mock("../agent/oauth", () => ({
  login: fixture.login, openLoginInBrowser: fixture.reopen, completeManual: fixture.manual, cancelLogin: fixture.cancel,
  getStatus: () => fixture.status,
  getAccountLimits: fixture.limits, consumeCodexResetCredit: fixture.resetQuota,
  onOAuthStatus: (callback: typeof fixture.onStatus) => { fixture.onStatus = callback; return { dispose() {} }; },
}));
vi.mock("../stores/settingsManager", () => ({ DEFAULT_SETTINGS: {} }));
vi.mock("../agent/provider", () => ({ listModels: vi.fn() }));
vi.mock("./webviewHtml", () => ({ renderWebviewHtml: () => "<html></html>" }));
vi.mock("../stores/featureStore", () => ({ MODEL_CATALOG: [] }));
vi.mock("../context/workspaceContext", () => ({ listRules: vi.fn(), listSkills: vi.fn() }));
vi.mock("../integrations/mcpClient", () => ({ mcpManager: {} }));
vi.mock("../agent/personas", () => ({ BUILTIN_PERSONAS: [] }));
vi.mock("../agent/semanticIndex", () => ({ onIndexStatus: () => () => {} }));
vi.mock("../agent/docsIndex", () => ({ onDocsStatus: () => () => {} }));
vi.mock("../context/workspaceUtils", () => ({ getWorkspaceRoot: vi.fn() }));
vi.mock("../agent/llamacpp", () => ({ onLlamacppStatus: () => ({ dispose() {} }) }));
vi.mock("../agent/ollama", () => ({ onOllamaStatus: () => ({ dispose() {} }) }));
vi.mock("../stores/usageStore", () => ({
  getUsage: () => fixture.usage, resetUsage: fixture.resetUsage, flushUsage: fixture.flushUsage,
  onUsageChanged: (listener: typeof fixture.onUsage) => {
    fixture.onUsage = listener;
    return () => { fixture.onUsage = undefined; };
  },
}));
vi.mock("../integrations/externalHooks", () => ({}));
vi.mock("../stores/modelRegistry", () => ({ onAllModels: () => () => {} }));

import { SettingsPanel } from "./settingsPanel";

const authorizationUrl = "https://auth.openai.com/oauth/authorize?state=fixture&code_challenge=public-challenge";
beforeEach(() => {
  vi.clearAllMocks();
  fixture.usage = { model: { promptTokens: 50, completionTokens: 5, requests: 1, lastUsed: 1 } };
  fixture.flushUsage.mockImplementation(async () => {});
  fixture.resetUsage.mockImplementation(async () => { fixture.usage = {}; });
  fixture.confirm.mockResolvedValue(undefined);
  fixture.status = { accounts: [], errors: {}, balanceStrategy: "first", pending: "codex", authorizationUrl };
  SettingsPanel.createOrShow({ extensionUri: "extension" } as any, {} as any, {} as any);
});
afterEach(() => { SettingsPanel.currentPanel?.dispose(); });

describe("settings host OAuth message handling", () => {
  it("dispatches Codex Add Account, browser retry, and cancellation through the real webview listener", async () => {
    await fixture.receive!({ type: "oauthLogin", kind: "codex" });
    await fixture.receive!({ type: "oauthOpenLogin", kind: "codex" });
    await fixture.receive!({ type: "oauthCancel", kind: "codex" });
    expect(fixture.login).toHaveBeenCalledWith("codex");
    expect(fixture.reopen).toHaveBeenCalledWith("codex");
    expect(fixture.cancel).toHaveBeenCalledWith("codex");
  });

  it("forwards the current authorization URL when status is requested or pushed", async () => {
    await fixture.receive!({ type: "oauthGet" });
    fixture.onStatus!(fixture.status);
    expect(fixture.postMessage.mock.calls).toEqual([
      [{ type: "oauthStatus", status: fixture.status }],
      [{ type: "oauthStatus", status: fixture.status }],
    ]);
  });

  it("copies only the active host URL and acknowledges its identity", async () => {
    await fixture.receive!({ type: "oauthCopyLogin", kind: "codex", url: "https://untrusted.invalid" });
    expect(fixture.writeText).toHaveBeenCalledWith(authorizationUrl);
    expect(fixture.postMessage).toHaveBeenCalledWith({ type: "oauthLinkCopied", kind: "codex", authorizationUrl });
    await fixture.receive!({ type: "oauthCopyLogin", kind: "claude-code" });
    expect(fixture.writeText).toHaveBeenCalledTimes(1);
    fixture.status = { accounts: [], errors: {}, balanceStrategy: "first" };
    await fixture.receive!({ type: "oauthCopyLogin", kind: "codex" });
    expect(fixture.writeText).toHaveBeenCalledTimes(1);
  });

  it.each(["oauthLogin", "oauthOpenLogin", "oauthManualCallback", "oauthCopyLogin"])("surfaces %s failures while retaining the current manual-login fallback", async (type) => {
    const failure = new Error("Fixture operation failed");
    if (type === "oauthLogin") fixture.login.mockRejectedValueOnce(failure);
    if (type === "oauthOpenLogin") fixture.reopen.mockRejectedValueOnce(failure);
    if (type === "oauthManualCallback") fixture.manual.mockRejectedValueOnce(failure);
    if (type === "oauthCopyLogin") fixture.writeText.mockRejectedValueOnce(failure);
    await fixture.receive!({ type, kind: "codex", url: "http://localhost:1455/auth/callback?code=fixture" });
    await Promise.resolve();
    expect(fixture.postMessage).toHaveBeenCalledWith({ type: "oauthStatus", status: {
      ...fixture.status, errors: { codex: "Fixture operation failed" },
    } });
  });

  it.each([false, true])("ignores a cancelled manual exchange's late error after restart=%s", async (restart) => {
    let rejectExchange!: (error: Error) => void;
    fixture.manual.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectExchange = reject; }));
    const exchange = fixture.receive!({ type: "oauthManualCallback", kind: "codex", url: "http://localhost:1455/auth/callback?code=old" });
    await fixture.receive!({ type: "oauthCancel", kind: "codex" });
    fixture.status = { accounts: [], errors: {}, balanceStrategy: "first" };
    if (restart) {
      await fixture.receive!({ type: "oauthLogin", kind: "codex" });
      fixture.status = { ...fixture.status, pending: "codex", authorizationUrl: `${authorizationUrl}&attempt=new` };
    }
    fixture.onStatus!(fixture.status);
    fixture.postMessage.mockClear();
    rejectExchange(new Error("Old exchange was cancelled"));
    await exchange;
    expect(fixture.postMessage).not.toHaveBeenCalled();
    expect(fixture.status.errors).toEqual({});
  });

  it("surfaces a backend-recorded manual error after the failed attempt has cleared its URL", async () => {
    fixture.manual.mockImplementationOnce(async () => {
      fixture.status = { accounts: [], errors: { codex: "Token exchange failed" }, balanceStrategy: "first" };
      throw new Error("Token exchange failed");
    });
    await fixture.receive!({ type: "oauthManualCallback", kind: "codex", url: "code" });
    expect(fixture.postMessage).toHaveBeenCalledWith({ type: "oauthStatus", status: fixture.status });
  });

  it("still surfaces manual submission when no login was active", async () => {
    fixture.status = { accounts: [], errors: {}, balanceStrategy: "first" };
    fixture.manual.mockRejectedValueOnce(new Error("No login in progress"));
    await fixture.receive!({ type: "oauthManualCallback", kind: "codex", url: "code" });
    expect(fixture.postMessage).toHaveBeenCalledWith({ type: "oauthStatus", status: {
      ...fixture.status, errors: { codex: "No login in progress" },
    } });
  });
});


describe("Usage & Quota host actions", () => {
  it("waits for pending usage writes before refreshing and acknowledges the clicked request", async () => {
    let commit!: () => void;
    fixture.flushUsage.mockImplementationOnce(() => new Promise<void>(resolve => { commit = resolve; }));
    const refreshing = fixture.receive!({ type: "getUsage", requestId: "refresh-1" });
    expect(fixture.postMessage).not.toHaveBeenCalled();
    fixture.usage = { fresh: { promptTokens: 75 } };
    commit(); await refreshing;
    expect(fixture.postMessage).toHaveBeenCalledWith({ type: "usageData", usage: fixture.usage });
    expect(fixture.postMessage).toHaveBeenCalledWith({ type: "usageActionResult", requestId: "refresh-1", action: "refresh", status: "success" });
  });

  it.each([true, false])("resets only after native confirmation (confirm=%s)", async confirm => {
    const prior = fixture.usage;
    fixture.confirm.mockResolvedValueOnce(confirm ? "Reset Usage" : undefined);
    await fixture.receive!({ type: "resetUsage", requestId: "reset-1" });
    expect(fixture.confirm).toHaveBeenCalledWith("Reset all recorded token usage?", expect.objectContaining({ modal: true }), "Reset Usage");
    expect(fixture.resetUsage).toHaveBeenCalledTimes(confirm ? 1 : 0);
    expect(fixture.usage).toEqual(confirm ? {} : prior);
    expect(fixture.postMessage).toHaveBeenCalledWith({ type: "usageActionResult", requestId: "reset-1", action: "reset", status: confirm ? "success" : "cancelled" });
    expect(fixture.resetQuota).not.toHaveBeenCalled();
  });

  it.each(["getUsage", "resetUsage"])("returns a visible %s failure without replacing saved usage", async type => {
    const prior = fixture.usage;
    const error = new Error("Storage unavailable");
    if (type === "getUsage") fixture.flushUsage.mockRejectedValueOnce(error);
    else { fixture.confirm.mockResolvedValueOnce("Reset Usage"); fixture.resetUsage.mockRejectedValueOnce(error); }
    await fixture.receive!({ type, requestId: "failed" });
    expect(fixture.usage).toBe(prior);
    expect(fixture.postMessage).toHaveBeenCalledWith({ type: "usageActionResult", requestId: "failed", action: type === "getUsage" ? "refresh" : "reset", status: "error", error: "Storage unavailable" });
    expect(fixture.postMessage.mock.calls.some(([message]) => message.type === "usageData")).toBe(false);
  });

  it("does not open duplicate confirmation dialogs or reset usage twice", async () => {
    let confirm!: (value: string) => void;
    fixture.confirm.mockImplementationOnce(() => new Promise(resolve => { confirm = resolve; }));
    const first = fixture.receive!({ type: "resetUsage", requestId: "first" });
    await fixture.receive!({ type: "resetUsage", requestId: "duplicate" });
    expect(fixture.confirm).toHaveBeenCalledOnce();
    expect(fixture.postMessage).toHaveBeenCalledWith(expect.objectContaining({ requestId: "duplicate", status: "error" }));
    confirm("Reset Usage"); await first;
    expect(fixture.resetUsage).toHaveBeenCalledOnce();
  });

  it("pushes committed usage changes and unsubscribes when settings close", () => {
    const usage = { live: { promptTokens: 150 } };
    fixture.onUsage!(usage);
    expect(fixture.postMessage).toHaveBeenCalledWith({ type: "usageData", usage });
    SettingsPanel.currentPanel!.dispose();
    expect(fixture.onUsage).toBeUndefined();
  });

  it("coalesces account reads and correlates both replies", async () => {
    let finish!: (value: Awaited<ReturnType<typeof fixture.limits>>) => void;
    fixture.limits.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const first = fixture.receive!({ type: "oauthLimits", id: "account", requestId: "first" });
    const second = fixture.receive!({ type: "oauthLimits", id: "account", requestId: "second" });
    expect(fixture.limits).toHaveBeenCalledOnce();
    finish({ limits: [], resetCredits: 3 }); await Promise.all([first, second]);
    for (const requestId of ["first", "second"]) expect(fixture.postMessage).toHaveBeenCalledWith({ type: "oauthLimits", id: "account", requestId, limits: [], resetCredits: 3 });
  });

  it("settles credit-reset failures and refreshes quota instead of leaving Resetting stuck", async () => {
    fixture.resetQuota.mockRejectedValueOnce(new Error("Request timed out; refresh limits before retrying"));
    await fixture.receive!({ type: "oauthResetCredit", id: "account", requestId: "credit-reset" });
    expect(fixture.postMessage).toHaveBeenCalledWith({ type: "oauthResetResult", id: "account", requestId: "credit-reset", ok: false, message: "Request timed out; refresh limits before retrying" });
    expect(fixture.limits).toHaveBeenCalledWith("account", expect.any(AbortSignal));
  });

  it("returns quota read errors without erasing the previous limits", async () => {
    fixture.limits.mockRejectedValueOnce(new Error("Quota endpoint unavailable"));
    await fixture.receive!({ type: "oauthLimits", id: "account", requestId: "limits" });
    expect(fixture.postMessage).toHaveBeenCalledWith({ type: "oauthLimits", id: "account", requestId: "limits", error: "Quota endpoint unavailable" });
  });

  it("prevents duplicate credit consumption and aborts pending reads when disposed", async () => {
    let finish!: (value: { ok: boolean }) => void;
    fixture.resetQuota.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const reset = fixture.receive!({ type: "oauthResetCredit", id: "account", requestId: "reset" });
    await fixture.receive!({ type: "oauthResetCredit", id: "account", requestId: "duplicate" });
    expect(fixture.resetQuota).toHaveBeenCalledOnce();
    expect(fixture.postMessage).toHaveBeenCalledWith(expect.objectContaining({ requestId: "duplicate", ok: false }));
    expect(fixture.postMessage).toHaveBeenCalledWith({ type: "oauthLimits", requestId: "duplicate", id: "account", limits: [{ label: "Session", remaining: 75, limit: 100 }], resetCredits: 1 });
    const signal = fixture.resetQuota.mock.calls[0][1]!;
    SettingsPanel.currentPanel!.dispose();
    expect(signal.aborted).toBe(true);
    finish({ ok: false }); await reset;
  });
});
