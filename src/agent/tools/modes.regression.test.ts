/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { describe, expect, it, vi } from "vitest";
import { MULTITASK_TOOLS, schemasForMode, TOOLS, toolsForMode } from "./index";

// Keep the real tool registry and handlers; only the absent editor runtime is mocked.
vi.mock("vscode", () => ({}));

describe("production tool mode restrictions", () => {
  it("excludes WritePlan and other filesystem writes from read-only Ask mode", () => {
    const tools = toolsForMode("ask");
    const names = tools.map((tool) => tool.schema.function.name);

    expect(names).toContain("Read");
    expect(names).toContain("Task");
    for (const name of ["WritePlan", "Write", "StrReplace", "Delete", "EditNotebook", "Shell"]) {
      expect(names).not.toContain(name);
    }
    expect(tools.every((tool) => !tool.mutating)).toBe(true);
  });

  it.each(["multitask", "project"] as const)("excludes WritePlan from the %s coordinator", (mode) => {
    const names = toolsForMode(mode).map((tool) => tool.schema.function.name);

    expect(names).toContain("Task");
    expect(names).not.toContain("WritePlan");
    expect(MULTITASK_TOOLS.has("WritePlan")).toBe(false);
  });

  it.each(["plan", "agent", "debug"] as const)("allows saving plans in %s mode", (mode) => {
    expect(toolsForMode(mode)).toContain(TOOLS.WritePlan);
    expect(schemasForMode(mode).map((schema) => schema.function.name)).toContain("WritePlan");
  });

  it("allows only WritePlan to mutate files in Plan mode", () => {
    const tools = toolsForMode("plan");
    const names = tools.map((tool) => tool.schema.function.name);

    expect(names).toContain("Read");
    expect(names).toContain("WritePlan");
    expect(tools.filter((tool) => tool.mutating)).toEqual([TOOLS.WritePlan]);
    for (const name of ["Write", "StrReplace", "Delete", "EditNotebook", "Shell"]) {
      expect(names).not.toContain(name);
    }
  });
});
