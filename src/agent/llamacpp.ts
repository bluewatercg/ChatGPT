/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

// llama.cpp local model manager.
// - Requires llama.cpp installed on the system (provides `llama-server`).
//   Windows: irm https://llama.app/install.ps1 | iex · Linux/Mac: curl -LsSf https://llama.app/install.sh | sh
// - Search/download GGUF models from the Hugging Face Hub (@huggingface/hub).
// - Import local .gguf files. Load/unload = spawn/kill a `llama-server` per model
//   on its own port, exposing an OpenAI-compatible endpoint at /v1.
// - ponytail: one server process per loaded model (simple). Upgrade to a single
//   server with model-swapping (`-hf` / slots) if RAM pressure matters.

import * as fs from "fs/promises";
import { createHash, randomUUID } from "crypto";
import * as path from "path";
import * as os from "os";
import * as net from "net";
import { spawn, execFile } from "child_process";
import * as vscode from "vscode";
import { importRuntimeDep } from "../runtimeDeps";

/**
 * llama-server launch configuration. Used both as the global default and as a
 * per-model override. Empty/undefined fields fall back to the global defaults,
 * then to llama-server's own defaults. See `tools/server/README.md`.
 */
export interface LlamacppServerConfig {
  /** Bind host (default 127.0.0.1). */
  host?: string;
  /** Bind port. 0/undefined → auto-assign from BASE_PORT. */
  port?: number;
  /** Prompt context size in tokens (-c). 0 = read from model. */
  ctxSize?: number;
  /** Use the jinja chat-template engine (--jinja). Recommended on. */
  jinja?: boolean;
  /** Flash attention (-fa): "on" | "off" | "auto". */
  flashAttn?: "on" | "off" | "auto";
  /** Layers to offload to VRAM (-ngl): a number, "auto", or "all". */
  nGpuLayers?: string;
  /** Generation threads (-t). */
  threads?: number;
  /** Parallel slots (--parallel). Splits ctx across concurrent requests. */
  parallel?: number;
  /** Logical batch size (-b). */
  batchSize?: number;
  /** Physical batch size (-ub). */
  ubatchSize?: number;
  /** KV cache K type (-ctk), e.g. "q8_0", "f16". */
  cacheTypeK?: string;
  /** KV cache V type (-ctv). */
  cacheTypeV?: string;
  /** Multimodal projector file (--mmproj) for vision models. */
  mmprojPath?: string;
  /** Draft model .gguf for speculative decoding / MTP (-md). */
  draftModelPath?: string;
  /** Tokens to draft per step (--spec-draft-n-max). */
  specDraftNMax?: number;
  /** Draft model GPU layers (-ngld). */
  draftNGpuLayers?: string;
  /** Disable mmap (--no-mmap). Helps on unified-memory machines. */
  noMmap?: boolean;
  /** Lock model in RAM (--mlock). */
  mlock?: boolean;
  /** Raw extra args appended verbatim (space-separated escape hatch). */
  extraArgs?: string;
}

export interface LlamacppModel {
  id: string;            // stable id (repo/file or imported basename)
  name: string;         // display name
  /** Local absolute path to the .gguf file (once downloaded/imported). */
  filePath: string;
  /** HF repo id, if sourced from the Hub. */
  repo?: string;
  /** File name within the repo / on disk. */
  file: string;
  sizeBytes?: number;
  /** Port the server binds to when loaded. */
  port: number;
  /** Auto-load this model when the extension starts. */
  autoLoad: boolean;
  /** Override the global config for just this model. */
  useCustomConfig?: boolean;
  /** Per-model context length (tokens). Used only when useCustomConfig. @deprecated use config.ctxSize */
  contextLength?: number;
  /** Per-model llama-server config (used only when useCustomConfig). */
  config?: LlamacppServerConfig;
}

/** Default context length (tokens) when a model has no custom override. */
export const DEFAULT_CONTEXT_LENGTH = 65536;

/** Sensible global launch defaults applied to every load unless overridden. */
export const DEFAULT_SERVER_CONFIG: LlamacppServerConfig = {
  host: "127.0.0.1",
  ctxSize: DEFAULT_CONTEXT_LENGTH,
  jinja: true,
  flashAttn: "auto",
  nGpuLayers: "auto",
  parallel: 1,
};

export interface HfGgufResult {
  repo: string;
  file: string;
  sizeBytes?: number;
  downloads?: number;
  likes?: number;
}

export interface LlamacppStatus {
  installed: boolean;
  /** model id -> running */
  running: Record<string, boolean>;
  /** model id -> loading (spawned, weights not ready yet) */
  loading: Record<string, boolean>;
  /** model id -> last error */
  errors: Record<string, string>;
  /** model id -> recent server log lines (stdout+stderr, tail) */
  logs: Record<string, string[]>;
}

// llama.cpp now ships a single `llama` binary; `llama serve` == `llama-server`.
// We prefer the unified binary and fall back to the standalone one.
const UNIFIED_BIN = "llama";
const LEGACY_BIN = "llama-server";
/** Resolved at install-check time: argv prefix to launch the server. */
let serverCmd: { bin: string; pre: string[] } = { bin: UNIFIED_BIN, pre: ["serve"] };
const MAX_LOG_LINES = 500;

/** Ask the OS for a free ephemeral port (bind :0, read the assigned port). */
function getFreePort(host = "127.0.0.1"): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, host, () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

let modelsDir: string | undefined;
let extCtx: vscode.ExtensionContext | undefined;

export function initLlamacpp(ctx: vscode.ExtensionContext): void {
  extCtx = ctx;
  modelsDir = path.join(ctx.globalStorageUri.fsPath, "llamacpp-models");
}

// ---- status events ----
const _onStatus = new vscode.EventEmitter<LlamacppStatus>();
export const onLlamacppStatus = _onStatus.event;

interface Running {
  proc: ReturnType<typeof spawn>;
  port: number;
}
const running = new Map<string, Running>();
const loadPromises = new Map<string, Promise<void>>();
const loading = new Map<string, boolean>();
const errors = new Map<string, string>();
const logs = new Map<string, string[]>();
let installedCache: boolean | undefined;

/** Append server output to a model's tail log (capped) and notify listeners. */
function appendLog(id: string, chunk: string): void {
  const cur = logs.get(id) ?? [];
  const lines = chunk.split(/\r?\n/).filter((l) => l.length > 0);
  if (!lines.length) return;
  const next = [...cur, ...lines];
  logs.set(id, next.length > MAX_LOG_LINES ? next.slice(next.length - MAX_LOG_LINES) : next);
  emit();
}

async function ensureDir(): Promise<string> {
  if (!modelsDir) throw new Error("llama.cpp not initialized");
  await fs.mkdir(modelsDir, { recursive: true });
  return modelsDir;
}

function snapshot(): LlamacppStatus {
  const r: Record<string, boolean> = {};
  for (const id of running.keys()) r[id] = true;
  const l: Record<string, boolean> = {};
  for (const [k, v] of loading) if (v) l[k] = true;
  const e: Record<string, string> = {};
  for (const [k, v] of errors) e[k] = v;
  const g: Record<string, string[]> = {};
  for (const [k, v] of logs) g[k] = v;
  return { installed: installedCache ?? false, running: r, loading: l, errors: e, logs: g };
}

function emit() {
  _onStatus.fire(snapshot());
}

// ---- install check / install ----
export function checkInstalled(): Promise<boolean> {
  // Prefer the unified `llama serve`; fall back to legacy `llama-server`.
  return new Promise((resolve) => {
    execFile(UNIFIED_BIN, ["serve", "--help"], (err) => {
      if (!err) {
        serverCmd = { bin: UNIFIED_BIN, pre: ["serve"] };
        installedCache = true;
        return resolve(true);
      }
      execFile(LEGACY_BIN, ["--version"], (err2) => {
        if (!err2) serverCmd = { bin: LEGACY_BIN, pre: [] };
        installedCache = !err2;
        resolve(!err2);
      });
    });
  });
}

/** Install llama.cpp via the platform package manager (winget / curl script). */
export async function installLlamacpp(): Promise<void> {
  const term = vscode.window.createTerminal("Install llama.cpp");
  term.show();
  if (process.platform === "win32") {
    term.sendText("irm https://llama.app/install.ps1 | iex");
  } else if (process.platform === "darwin") {
    term.sendText("curl -LsSf https://llama.app/install.sh | sh");
  } else {
    term.sendText("curl -LsSf https://llama.app/install.sh | sh");
  }
  vscode.window.showInformationMessage(
    "OpenCursor: Installing llama.cpp in the terminal. Re-check status once it finishes."
  );
}

// ---- HF GGUF search ----
export async function searchGguf(query: string, limit = 20): Promise<HfGgufResult[]> {
  const hub = await importRuntimeDep("@huggingface/hub");
  const out: HfGgufResult[] = [];
  for await (const m of hub.listModels({
    search: { query, tags: ["gguf"] },
    sort: "downloads",
    limit,
  })) {
    out.push({ repo: (m as any).name, downloads: (m as any).downloads, likes: (m as any).likes, file: "" });
  }
  return out;
}

/** List the .gguf files inside a repo so the user can pick a quantization. */
export async function listRepoGgufFiles(repo: string): Promise<HfGgufResult[]> {
  const hub = await importRuntimeDep("@huggingface/hub");
  const files: HfGgufResult[] = [];
  for await (const f of hub.listFiles({ repo, recursive: true })) {
    if (f.type === "file" && /\.gguf$/i.test(f.path)) {
      files.push({ repo, file: f.path, sizeBytes: f.size });
    }
  }
  return files;
}

// ---- download / import ----
function modelId(repo: string | undefined, file: string): string {
  return repo ? `${repo}/${file}` : file;
}

/** Download a GGUF file from the Hub into the models dir. Returns the new model. */
export async function downloadGguf(
  repo: string,
  file: string,
  onProgress?: (received: number, total: number) => void,
  signal?: AbortSignal,
): Promise<LlamacppModel> {
  const dir = await ensureDir();
  const url = `https://huggingface.co/${repo.split("/").map(encodeURIComponent).join("/")}/resolve/main/${file.split("/").map(encodeURIComponent).join("/")}`;
  const identity = createHash("sha256").update(`${repo}/${file}`).digest("hex");
  const dest = path.join(dir, identity, path.basename(file));
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const temporary = `${dest}.${randomUUID()}.part`;
  const res = await fetch(url, { signal });
  if (!res.ok || !res.body) throw new Error(`download ${res.status}`);
  const total = res.headers.get("content-encoding") ? 0 : Number(res.headers.get("content-length") || 0);
  let received = 0;
  const reader = res.body.getReader();
  async function* chunks() {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      onProgress?.(received, total);
      yield value;
    }
  }
  try {
    await fs.writeFile(temporary, chunks(), { flag: "wx", signal });
    signal?.throwIfAborted();
    if (!received || (total > 0 && received !== total)) throw new Error(`incomplete GGUF download: received ${received} of ${total} bytes`);
    await fs.rename(temporary, dest);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
    await fs.rm(temporary, { force: true });
  }
  const stat = await fs.stat(dest);
  return makeModel({ repo, file, filePath: dest, sizeBytes: stat.size, name: path.basename(file, ".gguf") });
}

/** Import an existing local .gguf file (copied into the models dir). */
export async function importGguf(srcPath: string): Promise<LlamacppModel> {
  const dir = await ensureDir();
  const base = path.basename(srcPath);
  const identity = createHash("sha256").update(await fs.realpath(srcPath)).digest("hex");
  const dest = path.join(dir, identity, base);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  if (path.resolve(srcPath) !== path.resolve(dest)) {
    const temporary = `${dest}.${randomUUID()}.part`;
    try {
      await fs.copyFile(srcPath, temporary);
      await fs.rename(temporary, dest);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
  const stat = await fs.stat(dest);
  return { ...makeModel({ file: base, filePath: dest, sizeBytes: stat.size, name: path.basename(base, ".gguf") }), id: `import:${identity}/${base}` };
}

function makeModel(p: { repo?: string; file: string; filePath: string; sizeBytes?: number; name: string }): LlamacppModel {
  return {
    id: modelId(p.repo, p.file),
    name: p.name,
    filePath: p.filePath,
    repo: p.repo,
    file: p.file,
    sizeBytes: p.sizeBytes,
    port: 0, // assigned per-load: a fresh random free port every time
    autoLoad: false,
  };
}

/** Remove a model's file from disk. */
export async function deleteGgufFile(m: LlamacppModel): Promise<void> {
  await unloadModel(m.id);
  await fs.rm(m.filePath, { force: true });
}

/**
 * Merge the effective launch config for a model: per-model override (when
 * enabled) layered over the supplied global config, over built-in defaults.
 * Honors the legacy per-model `contextLength` field.
 */
export function effectiveConfig(m: LlamacppModel, globalCfg?: LlamacppServerConfig): LlamacppServerConfig {
  const merged: LlamacppServerConfig = { ...DEFAULT_SERVER_CONFIG, ...(globalCfg ?? {}) };
  if (m.useCustomConfig) {
    if (m.config) Object.assign(merged, prune(m.config));
    if (m.contextLength) merged.ctxSize = m.contextLength; // legacy field wins if set
  }
  return merged;
}

/** Drop undefined/empty values so they don't clobber lower-priority defaults. */
function prune(c: LlamacppServerConfig): LlamacppServerConfig {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(c)) {
    if (v === undefined || v === null || v === "") continue;
    out[k] = v;
  }
  return out as LlamacppServerConfig;
}

/** Effective context length for a model (kept for callers that only need ctx). */
export function effectiveContextLength(m: LlamacppModel, globalCtx: number): number {
  const cfg = effectiveConfig(m, { ctxSize: globalCtx });
  return cfg.ctxSize ?? globalCtx;
}

/** Effective bind port: the running server's port, else a per-model config override. */
function effectivePort(m: LlamacppModel, cfg: LlamacppServerConfig): number {
  const r = running.get(m.id);
  if (r) return r.port;
  return (m.useCustomConfig && cfg.port) || 0;
}

/** Base URL of a model's local OpenAI-compatible server (no trailing slash). */
export function serverUrlFor(m: LlamacppModel, globalCfg?: LlamacppServerConfig): string {
  const cfg = effectiveConfig(m, globalCfg);
  const host = cfg.host && cfg.host !== "0.0.0.0" ? cfg.host : "127.0.0.1";
  return `http://${host}:${effectivePort(m, cfg)}/v1`;
}

/** Build the llama-server argv from a model + effective config. */
function buildArgs(m: LlamacppModel, cfg: LlamacppServerConfig, port: number): string[] {
  const args: string[] = ["-m", m.filePath, "--port", String(port), "--host", cfg.host || "127.0.0.1"];
  if (cfg.ctxSize != null) args.push("--ctx-size", String(cfg.ctxSize));
  args.push(cfg.jinja === false ? "--no-jinja" : "--jinja");
  if (cfg.flashAttn) args.push("-fa", cfg.flashAttn);
  if (cfg.nGpuLayers) args.push("-ngl", cfg.nGpuLayers);
  if (cfg.threads != null) args.push("-t", String(cfg.threads));
  if (cfg.parallel != null) args.push("--parallel", String(cfg.parallel));
  if (cfg.batchSize != null) args.push("-b", String(cfg.batchSize));
  if (cfg.ubatchSize != null) args.push("-ub", String(cfg.ubatchSize));
  if (cfg.cacheTypeK) args.push("-ctk", cfg.cacheTypeK);
  if (cfg.cacheTypeV) args.push("-ctv", cfg.cacheTypeV);
  if (cfg.mmprojPath) args.push("--mmproj", cfg.mmprojPath);
  if (cfg.draftModelPath) {
    args.push("-md", cfg.draftModelPath);
    if (cfg.specDraftNMax != null) args.push("--spec-draft-n-max", String(cfg.specDraftNMax));
    if (cfg.draftNGpuLayers) args.push("-ngld", cfg.draftNGpuLayers);
  }
  if (cfg.noMmap) args.push("--no-mmap");
  if (cfg.mlock) args.push("--mlock");
  if (cfg.extraArgs?.trim()) args.push(...cfg.extraArgs.trim().split(/\s+/));
  return args;
}

// ---- load / unload ----
export function loadModel(m: LlamacppModel, globalCfg?: LlamacppServerConfig | number): Promise<void> {
  const pending = loadPromises.get(m.id);
  if (pending) return pending;
  const promise = startModel(m, globalCfg).finally(() => loadPromises.delete(m.id));
  loadPromises.set(m.id, promise);
  return promise;
}

async function startModel(m: LlamacppModel, globalCfg?: LlamacppServerConfig | number): Promise<void> {
  if (running.has(m.id)) return;
  errors.delete(m.id);
  logs.set(m.id, []); // fresh log per load
  loading.set(m.id, true);
  emit(); // surface loading state immediately
  // Back-compat: callers used to pass a global context length number.
  const gcfg: LlamacppServerConfig | undefined =
    typeof globalCfg === "number" ? { ctxSize: globalCfg } : globalCfg;
  const cfg = effectiveConfig(m, gcfg);
  const host = cfg.host && cfg.host !== "0.0.0.0" ? cfg.host : "127.0.0.1";

  // Always launch on a fresh OS-assigned random port. If the server still
  // fails to bind (TOCTOU race with another process), retry with a new one.
  const MAX_BIND_TRIES = 3;
  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= MAX_BIND_TRIES; attempt++) {
    let port: number;
    try {
      port = await getFreePort(cfg.host || "127.0.0.1");
    } catch (e: any) {
      lastErr = new Error(`could not find a free port: ${e?.message || e}`);
      break;
    }
    try {
      await spawnServer(m, cfg, host, port);
      return; // loaded
    } catch (e: any) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      // Bind failure → retry on a new random port; anything else is fatal.
      const bindFail = /couldn't bind|address already in use|EADDRINUSE|HTTP server error/i.test(lastErr.message) ||
        (logs.get(m.id) || []).some((l) => /couldn't bind|address already in use/i.test(l));
      if (!bindFail) break;
      appendLog(m.id, `[retry] port ${port} unavailable, trying a new random port (${attempt}/${MAX_BIND_TRIES})`);
    }
  }
  loading.delete(m.id);
  const msg = lastErr?.message || "failed to start server";
  errors.set(m.id, msg);
  emit();
  throw new Error(msg);
}

/** Spawn one llama-server on `port` and resolve when /health reports ready. */
function spawnServer(m: LlamacppModel, cfg: LlamacppServerConfig, host: string, port: number): Promise<void> {
  const argv = [...serverCmd.pre, ...buildArgs(m, cfg, port)];
  appendLog(m.id, `$ ${serverCmd.bin} ${argv.join(" ")}`);
  const proc = spawn(serverCmd.bin, argv, { stdio: ["ignore", "pipe", "pipe"] });
  running.set(m.id, { proc, port });
  proc.stdout?.on("data", (b) => appendLog(m.id, b.toString()));
  proc.stderr?.on("data", (b) => appendLog(m.id, b.toString()));
  emit();

  let resolved = false;
  return new Promise<void>((resolve, reject) => {
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    const healthAbort = new AbortController();
    const fail = (msg: string) => {
      // Lifetime cleanup also applies after the startup promise has resolved.
      const owned = running.get(m.id)?.proc === proc;
      if (owned) {
        running.delete(m.id);
        loading.delete(m.id);
        errors.set(m.id, msg);
        appendLog(m.id, `[error] ${msg}`);
        emit();
      }
      clearTimeout(pollTimer);
      healthAbort.abort();
      if (resolved) return;
      resolved = true;
      reject(new Error(msg));
    };
    proc.on("error", (e) => fail(e.message));
    proc.on("exit", (code) => fail(`server exited (${code}) — see log`));

    // Poll /health until the model is fully loaded. llama-server returns 503
    // ("loading model") until weights finish, then 200 ("ok"). This is the only
    // reliable readiness signal — the "listening" log fires far too early.
    const healthUrl = `http://${host}:${port}/health`;
    const deadline = Date.now() + 10 * 60_000; // generous: big models can take minutes
    const poll = async () => {
      if (resolved) return;
      if (!running.has(m.id)) return; // exited
      try {
        const r = await fetch(healthUrl, { signal: AbortSignal.any([healthAbort.signal, AbortSignal.timeout(5000)]) });
        if (resolved || running.get(m.id)?.proc !== proc) return;
        if (r.ok) {
          resolved = true;
          loading.delete(m.id);
          appendLog(m.id, `[ready] model loaded on port ${port}`);
          emit();
          resolve();
          return;
        }
      } catch {
        // server not accepting connections yet — keep waiting
      }
      if (resolved) return;
      if (Date.now() > deadline) {
        fail("timed out waiting for model to load");
        proc.kill();
        return;
      }
      pollTimer = setTimeout(poll, 500);
    };
    poll();
  });
}

/**
 * Ensure a model's server is running before a chat request. No-op if already
 * loaded; otherwise loads it (resolves once the HTTP listener is ready).
 */
export async function ensureLoaded(m: LlamacppModel, globalCfg?: LlamacppServerConfig): Promise<void> {
  await loadModel(m, globalCfg);
}

export async function unloadModel(id: string): Promise<void> {
  const r = running.get(id);
  if (!r) return;
  running.delete(id);
  loading.delete(id);
  r.proc.kill();
  appendLog(id, "[stopped] server unloaded");
  emit();
}

export function getStatus(): LlamacppStatus {
  return snapshot();
}

export function isRunning(id: string): boolean {
  return running.has(id);
}

/** Kill all running servers (extension shutdown). */
export function disposeLlamacpp(): void {
  for (const { proc } of running.values()) proc.kill();
  running.clear();
}

/** Pick a local .gguf file via the OS dialog. */
export async function pickLocalGguf(): Promise<string | undefined> {
  const uris = await vscode.window.showOpenDialog({
    canSelectMany: false,
    filters: { "GGUF model": ["gguf"] },
    openLabel: "Import GGUF",
    defaultUri: vscode.Uri.file(os.homedir()),
  });
  return uris?.[0]?.fsPath;
}
