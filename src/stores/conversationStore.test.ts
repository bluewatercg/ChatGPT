/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { expect, it, vi } from "vitest";
vi.mock("vscode", () => ({}));
import { ConversationStore } from "./conversationStore";
import { buildMessages, snapshotUserContext } from "../agent/messages";
import { restoreContext, saveContext, type ContextState } from "../agent/contextState";
import type { Step } from "../agent/types";

function storage() {
  const values = new Map<string, string>();
  return {
    get: <T>(key: string, fallback?: T): T | undefined => values.has(key) ? JSON.parse(values.get(key)!) : fallback,
    update: async (key: string, value: unknown) => {
      if (value === undefined) values.delete(key);
      else values.set(key, JSON.stringify(value));
    },
  };
}

it("persists original request envelopes and working checkpoints through actual conversation save/reopen", async () => {
  const context = { workspaceState: storage(), globalState: storage() } as unknown as ConstructorParameters<typeof ConversationStore>[0];
  const store = new ConversationStore(context);
  const conversation = await store.create();
  const snapshot = snapshotUserContext({ userInfo: "Preserve local edits", openFiles: "app.ts", timestamp: "2026-09-07T12:00:00Z" });
  const steps: Step[] = [
    { kind: "user", text: "Inspect", context: snapshot, attachments: [{ id: "notes", kind: "text", mime: "text/plain", name: "notes", data: "Keep this" }] },
    { kind: "assistant", text: "Inspected", calls: [] },
  ];
  const state: ContextState = {};
  saveContext(steps, steps, state);
  const before = buildMessages("OpenCursor", steps);
  await store.update(conversation.id, { steps, contextState: state });
  steps[0] = { kind: "user", text: "Later mutable local value" };
  const reopenedStore = new ConversationStore(context);
  const reopened = reopenedStore.get(conversation.id)!;
  reopened.steps.push({ kind: "user", text: "Continue", context: snapshotUserContext({ ...snapshot, timestamp: "later" }, snapshot) });
  const restored = restoreContext(reopened.steps, reopened.contextState);
  expect(buildMessages("OpenCursor", restored).slice(0, before.length)).toEqual(before);
  expect(reopened.contextState?.checkpoint).toBeDefined();
  await reopenedStore.update(conversation.id, { steps: reopened.steps });
  expect(store.get(conversation.id)?.steps).toEqual(reopened.steps);
});
