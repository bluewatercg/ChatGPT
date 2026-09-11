/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import { getWorkspaceRoot } from "../context/workspaceUtils";

export interface McpServerConfig {
  name: string;
  /** "stdio" launches a command; "sse"/"http" connects to a URL. */
  transport: "stdio" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  enabled: boolean;
}

export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: object;
}

interface JsonRpcResponse {
  id?: number;
  result?: any;
  error?: { code: number; message: string };
  method?: string;
  params?: any;
}

/** Minimal MCP client over stdio (JSON-RPC 2.0). SSE/http is best-effort. */
export class McpConnection {
  private proc?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  private buf = "";
  public tools: McpToolDef[] = [];
  public connected = false;
  public lastError?: string;

  constructor(public readonly config: McpServerConfig) {}

  async connect(timeoutMs = 15000): Promise<void> {
    if (this.config.transport !== "stdio") {
      // SSE/http transport: not spawned; mark connected without tools for now.
      this.lastError = "only stdio transport is supported";
      throw new Error(this.lastError);
    }
    if (!this.config.command) {
      throw new Error("stdio MCP server requires a command");
    }

    // On Windows, npm-shipped launchers (npx/npm/pnpm/yarn) are .cmd shims that
    // are not directly spawnable, so run through a shell. The shell also resolves
    // commands via PATHEXT instead of failing with ENOENT.
    // Node deprecated args+shell:true (DEP0190), so pre-join into one quoted string.
    const useShell = process.platform === "win32";
    const args = this.config.args ?? [];
    const cmd = useShell
      ? [this.config.command, ...args].map((a) => (/[\s"^&|<>]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a)).join(" ")
      : this.config.command;
    const proc = spawn(cmd, useShell ? [] : args, {
      cwd: getWorkspaceRoot(),
      env: { ...process.env, ...(this.config.env ?? {}) },
      shell: useShell,
    });
    this.proc = proc;
    proc.stdin.on("error", (error) => {
      this.lastError = error.message;
      for (const { reject } of this.pending.values()) reject(error);
    });

    // Keep the last stderr lines so a startup failure surfaces a real reason
    // instead of just "MCP server closed".
    let stderrTail = "";
    proc.stdout.on("data", (d) => this._onData(d.toString()));
    proc.stderr.on("data", (d) => {
      stderrTail = (stderrTail + d.toString()).slice(-2000);
    });
    proc.on("error", (e) => {
      this.lastError = e.message;
      this.connected = false;
    });
    proc.on("close", (code) => {
      this.connected = false;
      if (code) this.lastError = `${this.config.command} exited (code ${code})${stderrTail ? `: ${stderrTail.trim().split("\n").pop()}` : ""}`;
      const reason = this.lastError || "MCP server closed";
      for (const { reject } of this.pending.values()) {
        reject(new Error(reason));
      }
      this.pending.clear();
    });

    await this._request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "ocursor", version: "1.0.0" },
      }, undefined, timeoutMs);
    this._notify("notifications/initialized", {});

    const toolList = await this._request("tools/list", {}, undefined, timeoutMs);
    this.tools = (toolList?.tools ?? []).map((t: any) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
    this.connected = true;
  }

  async callTool(name: string, args: any, signal?: AbortSignal): Promise<string> {
    const res = await this._request("tools/call", { name, arguments: args ?? {} }, signal);
    const content = res?.content;
    if (Array.isArray(content)) {
      const output = content
        .map((c: any) => (c.type === "text" ? c.text : JSON.stringify(c)))
        .join("\n");
      return res.isError ? `error: ${output}` : output;
    }
    return JSON.stringify(res ?? {});
  }

  /** List resources exposed by this server (resources/list). */
  async listResources(signal?: AbortSignal): Promise<{ uri: string; name?: string; description?: string; mimeType?: string }[]> {
    const res = await this._request("resources/list", {}, signal);
    return (res?.resources ?? []).map((r: any) => ({
      uri: r.uri,
      name: r.name,
      description: r.description,
      mimeType: r.mimeType,
    }));
  }

  /** Read a resource (resources/read); returns its text contents joined. */
  async readResource(uri: string, signal?: AbortSignal): Promise<string> {
    const res = await this._request("resources/read", { uri }, signal);
    const contents = res?.contents;
    if (Array.isArray(contents)) {
      return contents
        .map((c: any) => (typeof c.text === "string" ? c.text : c.blob !== undefined ? `[binary ${c.mimeType ?? ""}]` : JSON.stringify(c)))
        .join("\n");
    }
    return JSON.stringify(res ?? {});
  }

  dispose() {
    for (const { reject } of this.pending.values()) reject(new Error("MCP connection closed"));
    this.pending.clear();
    this.proc?.kill();
    this.proc = undefined;
    this.connected = false;
  }

  private _onData(chunk: string) {
    this.buf += chunk;
    const lines = this.buf.split("\n");
    this.buf = lines.pop() ?? "";
    for (const line of lines) {
      const t = line.trim();
      if (!t) {
        continue;
      }
      let msg: JsonRpcResponse;
      try {
        msg = JSON.parse(t);
      } catch {
        continue;
      }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) {
          p.reject(new Error(msg.error.message));
        } else {
          p.resolve(msg.result);
        }
      }
    }
  }

  private _request(method: string, params: any, signal?: AbortSignal, timeoutMs = 300_000): Promise<any> {
    if (signal?.aborted) return Promise.reject(new Error("aborted: MCP request"));
    if (!this.proc || this.proc.stdin.destroyed) return Promise.reject(new Error("MCP connection is closed"));
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error, value?: any) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.pending.delete(id);
        if (error) reject(error); else resolve(value);
      };
      const cancel = (reason: string) => {
        if (settled) return;
        // MCP cancellation is advisory: the server may already have committed
        // an action. Never imply that settling the local promise rolls it back.
        if (method !== "initialize") this._notify("notifications/cancelled", { requestId: id, reason });
        finish(new Error(`${reason}; server cancellation is best effort`));
      };
      const onAbort = () => cancel("aborted: MCP request");
      const timer = setTimeout(() => cancel(`timeout: MCP ${method}`), timeoutMs);
      this.pending.set(id, { resolve: (value) => finish(undefined, value), reject: (error) => finish(error) });
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        this.proc!.stdin.write(payload, (error) => { if (error) finish(error); });
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private _notify(method: string, params: any) {
    const payload = JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
    try {
      if (!this.proc?.stdin.destroyed) this.proc?.stdin.write(payload, () => { /* close handler settles requests */ });
    } catch { /* cancellation notifications are best effort */ }
  }
}

/** Manages all configured MCP connections. */
export class McpManager {
  private connections = new Map<string, McpConnection>();
  private syncing: Promise<void> = Promise.resolve();
  private generation = 0;

  sync(configs: McpServerConfig[]): Promise<void> {
    const snapshot = structuredClone(configs);
    const generation = this.generation;
    const next = this.syncing.catch(() => {}).then(() => this.applyConfigs(snapshot, generation));
    this.syncing = next;
    return next;
  }

  private async applyConfigs(configs: McpServerConfig[], generation: number): Promise<void> {
    if (generation !== this.generation) return;
    // Dispose connections no longer present or disabled.
    for (const [name, conn] of this.connections) {
      const cfg = configs.find((c) => c.name === name);
      if (!cfg || !cfg.enabled || !conn.connected || JSON.stringify(cfg) !== JSON.stringify(conn.config)) {
        conn.dispose();
        this.connections.delete(name);
      }
    }
    // Connect new enabled servers.
    for (const cfg of configs) {
      if (generation !== this.generation) return;
      if (!cfg.enabled || this.connections.has(cfg.name)) {
        continue;
      }
      const conn = new McpConnection(cfg);
      this.connections.set(cfg.name, conn);
      try {
        await conn.connect();
      } catch (e) {
        conn.lastError = e instanceof Error ? e.message : String(e);
        conn.dispose();
      }
    }
  }

  /** Returns all tools across connected servers, namespaced as `mcp__<server>__<tool>`. */
  listTools(): { qualifiedName: string; server: string; tool: McpToolDef }[] {
    const out: { qualifiedName: string; server: string; tool: McpToolDef }[] = [];
    for (const [name, conn] of this.connections) {
      if (!conn.connected) {
        continue;
      }
      for (const tool of conn.tools) {
        out.push({ qualifiedName: `mcp__${name}__${tool.name}`, server: name, tool });
      }
    }
    return out;
  }

  async callTool(qualifiedName: string, args: any, signal?: AbortSignal): Promise<string> {
    const m = qualifiedName.match(/^mcp__(.+?)__(.+)$/);
    if (!m) {
      return `error: invalid MCP tool name ${qualifiedName}`;
    }
    const conn = this.connections.get(m[1]);
    if (!conn || !conn.connected) {
      return `error: MCP server ${m[1]} not connected`;
    }
    try {
      return await conn.callTool(m[2], args, signal);
    } catch (e) {
      return `error: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  /** List resources across all connected servers, namespaced by server. */
  async listResources(signal?: AbortSignal): Promise<{ server: string; uri: string; name?: string; description?: string; mimeType?: string }[]> {
    const out: { server: string; uri: string; name?: string; description?: string; mimeType?: string }[] = [];
    for (const [name, conn] of this.connections) {
      if (signal?.aborted) throw new Error("aborted: MCP resource listing");
      if (!conn.connected) continue;
      try {
        for (const r of await conn.listResources(signal)) out.push({ server: name, ...r });
      } catch {
        /* server may not support resources */
      }
    }
    return out;
  }

  async readResource(server: string, uri: string, signal?: AbortSignal): Promise<string> {
    const conn = this.connections.get(server);
    if (!conn || !conn.connected) return `error: MCP server ${server} not connected`;
    try {
      return await conn.readResource(uri, signal);
    } catch (e) {
      return `error: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  status(): { name: string; connected: boolean; toolCount: number; tools: string[]; error?: string }[] {
    const out: { name: string; connected: boolean; toolCount: number; tools: string[]; error?: string }[] = [];
    for (const [name, conn] of this.connections) {
      out.push({ name, connected: conn.connected, toolCount: conn.tools.length, tools: conn.tools.map((t) => t.name), error: conn.lastError });
    }
    return out;
  }

  disposeAll() {
    this.generation++;
    for (const conn of this.connections.values()) {
      conn.dispose();
    }
    this.connections.clear();
  }
}

export const mcpManager = new McpManager();
