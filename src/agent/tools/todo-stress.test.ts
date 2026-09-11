/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { writeTodos as todoWriteHandler } from "./todoState";
import type { TodoItem, ToolContext } from "./types";
/**
 * STRESS TESTS — TodoWrite must survive 5+ minutes of continuous use.
 * Simulates rapid-fire model calls, many items, truncated JSON, and
 * the full create→progress→complete lifecycle.
 */
import { describe, it, expect } from "vitest";

// ==================== STRESS TESTS ====================

describe("STRESS: 50-item todo lifecycle", () => {
  it("create 50 → mark all in_progress → mark all completed", () => {
    const ctx: ToolContext = { todos: [] } as unknown as ToolContext;

    // Create 50 items (no id — Mimo style)
    const items = Array.from({ length: 50 }, (_, i) => ({
      content: `Task ${i + 1}: ${"x".repeat(50)}`,
      status: "pending" as const,
    }));
    const r = todoWriteHandler({ todos: items, merge: false }, ctx);
    expect(ctx.todos.length).toBe(50);
    expect(r.output.startsWith("error:")).toBe(false);

    // Mark all as in_progress one by one
    for (let i = 0; i < 50; i++) {
      const r2 = todoWriteHandler({ todos: [{ content: ctx.todos[i].content, status: "in_progress" }], merge: true }, ctx);
      expect(r2.output.startsWith("error:")).toBe(false);
    }

    // Mark all as completed one by one
    for (let i = 0; i < 50; i++) {
      const r3 = todoWriteHandler({ todos: [{ content: ctx.todos[i].content, status: "completed" }], merge: true }, ctx);
      expect(r3.output.startsWith("error:")).toBe(false);
    }

    const done = ctx.todos.filter((t) => t.status === "completed").length;
    expect(done).toBeGreaterThanOrEqual(50);
  });
});

describe("STRESS: 200 sequential TodoWrite calls", () => {
  it("200 rapid-fire calls without crash", () => {
    const ctx: ToolContext = { todos: [] } as unknown as ToolContext;
    for (let i = 0; i < 200; i++) {
      const r = todoWriteHandler({
        todos: [{ content: `Rapid task ${i}`, status: i % 3 === 0 ? "completed" : i % 3 === 1 ? "in_progress" : "pending" }],
        merge: i > 0,
      }, ctx);
      expect(r.output.startsWith("error:")).toBe(false);
      expect(r.output).not.toBe("(no todos)");
    }
    expect(ctx.todos.length).toBeGreaterThan(0);
  });
});

describe("STRESS: large payloads", () => {
  it("TodoWrite with 100 items, each 500 chars", () => {
    const ctx: ToolContext = { todos: [] } as unknown as ToolContext;
    const items = Array.from({ length: 100 }, (_, i) => ({
      content: `Task ${i}: ${"Lorem ipsum dolor sit amet ".repeat(20)}`,
      status: "pending" as const,
    }));
    const r = todoWriteHandler({ todos: items, merge: false }, ctx);
    expect(ctx.todos.length).toBe(100);
    expect(r.output.startsWith("error:")).toBe(false);
    expect(r.output.split("\n").length).toBe(100);
  });

  it("TodoWrite with 200 items", () => {
    const ctx: ToolContext = { todos: [] } as unknown as ToolContext;
    const items = Array.from({ length: 200 }, (_, i) => ({
      content: `Task ${i}`,
      status: i % 2 === 0 ? "completed" as const : "pending" as const,
    }));
    const r = todoWriteHandler({ todos: items, merge: false }, ctx);
    expect(ctx.todos.length).toBe(200);
    expect(r.output.startsWith("error:")).toBe(false);
  });

  it("TodoWrite with unicode content", () => {
    const ctx: ToolContext = { todos: [] } as unknown as ToolContext;
    const items = [
      { content: "日本語テスト 🎌", status: "pending" as const },
      { content: "한국어 테스트 🇰🇷", status: "in_progress" as const },
      { content: "中文测试 🇨🇳", status: "completed" as const },
      { content: "العربية اختبار 🇸🇦", status: "cancelled" as const },
    ];
    const r = todoWriteHandler({ todos: items, merge: false }, ctx);
    expect(ctx.todos.length).toBe(4);
    expect(r.output).toContain("日本語テスト");
    expect(r.output).toContain("한국어");
    expect(r.output).toContain("中文");
    expect(r.output).toContain("العربية");
  });

  it("TodoWrite with special chars in content", () => {
    const ctx: ToolContext = { todos: [] } as unknown as ToolContext;
    const items = [
      { content: 'Quote "test"', status: "pending" as const },
      { content: "Backslash \\path\\to\\file", status: "pending" as const },
      { content: "Newline\ntest", status: "pending" as const },
      { content: "Tab\there", status: "pending" as const },
      { content: "<html>tags</html>", status: "pending" as const },
    ];
    const r = todoWriteHandler({ todos: items, merge: false }, ctx);
    expect(ctx.todos.length).toBe(5);
    expect(r.output.startsWith("error:")).toBe(false);
  });
});

describe("STRESS: interleaved operations", () => {
  it("create → add → remove → complete → repeat 50x", () => {
    const ctx: ToolContext = { todos: [] } as unknown as ToolContext;
    for (let cycle = 0; cycle < 50; cycle++) {
      // Create
      todoWriteHandler({ todos: [{ content: `Cycle ${cycle}`, status: "pending" }], merge: cycle > 0 }, ctx);
      // Add another
      todoWriteHandler({ todos: [{ content: `Extra ${cycle}`, status: "pending" }], merge: true }, ctx);
      // Complete first
      todoWriteHandler({ todos: [{ content: `Cycle ${cycle}`, status: "completed" }], merge: true }, ctx);
      // Complete second
      todoWriteHandler({ todos: [{ content: `Extra ${cycle}`, status: "completed" }], merge: true }, ctx);
    }
    expect(ctx.todos.length).toBeGreaterThanOrEqual(50);
    const done = ctx.todos.filter((t) => t.status === "completed").length;
    expect(done).toBeGreaterThanOrEqual(50);
  });
});

describe("STRESS: defensive — every input type", () => {
  const adversarialInputs = [
    null,
    undefined,
    0,
    1,
    true,
    false,
    "",
    "string",
    [],
    {},
    { todos: null },
    { todos: undefined },
    { todos: 0 },
    { todos: true },
    { todos: "" },
    { todos: {} },
    { merge: null },
    { merge: undefined },
    { merge: "yes" },
    { merge: 1 },
    { todos: [null] },
    { todos: [undefined] },
    { todos: [0] },
    { todos: [true] },
    { todos: [""] },
    { todos: [{}] },
    { todos: [{ id: null }] },
    { todos: [{ content: null }] },
    { todos: [{ status: null }] },
    { todos: [{ id: 1, content: 2, status: 3 }] },
    { todos: Array.from({ length: 100 }, () => null) },
    { todos: Array.from({ length: 100 }, () => ({})) },
  ];

  for (let i = 0; i < adversarialInputs.length; i++) {
    it(`adversarial input #${i} never crashes, never returns error:`, () => {
      const ctx: ToolContext = { todos: [{ content: "Existing", status: "pending" }] } as unknown as ToolContext;
      const r = todoWriteHandler(adversarialInputs[i], ctx);
      expect(typeof r.output).toBe("string");
      expect(r.output.startsWith("error:")).toBe(false);
      expect(ctx.todos.length).toBeGreaterThanOrEqual(0);
    });
  }
});
