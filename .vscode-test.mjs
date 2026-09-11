/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  files: 'out/test/**/*.test.js',
  version: '1.96.0',
  ...(process.env.OPENCURSOR_TEST_EXTENSION_PATH ? { extensionDevelopmentPath: process.env.OPENCURSOR_TEST_EXTENSION_PATH } : {}),
  launchArgs: ['--disable-gpu', '--disable-workspace-trust', ...(process.getuid?.() === 0 ? ['--no-sandbox'] : [])],
  mocha: { timeout: 20000 },
});
