/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

// @vitest-environment jsdom
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { vscode } from "../shared/vscode";

vi.mock("../shared/vscode", () => ({ vscode: { postMessage: vi.fn() } }));
vi.mock("./components/Composer", () => ({
  KIND_SVG: {}, applyFileIconTo: vi.fn(),
  Composer: (props: any) => <div><button data-testid="send" onClick={() => props.onSubmit("queued-A", [])}>Send fixture</button><button data-testid="agent" onClick={() => props.onMode("agent")}>Agent mode</button></div>,
}));
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  HTMLElement.prototype.scrollIntoView = vi.fn();
  HTMLElement.prototype.scrollTo = vi.fn();
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<App />));
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
function message(data: any) { act(() => window.dispatchEvent(new MessageEvent("message", { data }))); }
function initial(extra: any = {}) { message({ type: "initialState", activeId: "A", mode: "ask", selectedModel: "api::model-A", turns: [{ role: "user", text: "Task A" }], personas: [], activePersonaId: "default", hasProviders: true, runningConvIds: ["A"], ...extra }); }

describe("production chat application lifecycle", () => {
  it("flushes a background chat queue to its original destination and settings", async () => {
    initial();
    act(() => (container.querySelector('[data-testid="send"]') as HTMLButtonElement).click());
    message({ type: "loadConversation", activeId: "B", turns: [{ role: "user", text: "Task B" }], running: false });
    message({ type: "modelSelected", model: "api::model-B" });
    act(() => (container.querySelector('[data-testid="agent"]') as HTMLButtonElement).click());
    message({ type: "agentEvent", convId: "A", event: { type: "run-status", status: "finished" } });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    const sends = vi.mocked(vscode.postMessage).mock.calls.map(([m]) => m as { type: string }).filter((m) => m.type === "sendMessage");
    expect(sends).toEqual([{ type: "sendMessage", convId: "A", text: "queued-A", attachments: undefined, model: "api::model-A", mode: "ask" }]);
    expect(container.querySelector(".chat-list")?.textContent ?? container.textContent).not.toContain("queued-A");
  });

  it("keeps a live question answerable when the webview restores a host snapshot", () => {
    initial({ turns: [{ role: "user", text: "Ask me" }, { role: "assistant", blocks: [{ kind: "tool", name: "AskQuestion", callId: "q", status: "running", input: { questions: [{ question: "Choose", options: ["Yes", "No"] }] } }] }] });
    expect(container.querySelectorAll(".qc-option").length).toBeGreaterThanOrEqual(2);
    expect(container.querySelector(".question-card.done")).toBeNull();
  });

  it("restores completed answers from the host after a reload", () => {
    initial({ runningConvIds: [], turns: [{ role: "assistant", blocks: [{ kind: "tool", name: "AskQuestion", callId: "q", status: "completed", input: { questions: [{ question: "Branch" }] }, answers: { "0": ["Keep main"] } }] }] });
    expect(container.querySelector(".qc-a")?.textContent).toBe("Keep main");
  });
});
