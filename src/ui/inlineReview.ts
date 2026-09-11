/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import * as vscode from "vscode";
import { computeHunks, pendingChanges } from "../stores/pendingChanges";
import { safePath } from "../context/workspaceUtils";

const SCHEME = "ocursor-inline-original";
const ORIGINALS = new Map<string, string>();
const originalsChanged = new vscode.EventEmitter<vscode.Uri>();

function beforeUriFor(relPath: string): vscode.Uri {
  // Build via `from` rather than `parse`: a path like `/workspace/lib/a.ts`
  // would otherwise be parsed as an authority ("//workspace").
  const p = relPath.replace(/\\/g, "/");
  return vscode.Uri.from({ scheme: SCHEME, path: p.startsWith("/") ? p : `/${p}` });
}

function fileUriFor(relPath: string): vscode.Uri | undefined {
  try {
    return vscode.Uri.file(safePath(relPath));
  } catch {
    return undefined;
  }
}

/**
 * VS Code's own diff editor is the only way to get real full-width
 * inserted/deleted rows — the extension API has no view-zone/line-widget
 * capability, so decorations can never add rows to a document. Forcing
 * `renderSideBySide: false` turns it into the single-column inline diff.
 */
const INLINE_SETTINGS: Record<string, boolean> = {
  renderSideBySide: false,
};
let settingApplied = false;
const previousValues = new Map<string, boolean | undefined>();

async function applyInlineDiffSetting() {
  if (settingApplied) return;
  settingApplied = true;
  const cfg = vscode.workspace.getConfiguration("diffEditor");
  for (const [key, value] of Object.entries(INLINE_SETTINGS)) {
    previousValues.set(key, cfg.inspect<boolean>(key)?.workspaceValue);
    if (cfg.get<boolean>(key) === value) continue;
    try {
      await cfg.update(key, value, vscode.ConfigurationTarget.Workspace);
    } catch {
      // No workspace to write to (single loose file) — the diff still opens, just unstyled.
    }
  }
}

async function restoreInlineDiffSetting() {
  if (!settingApplied) return;
  settingApplied = false;
  const cfg = vscode.workspace.getConfiguration("diffEditor");
  for (const [key, previous] of previousValues) {
    try {
      await cfg.update(key, previous, vscode.ConfigurationTarget.Workspace);
    } catch {
      // best-effort
    }
  }
  previousValues.clear();
}

/** Push the latest "before" text into an already-open diff without touching tabs. */
function refreshOriginal(relPath: string) {
  const change = pendingChanges.get(relPath);
  if (!change) return;
  const before = beforeUriFor(relPath);
  ORIGINALS.set(before.path.replace(/^\//, ""), change.before);
  originalsChanged.fire(before);
}

/** Open the inline diff for a tracked change. Only ever called from an explicit user action. */
async function showInlineDiff(relPath: string, preserveFocus = true) {
  const change = pendingChanges.get(relPath);
  if (!change) return;
  const fileUri = fileUriFor(relPath);
  if (!fileUri) return;
  const before = beforeUriFor(relPath);
  refreshOriginal(relPath);
  await applyInlineDiffSetting();
  await vscode.commands.executeCommand(
    "vscode.diff",
    before,
    fileUri,
    `${relPath.split(/[\\/]/).pop()} (changes)`,
    { preserveFocus, preview: false, viewColumn: vscode.ViewColumn.Active }
  );
}

/** Close any inline-diff tab we opened for `relPath`. */
async function closeInlineDiff(relPath: string) {
  const target = beforeUriFor(relPath).toString();
  const doomed: vscode.Tab[] = [];
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input;
      if (input instanceof vscode.TabInputTextDiff && input.original.toString() === target) doomed.push(tab);
    }
  }
  if (doomed.length) await vscode.window.tabGroups.close(doomed, true);
  ORIGINALS.delete(relPath.replace(/\\/g, "/"));
}

/**
 * Changed-line highlight for when the file is opened as a normal editor rather
 * than through the inline diff (the diff editor draws its own colours).
 */
const addedDecoration = vscode.window.createTextEditorDecorationType({
  isWholeLine: true,
  backgroundColor: new vscode.ThemeColor("diffEditor.insertedLineBackground"),
  overviewRulerColor: new vscode.ThemeColor("editorOverviewRuler.addedForeground"),
  overviewRulerLane: vscode.OverviewRulerLane.Left,
  borderColor: new vscode.ThemeColor("diffEditor.insertedTextBorder"),
  borderWidth: "0 0 0 2px",
  borderStyle: "solid",
  rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
});

/** Map an open editor to the pending change (if any) covering its document. */
function changeForEditor(editor: vscode.TextEditor) {
  const target = editor.document.uri.fsPath;
  for (const change of pendingChanges.list()) {
    const uri = fileUriFor(change.path);
    if (uri && uri.fsPath === target) return change;
  }
  return undefined;
}

function refreshEditor(editor: vscode.TextEditor) {
  const change = changeForEditor(editor);
  if (!change || change.previewOnly) {
    editor.setDecorations(addedDecoration, []);
    return;
  }
  // Diff against the live document text so highlights stay correct if the user
  // keeps typing after the agent's edit.
  const hunks = computeHunks(change.before, editor.document.getText());
  const lastLine = Math.max(editor.document.lineCount - 1, 0);
  const added: vscode.Range[] = [];
  for (const h of hunks) {
    if (!h.afterLines.length) continue;
    const start = Math.min(h.startLine, lastLine);
    const end = Math.min(h.endLine, lastLine);
    added.push(new vscode.Range(start, 0, end, editor.document.lineAt(end).text.length));
  }
  editor.setDecorations(addedDecoration, added);
}

let refreshTimer: NodeJS.Timeout | undefined;
/** Paths we currently have an inline-diff tab open for. */
const openDiffs = new Set<string>();

/**
 * Never opens or focuses anything. Agent edits only refresh the content of
 * diffs the user opened themselves, close ones whose change is gone, and
 * repaint changed-line highlights in already-visible editors.
 */
async function sync() {
  const live = new Set(pendingChanges.list().map((c) => c.path));

  for (const path of [...openDiffs]) {
    if (!live.has(path)) {
      openDiffs.delete(path);
      await closeInlineDiff(path);
    } else {
      // Update the virtual "before" document in place — no vscode.diff call,
      // so an edit can never pull the editor onto a diff tab.
      refreshOriginal(path);
    }
  }
  if (!live.size) await restoreInlineDiffSetting();

  for (const editor of vscode.window.visibleTextEditors) {
    if (editor.document.uri.scheme === "file") refreshEditor(editor);
  }
}

function scheduleSync() {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => void sync(), 80);
}

/** Register the inline diff view, its virtual original-content provider, and highlights. */
export function registerInlineReview(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, {
      onDidChange: originalsChanged.event,
      provideTextDocumentContent: (uri) => ORIGINALS.get(uri.path.replace(/^\//, "")) ?? "",
    }),
    vscode.commands.registerCommand("ocursor.viewDiff", async (path: string) => {
      await showInlineDiff(path, false);
      openDiffs.add(path);
    }),
    addedDecoration,
    originalsChanged,
    { dispose: () => refreshTimer && clearTimeout(refreshTimer) },
    { dispose: () => void restoreInlineDiffSetting() },
    { dispose: pendingChanges.onChange(scheduleSync) },
    vscode.window.onDidChangeVisibleTextEditors(() => {
      for (const editor of vscode.window.visibleTextEditors) {
        if (editor.document.uri.scheme === "file") refreshEditor(editor);
      }
    }),
    // Typing only refreshes highlights — re-opening diff tabs on every keystroke
    // would thrash the editor.
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.scheme !== "file") return;
      for (const editor of vscode.window.visibleTextEditors) {
        if (editor.document === e.document) scheduleSync();
      }
    })
  );
  scheduleSync();
}
