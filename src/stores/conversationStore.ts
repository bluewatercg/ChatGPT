/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import * as vscode from "vscode";
import type { Step } from "../agent/types";
import type { Turn } from "../shared/turns";
import type { ContextState } from "../agent/contextState";

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  steps: Step[];
  contextState?: ContextState;
  /** Authoritative UI turns, owned by the host and persisted for rendering. */
  turns: Turn[];
  /** Persona/preset this conversation uses. */
  personaId?: string;
  /** Tokens consumed by the last run (drives the composer context ring). */
  usedTokens?: number;
}

export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: number;
}

const KEY = "ocursor.conversations";
const ACTIVE_KEY = "ocursor.activeConversation";

export class ConversationStore {
  constructor(private readonly context: vscode.ExtensionContext) {
    void this.migrateFromGlobal();
  }

  /** workspaceState = per-workspace storage; VS Code scopes it for us. */
  private get state(): vscode.Memento {
    return this.context.workspaceState;
  }

  /** One-time: move old globalState conversations into this workspace. */
  private async migrateFromGlobal(): Promise<void> {
    const old = this.context.globalState.get<Conversation[]>(KEY);
    if (!old?.length || this.state.get<Conversation[]>(KEY)?.length) {
      if (old) await this.context.globalState.update(KEY, undefined);
      return;
    }
    await this.state.update(KEY, old);
    const active = this.context.globalState.get<string>(ACTIVE_KEY);
    if (active) await this.state.update(ACTIVE_KEY, active);
    await this.context.globalState.update(KEY, undefined);
    await this.context.globalState.update(ACTIVE_KEY, undefined);
  }

  private all(): Conversation[] {
    return this.state.get<Conversation[]>(KEY, []);
  }

  private async persist(list: Conversation[]): Promise<void> {
    await this.state.update(KEY, list);
  }

  list(): ConversationSummary[] {
    return this.all()
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt }));
  }

  get(id: string): Conversation | undefined {
    return this.all().find((c) => c.id === id);
  }

  getActiveId(): string | undefined {
    return this.state.get<string>(ACTIVE_KEY);
  }

  async setActiveId(id: string | undefined): Promise<void> {
    await this.state.update(ACTIVE_KEY, id);
  }

  async create(personaId?: string): Promise<Conversation> {
    const now = Date.now();
    const conv: Conversation = {
      id: `c_${now}_${Math.random().toString(36).slice(2, 8)}`,
      title: "New Chat",
      createdAt: now,
      updatedAt: now,
      steps: [],
      turns: [],
      personaId,
    };
    const list = this.all();
    list.push(conv);
    await this.persist(list);
    await this.setActiveId(conv.id);
    return conv;
  }

  async update(id: string, patch: Partial<Pick<Conversation, "steps" | "contextState" | "turns" | "title" | "personaId" | "usedTokens">>): Promise<void> {
    const list = this.all();
    const i = list.findIndex((c) => c.id === id);
    if (i === -1) return;
    list[i] = { ...list[i], ...patch, updatedAt: Date.now() };
    await this.persist(list);
  }

  async delete(id: string): Promise<void> {
    const list = this.all().filter((c) => c.id !== id);
    await this.persist(list);
    if (this.getActiveId() === id) {
      await this.setActiveId(undefined);
    }
  }
}

/** Derive a short title from the first user message. */
export function titleFromText(text: string): string {
  const t = text.trim().replace(/\s+/g, " ");
  return t.length > 40 ? t.slice(0, 40) + "…" : t || "New Chat";
}
