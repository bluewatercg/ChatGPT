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
import { ProvidersPanel } from "./ProvidersPanel";
import { EMPTY_FEATURES, type OAuthStatus } from "../features";
import { vscode } from "../../shared/vscode";

vi.mock("../../shared/vscode", () => ({ vscode: { postMessage: vi.fn() } }));

let root: Root;
let container: HTMLDivElement;
const authorizationUrl = "https://auth.openai.com/oauth/authorize?state=fixture&code_challenge=public-challenge";
const pending: OAuthStatus = { accounts: [], errors: {}, pending: "codex", authorizationUrl };
function render(status: OAuthStatus) {
  act(() => root.render(<ProvidersPanel features={EMPTY_FEATURES} setFeatures={vi.fn()} oauthStatus={status} />));
}
function button(label: string): HTMLButtonElement {
  const result = [...container.querySelectorAll("button")].find((element) => element.textContent?.trim() === label);
  if (!result) throw new Error(`Button not found: ${label}`);
  return result;
}
function click(label: string) { act(() => button(label).click()); }
function setInput(input: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  render({ accounts: [], errors: {} });
  click("OAuth Accounts");
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

describe("OAuth account sign-in UI", () => {
  it("dispatches the real Codex menu action and shows immediate cancellable progress before a host reply", () => {
    click("Add account");
    click("OpenAI Codex");
    expect(vscode.postMessage).toHaveBeenCalledWith({ type: "oauthLogin", kind: "codex" });
    expect(container.textContent).toContain("Starting sign-in to OpenAI Codex");
    expect(container.querySelector(".menu-pop")).toBeNull();
    click("Cancel");
    expect(vscode.postMessage).toHaveBeenCalledWith({ type: "oauthCancel", kind: "codex" });
    expect(button("Add account")).toBeDefined();
  });

  it("offers the authorization link, browser retry, copy, and manual completion after launch failure", () => {
    render({ ...pending, errors: { codex: "The browser could not be opened." } });
    const link = container.querySelector<HTMLInputElement>('[aria-label="Authorization URL"]')!;
    expect(link.value).toBe(authorizationUrl);
    expect(link.readOnly).toBe(true);
    click("Open browser");
    click("Copy link");
    expect(vscode.postMessage).toHaveBeenCalledWith({ type: "oauthOpenLogin", kind: "codex" });
    expect(vscode.postMessage).toHaveBeenCalledWith({ type: "oauthCopyLogin", kind: "codex" });
    const callback = container.querySelector<HTMLInputElement>('[aria-label="Callback URL or authorization code"]')!;
    expect(button("Submit").disabled).toBe(true);
    setInput(callback, "  http://localhost:1455/auth/callback?code=example&state=fixture  ");
    click("Submit");
    expect(vscode.postMessage).toHaveBeenCalledWith({ type: "oauthManualCallback", kind: "codex", url: "http://localhost:1455/auth/callback?code=example&state=fixture" });
    render({ ...pending, errors: { codex: "Callback could not be validated." } });
    expect(callback.value).toContain("code=example");
    expect(container.textContent).toContain("paste the full callback URL");
  });

  it("acknowledges only the current copied link and removes fallback state after cancellation", () => {
    render(pending);
    act(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "oauthLinkCopied", kind: "codex", authorizationUrl: "stale-url" } })));
    expect(button("Copy link")).toBeDefined();
    act(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "oauthLinkCopied", kind: "codex", authorizationUrl } })));
    expect(button("Copied")).toBeDefined();
    render({ accounts: [], errors: {} });
    expect(container.querySelector('[aria-label="Authorization URL"]')).toBeNull();
    render({ ...pending, authorizationUrl: `${authorizationUrl}&new_attempt=1` });
    expect(button("Copy link")).toBeDefined();
  });

  it("shows all provider errors with the current sign-in error first", () => {
    render({ ...pending, errors: { "claude-code": "Earlier Claude failure", codex: "Port 1455 is busy", antigravity: "Google sign-in failed" } });
    const errors = [...container.querySelectorAll('[role="alert"]')].map((element) => element.textContent);
    expect(errors).toHaveLength(3);
    expect(errors[0]).toContain("OpenAI Codex: Port 1455 is busy");
    expect(errors.join(" ")).toContain("Earlier Claude failure");
    expect(errors.join(" ")).toContain("Google sign-in failed");
    expect(container.querySelector('[aria-label="Authorization URL"]')).not.toBeNull();
  });
});
