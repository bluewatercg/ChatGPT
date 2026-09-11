/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

/** Slugify a string for use as a filename. */
export function slugify(s: string): string {
  return (
    String(s || "plan")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60)
      .replace(/-+$/, "") // remove trailing dashes after truncation
      || "plan"
  );
}


export const planRelativePath = (title: string) => `.plans/${slugify(title)}.md`;
