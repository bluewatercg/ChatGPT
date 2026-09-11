/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as path from "path";
import { pathToFileURL } from "url";
import { installRuntime } from "./runtimeInstaller";
import { runtimeManifest } from "./runtimeManifest";

let rootDir: string | undefined;
const imports = new Map<string, Promise<any>>();

export function initRuntimeDeps(storageDir: string): void {
  rootDir = path.join(storageDir, "runtime-deps-v2");
  imports.clear();
}

/** Prefer the Node ESM condition without flattening a package's native layout. */
function entryOf(pkg: any): string {
  const pick = (value: any): string | undefined => {
    if (typeof value === "string") return value;
    if (value && typeof value === "object") return pick(value.node ?? value.import ?? value.default ?? value.require);
    return undefined;
  };
  return pick(pkg.exports?.["."] ?? pkg.exports) || pkg.module || pkg.main || "index.js";
}

/** Install only the requested feature's pinned graph, and import its original files. */
export function importRuntimeDep<T = any>(name: string): Promise<T> {
  if (!(name in runtimeManifest.roots)) return Promise.reject(new Error(`Unpinned runtime dependency: ${name}`));
  let pending = imports.get(name);
  if (!pending) {
    pending = (async () => {
      // Development checkout: use the package-manager-installed graph.
      try { return await import(name); } catch (error: any) {
        if (!rootDir) throw error;
      }
      const directory = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "OpenCursor: installing feature runtime" },
        progress => installRuntime(name, rootDir!, { report: message => progress.report({ message }) }),
      );
      const pkg = JSON.parse(await fs.readFile(path.join(directory, "package.json"), "utf8"));
      return await import(pathToFileURL(path.join(directory, entryOf(pkg))).href);
    })();
    imports.set(name, pending);
    // A network or initialization failure must be retryable on the next call.
    void pending.catch(() => { imports.delete(name); });
  }
  return pending as Promise<T>;
}

export async function ensureRuntimeDeps(): Promise<boolean> {
  try { await importRuntimeDep("@huggingface/transformers"); return true; }
  catch (error: any) {
    vscode.window.showErrorMessage(`OpenCursor: failed to initialize local runtime: ${error?.message ?? error}`);
    return false;
  }
}
