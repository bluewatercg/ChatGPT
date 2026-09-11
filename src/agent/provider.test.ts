/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

/**
 * Unit tests for provider utilities.
 * Runs via vitest in CI (no VS Code dependency).
 * Sensitive data (API keys, tokens) must NEVER appear here.
 */
import { afterEach, describe, it, expect, vi } from "vitest";
vi.mock("vscode", () => ({ workspace: {}, Uri: {}, EventEmitter: class { event = () => ({ dispose() {} }); fire() {} } }));
vi.mock("./oauth", () => ({ streamOAuthChat: vi.fn() }));
import { listModels } from "./provider";
import { kindMatches, PROVIDER_PRESETS } from "../stores/featureStore";

afterEach(() => vi.unstubAllGlobals());

describe("provider base URLs", () => {
  it.each([
    ["https://api.example.com/v1/", "https://api.example.com/v1/models"],
    ["https://api.example.com/v1///", "https://api.example.com/v1/models"],
    ["https://api.example.com/v1", "https://api.example.com/v1/models"],
    ["https://api.example.com/", "https://api.example.com/models"],
    ["https://a.com/b/c/", "https://a.com/b/c/models"],
  ])("normalizes %s at the actual HTTP boundary", async (base, expected) => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "fixture" }] })));
    vi.stubGlobal("fetch", fetch);
    expect(await listModels(base, "fixture-key", false)).toEqual([{ id: "fixture" }]);
    expect(fetch).toHaveBeenCalledWith(expected, { headers: { authorization: "Bearer fixture-key" } });
  });
});

// --- kindMatches ---

describe("kindMatches", () => {
  it("matches single kind", () => {
    expect(kindMatches("mimo", "mimo")).toBe(true);
    expect(kindMatches("mimo", "openai")).toBe(false);
  });

  it("matches array kind", () => {
    expect(kindMatches(["openai", "codex"], "openai")).toBe(true);
    expect(kindMatches(["openai", "codex"], "anthropic")).toBe(false);
  });
});

// --- Provider presets ---

describe("PROVIDER_PRESETS", () => {
  it("has all expected providers", () => {
    const expected = ["openai", "anthropic", "google", "openrouter", "ollama", "llamacpp", "mimo", "atlascloud", "astraflow"] as const;
    for (const key of expected) {
      expect(PROVIDER_PRESETS[key]).toBeDefined();
    }
  });

  it("every provider has a valid HTTPS or localhost URL", () => {
    for (const [, preset] of Object.entries(PROVIDER_PRESETS)) {
      expect(preset.baseUrl.startsWith("https://") || preset.baseUrl.startsWith("http://localhost")).toBe(true);
    }
  });

  it("every provider URL has a versioned API path", () => {
    for (const [key, preset] of Object.entries(PROVIDER_PRESETS)) {
      expect(preset.baseUrl).toMatch(/\/v\d/);
    }
  });

  it("no provider URL has trailing slash", () => {
    for (const [, preset] of Object.entries(PROVIDER_PRESETS)) {
      expect(preset.baseUrl.endsWith("/")).toBe(false);
    }
  });

  it("remote providers require API keys", () => {
    const noKeyNeeded = ["ollama", "llamacpp"];
    for (const [key, preset] of Object.entries(PROVIDER_PRESETS)) {
      if (noKeyNeeded.includes(key)) {
        expect(preset.needsKey).toBe(false);
      } else {
        expect(preset.needsKey).toBe(true);
      }
    }
  });
});

// --- Security: no sensitive data ---

describe("security", () => {
  it("provider presets contain no API keys or tokens", () => {
    for (const [, preset] of Object.entries(PROVIDER_PRESETS)) {
      expect(preset.baseUrl).not.toMatch(/^(sk-|tp-|vbk_)/);
      expect(preset.label).not.toMatch(/key|token|secret/i);
    }
  });
});
