/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import type { ProviderEvent } from "../types";

/** Most streaming APIs report cumulative counters; emit each billed token once. */
export class UsageTracker {
  private prompt = 0;
  private completion = 0;
  private cachedRead = 0;
  private cachedWrite = 0;
  private readReported = false;
  private writeReported = false;
  private classifiedInput = 0;
  update(prompt: unknown, completion: unknown, cachedRead?: unknown, cachedWrite?: unknown): Extract<ProviderEvent, { type: "usage" }> | undefined {
    const valid = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
    const next = (value: unknown, before: number) => valid(value) ? Math.max(value, before) : before;
    const p = next(prompt, this.prompt);
    const c = next(completion, this.completion);
    const r = next(cachedRead, this.cachedRead);
    const w = next(cachedWrite, this.cachedWrite);
    const firstRead = !this.readReported && valid(cachedRead);
    const firstWrite = !this.writeReported && valid(cachedWrite);
    this.readReported ||= firstRead;
    this.writeReported ||= firstWrite;
    const classifiedInput = this.readReported ? p : 0;
    if (p === this.prompt && c === this.completion && r === this.cachedRead && w === this.cachedWrite && !firstRead && !firstWrite) return undefined;
    const event = {
      type: "usage" as const, promptTokens: p - this.prompt, completionTokens: c - this.completion,
      promptTokensTotal: p, completionTokensTotal: c,
      ...(r > this.cachedRead || firstRead ? { cachedReadTokens: r - this.cachedRead } : {}),
      ...(w > this.cachedWrite || firstWrite ? { cachedWriteTokens: w - this.cachedWrite } : {}),
      ...(classifiedInput > this.classifiedInput || firstRead ? { cacheReadInputTokens: classifiedInput - this.classifiedInput } : {}),
    };
    this.prompt = p;
    this.completion = c;
    this.cachedRead = r;
    this.cachedWrite = w;
    this.classifiedInput = classifiedInput;
    return event;
  }
}
