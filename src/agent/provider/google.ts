/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import type { ModelParams } from "./types";
import type { WireMessage, WireToolCall } from "../types";

/** Scope Google extensions to its own HTTPS API, never a lookalike/proxy URL. */
export function isGoogleOpenAIEndpoint(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return url.protocol === "https:" && url.hostname === "generativelanguage.googleapis.com"
      && !url.username && !url.password && (!url.port || url.port === "443");
  } catch { return false; }
}

// https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures#signatures-for-openai-compatibility
export function googleToolCall(call: WireToolCall): Record<string, unknown> {
  return {
    id: call.id, type: call.type, function: { ...call.function },
    ...(call.thoughtSignature ? { extra_content: { google: { thought_signature: call.thoughtSignature } } } : {}),
  };
}

export function googleThoughtSignature(call: unknown): string | undefined {
  if (!call || typeof call !== "object") return undefined;
  const signature = (call as { extra_content?: { google?: { thought_signature?: unknown } } }).extra_content?.google?.thought_signature;
  return typeof signature === "string" && signature ? signature : undefined;
}

/** Preserve observations from saved chats that predate signature persistence. */
export function prepareGoogleMessages(messages: WireMessage[], model: string): WireMessage[] {
  if (!/^gemini-[3-9](?:[.-]|$)/i.test(model)) return messages;
  const calls = new Map<string, { name: string; historical: boolean }>();
  return messages.map((message): WireMessage => {
    if (message.role === "assistant" && message.tool_calls?.length) {
      // A signed later sibling cannot substitute for the first call's signature.
      if (message.tool_calls[0].thoughtSignature) {
        for (const call of message.tool_calls) calls.set(call.id, { name: call.function.name, historical: false });
        return message;
      }
      const observations = message.tool_calls.map((call) => {
        calls.set(call.id, { name: call.function.name, historical: true });
        return `[Previously executed tool ${call.function.name}, call ${call.id}]\nArguments: ${call.function.arguments}`;
      });
      return { role: "assistant", content: [message.content, ...observations].filter(Boolean).join("\n\n") };
    }
    if (message.role === "tool" && calls.get(message.tool_call_id)?.historical !== false) {
      const header = `[Previous tool result ${calls.get(message.tool_call_id)?.name ?? "unknown"}, call ${message.tool_call_id}]`;
      return { role: "user", content: typeof message.content === "string" ? `${header}\n${message.content}`
        : [{ type: "text", text: header }, ...message.content] };
    }
    return message;
  });
}

/** Apply supported options after constructing the standard chat request. */
export function applyGoogleOpenAIOptions(body: Record<string, unknown>, model: string, params?: ModelParams): void {
  // https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/guides/gemini-3-8-flash
  // Sampling knobs are ignored on 3.8; penalties and multiple candidates fail.
  if (/^gemini-3\.8(?:-|$)/i.test(model)) {
    for (const key of ["temperature", "top_p", "top_k", "frequency_penalty", "presence_penalty", "candidate_count", "n"]) delete body[key];
  }
  if (!/^gemini-/i.test(model)) return;
  // https://ai.google.dev/gemini-api/docs/openai#thinking
  // https://ai.google.dev/gemini-api/docs/generate-content/thinking#thinking-levels-gemini-3
  const selected = params?.thinking === "disabled" ? "none" : body.reasoning_effort;
  if (typeof selected !== "string") return;
  let effort = selected.toLowerCase().trim();
  if (["auto", "default", ""].includes(effort)) { delete body.reasoning_effort; return; }
  if (["xhigh", "max"].includes(effort)) effort = "high";
  const newerFlash = /^gemini-3\.[78]-flash(?:-|$)/i.test(model);
  const pro = /^gemini-(?:3(?:\.\d+)?-pro|2\.5-pro)(?:-|$)/i.test(model);
  if (["none", "off", "disabled"].includes(effort)) {
    effort = newerFlash || pro ? "low" : /^gemini-[3-9](?:[.-]|$)/i.test(model) ? "minimal" : "none";
  }
  if (effort === "minimal" && (newerFlash || pro)) effort = "low";
  if (["none", "minimal", "low", "medium", "high"].includes(effort)) body.reasoning_effort = effort;
  else delete body.reasoning_effort;
}
