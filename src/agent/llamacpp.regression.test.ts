/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { EventEmitter } from "events";
import { PassThrough } from "stream";
import { spawn } from "child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({ EventEmitter: class { event = () => ({ dispose() {} }); fire() {} } }));
vi.mock("child_process", () => ({ spawn: vi.fn(), execFile: vi.fn() }));
vi.mock("../runtimeDeps", () => ({ importRuntimeDep: vi.fn() }));
import { downloadGguf, importGguf, initLlamacpp, loadModel, ensureLoaded, unloadModel, disposeLlamacpp, isRunning, getStatus, type LlamacppModel } from "./llamacpp";

let temporaryRoot: string;
let procs: (EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: ReturnType<typeof vi.fn> })[];
const model: LlamacppModel = { id: "fixture", file: "fixture.gguf", filePath: "/tmp/fixture.gguf", name: "fixture", autoLoad: false, port: 0 };
beforeEach(async () => {
  temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ocursor-llama-test-"));
  initLlamacpp({ globalStorageUri: { fsPath: temporaryRoot } } as Parameters<typeof initLlamacpp>[0]);
  procs = [];
  vi.mocked(spawn).mockImplementation(() => {
    const proc = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
    proc.kill.mockImplementation(() => { proc.emit("exit", null); return true; });
    procs.push(proc);
    return proc as unknown as ReturnType<typeof spawn>;
  });
  vi.stubGlobal("fetch", vi.fn(async () => new Response("fixture model bytes")));
});
afterEach(async () => { disposeLlamacpp(); await fs.rm(temporaryRoot, { recursive: true, force: true }); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("GGUF storage integrity", () => {
  it("keeps matching basenames from different repositories and directories separate", async () => {
    const a = await downloadGguf("vendor/A", "one/model.gguf");
    vi.mocked(fetch).mockResolvedValueOnce(new Response("different model bytes"));
    const b = await downloadGguf("vendor/B", "one/model.gguf");
    const c = await downloadGguf("vendor/A", "two/model.gguf");
    expect(new Set([a.id, b.id, c.id]).size).toBe(3);
    expect(new Set([a.filePath, b.filePath, c.filePath]).size).toBe(3);
    expect(await fs.readFile(a.filePath, "utf8")).toBe("fixture model bytes");
    expect(await fs.readFile(b.filePath, "utf8")).toBe("different model bytes");
  });

  it("does not replace an existing file when a download is incomplete", async () => {
    const first = await downloadGguf("vendor/A", "model.gguf");
    vi.mocked(fetch).mockResolvedValueOnce(new Response("partial", { headers: { "content-length": "100" } }));
    await expect(downloadGguf("vendor/A", "model.gguf")).rejects.toThrow("incomplete GGUF download");
    expect(await fs.readFile(first.filePath, "utf8")).toBe("fixture model bytes");
    expect(await fs.readdir(path.dirname(first.filePath))).toEqual(["model.gguf"]);
  });

  it("cleans partial downloads on abort and preserves the installed model", async () => {
    const first = await downloadGguf("vendor/A", "model.gguf");
    const abort = new AbortController();
    await expect(downloadGguf("vendor/A", "model.gguf", () => abort.abort(), abort.signal)).rejects.toThrow();
    expect(await fs.readFile(first.filePath, "utf8")).toBe("fixture model bytes");
    expect(await fs.readdir(path.dirname(first.filePath))).toEqual(["model.gguf"]);
  });

  it("imports matching basenames without aliasing different local models", async () => {
    const a = path.join(temporaryRoot, "a", "model.gguf");
    const b = path.join(temporaryRoot, "b", "model.gguf");
    for (const file of [a, b]) { await fs.mkdir(path.dirname(file)); await fs.writeFile(file, file); }
    const first = await importGguf(a);
    const second = await importGguf(b);
    expect(first.id).not.toBe(second.id);
    expect(first.filePath).not.toBe(second.filePath);
    expect(await fs.readFile(first.filePath, "utf8")).toBe(a);
  });
});

describe("local server lifetime", () => {
  it("removes a ready server after it crashes and reloads on the next request", async () => {
    await loadModel(model);
    expect(isRunning(model.id)).toBe(true);
    procs[0].emit("exit", 137);
    expect(isRunning(model.id)).toBe(false);
    expect(getStatus().errors[model.id]).toContain("137");
    await ensureLoaded(model);
    expect(procs).toHaveLength(2);
    expect(isRunning(model.id)).toBe(true);
  });

  it("shares readiness across concurrent callers instead of returning before loading", async () => {
    let ready!: (value: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(() => new Promise((resolve) => { ready = resolve; }));
    const first = loadModel(model);
    let secondReady = false;
    const second = ensureLoaded(model).then(() => { secondReady = true; });
    await vi.waitFor(() => expect(ready).toBeTypeOf("function"));
    expect(secondReady).toBe(false);
    expect(procs).toHaveLength(1);
    ready(new Response("ready"));
    await Promise.all([first, second]);
    expect(secondReady).toBe(true);
  });

  it("does not label an intentional unload as a crash", async () => {
    await loadModel(model);
    await unloadModel(model.id);
    expect(isRunning(model.id)).toBe(false);
    expect(getStatus().errors[model.id]).toBeUndefined();
  });
});
