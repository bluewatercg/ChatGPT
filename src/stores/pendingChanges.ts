/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import * as fs from "fs/promises";
import { createHash } from "node:crypto";
import { safePath } from "../context/workspaceUtils";
import { computeHunks, type Hunk } from "../shared/lineDiff";
import { withPathLock, assertCurrentFile, readSnapshot, atomicReplace } from "./fileMutations";
export { computeHunks, type Hunk } from "../shared/lineDiff";

export interface ChangeOwner { conversationId: string; runId?: string; turnIndex?: number }
export interface ChangeScope { conversationId: string; fromTurnIndex?: number; runId?: string }
export interface PendingChange {
  path: string;
  before: string;
  after: string;
  existedBefore: boolean;
  binary?: boolean;
  previewOnly?: boolean;
  owner?: ChangeOwner;
}
interface EditRecord extends PendingChange {
  beforeBytes?: Buffer | null;
  backupPath?: string;
  afterDigest: string | null;
  originalMode?: number;
}
export const fileDigest = (bytes: Buffer | null): string | null => bytes === null ? null : createHash("sha256").update(bytes).digest("hex");
const TEXT_PREVIEW = 256_000;
function textView(data: Buffer | null): { text: string; binary: boolean; previewOnly: boolean } {
  if (data === null) return { text: "", binary: false, previewOnly: false };
  const sample = data.subarray(0, TEXT_PREVIEW);
  const text = sample.toString("utf8");
  const binary = sample.includes(0) || (data.length <= TEXT_PREVIEW && !Buffer.from(text, "utf8").equals(sample));
  return { text: binary ? `[Binary file: ${data.length} bytes]` : text.slice(0, TEXT_PREVIEW), binary, previewOnly: data.length > TEXT_PREVIEW || binary };
}
function matches(record: EditRecord, scope?: ChangeScope): boolean {
  if (!scope) return true;
  return record.owner?.conversationId === scope.conversationId &&
    (!scope.runId || record.owner?.runId === scope.runId) &&
    (scope.fromTurnIndex === undefined || (record.owner?.turnIndex ?? -1) >= scope.fromTurnIndex);
}

/** Ordered immutable edit snapshots, scoped to their originating chat and turn. */
export class PendingChangesStore {
  private changes = new Map<string, EditRecord[]>();
  private listeners = new Set<() => void>();
  onChange(fn: () => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private emit() { for (const listener of this.listeners) { try { listener(); } catch { /* observers cannot break a committed edit */ } } }
  private key(file: string) { const abs = safePath(file); return process.platform === "win32" ? abs.toLowerCase() : abs; }
  /** Compatibility surface for small text edits; mutation tools use recordBytes. */
  record(file: string, before: string, after: string, existedBefore: boolean, owner?: ChangeOwner) {
    this.recordBytes(file, existedBefore ? Buffer.from(before) : null, Buffer.from(after), owner);
  }
  /** A deletion's backup must already exist before the file is removed. */
  recordBytes(file: string, before: Buffer | null, after: Buffer | null, owner?: ChangeOwner, backupPath?: string, originalMode?: number) {
    const previous = textView(before), next = textView(after);
    const record: EditRecord = {
      path: file, before: previous.text, after: next.text, existedBefore: before !== null,
      binary: previous.binary || next.binary, previewOnly: previous.previewOnly || next.previewOnly,
      owner: owner ? { ...owner } : undefined,
      beforeBytes: backupPath ? undefined : before === null ? null : Buffer.from(before),
      backupPath, afterDigest: fileDigest(after), originalMode,
    };
    const key = this.key(file);
    const records = this.changes.get(key) ?? [];
    records.push(record); this.changes.set(key, records); this.emit();
  }
  list(scope?: ChangeScope): PendingChange[] {
    const out: PendingChange[] = [];
    for (const records of this.changes.values()) {
      const selected = records.filter((record) => matches(record, scope));
      if (!selected.length) continue;
      const first = selected[0], last = selected[selected.length - 1];
      out.push({ path: last.path, before: first.before, after: last.after, existedBefore: first.existedBefore,
        binary: selected.some((r) => r.binary), previewOnly: selected.some((r) => r.previewOnly), owner: last.owner });
    }
    return out;
  }
  get(file: string, scope?: ChangeScope): PendingChange | undefined { return this.list(scope).find((c) => this.key(c.path) === this.key(file)); }
  has(file: string): boolean { return this.changes.has(this.key(file)); }
  count(): number { return this.changes.size; }
  hunks(file: string): Hunk[] { const c = this.get(file); return c && !c.previewOnly ? computeHunks(c.before, c.after) : []; }
  private discard(key: string, record: EditRecord) {
    const records = this.changes.get(key)?.filter((item) => item !== record) ?? [];
    if (records.length) this.changes.set(key, records); else this.changes.delete(key);
    if (record.backupPath) void fs.rm(record.backupPath, { force: true }).catch(() => {});
  }
  accept(file: string, scope?: ChangeScope) {
    const key = this.key(file);
    for (const record of [...this.changes.get(key) ?? []]) if (matches(record, scope)) this.discard(key, record);
    this.emit();
  }
  acceptAll(scope?: ChangeScope) { for (const c of this.list(scope)) this.accept(c.path, scope); }
  private async original(record: EditRecord): Promise<Buffer | null> {
    if (!record.existedBefore) return null;
    if (record.backupPath) return fs.readFile(record.backupPath);
    if (record.beforeBytes) return Buffer.from(record.beforeBytes);
    throw new Error(`Cannot undo ${record.path}: the original backup is unavailable. Current file was preserved.`);
  }
  async reject(file: string, scope?: ChangeScope): Promise<void> {
    await withPathLock(file, undefined, async (canonical) => {
      const key = this.key(canonical);
      if (key !== this.key(file) && this.changes.has(this.key(file))) throw new Error(`Cannot undo ${file}: its destination changed. Current file was preserved.`);
      const records = [...this.changes.get(key) ?? []];
      for (const record of records.reverse()) {
        if (!matches(record, scope)) continue;
        const snapshot = await readSnapshot(canonical);
        if (fileDigest(snapshot.data) !== record.afterDigest) {
          throw new Error(`Cannot undo ${file}: it changed after this agent edit. Save or reconcile the newer changes first; no conflicting content was overwritten.`);
        }
        const original = await this.original(record);
        await atomicReplace(canonical, original, record.originalMode ?? snapshot.mode, undefined, async () => {
          await assertCurrentFile(snapshot);
          if (!this.changes.get(key)?.includes(record)) throw new Error(`Cannot undo ${file}: the change was already accepted or replaced.`);
        });
        this.discard(this.key(record.path), record);
        this.emit();
      }
    });
  }
  async rejectAll(scope?: ChangeScope): Promise<void> {
    const errors: string[] = [];
    for (const c of this.list(scope)) {
      try { await this.reject(c.path, scope); } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
    }
    if (errors.length) throw new Error(errors.join("\n"));
  }
  async acceptHunk(file: string, hunkIndex: number, scope?: ChangeScope): Promise<void> {
    await this.changeHunk(file, hunkIndex, false, scope);
  }
  async rejectHunk(file: string, hunkIndex: number, scope?: ChangeScope): Promise<void> {
    await this.changeHunk(file, hunkIndex, true, scope);
  }
  private async changeHunk(file: string, index: number, reject: boolean, scope?: ChangeScope) {
    await withPathLock(file, undefined, async (canonical) => {
      const key = this.key(canonical);
      const records = this.changes.get(key) ?? [];
      const selected = records.filter((r) => matches(r, scope));
      if (!selected.length) return;
      if (selected.length !== records.length) throw new Error("This file contains changes from another conversation. Review the whole change before undoing individual hunks.");
      const first = selected[0], last = selected[selected.length - 1];
      if (new Set(selected.map((record) => JSON.stringify(record.owner))).size > 1) {
        throw new Error("Partial review spans multiple conversations or turns. Review the whole file to preserve change ownership.");
      }
      if (selected.some((r) => r.previewOnly)) throw new Error("Partial undo is unavailable for binary or large files; review and undo the whole file.");
      const snapshot = await readSnapshot(canonical);
      if (fileDigest(snapshot.data) !== last.afterDigest) throw new Error(`Cannot update hunk in ${file}: the file has newer changes. Current content was preserved.`);
      const h = computeHunks(first.before, last.after)[index];
      if (!h) return;
      const beforeLines = first.before.length ? first.before.split("\n") : [];
      const afterLines = last.after.length ? last.after.split("\n") : [];
      if (reject) afterLines.splice(h.startLine, h.afterLines.length, ...h.beforeLines);
      else beforeLines.splice(h.beforeStart, h.beforeLines.length, ...h.afterLines);
      const before = Buffer.from(beforeLines.join("\n"));
      const after = Buffer.from(afterLines.join("\n"));
      await assertCurrentFile(snapshot);
      if (reject) await atomicReplace(canonical, after, snapshot.mode, undefined, () => assertCurrentFile(snapshot));
      for (const record of records) this.discard(key, record);
      if (!before.equals(after)) this.recordBytes(canonical, first.existedBefore ? before : null, after, first.owner);
      this.emit();
    });
  }
}
export const pendingChanges = new PendingChangesStore();
