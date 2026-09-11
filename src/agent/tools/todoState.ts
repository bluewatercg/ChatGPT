/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import type { ToolContext, ToolResult, TodoItem } from "./types";

/** Production todo state transitions, shared by tools and unit tests. */
export function writeTodos(input: any, ctx?: Pick<ToolContext, "todos">): ToolResult {
  try {
    if (!ctx) return { output: "error: todo context unavailable" };
    if (!Array.isArray(ctx.todos)) ctx.todos = [];

    // CRITICAL: Normalize incoming items. Models (Mimo, deepseek) send strings
    // instead of objects, or objects missing fields, or use wrong field names.
    // Accept 'todos', 'tasks', 'items', or any array field.
    const raw: any[] = Array.isArray(input?.todos) ? input.todos
      : Array.isArray(input?.tasks) ? input.tasks
      : Array.isArray(input?.items) ? input.items
      : Array.isArray(input) ? input
      : [];
    const usedIds = new Set(ctx.todos.map((todo, i) => todo.id || `auto_${i}`));
    const idFor = (id: unknown, content: unknown, index: number): string => {
      if (id) { usedIds.add(String(id)); return String(id); }
      if (input?.merge && content !== undefined) {
        const matches = ctx.todos.map((todo, i) => ({ todo, i })).filter(({ todo }) => todo.content === String(content));
        if (matches.length === 1) return matches[0].todo.id || `auto_${matches[0].i}`;
      }
      let candidate = `auto_${index}`;
      if (input?.merge) while (usedIds.has(candidate)) candidate = `auto_${++index}`;
      usedIds.add(candidate);
      return candidate;
    };
    type TodoUpdate = Partial<TodoItem> & { id: string };
    const incoming: TodoUpdate[] = raw.map((t, i): TodoUpdate | null => {
      if (typeof t === "string") {
        return { id: idFor(undefined, t, i), content: t, status: "pending" as const };
      }
      if (t && typeof t === "object") {
        const content = t.content ?? t.text ?? t.title ?? t.name;
        return {
          id: idFor(t.id, content, i),
          // Omitted fields must stay absent until merged with the existing item.
          ...(content != null ? { content: String(content) } : {}),
          ...(t.status !== undefined ? {
            status: (["pending", "in_progress", "completed", "cancelled"].includes(t.status) ? t.status : "pending") as TodoItem["status"],
          } : {}),
        };
      }
      return null;
    }).filter((t): t is TodoUpdate => t !== null);
    const withDefaults = (t: TodoUpdate): TodoItem => ({ content: "unnamed", status: "pending", ...t });

    if (incoming.length === 0 && ctx.todos.length === 0) {
      // Do not invent work or trigger continuation nudges for an empty payload.
      return { output: "(no todos)" };
    }

    if (input?.merge) {
      const byId = new Map(ctx.todos.map((t) => [t.id || `auto_${ctx.todos.indexOf(t)}`, t]));
      for (const t of incoming) {
        const key = t.id || `gen_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        byId.set(key, withDefaults({ ...byId.get(key), ...t, id: key }));
      }
      ctx.todos = [...byId.values()];
    } else if (incoming.length > 0) {
      ctx.todos = incoming.map(withDefaults);
    }

    const render = ctx.todos
      .map((t) => {
        const mark =
          t.status === "completed" ? "[x]" : t.status === "in_progress" ? "[~]" : t.status === "cancelled" ? "[-]" : "[ ]";
        return `${mark} ${t.content || "unnamed"}`;
      })
      .join("\n");
    return { output: render || "(no todos)" };
  } catch (e) {
    return { output: `(todos: ${ctx?.todos?.length || 0} items)` };
  }
}

export function readTodos(ctx?: Pick<ToolContext, "todos">): ToolResult {
  if (!ctx) return { output: "error: todo context unavailable" };
  if (!Array.isArray(ctx.todos) || !ctx.todos.length) {
    return {
      output: "(no todos)",
    };
  }
  return { output: ctx.todos.map((t) => `- [${t.status}] ${t.content}`).join("\n") };
}
