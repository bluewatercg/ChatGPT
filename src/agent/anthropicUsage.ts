/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

const INPUT_FIELDS = ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"] as const;

export interface AnthropicUsageDelta {
  type: "usage";
  /** Newly accounted tokens; safe for the usage store to accumulate. */
  promptTokens?: number;
  completionTokens?: number;
  /** Cumulative request occupancy, including cached input. */
  promptTokensTotal?: number;
  completionTokensTotal?: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
  cacheReadInputTokens?: number;
}

/**
 * Anthropic sends initial usage on message_start and cumulative, potentially
 * partial updates on message_delta. Cache reads/writes are disjoint input
 * buckets. Keep their totals for fitting while accounting each token once.
 */
export class AnthropicUsageTracker {
  private readonly input: Partial<Record<typeof INPUT_FIELDS[number], number>> = {};
  private promptTotal: number | undefined;
  private completionTotal: number | undefined;
  private classifiedInput = 0;

  update(value: unknown): AnthropicUsageDelta | undefined {
    if (!value || typeof value !== "object") return undefined;
    const usage = value as Record<string, unknown>;
    const valid = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
    const previousRead = this.input.cache_read_input_tokens ?? 0;
    const previousWrite = this.input.cache_creation_input_tokens ?? 0;
    const firstRead = this.input.cache_read_input_tokens === undefined && valid(usage.cache_read_input_tokens);
    const firstWrite = this.input.cache_creation_input_tokens === undefined && valid(usage.cache_creation_input_tokens);
    let hasInput = false;
    for (const key of INPUT_FIELDS) {
      const count = usage[key];
      if (!valid(count)) continue;
      this.input[key] = Math.max(this.input[key] ?? 0, count);
      hasInput = true;
    }
    const event: AnthropicUsageDelta = { type: "usage" };
    const reads = (this.input.cache_read_input_tokens ?? 0) - previousRead;
    const writes = (this.input.cache_creation_input_tokens ?? 0) - previousWrite;
    if (reads > 0 || firstRead) event.cachedReadTokens = reads;
    if (writes > 0 || firstWrite) event.cachedWriteTokens = writes;
    if (hasInput) {
      const total = Math.max(this.promptTotal ?? 0, INPUT_FIELDS.reduce((sum, key) => sum + (this.input[key] ?? 0), 0));
      if (this.promptTotal === undefined || total !== this.promptTotal) event.promptTokens = total - (this.promptTotal ?? 0);
      this.promptTotal = total;
    }
    if (valid(usage.output_tokens)) {
      const total = Math.max(this.completionTotal ?? 0, usage.output_tokens);
      if (this.completionTotal === undefined || total !== this.completionTotal) event.completionTokens = total - (this.completionTotal ?? 0);
      this.completionTotal = total;
    }
    const classifiedInput = this.input.cache_read_input_tokens !== undefined ? this.promptTotal ?? 0 : 0;
    if (classifiedInput > this.classifiedInput || firstRead) event.cacheReadInputTokens = classifiedInput - this.classifiedInput;
    this.classifiedInput = classifiedInput;
    if (event.promptTokens === undefined && event.completionTokens === undefined && !firstRead && !firstWrite) return undefined;
    if (this.promptTotal !== undefined) event.promptTokensTotal = this.promptTotal;
    if (this.completionTotal !== undefined) event.completionTokensTotal = this.completionTotal;
    return event;
  }
}
