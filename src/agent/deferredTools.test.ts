/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { describe, expect, it } from "vitest";
import { ContextArchive } from "./contextArchive";
import { DeferredToolSchemas } from "./deferredTools";
import type { ToolSchema } from "./types";

function schema(name: string, description = "Tool description", fieldDescription = "Input text"): ToolSchema {
  return { type: "function", function: { name, description, parameters: { type: "object", properties: { text: { type: "string", description: fieldDescription } }, required: ["text"] } } };
}

function largeCollection(): ToolSchema[] {
  return Array.from({ length: 20 }, (_, i) => schema(`mcp__server__tool_${i}`, `Searchable capability ${i}`, "Detailed parameters. ".repeat(200)));
}

function catalogEntry(archive: ContextArchive, registry: DeferredToolSchemas, name: string): { line: string; id: string } {
  const result = archive.read({ id: registry.catalogId!, pattern: `${name} —` });
  const line = result.split("\n").find((line) => line.startsWith(`${name} —`));
  if (!line) throw new Error(`Missing catalog entry: ${name}`);
  const id = line.match(/ReadContext \{"id":"([^"]+)"\}/)?.[1];
  if (!id) throw new Error(`Missing schema id: ${line}`);
  return { line, id };
}

describe("DeferredToolSchemas", () => {
  it("omits large schema collections until an individual schema is loaded", () => {
    const archive = new ContextArchive();
    const schemas = largeCollection();
    const registry = new DeferredToolSchemas(archive, schemas);
    expect(registry.isDeferred).toBe(true);
    expect(registry.activeSchemas()).toEqual([]);
    const { id } = catalogEntry(archive, registry, schemas[7].function.name);
    const result = archive.read({ id });
    const body = result.slice(result.indexOf("\n\n") + 2);
    expect(JSON.parse(body)).toEqual(schemas[7]);
    expect(registry.activate(id)).toBe(true);
    expect(registry.activeSchemas()).toEqual([schemas[7]]);
    expect(registry.activeSchemas()[0]).toBe(schemas[7]);
    expect(JSON.stringify(registry.activeSchemas()).length).toBeLessThan(JSON.stringify(schemas).length / 10);
    expect(registry.activate(id)).toBe(false);
  });

  it("keeps small collections immediately available without adding an archive catalog", () => {
    const archive = new ContextArchive();
    const schemas = [schema("small_a"), schema("small_b")];
    const registry = new DeferredToolSchemas(archive, schemas);
    expect(registry.isDeferred).toBe(false);
    expect(registry.catalogId).toBeUndefined();
    expect(registry.activeSchemas()).toEqual(schemas);
    expect(registry.activate(archive.store(JSON.stringify(schemas[0]), "MCP schema small_a"))).toBe(false);
    const empty = new DeferredToolSchemas(archive, []);
    expect(empty.isDeferred).toBe(false);
    expect(empty.activeSchemas()).toEqual([]);
  });

  it("retains previously used names and preserves original ordering when more are loaded", () => {
    const archive = new ContextArchive();
    const schemas = largeCollection();
    const used = new Set([schemas[15].function.name, schemas[2].function.name, "no_longer_installed"]);
    const registry = new DeferredToolSchemas(archive, schemas, used);
    expect(registry.activeSchemas()).toEqual([schemas[2], schemas[15]]);
    expect(registry.activate(catalogEntry(archive, registry, schemas[15].function.name).id)).toBe(false);
    expect(registry.activate(catalogEntry(archive, registry, schemas[10].function.name).id)).toBe(true);
    expect(registry.activate(catalogEntry(archive, registry, schemas[0].function.name).id)).toBe(true);
    expect(registry.activeSchemas()).toEqual([schemas[0], schemas[2], schemas[10], schemas[15]]);
    expect(used).toEqual(new Set([schemas[15].function.name, schemas[2].function.name, "no_longer_installed"]));
  });

  it("rebuilds stable catalog and schema ids in a new conversation archive", () => {
    const schemas = largeCollection();
    const firstArchive = new ContextArchive();
    const first = new DeferredToolSchemas(firstArchive, schemas);
    const secondArchive = new ContextArchive();
    const second = new DeferredToolSchemas(secondArchive, schemas, new Set([schemas[3].function.name]));
    expect(first.catalogId).toBe(second.catalogId);
    const firstId = catalogEntry(firstArchive, first, schemas[5].function.name).id;
    const secondId = catalogEntry(secondArchive, second, schemas[5].function.name).id;
    expect(firstId).toBe(secondId);
    expect(second.activate(firstId)).toBe(true);
    expect(second.activeSchemas()).toEqual([schemas[3], schemas[5]]);
  });

  it("keeps catalog lines searchable and compact while retaining exact schema descriptions", () => {
    const archive = new ContextArchive();
    const description = "Find records\nwith details " + "very long description ".repeat(1000);
    const registry = new DeferredToolSchemas(archive, [schema("mcp__data__find", description)]);
    const { line, id } = catalogEntry(archive, registry, "mcp__data__find");
    expect(line).toContain("Find records with details");
    expect(line.length).toBeLessThan(300);
    expect(archive.read({ id, pattern: "very long description" })).toContain("very long description");
    expect(id).toBe(archive.store(JSON.stringify(schema("mcp__data__find", description)), "MCP schema mcp__data__find"));
  });

  it("does not activate tools from catalog ids, other archives, names or unknown ids", () => {
    const archive = new ContextArchive();
    const schemas = largeCollection();
    const registry = new DeferredToolSchemas(archive, schemas);
    for (const id of [registry.catalogId!, archive.store("saved output", "Shell result"), schemas[0].function.name, "ctx_" + "0".repeat(64), "../../tool"]) {
      expect(registry.activate(id)).toBe(false);
    }
    expect(registry.activeSchemas()).toEqual([]);
  });

  it("takes its own registry and used-name snapshots", () => {
    const archive = new ContextArchive();
    const schemas = largeCollection();
    const first = schemas[0];
    const used = new Set([first.function.name]);
    const registry = new DeferredToolSchemas(archive, schemas, used);
    schemas.length = 0;
    used.clear();
    const active = registry.activeSchemas();
    active.length = 0;
    expect(registry.activeSchemas()).toEqual([first]);
  });
});
