/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { describe, expect, it } from "vitest";
import { RetrievalProgress } from "./retrievalProgress";

const read = (input: unknown = { path: "a.ts" }, output = "source") => ({
	name: "Read", input, output, status: "completed" as const,
});

describe("retrieval progress", () => {
	it("detects alternating probes with equivalent full arguments regardless of key order", () => {
		const progress = new RetrievalProgress();
		const grep = { name: "Grep", input: { path: "src", pattern: "bug" }, status: "completed" as const, output: "a.ts:12: bug" };
		expect(progress.observe([read(), grep])).toBeUndefined();
		expect(progress.observe([read()])).toBeUndefined();
		expect(progress.observe([{ ...grep, input: { pattern: "bug", path: "src" } }])).toBeUndefined();
		expect(progress.observe([read()])).toBe("recover");
	});

	it("counts repeated rounds rather than parallel calls", () => {
		const progress = new RetrievalProgress();
		expect(progress.observe(Array.from({ length: 20 }, () => read()))).toBeUndefined();
		expect(progress.observe(Array.from({ length: 20 }, () => read()))).toBeUndefined();
		expect(progress.observe([read()])).toBeUndefined();
		expect(progress.observe([read()])).toBe("recover");
	});

	it("allows new ranges and changed contents without limiting legitimate investigation", () => {
		const progress = new RetrievalProgress();
		for (let i = 0; i < 20; i++) {
			expect(progress.observe([read({ path: "a.ts", offset: i * 100 })])).toBeUndefined();
		}
		for (let i = 0; i < 20; i++) {
			expect(progress.observe([read(undefined, `changed ${i}`)])).toBeUndefined();
		}
	});

	it.each(["Write", "StrReplace", "Shell", "AwaitShell", "Task", "AskQuestion"])("resets after successful %s", (name) => {
		const progress = new RetrievalProgress();
		for (let i = 0; i < 4; i++) progress.observe([read()]);
		progress.observe([{ name, input: {}, status: "completed", output: "done" }]);
		expect(progress.observe([read()])).toBeUndefined();
		expect(progress.observe([read()])).toBeUndefined();
		expect(progress.observe([read()])).toBeUndefined();
		expect(progress.observe([read()])).toBe("recover");
	});

	it("does not treat todo churn or failed edits as new investigation evidence", () => {
		const progress = new RetrievalProgress();
		progress.observe([read()]);
		for (let i = 1; i <= 8; i++) {
			progress.observe([{ name: "TodoWrite", input: {}, output: `status ${i}`, status: "completed" }]);
			progress.observe([{ name: "Write", input: {}, output: "denied", status: "error" }]);
			expect(progress.observe([read()])).toBe(i === 3 ? "recover" : i === 6 ? "wrap-up" : i === 8 ? "pause" : undefined);
		}
	});

	it("detects repeated retrieval failures as well as unchanged successful results", () => {
		const progress = new RetrievalProgress();
		const missing = { ...read(undefined, "error: file not found"), status: "error" as const };
		for (let i = 0; i < 3; i++) expect(progress.observe([missing])).toBeUndefined();
		expect(progress.observe([missing])).toBe("recover");
	});

	it("compares the full arguments and image payload instead of an abbreviated prefix", () => {
		const progress = new RetrievalProgress();
		const path = "directory/".repeat(30);
		for (let i = 0; i < 10; i++) {
			expect(progress.observe([read({ path: `${path}${i}.ts` })])).toBeUndefined();
			expect(progress.observe([{ ...read(), image: { mime: "image/png", base64: `image ${i}` } }])).toBeUndefined();
		}
	});
});
