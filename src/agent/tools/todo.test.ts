/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { writeTodos as todoWriteHandler, readTodos as todoReadHandler } from "./todoState";
import type { TodoItem, ToolContext } from "./types";
/**
 * Unit tests for TodoWrite / TodoRead tools and the rolling window anti-loop.
 * Runs via vitest in CI (no VS Code dependency).
 */
import { describe, it, expect } from "vitest";

// ==================== TESTS ====================

describe("TodoWrite handler", () => {
  it("creates todos with merge=false", () => {
    const ctx: ToolContext = { todos: [] };
    const result = todoWriteHandler(
      { todos: [{ id: "1", content: "Fix bug", status: "pending" }], merge: false },
      ctx,
    );
    expect(ctx.todos).toHaveLength(1);
    expect(ctx.todos[0].content).toBe("Fix bug");
    expect(result.output).toBe("[ ] Fix bug");
  });

  it("replaces entire list with merge=false", () => {
    const ctx: ToolContext = { todos: [{ id: "1", content: "Old task", status: "pending" }] };
    todoWriteHandler(
      { todos: [{ id: "2", content: "New task", status: "in_progress" }], merge: false },
      ctx,
    );
    expect(ctx.todos).toHaveLength(1);
    expect(ctx.todos[0].id).toBe("2");
    expect(ctx.todos[0].content).toBe("New task");
  });

  it("preserves existing work when an empty replacement arrives", () => {
    const ctx: ToolContext = { todos: [{ id: "1", content: "Existing task", status: "pending" }] };
    const result = todoWriteHandler({ todos: [], merge: false }, ctx);
    expect(result.output).toBe("[ ] Existing task");
    expect(ctx.todos).toHaveLength(1); // unchanged
    expect(ctx.todos[0].content).toBe("Existing task");
  });

  it("merges by id with merge=true", () => {
    const ctx: ToolContext = {
      todos: [
        { id: "1", content: "Task A", status: "pending" },
        { id: "2", content: "Task B", status: "pending" },
      ],
    };
    todoWriteHandler(
      { todos: [{ id: "1", status: "completed" }], merge: true },
      ctx,
    );
    expect(ctx.todos).toHaveLength(2);
    expect(ctx.todos.find((t) => t.id === "1")!.status).toBe("completed");
    expect(ctx.todos.find((t) => t.id === "1")!.content).toBe("Task A"); // preserved
    expect(ctx.todos.find((t) => t.id === "2")!.status).toBe("pending"); // unchanged
  });

  it("adds new item with merge=true", () => {
    const ctx: ToolContext = { todos: [{ id: "1", content: "Task A", status: "pending" }] };
    todoWriteHandler(
      { todos: [{ id: "2", content: "Task B", status: "pending" }], merge: true },
      ctx,
    );
    expect(ctx.todos).toHaveLength(2);
  });

  it("outputs [x] for completed, [~] for in_progress, [-] for cancelled, [ ] for pending", () => {
    const ctx: ToolContext = { todos: [] };
    todoWriteHandler(
      {
        todos: [
          { id: "1", content: "Done", status: "completed" },
          { id: "2", content: "Active", status: "in_progress" },
          { id: "3", content: "Skipped", status: "cancelled" },
          { id: "4", content: "Waiting", status: "pending" },
        ],
        merge: false,
      },
      ctx,
    );
    const result = todoWriteHandler({ todos: ctx.todos, merge: true }, ctx);
    expect(result.output).toContain("[x] Done");
    expect(result.output).toContain("[~] Active");
    expect(result.output).toContain("[-] Skipped");
    expect(result.output).toContain("[ ] Waiting");
  });

  it("keeps an empty merge empty without inventing work", () => {
    const ctx: ToolContext = { todos: [] };
    const result = todoWriteHandler({ todos: [], merge: true }, ctx);
    // merge=true with empty incoming: ctx.todos stays empty, output is "(no todos)"
    expect(ctx.todos).toHaveLength(0);
    expect(result.output).toBe("(no todos)");
  });
});

describe("TodoRead handler", () => {
  it("returns (no todos) for empty list", () => {
    const ctx: ToolContext = { todos: [] };
    expect(todoReadHandler(ctx).output).toBe("(no todos)");
  });

  it("returns full list with status markers", () => {
    const ctx: ToolContext = {
      todos: [
        { id: "1", content: "Task A", status: "completed" },
        { id: "2", content: "Task B", status: "pending" },
      ],
    };
    const result = todoReadHandler(ctx);
    expect(result.output).toContain("- [completed] Task A");
    expect(result.output).toContain("- [pending] Task B");
  });
});
