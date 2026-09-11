/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { describe, expect, it } from "vitest";
import { applyOpenAIChatOptions } from "./openaiChat";

const endpoint = "https://api.openai.com/v1";
const sample = () => ({ max_tokens: 200, temperature: 0.3, top_p: 0.9, top_k: 12,
  logprobs: true, top_logprobs: 2, frequency_penalty: 0.2, presence_penalty: 0.1 });

describe("official OpenAI Chat Completions options", () => {
  it.each([
    "https://compatible.invalid/v1", "https://api.openai.com.evil.invalid/v1",
    "https://api.openai.com@evil.invalid/v1", "https://account@api.openai.com/v1",
    "https://api.openai.com:8443/v1", "http://api.openai.com/v1",
    "https://api.openai.com/v1?proxy=other", "https://api.openai.com/proxy/v1", "invalid URL",
  ])("does not impose provider-specific options on %s", (url) => {
    const body = sample();
    applyOpenAIChatOptions(body, url, "gpt-5.6-sol", { auxiliary: true });
    expect(body).toEqual(sample());
  });

  it.each(["gpt-4.1", "gpt-6-astra", "gpt-5.5-pro", "gpt-5.3-codex", "gpt-5.6-custom", "gpt-5.60"])(
    "leaves models outside this Chat contract unchanged: %s", (model) => {
      const body = sample();
      applyOpenAIChatOptions(body, endpoint, model, { auxiliary: true });
      expect(body).toEqual(sample());
    },
  );

  it("uses the current completion cap while preserving messages, tools and a smaller main-request budget", () => {
    const body: Record<string, unknown> = { ...sample(), max_tokens: 24, reasoning_effort: "high",
      messages: [{ role: "user", content: "Inspect this image." }], tools: [{ type: "function", function: { name: "Read" } }],
      stream: true, seed: 123, stop: ["END"] };
    const messages = body.messages;
    const tools = body.tools;
    applyOpenAIChatOptions(body, "https://API.OPENAI.COM:443/v1/", "gpt-5.6-sol-2026-08-01");
    expect(body).toEqual({ max_completion_tokens: 24, reasoning_effort: "high", messages, tools,
      stream: true, seed: 123, stop: ["END"] });
    expect(body.messages).toBe(messages);
    expect(body.tools).toBe(tools);
  });

  it("preserves an explicit current cap and leaves an unspecified cap unspecified", () => {
    const body: Record<string, unknown> = { max_tokens: 5000, max_completion_tokens: 1000 };
    applyOpenAIChatOptions(body, endpoint, "gpt-5.5");
    expect(body).toEqual({ max_completion_tokens: 1000 });
    const uncapped = {};
    applyOpenAIChatOptions(uncapped, endpoint, "gpt-5.6-luna");
    expect(uncapped).toEqual({});
  });

  it.each(["gpt-5.4", "gpt-5.4-mini"])("retains sampling at the documented default none effort for %s", (model) => {
    const body: Record<string, unknown> = sample();
    applyOpenAIChatOptions(body, endpoint, model);
    expect(body).toEqual({ max_completion_tokens: 200, temperature: 0.3, top_p: 0.9,
      logprobs: true, top_logprobs: 2, frequency_penalty: 0.2, presence_penalty: 0.1 });
  });

  it.each(["gpt-5.5", "gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"])(
    "uses default sampling with implicit medium reasoning for %s", (model) => {
      const body: Record<string, unknown> = sample();
      applyOpenAIChatOptions(body, endpoint, model);
      expect(body).toEqual({ max_completion_tokens: 200 });
    },
  );

  it.each(["gpt-5.4", "gpt-5.4-mini", "gpt-5.5", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"])(
    "keeps small title and judge output budgets usable for %s", (model) => {
      for (const max_tokens of [24, 200]) {
        const body: Record<string, unknown> = { max_tokens, temperature: 0, reasoning_effort: "high" };
        applyOpenAIChatOptions(body, endpoint, model, { auxiliary: true });
        expect(body).toEqual({ max_completion_tokens: max_tokens, temperature: 0, reasoning_effort: "none" });
      }
    },
  );

  it("preserves explicit none sampling on newer models and max only where supported", () => {
    const body: Record<string, unknown> = { temperature: 0.7, top_p: 0.6, reasoning_effort: "none" };
    applyOpenAIChatOptions(body, endpoint, "gpt-5.6-sol");
    expect(body).toEqual({ temperature: 0.7, top_p: 0.6, reasoning_effort: "none" });
    for (const [model, effort] of [["gpt-5.4", "xhigh"], ["gpt-5.5", "xhigh"], ["gpt-5.6-luna", "max"]]) {
      const request: Record<string, unknown> = { reasoning_effort: "max", temperature: 1 };
      applyOpenAIChatOptions(request, endpoint, model);
      expect(request).toEqual({ reasoning_effort: effort });
    }
  });

  it("omits automatic or unknown effort values and applies the provider's effective default", () => {
    for (const effort of ["auto", "default", "unsupported"]) {
      const request: Record<string, unknown> = { reasoning_effort: effort, temperature: 0.5 };
      applyOpenAIChatOptions(request, endpoint, "gpt-5.6-terra");
      expect(request).toEqual({});
    }
    const oldSelection: Record<string, unknown> = { reasoning_effort: "minimal", temperature: 0.5 };
    applyOpenAIChatOptions(oldSelection, endpoint, "gpt-5.5");
    expect(oldSelection).toEqual({ reasoning_effort: "none", temperature: 0.5 });
  });
});
