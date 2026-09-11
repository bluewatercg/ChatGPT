/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

const CHAT_MODEL = /^gpt-5\.(?:4(?:-mini)?|5|6(?:-sol|-terra|-luna)?)(?:-\d{4}-\d{2}-\d{2})?$/;

function isOfficialEndpoint(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return url.origin === "https://api.openai.com" && !url.username && !url.password
      && /^\/(?:v1\/?)?$/.test(url.pathname) && !url.search && !url.hash;
  } catch { return false; }
}

/** Apply the official API contract after generic Chat Completions parameters.
 * Other servers and models retain their own compatibility behavior. Pro and
 * Codex variants that require Responses are deliberately outside this helper.
 */
export function applyOpenAIChatOptions(
  body: Record<string, unknown>, apiBaseUrl: string, model: string,
  options: { auxiliary?: boolean } = {},
): void {
  if (!isOfficialEndpoint(apiBaseUrl) || !CHAT_MODEL.test(model)) return;

  // The current cap includes visible output and reasoning tokens; never raise a
  // user's main-request limit while translating the deprecated parameter.
  // https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create
  if (body.max_tokens !== undefined) {
    if (body.max_completion_tokens === undefined) body.max_completion_tokens = body.max_tokens;
    delete body.max_tokens;
  }
  // top_k is an extension of some compatible servers, absent from this API.
  delete body.top_k;

  const is56 = model.startsWith("gpt-5.6");
  const defaultEffort = model.startsWith("gpt-5.4") ? "none" : "medium";
  let selected = typeof body.reasoning_effort === "string" ? body.reasoning_effort.trim().toLowerCase() : undefined;
  if (selected === "minimal") selected = "none";
  if (selected === "max" && !is56) selected = "xhigh";
  const supported = ["none", "low", "medium", "high", "xhigh", ...(is56 ? ["max"] : [])];
  if (!selected || !supported.includes(selected)) selected = undefined;

  // Every model scoped above supports none. Tiny title/judge caps would otherwise
  // be consumed by reasoning, since 5.5 and 5.6 default to medium.
  // https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.5
  // https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.6
  if (options.auxiliary) selected = "none";
  if (selected) body.reasoning_effort = selected;
  else delete body.reasoning_effort;

  // 5.4 documents temperature/top_p/logprobs as supported only with none.
  // Conservatively retain default sampling for reasoning-enabled 5.5/5.6 as
  // well: their current guides do not document these sampling combinations.
  // https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.4
  if ((selected ?? defaultEffort) !== "none") {
    for (const key of ["temperature", "top_p", "logprobs", "top_logprobs", "frequency_penalty", "presence_penalty"]) delete body[key];
  }
}
