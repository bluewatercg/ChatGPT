/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

export interface BackgroundResult {
  id: string;
  title: string;
  text: string;
}

/** Run-owned tasks: completion order never depends on launch order. */
export class BackgroundTasks {
  private readonly jobs = new Map<string, { key: string; title: string; promise: Promise<void>; result?: BackgroundResult; reported: boolean; cancel: () => void }>();
  readonly limit = 4;

  findActive(key: string): string | undefined {
    return [...this.jobs].find(([, job]) => job.key === key && !job.result)?.[0];
  }
  get active(): number { return [...this.jobs.values()].filter(job => !job.result).length; }
  get pending(): boolean { return [...this.jobs.values()].some(job => !job.reported); }

  add(id: string, key: string, title: string, work: Promise<string>, cancel: () => void): void {
    const job: { key: string; title: string; promise: Promise<void>; result?: BackgroundResult; reported: boolean; cancel: () => void } = { key, title, promise: Promise.resolve(), reported: false, cancel };
    this.jobs.set(id, job);
    job.promise = work.then(
      text => { job.result ??= { id, title, text }; },
      error => { job.result ??= { id, title, text: `(subagent failed: ${error instanceof Error ? error.message : String(error)})` }; },
    );
  }
  drain(): BackgroundResult[] {
    const ready: BackgroundResult[] = [];
    for (const job of this.jobs.values()) {
      if (job.result && !job.reported) { job.reported = true; ready.push(job.result); }
    }
    return ready;
  }
  waitForNext(): Promise<unknown> {
    if ([...this.jobs.values()].some(job => job.result && !job.reported)) return Promise.resolve();
    const active = [...this.jobs.values()].filter(job => !job.result);
    return active.length ? Promise.race(active.map(job => job.promise)) : Promise.resolve();
  }

  cancelAll(): void {
    for (const [id, job] of this.jobs) {
      if (job.result) continue;
      job.cancel();
      job.result = { id, title: job.title, text: "(subagent cancelled)" };
    }
  }
}
