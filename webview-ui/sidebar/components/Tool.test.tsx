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
import { ToolCard } from "./Tool";
import { vscode } from "../../shared/vscode";

vi.mock("../../shared/vscode", () => ({ vscode: { postMessage: vi.fn() } }));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function renderQuestions(questions: Array<Record<string, unknown>>) {
  act(() => root.render(<ToolCard block={{
    kind: "tool", name: "AskQuestion", callId: "question-1", status: "running",
    input: { questions },
  }} />));
}

function button(label: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim() === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

function click(label: string) {
  act(() => button(label).click());
}

function field(): HTMLInputElement | HTMLTextAreaElement {
  const input = container.querySelector("input, textarea");
  if (!input) throw new Error("Missing answer field");
  return input as HTMLInputElement | HTMLTextAreaElement;
}

function type(value: string) {
  const input = field();
  const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function expectAnswers(answers: Record<string, string[]>) {
  expect(vscode.postMessage).toHaveBeenCalledOnce();
  expect(vscode.postMessage).toHaveBeenCalledWith({
    type: "answerQuestion", callId: "question-1", answers,
  });
}

describe("AskQuestion production form", () => {
  it.each([
    ["text", "release"], ["textArea", "first line\nsecond line"],
    ["number", "42"], ["date", "2026-09-07"],
  ])("submits a typed %s answer", (typeName, value) => {
    renderQuestions([{ prompt: "Your answer", type: typeName }]);
    type(value);
    click("Submit");
    expectAnswers({ "0": [value] });
    expect(container.querySelector(".qc-a")?.textContent).toBe(value);
  });

  it.each(["text", "textArea", "number", "date"])("requires an answer for %s", (typeName) => {
    renderQuestions([{ prompt: "Required", type: typeName, required: true }]);
    expect(button("Submit").disabled).toBe(true);
    expect(container.querySelector(".qc-skip")).toBeNull();
    click("Submit");
    act(() => field().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(vscode.postMessage).not.toHaveBeenCalled();
    type(typeName === "number" ? "0" : typeName === "date" ? "2026-09-07" : "answer");
    expect(button("Submit").disabled).toBe(false);
    click("Submit");
    expect(vscode.postMessage).toHaveBeenCalledOnce();
  });

  it("blocks Continue and Enter for a required blank field", () => {
    renderQuestions([{ prompt: "Required", type: "text", required: true }, { prompt: "Next", type: "text" }]);
    type("   ");
    click("Continue");
    act(() => field().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(container.querySelector(".qc-step")?.textContent).toBe("1 of 2");
    expect(vscode.postMessage).not.toHaveBeenCalled();
  });

  it("preserves earlier answers and edits after going Back", () => {
    renderQuestions([{ prompt: "Name", type: "text" }, { prompt: "Count", type: "number" }]);
    type("old");
    click("Continue");
    type("42");
    click("Back");
    type("new");
    click("Continue");
    click("Submit");
    expectAnswers({ "0": ["new"], "1": ["42"] });
  });

  it("does not submit an old answer after it is cleared", () => {
    renderQuestions([{ prompt: "Name", type: "text" }, { prompt: "Count", type: "number" }]);
    type("old");
    click("Continue");
    click("Back");
    type("");
    click("Continue");
    click("Submit");
    expectAnswers({ "0": [], "1": [] });
  });

  it("keeps Other answers working and validates required choices", () => {
    renderQuestions([{ prompt: "Choose", options: ["One", "Two"], required: true }]);
    expect(button("Submit").disabled).toBe(true);
    act(() => container.querySelector<HTMLButtonElement>(".qc-option-custom")!.click());
    expect(button("Submit").disabled).toBe(true);
    type("Three");
    click("Submit");
    expectAnswers({ "0": ["Three"] });
  });

  it("submits multiple choices together with Other", () => {
    renderQuestions([{ prompt: "Choose", options: ["One", "Two"], multiple: true }]);
    act(() => container.querySelector<HTMLButtonElement>(".qc-option")!.click());
    act(() => container.querySelector<HTMLButtonElement>(".qc-option-custom")!.click());
    type("Three");
    click("Submit");
    expectAnswers({ "0": ["One", "Three"] });
  });

  it("skips an optional answer without sending its draft", () => {
    renderQuestions([{ prompt: "Optional", type: "text" }]);
    type("draft");
    click("Skip");
    expectAnswers({ "0": [] });
  });

  it("does not duplicate an option when Other repeats it", () => {
    renderQuestions([{ prompt: "Choose", options: ["One", "Two"], multiple: true }]);
    act(() => container.querySelector<HTMLButtonElement>(".qc-option")!.click());
    act(() => container.querySelector<HTMLButtonElement>(".qc-option-custom")!.click());
    type("One");
    click("Submit");
    expectAnswers({ "0": ["One"] });
  });
});
