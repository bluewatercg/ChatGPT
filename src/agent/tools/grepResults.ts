/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

export type GrepMode = "content" | "files_with_matches" | "count";
export interface GrepRow { path: string; line?: number; text?: string; match?: boolean; count?: number }

/** Both backends paginate source rows, never repeated filenames or separators. */
export class GrepPage {
  private rows: GrepRow[] = [];
  private seen = 0;
  private chars = 0;
  private more = false;
  constructor(readonly mode: GrepMode, readonly skip: number, readonly cap: number) {}

  /** False means a real lookahead row proves that another page exists. */
  push(row: GrepRow): boolean {
    if (this.more) return false;
    this.seen++;
    if (this.seen <= this.skip) return true;
    const text = row.text ?? "";
    const clipped = text.length > 500 ? text.slice(0, 500) + " …[truncated; use Read for exact text]" : text;
    const size = clipped.length + row.path.length + 24;
    if (this.rows.length >= this.cap || (this.rows.length > 0 && this.chars + size > 20_000)) {
      this.more = true;
      return false;
    }
    this.rows.push({ ...row, text: clipped });
    this.chars += size;
    return true;
  }

  format(incomplete?: string): string {
    const unit = this.mode === "content" ? "rows" : "files";
    const next = this.more ? String(this.skip + this.rows.length) : "none";
    const header = `[Grep ${unit}=${this.rows.length} offset=${this.skip} next_offset=${next}${incomplete ? " scan_incomplete=true" : ""}]`;
    const out: string[] = [header];
    let lastPath: string | undefined;
    for (const row of this.rows) {
      if (this.mode === "files_with_matches") out.push(row.path);
      else if (this.mode === "count") out.push(`${row.path}:${row.count}`);
      else {
        if (row.path !== lastPath) { if (lastPath !== undefined) out.push(""); out.push(row.path); lastPath = row.path; }
        out.push(`${row.line}${row.match ? ":" : "-"}${row.text}`);
      }
    }
    if (!this.rows.length) out.push(this.skip > 0 ? "(no rows at this offset)" : "(no matches)");
    if (incomplete) out.push(`(${incomplete}; narrow path/glob/pattern — this is not a complete search)`);
    return out.join("\n");
  }
}
