/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { closeTrailingThinking, forceSettleOpenWork, type Mode, type Turn, type Attachment } from "./turns";

/** The queued message retains its destination and execution settings across tab changes. */
export function sendMessageIntent(convId: string | undefined, text: string, attachments?: Attachment[], model?: string, mode?: Mode) {
  return { type: "sendMessage" as const, convId: convId ?? null, text, attachments, model, mode };
}

/** Live snapshots come from the host and must retain pending interactions. */
export function restoreTurns(turns: Turn[], running: boolean): Turn[] {
  return running ? turns : forceSettleOpenWork(closeTrailingThinking(turns), "cancelled");
}
