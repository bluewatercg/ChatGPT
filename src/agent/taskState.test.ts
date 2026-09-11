/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { describe, expect, it } from "vitest";
import { ActivityLedger } from "./taskState";
import type { TodoItem } from "./tools/types";

describe("ActivityLedger", () => {
	it("bounds a large run while preserving totals, recent changes and active work", () => {
		const ledger = new ActivityLedger();
		for (let i = 0; i < 1000; i++) {
			ledger.record("Write", { path: `/workspace/${"directory/".repeat(20)}file-${i}.ts`, contents: "line" }, "completed", "Wrote file");
		}
		const todos: TodoItem[] = Array.from({ length: 1000 }, (_, i) => ({ id: `task-${i}`, status: i === 999 ? "in_progress" : i > 989 ? "pending" : "completed", content: `Work item ${i} ${"details ".repeat(100)}` }));
		const rendered = ledger.render({ request: "Request ".repeat(1000), todos });
		expect(rendered.length).toBeLessThan(5000);
		expect(rendered).toContain("Files changed (1000 total, 990 older omitted)");
		expect(rendered).toContain("Actions so far (1000 total, 988 older omitted)");
		expect(rendered).toContain("Todos: 1000 total (990 done, 10 open)");
		expect(rendered).toContain("Active todos (5 more omitted; use TodoRead for the full list)");
		expect(rendered).toContain("[in_progress] task-999: Work item 999");
		expect(rendered).toContain("[pending] task-990: Work item 990");
		expect(rendered.indexOf("[in_progress]")).toBeLessThan(rendered.indexOf("[pending]"));
		expect(rendered).not.toContain("file-0.ts");
		expect(rendered).toContain("file-999.ts");
		expect(rendered.match(/^  [✓✗]/gm)).toHaveLength(12);
		expect(rendered.match(/^  \[(?:pending|in_progress)\]/gm)).toHaveLength(5);
	});

	it("caps model-facing state even for very long tool names, notes and todo ids", () => {
		const ledger = new ActivityLedger();
		for (let i = 0; i < 1000; i++) {
			ledger.record("Write", { path: `${"path/".repeat(100)}${i}`, contents: "text" }, "completed", "done");
			ledger.record(`CustomTool${i}${"name".repeat(100)}`, { command: "command ".repeat(200) }, "error", "diagnostic ".repeat(1000));
		}
		ledger.record("WritePlan", {}, "completed", `.plans/${"plan".repeat(1000)}.md`);
		const todos: TodoItem[] = Array.from({ length: 1000 }, (_, i) => ({ id: String(i) + "id".repeat(1000), content: "todo ".repeat(1000), status: "pending" }));
		expect(ledger.render({ request: "request ".repeat(1000), todos }).length).toBeLessThan(5000);
	});

	it("keeps pending work available when no tool actions have occurred", () => {
		const ledger = new ActivityLedger();
		const rendered = ledger.render({ request: "", todos: [{ id: "verify", content: "Run final checks", status: "pending" }] });
		expect(rendered).toContain("[pending] verify: Run final checks");
		expect(rendered).toContain("1 open");
		expect(rendered).not.toContain("Actions so far");
		expect(rendered).not.toContain("trust it over your recollection");
		expect(rendered).not.toContain("re-run a command");
	});

	it("updates file recency after an edit and clears deleted when it is rewritten", () => {
		const ledger = new ActivityLedger();
		ledger.record("Delete", { path: "restored.ts" }, "completed", "deleted");
		for (let i = 0; i < 15; i++) ledger.record("Write", { path: `new-${i}.ts`, contents: "text" }, "completed", "wrote");
		expect(ledger.render({ request: "", todos: [] })).not.toContain("restored.ts (deleted)");
		ledger.record("Write", { path: "restored.ts", contents: "restored\ncontent" }, "completed", "wrote");
		const rendered = ledger.render({ request: "", todos: [] });
		const files = rendered.split("Files changed")[1].split("Actions so far")[0];
		expect(files).toContain("restored.ts +2 -0");
		expect(files).not.toContain("restored.ts (deleted)");
		expect(files.indexOf("restored.ts")).toBeGreaterThan(files.indexOf("new-14.ts"));
	});

	it("keeps full file identities when long paths share their first 90 characters", () => {
		const ledger = new ActivityLedger();
		const prefix = "shared/".repeat(30);
		ledger.record("Write", { path: `${prefix}first.ts`, contents: "text" }, "completed", "wrote");
		ledger.record("Write", { path: `${prefix}second.ts`, contents: "text" }, "completed", "wrote");
		const rendered = ledger.render({ request: "", todos: [] });
		expect(rendered).toContain("Files changed (2 total)");
		expect(rendered).toContain("first.ts +1 -0");
		expect(rendered).toContain("second.ts +1 -0");
	});

	it("does not let archive retrieval displace useful activity", () => {
		const ledger = new ActivityLedger();
		ledger.record("ReadContext", { id: "ctx_example" }, "completed", "saved context");
		expect(ledger.isEmpty).toBe(true);
		ledger.record("Write", { path: "changed.ts", contents: "text" }, "completed", "wrote");
		for (let i = 0; i < 100; i++) ledger.record("ReadContext", { id: `ctx_${i}` }, "completed", "saved context");
		const rendered = ledger.render({ request: "", todos: [] });
		expect(rendered).toContain("Actions so far (1 total)");
		expect(rendered).not.toContain("✓ ReadContext");
	});

	it("handles maxActions zero and clamps invalid, oversized and fractional limits", () => {
		const ledger = new ActivityLedger();
		for (let i = 0; i < 20; i++) ledger.record("Shell", { command: `check-${i}` }, "completed", "done");
		for (const maxActions of [Infinity, NaN, 1000]) {
			expect(ledger.render({ request: "", todos: [], maxActions }).match(/^  ✓/gm)).toHaveLength(12);
		}
		for (const maxActions of [0, -1]) {
			const rendered = ledger.render({ request: "", todos: [], maxActions });
			expect(rendered).toContain("20 total, 20 older omitted");
			expect(rendered).not.toContain("✓");
		}
		expect(ledger.render({ request: "", todos: [], maxActions: 2.9 }).match(/^  ✓/gm)).toHaveLength(2);
	});
});


it("distinguishes running jobs, cancelled waits, and verified exit outcomes", () => {
  const ledger = new ActivityLedger();
  ledger.record("Shell", { command: "long job" }, "completed", "started", { status: "running", processStatus: "running", jobId: "job" });
  ledger.record("AwaitShell", { shell_id: "job" }, "error", "wait cancelled", { status: "aborted", processStatus: "running", jobId: "job" });
  ledger.record("Shell", { command: "verify" }, "error", "Some progress text", { status: "failed", processStatus: "failed", exitCode: 1 });
  ledger.record("Shell", { command: "verify after fix" }, "completed", "all checks pass", { status: "completed", processStatus: "completed", exitCode: 0 });
  const state = ledger.render({ request: "Verify changes", todos: [] });
  expect(state).toContain("… Shell long job — running");
  expect(state).toContain("aborted (process running)");
  expect(state).toContain("failed (exit 1)");
  expect(state).toContain("completed (exit 0)");
  expect(state).not.toContain("Some progress text");
});
