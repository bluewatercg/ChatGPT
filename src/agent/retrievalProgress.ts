/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { createHash } from "node:crypto";
import type { ToolOutcome } from "./toolOutcome";

interface Observation {
	name: string;
	input: unknown;
	status: "completed" | "error";
	output: string;
	outcome?: ToolOutcome;
	image?: { mime: string; base64: string };
}

const RETRIEVAL_TOOLS = new Set([
	"Read", "Grep", "Glob", "SemanticSearch", "FileSearch", "ListDir",
	"ReadContext", "SearchDocs", "WebSearch", "WebFetch", "ReadLints",
]);
const BOOKKEEPING_TOOLS = new Set(["TodoRead", "TodoWrite", "SwitchMode"]);

/** Object property order does not distinguish two otherwise identical probes. */
function stableJson(value: unknown): string {
	return JSON.stringify(value, (_key, item: unknown) =>
		item && typeof item === "object" && !Array.isArray(item)
			? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
			: item,
	) ?? "";
}

/** Detect unchanged evidence across turns, including alternating search/read cycles. */
export class RetrievalProgress {
	private readonly outputs = new Map<string, string>();
	private staleRounds = 0;

	reset(): void {
		this.outputs.clear();
		this.staleRounds = 0;
	}

	get wrapUpRequested(): boolean {
		return this.staleRounds >= 6;
	}

	observe(turn: Observation[]): "recover" | "wrap-up" | "pause" | undefined {
		// Edits, shell commands, delegation and user answers can invalidate earlier
		// observations. Todo churn alone must not restart an investigation loop.
		if (turn.some(item => !RETRIEVAL_TOOLS.has(item.name) && !BOOKKEEPING_TOOLS.has(item.name)
			&& item.status === "completed" && (!item.outcome || ["completed", "running"].includes(item.outcome.status)))) {
			this.reset();
			return;
		}

		let retrieved = false;
		let newEvidence = false;
		for (const item of turn) {
			if (!RETRIEVAL_TOOLS.has(item.name)) continue;
			retrieved = true;
			const key = createHash("sha256").update(item.name).update(stableJson(item.input)).digest("hex");
			const value = createHash("sha256").update(item.status).update(item.output)
				.update(item.image?.mime ?? "").update(item.image?.base64 ?? "").digest("hex");
			if (this.outputs.get(key) !== value) newEvidence = true;
			this.outputs.set(key, value);
		}
		if (newEvidence) this.staleRounds = 0;
		else if (retrieved) this.staleRounds++;
		else return;

		if (this.staleRounds >= 8) return "pause";
		if (this.staleRounds === 6) return "wrap-up";
		if (this.staleRounds === 3) return "recover";
	}
}
