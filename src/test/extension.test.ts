/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import * as assert from "assert";
import * as vscode from "vscode";

suite("Installed extension host integration", () => {
  suiteSetup(async () => {
    const extension = vscode.extensions.getExtension("pkrd.ocursor");
    assert.ok(extension, "The extension under test must be installed in the development host");
    await extension.activate();
    assert.strictEqual(extension.isActive, true);
  });

  test("activation registers the real chat/settings/review commands", async () => {
    const commands = new Set(await vscode.commands.getCommands(true));
    for (const command of ["ocursor.addToChat", "ocursor.openSettings", "ocursor.viewDiff"]) {
      assert.ok(commands.has(command), `Missing registered command: ${command}`);
    }
    // Exercise the actual command handler: untracked paths must be a safe no-op.
    await vscode.commands.executeCommand("ocursor.viewDiff", "not-a-pending-file.ts");
  });

  test("activation installs a working original-document provider for review", async () => {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.from({ scheme: "ocursor-inline-original", path: "/missing.ts" }));
    assert.strictEqual(document.getText(), "");
    assert.strictEqual(document.uri.scheme, "ocursor-inline-original");
  });
});
