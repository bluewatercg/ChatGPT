/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import * as vscode from "vscode";
import * as crypto from "crypto";
import * as http from "http";
import { ProviderEvent, ToolSchema, WireMessage } from "./types";
import { ChatHTTPError } from "./provider";
import { AnthropicUsageTracker } from "./anthropicUsage";
import { sseData } from "./provider/sse";
import { CLAUDE_OAUTH_CONFIG as ANTHROPIC, buildClaudeAuthorizationUrl, buildClaudeMessagesRequest, claudeOAuthHeaders } from "./oauth/claude";
import { CODEX_CONFIG as CODEX, codexHeaders, createCodexRequest, parseCodexStream, CodexProtocolError } from "./oauth/codex";
import { ANTIGRAVITY_CONFIG as ANTIGRAVITY, antigravityHeaders, toAntigravityRequest, parseAntigravityStream, resolveAntigravityProject, AntigravityProtocolError } from "./oauth/antigravity";
import type { ModelParams, SamplingParams } from "./provider/types";

export type {
  OAuthKind,
  OAuthAccount,
  OAuthBalanceStrategy,
  OAuthLimit,
  OAuthUsage,
  OAuthAccountInfo,
  OAuthStatus,
} from "./oauth/types";
import type {
  OAuthKind,
  OAuthAccount,
  OAuthBalanceStrategy,
  OAuthLimit,
  OAuthUsage,
  OAuthAccountInfo,
  OAuthStatus,
} from "./oauth/types";

export const BALANCE_LABELS: Record<OAuthBalanceStrategy, string> = {
  "first": "First account",
  "round-robin": "Round robin",
  "highest-limit": "Highest remaining limit",
  "nearest-reset": "Nearest reset time",
};

export const OAUTH_LABEL: Record<OAuthKind, string> = { "claude-code": "Claude Code", codex: "OpenAI Codex", antigravity: "Google Antigravity" };

const redirectUri = (k: OAuthKind) =>
  k === "claude-code" ? `http://localhost:${ANTHROPIC.port}${ANTHROPIC.path}`
  : k === "codex" ? `http://localhost:${CODEX.port}${CODEX.path}`
  : `http://localhost:${ANTIGRAVITY.port}${ANTIGRAVITY.path}`;

// ---- Module state ----

let ctx: vscode.ExtensionContext | undefined;
/** Live in-memory accounts keyed by account id. */
const accounts = new Map<string, OAuthAccount>();
let pendingKind: OAuthKind | undefined;
const loginErrors: Partial<Record<OAuthKind, string>> = {};
const emitter = new vscode.EventEmitter<OAuthStatus>();
export const onOAuthStatus = emitter.event;
interface LoginAttempt {
  verifier: string;
  state: string;
  server: http.Server;
  authorizationUrl: string;
  callbackError?: string;
  browserError?: string;
  completing?: boolean;
}
/** In-flight login state stays local; only its browser link is exposed to the UI. */
const pending = new Map<OAuthKind, LoginAttempt>();
/** Single-flight refresh lock per account id (Codex rotates refresh tokens). */
const refreshing = new Map<string, Promise<OAuthAccount>>();
const resolvingProjects = new Map<string, Promise<OAuthAccount>>();
let persistence: Promise<void> = Promise.resolve();

/** Index of account ids persisted in globalState. */
const INDEX_KEY = "ocursor.oauth.accountIds";
const SECRET_KEY = (id: string) => `ocursor.oauth.acct.${id}`;

export function initOAuth(context: vscode.ExtensionContext) {
  ctx = context;
  const ids = ctx.globalState.get<string[]>(INDEX_KEY, []) ?? [];
  void Promise.all(ids.map(async (id) => {
    const raw = await ctx?.secrets.get(SECRET_KEY(id));
    if (!raw) return;
    try {
      const acc = JSON.parse(raw) as OAuthAccount;
      accounts.set(acc.id, acc);
    } catch {
      /* skip corrupt */
    }
  })).then(() => emit());
}

function info(acc: OAuthAccount): OAuthAccountInfo {
  return { id: acc.id, kind: acc.kind, email: acc.email, accountId: acc.accountId, disabled: acc.disabled };
}

function emit() {
  emitter.fire(getStatus());
}

export function getStatus(): OAuthStatus {
  return { accounts: [...accounts.values()].map(info), pending: pendingKind,
    ...(pendingKind && pending.get(pendingKind) ? { authorizationUrl: pending.get(pendingKind)!.authorizationUrl } : {}),
    errors: { ...loginErrors }, balanceStrategy: getBalanceStrategy() };
}

// ---- Enable/disable + load balancing ----

const STRATEGY_KEY = "ocursor.oauth.balanceStrategy";
/** Round-robin cursor per kind (session-scoped). */
const rrCursor = new Map<OAuthKind, number>();

export function getBalanceStrategy(): OAuthBalanceStrategy {
  return ctx?.globalState.get<OAuthBalanceStrategy>(STRATEGY_KEY) ?? "first";
}

export async function setBalanceStrategy(s: OAuthBalanceStrategy) {
  await ctx?.globalState.update(STRATEGY_KEY, s);
  emit();
}

export async function setAccountEnabled(id: string, enabled: boolean) {
  const acc = accounts.get(id);
  if (!acc) return;
  await saveAccount({ ...acc, disabled: !enabled });
  emit();
}

/** Enabled accounts of a kind, in insertion order. */
function enabledOfKind(kind: OAuthKind): OAuthAccount[] {
  return [...accounts.values()].filter((a) => a.kind === kind && !a.disabled);
}

/** Pick the account to use for a request, honoring the balance strategy. */
async function pickAccount(kind: OAuthKind): Promise<OAuthAccount | undefined> {
  const pool = enabledOfKind(kind);
  if (pool.length <= 1) return pool[0];
  const strategy = getBalanceStrategy();
  if (strategy === "round-robin") {
    const i = (rrCursor.get(kind) ?? -1) + 1;
    rrCursor.set(kind, i);
    return pool[i % pool.length];
  }
  if (strategy === "highest-limit" || strategy === "nearest-reset") {
    // Score each account by its limits; fall back to first on any failure.
    const scored = await Promise.all(pool.map(async (a) => {
      try {
        const u = await getAccountLimits(a.id);
        const remaining = u.limits.length ? Math.min(...u.limits.map((l) => l.remaining)) : 100;
        const resetAt = Math.min(...u.limits.map((l) => l.resetsAt ?? Number.MAX_SAFE_INTEGER));
        return { a, remaining, resetAt };
      } catch {
        return { a, remaining: -1, resetAt: Number.MAX_SAFE_INTEGER };
      }
    }));
    if (strategy === "highest-limit") scored.sort((x, y) => y.remaining - x.remaining);
    else scored.sort((x, y) => x.resetAt - y.resetAt);
    return scored[0]?.a ?? pool[0];
  }
  return pool[0];
}

export function listAccounts(): OAuthAccountInfo[] {
  return [...accounts.values()].map(info);
}

/** Any enabled account of the given kind connected? */
export function isConnected(kind: OAuthKind): boolean {
  return [...accounts.values()].some((a) => a.kind === kind && !a.disabled);
}

export function hasAnyAccount(): boolean {
  return accounts.size > 0;
}

// ---- PKCE ----

const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
function pkce() {
  const verifier = b64url(crypto.randomBytes(96));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

// ---- Persistence ----

async function saveAccount(acc: OAuthAccount) {
  accounts.set(acc.id, acc);
  const context = ctx;
  const ids = [...accounts.keys()];
  const raw = JSON.stringify(acc);
  const write = persistence.then(async () => {
    await context?.secrets.store(SECRET_KEY(acc.id), raw);
    await context?.globalState.update(INDEX_KEY, ids);
  });
  persistence = write.catch(() => {});
  await write;
}

export async function disconnect(id: string) {
  accounts.delete(id);
  const context = ctx;
  const ids = [...accounts.keys()];
  const write = persistence.then(async () => {
    await context?.secrets.delete(SECRET_KEY(id));
    await context?.globalState.update(INDEX_KEY, ids);
  });
  persistence = write.catch(() => {});
  await write;
  emit();
}

// ---- Login flow (loopback redirect) ----

export async function login(kind: OAuthKind) {
  // The UI has one active sign-in. A replacement must invalidate all older callbacks.
  for (const active of pending.keys()) cancelLogin(active);
  delete loginErrors[kind];

  const { verifier, challenge } = pkce();
  const state = crypto.randomBytes(16).toString("hex");
  const cfg = kind === "claude-code" ? ANTHROPIC : kind === "codex" ? CODEX : ANTIGRAVITY;

  const server = http.createServer(async (req, res) => {
    const reply = (status: number, text: string) => res.writeHead(status, { "content-type": "text/plain; charset=utf-8" }).end(text);
    try {
      const url = new URL(req.url || "/", `http://localhost:${cfg.port}`);
      if (url.pathname !== cfg.path) { reply(404, "Not found"); return; }
      if (pending.get(kind) !== attempt || attempt.completing) { reply(409, "This sign-in attempt is no longer waiting for a callback."); return; }
      const code = url.searchParams.get("code") || "";
      const retState = url.searchParams.get("state") || "";
      if (!retState || retState !== attempt.state) { reply(400, "OAuth state mismatch. Return to OpenCursor and use the current sign-in link."); return; }
      if (url.searchParams.has("error")) {
        clearLoginAttempt(kind, attempt);
        loginErrors[kind] = "Sign-in was declined or cancelled in the browser. Add the account again to retry.";
        emit();
        reply(400, "Sign-in was not completed. Return to OpenCursor to try again.");
        return;
      }
      if (!code) { reply(400, "No authorization code returned. Finish signing in and try again."); return; }
      await finishLoginAttempt(kind, attempt, code, retState);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(
        "<html><body style='font-family:sans-serif;padding:40px'><h2>Login successful</h2><p>You can close this tab and return to VS Code.</p></body></html>"
      );
    } catch {
      reply(400, "Sign-in failed. Return to OpenCursor to see the error and try again.");
    }
  });
  const attempt: LoginAttempt = { verifier, state, server, authorizationUrl: buildAuthUrl(kind, challenge, state) };
  pending.set(kind, attempt);
  pendingKind = kind;
  emit();

  // A failed local listener must not prevent browser sign-in or manual callback entry.
  server.on("error", (error: NodeJS.ErrnoException) => {
    if (pending.get(kind) !== attempt) return;
    attempt.callbackError = error.code === "EADDRINUSE"
      ? `Port ${cfg.port} is already in use. After signing in, paste the full callback URL from your browser below.`
      : `The local sign-in callback could not start${error.code ? ` (${error.code})` : ""}. After signing in, paste the full callback URL from your browser below.`;
    updateLoginError(kind, attempt);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const settle = (error?: Error) => {
        server.removeListener("error", fail);
        server.removeListener("close", closed);
        if (error) reject(error);
        else resolve();
      };
      const fail = (error: Error) => settle(error);
      const closed = () => settle();
      server.once("error", fail);
      server.once("close", closed);
      try { server.listen(cfg.port, "127.0.0.1", () => settle()); }
      catch (error) { settle(error instanceof Error ? error : new Error(String(error))); }
    });
  } catch {
    if (pending.get(kind) === attempt && !attempt.callbackError) {
      attempt.callbackError = "The local sign-in callback could not start. After signing in, paste the full callback URL from your browser below.";
      updateLoginError(kind, attempt);
    }
  }
  if (pending.get(kind) !== attempt) { closeLoginServer(attempt); return; }
  await openLoginInBrowser(kind);
}

function closeLoginServer(attempt: LoginAttempt) {
  try { attempt.server.close(); } catch { /* A failed listener may never have started. */ }
}

function clearLoginAttempt(kind: OAuthKind, attempt: LoginAttempt) {
  if (pending.get(kind) === attempt) {
    pending.delete(kind);
    if (pendingKind === kind) pendingKind = undefined;
  }
  closeLoginServer(attempt);
}

function updateLoginError(kind: OAuthKind, attempt: LoginAttempt) {
  if (pending.get(kind) !== attempt) return;
  const error = [attempt.callbackError, attempt.browserError].filter(Boolean).join(" ");
  if (error) loginErrors[kind] = error;
  else delete loginErrors[kind];
  emit();
}

/** Retry the current link without replacing its PKCE verifier or state. */
export async function openLoginInBrowser(kind: OAuthKind): Promise<void> {
  const attempt = pending.get(kind);
  if (!attempt) throw new Error("No login in progress — click Add account first");
  if (attempt.completing) throw new Error("Sign-in is already being completed.");
  try {
    const opened = await vscode.env.openExternal(vscode.Uri.parse(attempt.authorizationUrl));
    attempt.browserError = opened ? undefined : "VS Code could not open your browser. Use Copy link and open it in your browser manually.";
  } catch {
    attempt.browserError = "VS Code could not open your browser. Use Copy link and open it in your browser manually.";
  }
  updateLoginError(kind, attempt);
}

export function cancelLogin(kind: OAuthKind) {
  const attempt = pending.get(kind);
  if (attempt) clearLoginAttempt(kind, attempt);
  delete loginErrors[kind];
  emit();
}

async function finishLoginAttempt(kind: OAuthKind, attempt: LoginAttempt, code: string, retState: string) {
  if (pending.get(kind) !== attempt || attempt.completing) throw new Error("This sign-in attempt is no longer waiting for a callback.");
  // Invalid pasted callbacks must not consume the current login session.
  if (!code || retState !== attempt.state) {
    loginErrors[kind] = !code ? "No authorization code returned" : "OAuth state mismatch";
    emit();
    throw new Error(loginErrors[kind]);
  }
  attempt.completing = true;
  closeLoginServer(attempt);
  try {
    await completeLogin(kind, code, retState, attempt.state, attempt.verifier, () => pending.get(kind) === attempt);
    if (pending.get(kind) === attempt) {
      clearLoginAttempt(kind, attempt);
      delete loginErrors[kind];
      emit();
    }
  } catch (error) {
    if (pending.get(kind) === attempt) {
      clearLoginAttempt(kind, attempt);
      loginErrors[kind] = error instanceof Error ? error.message : String(error);
      emit();
    }
    throw error;
  }
}

/**
 * Manual fallback: the user pastes the callback URL (or just "code#state" /
 * the raw code) when the loopback redirect never reaches us.
 */
export async function completeManual(kind: OAuthKind, pasted: string): Promise<void> {
  const p = pending.get(kind);
  if (!p) throw new Error("No login in progress — click Add account first");
  let code = "";
  let retState = p.state;
  const text = pasted.trim();
  try {
    const url = new URL(text);
    code = url.searchParams.get("code") || "";
    retState = url.searchParams.get("state") || "";
  } catch {
    // Not a URL — accept "code#state" (Anthropic's copy box) or a bare code.
    const [c, s] = text.split("#");
    code = c;
    if (s !== undefined) retState = s;
  }
  await finishLoginAttempt(kind, p, code, retState);
}

function buildAuthUrl(kind: OAuthKind, challenge: string, state: string): string {
  if (kind === "claude-code") {
    return buildClaudeAuthorizationUrl({ challenge, state, redirectUri: redirectUri(kind) });
  }
  if (kind === "antigravity") {
    // Standard Google OAuth2 code flow (no PKCE; uses client secret).
    const params = new URLSearchParams({
      client_id: ANTIGRAVITY.clientId,
      response_type: "code",
      redirect_uri: redirectUri(kind),
      scope: ANTIGRAVITY.scopes.join(" "),
      state,
      access_type: "offline",
      prompt: "consent",
    });
    return `${ANTIGRAVITY.authUrl}?${params.toString()}`;
  }
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CODEX.clientId,
    redirect_uri: redirectUri(kind),
    scope: CODEX.scope,
    code_challenge: challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state,
    originator: CODEX.originator,
  });
  return `${CODEX.authUrl}?${params.toString()}`;
}

async function completeLogin(kind: OAuthKind, code: string, retState: string, expectState: string, verifier: string, isCurrent: () => boolean) {
  if (!code) throw new Error("No authorization code returned");
  if (retState !== expectState) throw new Error("OAuth state mismatch");
  const acc = kind === "claude-code" ? await exchangeAnthropic(code, verifier, expectState)
    : kind === "codex" ? await exchangeCodex(code, verifier)
    : await exchangeAntigravity(code);
  if (!isCurrent()) throw new Error("This sign-in attempt was cancelled or replaced. Use the current sign-in link.");
  await saveAccount(acc);
}

// ---- Token exchange / refresh ----

function decodeJwt(token: string): any {
  try {
    const payload = token.split(".")[1];
    const json = Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    return JSON.parse(json);
  } catch {
    return {};
  }
}

/** Decode identity hints locally; authentication is still performed upstream. */
function codexIdentity(tokens: { id_token?: string; access_token?: string }) {
  const claims = decodeJwt(tokens.id_token || "");
  const access = decodeJwt(tokens.access_token || "");
  const auth = claims["https://api.openai.com/auth"] || {};
  const accessAuth = access["https://api.openai.com/auth"] || {};
  return {
    accountId: auth.chatgpt_account_id || claims.chatgpt_account_id || claims.account_id || accessAuth.chatgpt_account_id,
    email: claims.email || access.email || access.preferred_username,
  };
}

function tokenExpiry(data: any): number {
  if (typeof data?.access_token !== "string" || !data.access_token.trim()) {
    throw new Error("OAuth response did not include an access token");
  }
  const seconds = Number(data.expires_in ?? 3600);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("OAuth response included an invalid token expiry");
  return Date.now() + seconds * 1000;
}

/** Build a stable account id; fall back to a random suffix if no native id. */
function accountId(kind: OAuthKind, nativeId?: string): string {
  return `${kind}:${nativeId || crypto.randomBytes(6).toString("hex")}`;
}

async function exchangeAnthropic(code: string, verifier: string, state: string): Promise<OAuthAccount> {
  const r = await fetch(ANTHROPIC.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
    body: JSON.stringify({
      code,
      grant_type: "authorization_code",
      client_id: ANTHROPIC.clientId,
      redirect_uri: redirectUri("claude-code"),
      code_verifier: verifier,
      state,
    }),
  });
  if (!r.ok) throw new Error(`Anthropic token exchange ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const d: any = await r.json();
  const acctUuid = d.account?.uuid;
  return {
    id: accountId("claude-code", acctUuid),
    kind: "claude-code",
    accessToken: d.access_token,
    refreshToken: d.refresh_token,
    expiresAt: tokenExpiry(d),
    email: d.account?.email_address,
    accountId: acctUuid,
  };
}

async function exchangeCodex(code: string, verifier: string): Promise<OAuthAccount> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri("codex"),
    client_id: CODEX.clientId,
    code_verifier: verifier,
  });
  const r = await fetch(CODEX.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
    body: body.toString(),
  });
  if (!r.ok) throw new Error(`Codex token exchange ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const d: any = await r.json();
  const identity = codexIdentity(d);
  return {
    id: accountId("codex", identity.accountId),
    kind: "codex",
    accessToken: d.access_token,
    refreshToken: d.refresh_token,
    idToken: d.id_token,
    expiresAt: tokenExpiry(d),
    email: identity.email,
    accountId: identity.accountId,
  };
}

async function exchangeAntigravity(code: string): Promise<OAuthAccount> {
  const r = await fetch(ANTIGRAVITY.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: ANTIGRAVITY.clientId,
      client_secret: ANTIGRAVITY.clientSecret,
      code,
      redirect_uri: redirectUri("antigravity"),
    }).toString(),
  });
  if (!r.ok) throw new Error(`Antigravity token exchange ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const d: any = await r.json();
  const expiresAt = tokenExpiry(d);
  const token = d.access_token as string;

  // Identify the user + resolve the Google Cloud project for Code Assist.
  let email: string | undefined;
  try {
    const ui = await fetch(`${ANTIGRAVITY.userInfoUrl}?alt=json`, { headers: { authorization: `Bearer ${token}`, accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    if (ui.ok) email = ((await ui.json()) as any)?.email;
  } catch { /* non-fatal */ }

  const { projectId } = await resolveAntigravityProject(token, { signal: AbortSignal.timeout(30_000) });

  return {
    id: accountId("antigravity", email || projectId),
    kind: "antigravity",
    accessToken: token,
    refreshToken: d.refresh_token,
    expiresAt,
    email,
    accountId: email,
    projectId,
  };
}

async function refreshAccount(acc: OAuthAccount): Promise<OAuthAccount> {
  const existing = refreshing.get(acc.id);
  if (existing) return existing;
  const p = (async () => {
    if (!acc.refreshToken) throw new Error(`${OAUTH_LABEL[acc.kind]} needs to be reconnected: no refresh token`);
    let next: OAuthAccount;
    if (acc.kind === "claude-code") {
      const r = await fetch(ANTHROPIC.tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({ client_id: ANTHROPIC.clientId, grant_type: "refresh_token", refresh_token: acc.refreshToken }),
      });
      if (!r.ok) throw new Error(`Anthropic refresh ${r.status}: ${(await r.text()).slice(0, 200)}`);
      const d: any = await r.json();
      next = { ...acc, accessToken: d.access_token, refreshToken: d.refresh_token || acc.refreshToken, expiresAt: tokenExpiry(d) };
    } else if (acc.kind === "antigravity") {
      const r = await fetch(ANTIGRAVITY.tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        signal: AbortSignal.timeout(30_000),
        body: new URLSearchParams({ grant_type: "refresh_token", client_id: ANTIGRAVITY.clientId, client_secret: ANTIGRAVITY.clientSecret, refresh_token: acc.refreshToken }).toString(),
      });
      if (!r.ok) throw new Error(`Antigravity refresh ${r.status}: ${(await r.text()).slice(0, 200)}`);
      const d: any = await r.json();
      next = { ...acc, accessToken: d.access_token, refreshToken: d.refresh_token || acc.refreshToken, expiresAt: tokenExpiry(d) };
    } else {
      const r = await fetch(CODEX.tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({ client_id: CODEX.clientId, grant_type: "refresh_token", refresh_token: acc.refreshToken }),
      });
      if (!r.ok) throw new Error(`Codex refresh ${r.status}: ${(await r.text()).slice(0, 200)}`);
      const d: any = await r.json();
      const identity = codexIdentity(d);
      next = { ...acc, accessToken: d.access_token, refreshToken: d.refresh_token || acc.refreshToken, idToken: d.id_token || acc.idToken,
        accountId: identity.accountId || acc.accountId, email: identity.email || acc.email, expiresAt: tokenExpiry(d) };
    }
    // A delayed refresh must not reconnect a removed account or undo a toggle.
    const current = accounts.get(acc.id);
    if (!current) throw new Error(`Account ${acc.id} is no longer connected`);
    if (current.accessToken !== acc.accessToken || current.refreshToken !== acc.refreshToken) return current;
    next.disabled = current.disabled;
    await saveAccount(next);
    delete loginErrors[acc.kind];
    const saved = accounts.get(acc.id);
    if (!saved) throw new Error(`Account ${acc.id} is no longer connected`);
    return saved;
  })();
  refreshing.set(acc.id, p);
  try {
    return await p;
  } finally {
    refreshing.delete(acc.id);
  }
}

/** Return an account with a fresh access token (refreshing if near expiry). */
async function validAccount(id: string): Promise<OAuthAccount> {
  const acc = accounts.get(id);
  if (!acc) throw new Error(`Account ${id} is not connected`);
  // Refresh 5 min before expiry.
  if (!acc.accessToken || !Number.isFinite(acc.expiresAt) || Date.now() > acc.expiresAt - 5 * 60 * 1000) {
    try {
      return await refreshAccount(acc);
    } catch (e) {
      loginErrors[acc.kind] = String((e as any)?.message || e);
      emit();
      throw e;
    }
  }
  return acc;
}

/** A caller may stop waiting without cancelling another request's token rotation. */
async function waitForAccount<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  let abort: () => void = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([work, cancelled]); }
  finally { signal.removeEventListener("abort", abort); }
}

/** Replay a rejected request once, sharing rotated tokens across concurrent calls. */
async function oauthFetch(id: string, build: (account: OAuthAccount) => { url: string; init: RequestInit }, signal?: AbortSignal): Promise<Response> {
  signal?.throwIfAborted();
  const account = await waitForAccount(validAccount(id), signal);
  signal?.throwIfAborted();
  if (!accounts.has(id)) throw new Error(`Account ${id} is no longer connected`);
  const request = build(account);
  const init = { ...request.init, signal: signal ?? request.init.signal ?? AbortSignal.timeout(30_000) };
  const response = await fetch(request.url, init);
  if (response.status !== 401 || !account.refreshToken) return response;
  await response.body?.cancel().catch(() => {});
  signal?.throwIfAborted();
  const current = accounts.get(id);
  if (!current) throw new Error(`Account ${id} is no longer connected`);
  const fresh = await waitForAccount(current.accessToken !== account.accessToken ? validAccount(id) : refreshAccount(current), signal);
  signal?.throwIfAborted();
  if (!accounts.has(id)) throw new Error(`Account ${id} is no longer connected`);
  const headers = Object.fromEntries(new Headers(init.headers).entries());
  headers.authorization = `Bearer ${fresh.accessToken}`;
  if (fresh.kind === "codex") {
    delete headers["chatgpt-account-id"];
    if (fresh.accountId) headers["chatgpt-account-id"] = fresh.accountId;
  }
  return fetch(request.url, { ...init, headers });
}

async function ensureAntigravityProject(id: string, signal?: AbortSignal): Promise<OAuthAccount> {
  signal?.throwIfAborted();
  const account = await waitForAccount(validAccount(id), signal);
  if (account.projectId?.trim()) return account;
  let work = resolvingProjects.get(id);
  if (!work) {
    work = (async () => {
      const deadline = AbortSignal.timeout(30_000);
      const project = await resolveAntigravityProject(account.accessToken, {
        signal: deadline,
        fetch: (url, init) => oauthFetch(id, (fresh) => ({ url: String(url), init: {
          ...init, headers: antigravityHeaders(fresh.accessToken, { purpose: "project" }),
        } }), deadline),
      });
      const current = accounts.get(id);
      if (!current) throw new Error(`Account ${id} is no longer connected`);
      const next = { ...current, projectId: project.projectId };
      await saveAccount(next);
      return next;
    })().finally(() => resolvingProjects.delete(id));
    resolvingProjects.set(id, work);
  }
  return waitForAccount(work, signal);
}

/** First enabled account of a kind (default for routing). */
function firstOfKind(kind: OAuthKind): OAuthAccount | undefined {
  return [...accounts.values()].find((a) => a.kind === kind && !a.disabled);
}

// ---- Usage limits ----

const QUOTA_TIMEOUT_MS = 20_000;

/** One deadline covers credential/project waits, transport, and response-body reads. */
async function quotaOperation<T>(label: string, parent: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const cancel = () => controller.abort(new DOMException(`${label} cancelled`, "AbortError"));
  const timer = setTimeout(() => controller.abort(new DOMException(`${label} timed out after 20 seconds`, "TimeoutError")), QUOTA_TIMEOUT_MS);
  timer.unref?.();
  if (parent?.aborted) cancel();
  else parent?.addEventListener("abort", cancel, { once: true });
  try {
    controller.signal.throwIfAborted();
    // Shared token refresh/project discovery has its own deadline and may still
    // serve other callers; cancelling this view stops its wait, not that work.
    return await waitForAccount(Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return work(controller.signal);
    }), controller.signal);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener("abort", cancel);
  }
}

async function quotaJson(response: Response, label: string, signal?: AbortSignal): Promise<any> {
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`${label} HTTP ${response.status}`);
  }
  try {
    const data: unknown = await waitForAccount(response.json(), signal);
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Expected an object");
    return data;
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof SyntaxError) throw new Error(`${label} returned an invalid JSON response`);
    throw new Error(`${label} response could not be read`);
  }
}

/** Parse a reset value (epoch s/ms or ISO string) into epoch ms. */
function parseResetMs(v: unknown): number | undefined {
  if (v == null) return undefined;
  if (typeof v === "number") return v < 1e12 ? v * 1000 : v;
  if (typeof v === "string") {
    if (/^\d+$/.test(v)) { const n = Number(v); return n < 1e12 ? n * 1000 : n; }
    const t = Date.parse(v);
    return Number.isNaN(t) ? undefined : t;
  }
  return undefined;
}

export async function getAccountLimits(id: string, signal?: AbortSignal): Promise<OAuthUsage> {
  return quotaOperation("Quota refresh", signal, async deadline => {
    const fresh = await waitForAccount(validAccount(id), deadline);
    deadline.throwIfAborted();
    if (!accounts.has(id)) throw new Error(`Account ${id} is no longer connected`);
    const usage = fresh.kind === "claude-code" ? { limits: await getClaudeLimits(fresh, deadline) }
      : fresh.kind === "antigravity" ? { limits: await getAntigravityLimits(fresh, deadline) }
      : await getCodexUsage(fresh, deadline);
    // A response for an account removed while the request ran must not become
    // a fresh quota snapshot in the settings panel's cache.
    if (!accounts.has(id)) throw new Error(`Account ${id} is no longer connected`);
    return usage;
  });
}

// Claude Code usage: % utilization per rolling window (5h + weekly).
async function getClaudeLimits(acc: OAuthAccount, signal?: AbortSignal): Promise<OAuthLimit[]> {
  const r = await oauthFetch(acc.id, (fresh) => ({ url: ANTHROPIC.usageUrl, init: { method: "GET", headers: claudeOAuthHeaders(fresh.accessToken) } }), signal);
  const d = await quotaJson(r, "Claude usage", signal);
  const out: OAuthLimit[] = [];
  const win = (w: any, label: string) => {
    if (!w || typeof w.utilization !== "number") return;
    out.push({ label, remaining: Math.max(0, 100 - Math.round(w.utilization)), limit: 100, resetsAt: parseResetMs(w.resets_at) });
  };
  win(d.five_hour, "Session (5h)");
  win(d.seven_day, "Weekly (7d)");
  for (const [k, v] of Object.entries(d)) {
    if (k.startsWith("seven_day_") && k !== "seven_day") win(v, `Weekly ${k.slice("seven_day_".length)} (7d)`);
  }
  return out;
}

// Codex usage: rate_limit primary/secondary windows + available reset credits.
async function getCodexUsage(acc: OAuthAccount, signal?: AbortSignal): Promise<OAuthUsage> {
  const r = await oauthFetch(acc.id, (fresh) => ({ url: "https://chatgpt.com/backend-api/wham/usage", init: { method: "GET", headers: codexHeaders(fresh) } }), signal);
  const d = await quotaJson(r, "Codex usage", signal);
  const rl = d.rate_limit ?? d.rate_limits ?? d.rate_limits_by_limit_id?.codex ?? d;
  const limits: OAuthLimit[] = [];
  const win = (w: any, label: string) => {
    if (!w) return;
    const used = Number(w.used_percent ?? w.percent_used ?? 0);
    limits.push({ label, remaining: Math.max(0, Math.min(100, 100 - Math.round(used))), limit: 100, resetsAt: parseResetMs(w.reset_at ?? w.resets_at ?? w.resetAt) });
  };
  win(rl.primary_window ?? rl.primary, "Session (5h)");
  win(rl.secondary_window ?? rl.secondary, "Weekly");
  const resetCredits = Math.max(0, Number(d.rate_limit_reset_credits?.available_count ?? 0));
  return { limits, resetCredits };
}

/** Spend one Codex rate-limit reset credit (irreversible). Returns true on success. */
export async function consumeCodexResetCredit(id: string, signal?: AbortSignal): Promise<{ ok: boolean; message?: string }> {
  const acc = accounts.get(id);
  if (!acc) return { ok: false, message: "This account is no longer connected" };
  if (acc.kind !== "codex") return { ok: false, message: "Not a Codex account" };
  let dispatched = false;
  try {
    return await quotaOperation("Codex reset credit", signal, async deadline => {
      await waitForAccount(validAccount(id), deadline);
      deadline.throwIfAborted();
      const fresh = accounts.get(id);
      if (!fresh || fresh.kind !== "codex") throw new Error(`Account ${id} is no longer connected`);
      const redeemId = crypto.randomUUID();
      // This mutation is deliberately sent once. Never use the oauthFetch
      // 401 replay path or retry an ambiguous network/body failure here.
      dispatched = true;
      const r = await fetch("https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume", {
        method: "POST",
        headers: codexHeaders(fresh),
        body: JSON.stringify({ redeem_request_id: redeemId }),
        signal: deadline,
      });
      const text = await waitForAccount(r.text(), deadline);
      let data: any;
      try { data = text ? JSON.parse(text) : null; }
      catch {
        if (!r.ok) return { ok: false, message: `Codex reset credit HTTP ${r.status}` };
        throw new Error("Codex reset credit returned an invalid JSON response");
      }
      const message = typeof data?.message === "string" ? data.message.slice(0, 500) : undefined;
      if (!r.ok) return { ok: false, message: `Codex reset credit HTTP ${r.status}${message ? `: ${message}` : ""}` };
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Codex reset credit returned an empty or invalid response");
      const windowsReset = Number(data.windows_reset ?? 0);
      const ok = data.code === "reset" || Number.isFinite(windowsReset) && windowsReset > 0;
      return { ok, message: message || (data.code === "no_credit" ? "No reset credits available"
        : ok ? undefined : "The provider did not confirm a reset. Refresh usage before trying again.") };
    });
  } catch (error) {
    if (!dispatched) throw error;
    const failure = new Error(`${error instanceof Error ? error.message : "Codex reset credit failed"}. The request may have consumed a credit. Refresh usage before trying again.`);
    failure.name = error instanceof Error ? error.name : "Error";
    throw failure;
  }
}

// Antigravity usage: per-model remainingFraction via fetchAvailableModels.
async function getAntigravityLimits(acc: OAuthAccount, signal?: AbortSignal): Promise<OAuthLimit[]> {
  await ensureAntigravityProject(acc.id, signal);
  const r = await oauthFetch(acc.id, (fresh) => ({ url: ANTIGRAVITY.quotaUrl, init: {
    method: "POST", headers: antigravityHeaders(fresh.accessToken, { purpose: "catalog" }),
    body: JSON.stringify({ project: fresh.projectId }),
  } }), signal);
  const d = await quotaJson(r, "Antigravity usage", signal);
  const out: OAuthLimit[] = [];
  for (const [key, info] of Object.entries<any>(d.models ?? {})) {
    if (!info?.quotaInfo || info.isInternal) continue;
    const remaining = Number(info.quotaInfo.remainingFraction ?? 0);
    out.push({ label: info.displayName || key, remaining: Math.max(0, Math.min(100, Math.round(remaining * 100))), limit: 100, resetsAt: parseResetMs(info.quotaInfo.resetTime) });
  }
  return out;
}

// ---- Model listing ----

export async function listOAuthModels(kind: OAuthKind): Promise<string[]> {
  if (kind === "claude-code") {
    const curated = [...ANTHROPIC.models];
    const acc = firstOfKind("claude-code");
    if (!acc) return curated;
    try {
      // /v1/models is reachable with the OAuth bearer + oauth beta header.
      const r = await oauthFetch(acc.id, (fresh) => ({ url: ANTHROPIC.modelsUrl, init: { method: "GET", headers: claudeOAuthHeaders(fresh.accessToken) } }));
      if (r.ok) {
        const d: any = await r.json();
        const ids = (d?.data ?? []).map((m: any) => m.id).filter(Boolean) as string[];
        if (ids.length) {
          // Prefetch may omit brand-new aliases; always keep curated IDs first.
          const seen = new Set<string>();
          const merged: string[] = [];
          for (const id of [...curated, ...ids]) {
            if (seen.has(id)) continue;
            seen.add(id);
            merged.push(id);
          }
          return merged;
        }
      }
    } catch {
      /* fall through to preset */
    }
    return curated;
  }
  if (kind === "antigravity") {
    const acc = firstOfKind("antigravity");
    if (!acc) return [...ANTIGRAVITY.models];
    try {
      await ensureAntigravityProject(acc.id);
      const r = await oauthFetch(acc.id, (fresh) => ({ url: ANTIGRAVITY.quotaUrl, init: {
        method: "POST", headers: antigravityHeaders(fresh.accessToken, { purpose: "catalog" }),
        body: JSON.stringify({ project: fresh.projectId }),
      } }));
      if (r.ok) {
        const d: any = await r.json();
        const ids = Object.entries<any>(d.models ?? {})
          .filter(([, info]) => info?.quotaInfo && !info.isInternal)
          .map(([id]) => id);
        if (ids.length) return ids;
      }
    } catch {
      /* fall through to preset */
    }
    return [...ANTIGRAVITY.models];
  }
  const acc = firstOfKind("codex");
  if (!acc) return [...CODEX.fallbackModels];
  try {
    const r = await oauthFetch(acc.id, (fresh) => ({
      url: `${CODEX.modelsUrl}?client_version=${encodeURIComponent(CODEX.cliVersion)}`,
      init: { method: "GET", headers: codexHeaders(fresh) },
    }));
    if (r.ok) {
      const d: any = await r.json();
      const ids = (d?.models ?? []).map((m: any) => m.slug).filter(Boolean);
      if (ids.length) return ids;
    }
  } catch {
    /* fall through to fallback list */
  }
  return [...CODEX.fallbackModels];
}

/** Whether a model id belongs to a connected OAuth provider. */
export async function oauthKindForModel(modelId: string): Promise<OAuthKind | undefined> {
  if (isConnected("claude-code") && /^claude-/i.test(modelId)) return "claude-code";
  if (isConnected("codex") && /^(gpt-[56](\.|-|$)|o\d|codex-)/i.test(modelId)) return "codex";
  return undefined;
}

// ---- Chat streaming ----

export async function* streamOAuthChat(kind: OAuthKind, opts: {
  model: string;
  messages: WireMessage[];
  tools?: ToolSchema[];
  maxTokens?: number;
  promptCacheKey?: string;
  modelParams?: { thinking?: string; reasoningEffort?: string; maxContext?: string };
  temperature?: number;
  sampling?: SamplingParams;
  signal: AbortSignal;
}): AsyncGenerator<ProviderEvent> {
  opts.signal.throwIfAborted();
  const acc = (await waitForAccount(pickAccount(kind), opts.signal)) ?? firstOfKind(kind);
  opts.signal.throwIfAborted();
  if (!acc) throw new Error(`${OAUTH_LABEL[kind]} is not connected`);
  if (kind === "claude-code") return yield* streamClaudeCode(acc.id, opts);
  if (kind === "antigravity") return yield* streamAntigravity(acc.id, opts);
  return yield* streamCodex(acc.id, opts);
}

async function* streamClaudeCode(id: string, opts: Parameters<typeof buildClaudeMessagesRequest>[1]): AsyncGenerator<ProviderEvent> {
  const response = await oauthFetch(id, (account) => buildClaudeMessagesRequest(account.accessToken, opts), opts.signal);
  if (!response.ok || !response.body) {
    throw new ChatHTTPError(response.ok ? 502 : response.status, `claude-code ${response.status}: ${(await response.text().catch(() => "")).slice(0, 500)}`);
  }
  yield* parseAnthropicStream(response.body.getReader());
}

async function* streamCodex(id: string, opts: Parameters<typeof createCodexRequest>[0]): AsyncGenerator<ProviderEvent> {
  const response = await oauthFetch(id, (account) => createCodexRequest(opts, account), opts.signal);
  if (!response.ok || !response.body) {
    throw new ChatHTTPError(response.ok ? 502 : response.status, `codex ${response.status}: ${(await response.text().catch(() => "")).slice(0, 500)}`);
  }
  try { yield* parseCodexStream(response.body.getReader(), opts.signal, { provider: "codex", model: opts.model }); }
  catch (error) {
    if (error instanceof CodexProtocolError) throw new ChatHTTPError(error.status, error.message);
    throw error;
  }
}

async function* parseAnthropicStream(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncGenerator<ProviderEvent> {
  let finishReason = "stop";
  let finished = false;
  const usageTracker = new AnthropicUsageTracker();
  const toolBlocks: Record<number, { id: string; name: string; args: string }> = {};
  for await (const data of sseData(reader)) {
      if (!data || data === "[DONE]") continue;
      let chunk: any;
      try { chunk = JSON.parse(data); } catch { continue; }
      // Anthropic can stream a 200 OK then an in-band `error` event (overloaded,
      // invalid model, mid-stream effort/thinking rejection). Without this the
      // frame is silently dropped and the turn ends with no text and no error.
      if (chunk.type === "error") {
        const e = chunk.error ?? {};
        throw new ChatHTTPError(502, `claude-code stream error: ${e.type ?? "error"} — ${e.message ?? data.slice(0, 300)}`);
      }
      if (chunk.type === "content_block_start" && chunk.content_block?.type === "tool_use") {
        const cb = chunk.content_block;
        toolBlocks[chunk.index] = { id: cb.id, name: cb.name, args: "" };
        yield { type: "tool-call-start", index: chunk.index, id: cb.id || `call_${chunk.index}`, name: cb.name };
      } else if (chunk.type === "content_block_delta") {
        const d = chunk.delta;
        if (d?.type === "text_delta") yield { type: "text-delta", text: d.text };
        else if (d?.type === "thinking_delta") yield { type: "thinking-delta", text: d.thinking ?? d.text ?? "" };
        else if (d?.type === "input_json_delta") {
          const tb = toolBlocks[chunk.index];
          if (tb) { tb.args += d.partial_json ?? ""; yield { type: "tool-call-args-delta", index: chunk.index, delta: d.partial_json ?? "" }; }
        }
      } else if (chunk.type === "message_delta") {
        if (chunk.delta?.stop_reason) { finishReason = chunk.delta.stop_reason; finished = true; }
        const usage = usageTracker.update(chunk.usage);
        if (usage) yield usage;
      } else if (chunk.type === "message_stop") {
        finished = true;
      } else if (chunk.type === "message_start" && chunk.message?.usage) {
        const usage = usageTracker.update(chunk.message.usage);
        if (usage) yield usage;
      }
  }
  if (!finished) throw new ChatHTTPError(502, "claude-code stream ended before completion");
  for (const idx of Object.keys(toolBlocks).map(Number).sort((a, b) => a - b)) {
    const a = toolBlocks[idx];
    if (a.name) yield { type: "tool-call", call: { id: a.id || `call_${idx}`, name: a.name, arguments: a.args || "{}" } };
  }
  if (finishReason === "refusal") {
    throw new ChatHTTPError(400, "claude-code refused the request (safety classifier). Try Opus 5 or another model, or rephrase.");
  }
  yield { type: "done", finishReason };
}

// ---- Antigravity (Google Cloud Code, Gemini wire format) ----

async function* streamAntigravity(id: string, opts: {
  model: string;
  messages: WireMessage[];
  tools?: ToolSchema[];
  maxTokens?: number;
  modelParams?: ModelParams;
  sampling?: SamplingParams;
  temperature?: number;
  promptCacheKey?: string;
  signal: AbortSignal;
}): AsyncGenerator<ProviderEvent> {
  try {
    await ensureAntigravityProject(id, opts.signal);
    const sessionId = opts.promptCacheKey
      ? crypto.createHash("sha256").update(`${id}:${opts.promptCacheKey}`).digest().readBigUInt64BE().toString()
      : undefined;
    const response = await oauthFetch(id, (account) => ({
      url: `${ANTIGRAVITY.apiBase}/v1internal:streamGenerateContent?alt=sse`,
      init: {
        method: "POST",
        headers: antigravityHeaders(account.accessToken, { purpose: "generation" }),
        body: JSON.stringify(toAntigravityRequest({ ...opts, projectId: account.projectId!, sessionId })),
      },
    }), opts.signal);
    if (!response.ok || !response.body) {
      throw new ChatHTTPError(response.ok ? 502 : response.status, `antigravity ${response.status}: ${(await response.text().catch(() => "")).slice(0, 500)}`);
    }
    yield* parseAntigravityStream(response.body.getReader(), { signal: opts.signal });
  } catch (error) {
    if (error instanceof AntigravityProtocolError) throw new ChatHTTPError(error.status, error.message);
    throw error;
  }
}
