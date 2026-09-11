/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { listModels } from "../agent/provider";
import { listOAuthModels } from "../agent/oauth";
import { initModelRegistry, refreshAllModels, getAllModels } from "./modelRegistry";

vi.mock("../agent/provider", () => ({ listModels: vi.fn() }));
vi.mock("../agent/oauth", () => ({
  onOAuthStatus: vi.fn(), isConnected: (kind: string) => kind === "codex", listOAuthModels: vi.fn(),
  OAUTH_LABEL: { codex: "Codex", "claude-code": "Claude Code", antigravity: "Antigravity" },
}));
vi.mock("./featureStore", () => ({ providerEnabled: (provider: { enabled?: boolean }) => provider.enabled !== false }));
vi.mock("../agent/semanticIndex", () => ({ setEmbedModel: vi.fn(), setRemoteEmbedModel: vi.fn(), EMBED_MODELS: [{ id: "minilm" }] }));

afterEach(() => vi.useRealTimers());

describe("production provider model registry", () => {
  it("retains colliding model IDs across API, custom API, and OAuth groups", async () => {
    vi.useFakeTimers();
    vi.mocked(listModels).mockResolvedValue([{ id: "shared-model" }, { id: "shared-model" }]);
    vi.mocked(listOAuthModels).mockResolvedValue(["shared-model", "shared-model"]);
    const optionsFor = vi.fn((_id: string, kind?: string) => [{ key: "reasoning_effort", label: "Effort", type: "select", value: kind }]);
    const featureStore = {
      get: () => ({ providers: [
        { id: "popular:openai", name: "OpenAI", kind: "openai", baseUrl: "https://api.example.test" },
        { id: "custom", name: "Custom", kind: "openai", baseUrl: "https://custom.example.test" },
        { id: "disabled", name: "Disabled", kind: "openai", baseUrl: "https://disabled.example.test", enabled: false },
      ], embedModel: "minilm" }),
      onDidChange: vi.fn(), nameFor: (id: string, kind: string) => `${kind}/${id}`, optionsFor,
    };
    initModelRegistry(featureStore as any, { getProviderKey: async () => "fixture-key" } as any);
    const result = await refreshAllModels();
    expect(result.modelList.map((model) => [model.providerId, model.id])).toEqual([
      ["popular:openai", "shared-model"], ["custom", "shared-model"], ["oauth:codex", "shared-model"],
    ]);
    expect(result.models).toEqual(["shared-model"]);
    expect(result.modelList.at(-1)).toMatchObject({ name: "codex/shared-model", options: [{ value: "codex" }] });
    expect(listModels).toHaveBeenCalledTimes(2);
    expect(listOAuthModels).toHaveBeenCalledOnce();
    expect(getAllModels()).toBe(result);
  });
});
