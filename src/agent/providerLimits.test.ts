/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { describe, expect, it } from "vitest";
import { defaultAnthropicMaxTokens, responseTokenReservation } from "./providerLimits";

describe("response token reservation", () => {
  it.each([
    ["claude-haiku-4-5", undefined, 8192],
    ["claude-opus-4-5", "max", 8192],
    ["claude-sonnet-4-6", undefined, 32768],
    ["claude-opus-4-8", "medium", 32768],
    ["claude-opus-5", "xhigh", 65536],
    ["claude-fable-5", "max", 65536],
    ["claude-mythos", undefined, 32768],
  ])("reserves the Anthropic request default for %s at %s effort", (model, effort, expected) => {
    expect(defaultAnthropicMaxTokens(model!, effort as string | undefined)).toBe(expected);
    const options = { model: model!, modelParams: { reasoningEffort: effort as string | undefined } };
    expect(responseTokenReservation({ ...options, anthropic: true })).toBe(expected);
    expect(responseTokenReservation({ ...options, oauthKind: "claude-code" })).toBe(expected);
  });

  it("honors an explicit positive limit before the Anthropic auto default", () => {
    expect(responseTokenReservation({ model: "claude-opus-5", anthropic: true, maxTokens: 4096 })).toBe(4096);
    expect(responseTokenReservation({ model: "claude-opus-5", anthropic: true, maxTokens: 0 })).toBe(32768);
  });

  it("matches provider routing when the transport is inferred or explicitly overridden", () => {
    expect(responseTokenReservation({ model: "claude-opus-5", apiBaseUrl: "https://api.anthropic.com/v1" })).toBe(32768);
    expect(responseTokenReservation({ model: "claude-opus-5", apiBaseUrl: "https://api.anthropic.com/v1", anthropic: false })).toBe(4096);
    expect(responseTokenReservation({ model: "claude-opus-5", anthropic: true, oauthKind: "codex" })).toBe(4096);
    expect(responseTokenReservation({ model: "claude-opus-5", anthropic: true, oauthKind: "antigravity" })).toBe(8192);
  });

  it("reserves the Antigravity default and applies its transport ceiling", () => {
    expect(responseTokenReservation({ model: "gemini-pro", oauthKind: "antigravity" })).toBe(8192);
    expect(responseTokenReservation({ model: "gemini-pro", oauthKind: "antigravity", maxTokens: 1536 })).toBe(1536);
    expect(responseTokenReservation({ model: "gemini-pro", oauthKind: "antigravity", maxTokens: 100000 })).toBe(64000);
  });

  it("uses configured output headroom for compatible endpoints and a fallback for server defaults", () => {
    expect(responseTokenReservation({ model: "local-model", maxTokens: 20000 })).toBe(20000);
    expect(responseTokenReservation({ model: "local-model", maxTokens: 0 })).toBe(4096);
    expect(responseTokenReservation({ model: "gpt-5.6", oauthKind: "codex" })).toBe(4096);
  });
});
