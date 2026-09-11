/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { writeTool } from "./files";
import { mcpManager } from "../../integrations/mcpClient";
import { defineTool } from "./types";

// ---- CallMcpTool ----
export const callMcpToolTool = defineTool("CallMcpTool", true, async () => ({
  output: "error: MCP tool execution requires the agent's guarded dispatcher",
}));

// ---- FetchMcpResource ----
export const fetchMcpResourceTool = defineTool("FetchMcpResource", true, async (input, signal, callId, ctx) => {
  const server = String(input?.server ?? "").trim();
  const uri = String(input?.uri ?? "").trim();
  if (!server || !uri) return { output: "error: FetchMcpResource requires 'server' and 'uri'" };

  const content = await mcpManager.readResource(server, uri, signal);
  if (content.startsWith("error:")) return { output: content };

  const downloadPath = input?.downloadPath ? String(input.downloadPath) : "";
  if (downloadPath) {
    signal?.throwIfAborted();
    const veto = await ctx?.beforeResourceWrite?.(downloadPath, content, signal);
    if (veto) return { output: `error: blocked by hook: ${veto}` };
    signal?.throwIfAborted();
    return writeTool.execute({ path: downloadPath, contents: content }, signal, callId, ctx);
  }
  return { output: content };
});

// ---- ListMcpResources ----
export const listMcpResourcesTool = defineTool("ListMcpResources", false, async (input, signal) => {
  const filter = input?.server ? String(input.server) : "";
  const resources = (await mcpManager.listResources(signal)).filter((r) => !filter || r.server === filter);
  if (resources.length === 0) return { output: "No MCP resources available." };
  const lines = resources.map(
    (r) => `${r.server}\t${r.uri}${r.name ? `\t${r.name}` : ""}${r.mimeType ? `\t(${r.mimeType})` : ""}`
  );
  return { output: lines.join("\n") };
});
