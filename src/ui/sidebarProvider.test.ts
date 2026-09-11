/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarProvider } from "./sidebarProvider";
import { ConversationStore } from "../stores/conversationStore";
import { runAgent } from "../agent/loop";
import { generateTitle } from "../agent/provider";
import { recordUsage } from "../stores/usageStore";
import { DEFAULT_APPROVAL } from "../agent/approvalPolicy";
import { MODEL_CATALOG, type ModelDef } from "../stores/featureStore";

vi.mock("vscode", () => ({ window: { showWarningMessage: vi.fn(), showErrorMessage: vi.fn(), state: { focused: true } } }));
vi.mock("../agent/loop", () => ({ runAgent: vi.fn() }));
vi.mock("../agent/provider", () => ({ generateTitle: vi.fn(), listModels: vi.fn() }));
vi.mock("../stores/featureStore", () => ({ MODEL_CATALOG: [], optionsToParams: () => ({}), kindMatches: (a: string, b: string) => a === b, providerEnabled: (p: any) => p.enabled !== false }));
vi.mock("../agent/llamacpp", () => ({ ensureLoaded: vi.fn(), serverUrlFor: () => "http://local" }));
vi.mock("../agent/ollama", () => ({ ollamaOpenAIBase: () => "http://ollama" }));
vi.mock("../agent/oauth", () => ({}));
vi.mock("../stores/usageStore", () => ({ recordUsage: vi.fn() }));
vi.mock("../integrations/hooksRunner", () => ({ runHooks: vi.fn(), runBlockingHooks: vi.fn(async () => undefined) }));
vi.mock("../context/workspaceUtils", () => ({ getWorkspaceRoot: () => "/workspace", safePath: (p: string) => p }));
vi.mock("../agent/personas", () => ({}));
vi.mock("../stores/pendingChanges", () => ({ pendingChanges: { rejectAll: vi.fn() } }));
vi.mock("./fileIcons", () => ({}));
vi.mock("../context/mentions", () => ({ resolveMentions: vi.fn() }));
vi.mock("../logging", () => ({ getLog: () => ({ appendLine: vi.fn() }), logError: vi.fn() }));

function memento() {
  const values = new Map<string, any>();
  return {
    get: (key: string, fallback?: any) => values.has(key) ? structuredClone(values.get(key)) : fallback,
    update: async (key: string, value: any) => {
      if (value === undefined) values.delete(key);
      else values.set(key, structuredClone(value));
    },
  };
}
async function fixture() {
  const context = { globalState: memento(), workspaceState: memento() };
  const store = new ConversationStore(context as any);
  const a = await store.create(), b = await store.create();
  const features = { providers: [{ id: "api", kind: "anthropic", enabled: true, baseUrl: "https://api.example.test" }], llamacppModels: [], autoGenerateTitles: false, hooks: [], subagents: [], approvalPolicy: { ...DEFAULT_APPROVAL, shell: { mode: "ask", allowlist: [], denylist: [] } }, maxAgentSteps: 10 };
  const host = new SidebarProvider(context as any, { getSettings: () => ({ model: "api::model", maxResponseLength: 0 }), getProviderKey: async () => "test-key" } as any, { get: () => features, allModels: () => [], optionsFor: () => [] } as any) as any;
  host._activeId = b.id;
  host._view = { webview: { postMessage: vi.fn() } };
  host._sendConversations = vi.fn();
  host._personaPromptFor = () => "test prompt";
  host._contextTokensFor = () => 8000;
  host._modelsForProvider = () => [];
  host.featureStore.optionsFor = () => [];
  return { host, store, a, b, features };
}
function session() {
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => { resolveDone = resolve; });
  return { abort: new AbortController(), pendingApprovals: new Map(), pendingQuestions: new Map(), subagentAborts: new Map(), turns: [], history: [], contextState: {}, done, resolveDone };
}

beforeEach(() => {
  vi.clearAllMocks();
  MODEL_CATALOG.length = 0;
});

describe("production sidebar session lifecycle", () => {
  it("saves live tool history and waits for Stop cleanup before sending a follow-up", async () => {
    const { host, a, store } = await fixture();
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const cleanup = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(runAgent).mockImplementationOnce(async (opts) => {
      opts.history.push(
        { kind: "user", text: opts.prompt },
        { kind: "assistant", text: "Found the failing branch", calls: [{ id: "read", name: "Read", arguments: '{"path":"src/issue.ts"}' }] },
        { kind: "tool-result", callId: "read", name: "Read", status: "completed", output: "The exact source already inspected" },
      );
      opts.contextState!.todos = [{ id: "fix", content: "Fix the failing branch", status: "in_progress" }];
      opts.emit({ type: "tool-call-completed", callId: "read", name: "Read", status: "completed", result: "The exact source already inspected" });
      host._persistTurnsNow(a.id, host._sessions.get(a.id));
      entered();
      await new Promise<void>((resolve) => opts.signal.addEventListener("abort", () => resolve(), { once: true }));
      await cleanup;
      opts.history.push({ kind: "assistant", text: "Interrupted while preparing the fix", calls: [] });
    });
    const running = host._handleMessage("Fix this issue", undefined, { convId: a.id });
    await started;
    // A persisted snapshot must contain model history before runAgent returns.
    expect(store.get(a.id)?.steps.at(-1)).toMatchObject({ kind: "tool-result", output: "The exact source already inspected" });
    expect(store.get(a.id)?.contextState?.todos?.[0].id).toBe("fix");
    host._cancelSession(a.id);
    const followup = host._handleMessage("Continue", undefined, { convId: a.id });
    expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([running, followup]);
    const resumed = vi.mocked(runAgent).mock.calls[1][0];
    expect(resumed.history).toEqual(store.get(a.id)?.steps);
    expect(resumed.history).toContainEqual(expect.objectContaining({ kind: "tool-result", output: "The exact source already inspected" }));
    expect(resumed.history.at(-1)).toMatchObject({ text: "Interrupted while preparing the fix" });
    expect(resumed.contextState?.todos?.[0].id).toBe("fix");
  });

  it("Stop resolves pending approval and remains idempotent", async () => {
    const { host, a } = await fixture();
    const s = session();
    host._sessions.set(a.id, s);
    const pending = host._approveTool(a.id, s, "Shell", { command: "npm test" }, "shell-1");
    expect(s.pendingApprovals.size).toBe(1);
    host._cancelSession(a.id);
    host._cancelSession(a.id);
    expect(await pending).toBe(false);
    expect(s.pendingApprovals.size).toBe(0);
    expect(s.abort.signal.aborted).toBe(true);
  });

  it("settles an approval requested after the signal was already aborted", async () => {
    const { host, a } = await fixture();
    const s = session();
    s.abort.abort();
    expect(await host._approveTool(a.id, s, "Shell", { command: "npm test" }, "shell-1")).toBe(false);
  });

  it("routes explicit background sends with their original mode/model", async () => {
    const { host, a, b, store } = await fixture();
    host._resolveProviderForModel = vi.fn(async (id: string) => ({ baseUrl: "https://api.example.test", apiKey: "test", model: id, anthropic: false }));
    await host._handleMessage("queued for A", undefined, { convId: a.id, model: "queued-model", mode: "ask" });
    const opts = vi.mocked(runAgent).mock.calls[0][0];
    expect(opts).toMatchObject({ prompt: "queued for A", model: "queued-model", mode: "ask", promptCacheKey: a.id });
    expect(store.get(a.id)?.turns[0]).toMatchObject({ text: "queued for A", model: "queued-model", mode: "ask" });
    expect(store.get(b.id)?.turns).toEqual([]);
    expect(host._activeId).toBe(b.id);
  });

  it("deleting a live conversation waits for cancellation and final cleanup", async () => {
    const { host, a, store } = await fixture();
    let release!: () => void;
    const cleanup = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    vi.mocked(runAgent).mockImplementationOnce(async (opts) => {
      entered();
      await new Promise<void>((resolve) => opts.signal.addEventListener("abort", () => resolve(), { once: true }));
      await cleanup;
    });
    const running = host._handleMessage("work", undefined, { convId: a.id });
    await started;
    const deleting = host._deleteConversation(a.id);
    expect(host._sessions.get(a.id).abort.signal.aborted).toBe(true);
    expect(store.get(a.id)).toBeDefined();
    release();
    await Promise.all([running, deleting]);
    expect(store.get(a.id)).toBeUndefined();
    expect(host._sessions.has(a.id)).toBe(false);
  });

  it("records title usage and cancels a pending title when its completed chat is deleted", async () => {
    const { host, a, features } = await fixture();
    features.autoGenerateTitles = true;
    let titleSignal!: AbortSignal;
    vi.mocked(generateTitle).mockImplementationOnce(async (...args: any[]) => {
      const options = args[6];
      titleSignal = options.signal;
      options.onUsage({ type: "usage", promptTokens: 11, completionTokens: 3, requestId: "title-request", model: "title-model" });
      await new Promise<void>((resolve) => titleSignal.addEventListener("abort", () => resolve(), { once: true }));
      return "Fixture title";
    });
    await host._handleMessage("work", undefined, { convId: a.id });
    expect(vi.mocked(recordUsage)).toHaveBeenCalledWith("title-model", 11, 3, expect.objectContaining({ requestId: "title-request" }));
    expect(host._sessions.has(a.id)).toBe(false);
    expect(titleSignal.aborted).toBe(false);
    await host._deleteConversation(a.id);
    expect(titleSignal.aborted).toBe(true);
  });

  it("stores nested question answers in the authoritative snapshot", async () => {
    const { host, a, store } = await fixture();
    const s = session() as any;
    s.turns = [{ role: "assistant", blocks: [{ kind: "tool", callId: "task", name: "Task", status: "running", input: {}, subBlocks: [{ kind: "tool", callId: "q", name: "AskQuestion", status: "running", input: {} }] }] }];
    const answer = host._askUser(s, "q", s.abort.signal);
    host._sessions.set(a.id, s);
    host._answerQuestion("q", { "0": ["Keep main"] });
    expect(await answer).toEqual({ "0": ["Keep main"] });
    expect((store.get(a.id)!.turns[0] as any).blocks[0].subBlocks[0].answers).toEqual({ "0": ["Keep main"] });
  });
});

describe("production scoped provider routing", () => {
  it("explicit API scope wins over OAuth and local model collisions", async () => {
    const { host, features } = await fixture();
    host._oauthModelKind.set("claude", "claude-code");
    host._ollamaModelIds.add("claude");
    features.llamacppModels.push({ id: "claude" } as never);
    expect(await host._resolveProviderForModel("api::claude")).toMatchObject({ providerId: "api", apiKey: "test-key", baseUrl: "https://api.example.test", model: "claude" });
    expect((await host._resolveProviderForModel("claude")).oauthKind).toBe("claude-code");
  });
  it("keeps the explicit API endpoint through run startup despite a local model collision", async () => {
    const { host, features, a } = await fixture();
    features.llamacppModels.push({ id: "model" } as never);
    await host._handleMessage("use API", undefined, { convId: a.id, model: "api::model" });
    expect(vi.mocked(runAgent).mock.calls[0][0]).toMatchObject({ apiBaseUrl: "https://api.example.test", apiKey: "test-key", model: "model" });
  });
  it("does not silently substitute another provider when the chosen one is disabled", async () => {
    const { host, features } = await fixture();
    features.providers[0].enabled = false;
    await expect(host._resolveProviderForModel("api::claude")).rejects.toThrow("unavailable or disabled");
  });
});

describe("production catalog update visibility", () => {
  async function modelsFixture(disabledModels: string[] = []) {
    const { host, features } = await fixture();
    const catalog: ModelDef[] = [
      { id: "old-model", name: "Old model", kind: "anthropic" },
      { id: "new-model", name: "New model", kind: "anthropic" },
      { id: "optional-model", name: "Optional model", kind: "anthropic", enabled: false },
    ];
    MODEL_CATALOG.push(...catalog);
    Object.assign(features, {
      providers: [{ id: "popular:anthropic", name: "Anthropic", kind: "anthropic", enabled: true, baseUrl: "https://api.example.test" }],
      enabledModels: ["old-model"], disabledModels, disabledLocalModels: [],
    });
    host.featureStore.allModels = () => catalog;
    host.featureStore.nameFor = (id: string) => id;
    return host;
  }

  it("shows newly shipped catalog defaults with an old saved allowlist before provider discovery", async () => {
    const host = await modelsFixture();
    expect(host._buildModelList([]).map((model: ModelDef) => model.id)).toEqual([
      "popular:anthropic::old-model", "popular:anthropic::new-model",
    ]);
  });

  it("preserves explicit user opt-outs even when the model is a new default or fetched", async () => {
    const host = await modelsFixture(["new-model"]);
    expect(host._buildModelList([{ providerId: "popular:anthropic", ids: ["old-model", "new-model", "uncurated-model"] }]).map((model: ModelDef) => model.id)).toEqual([
      "popular:anthropic::old-model",
    ]);
  });
});
