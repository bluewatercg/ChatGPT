/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

/** Parse the production TodoWrite/TodoRead display format. */
export function parseTodos(output: string): { status: string; content: string }[] {
  const items: { status: string; content: string }[] = [];
  for (const raw of output.split("\n")) {
    const line = raw.trim();
    let m = line.match(/^\[(x| |~|-)\]\s+(.*)$/);
    if (m) {
      const map: Record<string, string> = { x: "completed", " ": "pending", "~": "in_progress", "-": "cancelled" };
      items.push({ status: map[m[1]] || "pending", content: m[2] });
      continue;
    }
    m = line.match(/^-\s*\[(\w+)\]\s+(.*)$/);
    if (m) {
      items.push({ status: m[1], content: m[2] });
    }
  }
  return items;
}
