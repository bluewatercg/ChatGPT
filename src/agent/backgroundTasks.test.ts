/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { describe, expect, it, vi } from "vitest";
import { BackgroundTasks } from "./backgroundTasks";

function deferred() {
  let resolve!: (text: string) => void;
  const promise = new Promise<string>(r => { resolve = r; });
  return { promise, resolve };
}

describe("background task results", () => {
  it("delivers a faster sibling without waiting for an earlier slow task", async () => {
    const tasks = new BackgroundTasks();
    const slow = deferred(), fast = deferred();
    tasks.add("slow", "a", "Slow", slow.promise, () => {});
    tasks.add("fast", "b", "Fast", fast.promise, () => {});
    fast.resolve("fast result");
    await tasks.waitForNext();
    expect(tasks.drain()).toEqual([{ id: "fast", title: "Fast", text: "fast result" }]);
    expect(tasks.active).toBe(1);
    expect(tasks.pending).toBe(true);
    expect(tasks.findActive("a")).toBe("slow");
    expect(tasks.findActive("b")).toBeUndefined();
    slow.resolve("slow result");
    await tasks.waitForNext();
    expect(tasks.drain()).toEqual([{ id: "slow", title: "Slow", text: "slow result" }]);
    expect(tasks.drain()).toEqual([]);
    expect(tasks.pending).toBe(false);
  });
  it("cancels owned work and emits one terminal report", () => {
    const tasks = new BackgroundTasks();
    const cancel = vi.fn();
    tasks.add("task", "key", "Task", new Promise(() => {}), cancel);
    tasks.cancelAll(); tasks.cancelAll();
    expect(cancel).toHaveBeenCalledOnce();
    expect(tasks.drain()[0].text).toBe("(subagent cancelled)");
    expect(tasks.pending).toBe(false);
  });
});
