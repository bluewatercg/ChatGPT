/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

// External docs indexing: crawl a docs site (same-origin, breadth-first),
// strip HTML to text, chunk + embed with the same local model as the codebase
// index, store as JSON per doc source in globalStorage.
// ponytail: naive regex HTML→text + 40-page crawl cap; upgrade to a real
// readability extractor / sitemap.xml when large doc sites matter.

import * as fs from "fs/promises";
import * as path from "path";
import { embedTexts, embedQuery, getEmbedFingerprint } from "./semanticIndex";

export interface DocSource {
  id: string;
  name: string;
  url: string;
  /** Pages indexed (0 = not indexed yet). */
  pages?: number;
  chunks?: number;
  indexedAt?: number;
  /** Crawl page cap (default 200). */
  maxPages?: number;
  /** Last indexing error, if the crawl/embed failed. */
  error?: string;
}

interface DocChunk {
  url: string;
  title: string;
  text: string;
  vec: number[];
}
interface DocIndexFile {
  fingerprint: string;
  chunks: DocChunk[];
}

const DEFAULT_MAX_PAGES = 200;
const CHUNK_CHARS = 1600;
const FETCH_TIMEOUT = 15000;
/** Parallel fetches per batch. Modest to stay under typical rate limits. */
const BATCH_SIZE = 6;
/** Pause between batches; grows on 429/503 responses. */
const BATCH_DELAY = 150;

let storageDir: string | undefined;
export function setDocsStorageDir(dir: string): void {
  storageDir = dir;
}

// Doc-source list provider (set from extension.ts; avoids a featureStore dep here).
let docSourcesProvider: () => DocSource[] = () => [];
export function setDocSourcesProvider(fn: () => DocSource[]): void {
  docSourcesProvider = fn;
}
export function listDocSources(): DocSource[] {
  return docSourcesProvider();
}
function fileFor(id: string): string {
  return path.join(storageDir!, `docs-${id}.json`);
}

// ---- Status (settings UI progress) ----
export interface DocsStatus {
  /** docId currently being indexed, if any. */
  indexing?: string;
  done: number;
  total: number;
  error?: string;
}
let status: DocsStatus = { done: 0, total: 0 };
const subs = new Set<(s: DocsStatus) => void>();

// ---- Per-doc crawl logs (in-memory, reset on each re-index) ----
const docLogs = new Map<string, string[]>();
const MAX_LOG_LINES = 500;
function log(id: string, line: string) {
  const lines = docLogs.get(id) ?? [];
  lines.push(`${new Date().toLocaleTimeString()}  ${line}`);
  if (lines.length > MAX_LOG_LINES) lines.shift();
  docLogs.set(id, lines);
}
export function getDocLogs(id: string): string[] {
  return docLogs.get(id) ?? [];
}
export function onDocsStatus(fn: (s: DocsStatus) => void): () => void {
  subs.add(fn);
  return () => subs.delete(fn);
}
export function getDocsStatus(): DocsStatus {
  return status;
}
function emit(patch: Partial<DocsStatus>) {
  status = { ...status, ...patch };
  for (const fn of subs) fn(status);
}

// ---- HTML → text ----
function htmlToText(html: string): { title: string; text: string } {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? "";
  let t = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<(h[1-6]|p|li|tr|div|br|pre)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*/g, "\n\n");
  return { title, text: t.trim() };
}

// ---- Smart link filtering ----
// Path segments that are locale codes (translated duplicates).
const LOCALE_SEG = /^(en|de|fr|es|it|pt|ja|zh|ko|ru|nl|pl|tr|id|th|vi|sv|da|fi|no|cs|uk|ar|he|hi)([-_][a-z0-9]{2,4})?$/i;
// Pages that are not documentation content (link dumps, meta, legal, auth…).
const SKIP_PATH = /\/(changelog|blog|news|glossary|discord|community|jobs|careers|legal|privacy|terms|support|contact|search|login|signin|signup|logout|register|account|videos?|events?|sitemap[^/]*)(\/|$)|\/llms(-full)?\.txt$/i;

/** First path segment if it's a locale code (e.g. "en" in /en/stable/x), else null. */
function localeOf(pathname: string): string | null {
  const first = pathname.split("/").filter(Boolean)[0];
  return first && LOCALE_SEG.test(first) && !/^(go|js|api)$/i.test(first) ? first.toLowerCase() : null;
}

/**
 * Canonicalize a URL for dedup: strip hash + all query strings, normalize
 * trailing slash. Never rewrites the path (a stripped locale prefix can 404);
 * instead, links whose locale prefix differs from the start URL's are skipped
 * (translated duplicates). Returns null if the URL should not be crawled.
 */
function canonicalUrl(raw: string, baseUrl: string, startLocale: string | null): string | null {
  let u: URL;
  try { u = new URL(raw, baseUrl); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  if (/\.(png|jpe?g|gif|svg|css|js|json|ico|woff2?|ttf|zip|gz|tar|pdf|mp4|webm|xml|txt)$/i.test(u.pathname) && !/\/$/.test(u.pathname)) {
    // Allow bare "/" paths; block asset & dump files (incl. llms.txt handled below too).
    if (!/\.(html?)$/i.test(u.pathname)) return null;
  }
  if (SKIP_PATH.test(u.pathname)) return null;
  // Skip translated duplicates: locale prefix that differs from the start URL's.
  if (localeOf(u.pathname) !== startLocale && localeOf(u.pathname) !== null) return null;
  u.hash = "";
  // Drop ALL query strings — docs pages with params are duplicate variants.
  u.search = "";
  // Normalize trailing slash (except root).
  if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, "");
  u.hostname = u.hostname.toLowerCase();
  return u.toString();
}

function extractLinks(body: string, baseUrl: string, isHtml: boolean, startLocale: string | null): string[] {
  const out: string[] = [];
  const base = new URL(baseUrl);
  // HTML hrefs, or markdown [text](url) links for sites serving markdown.
  const re = isHtml ? /href\s*=\s*["']([^"'#]+)["']/gi : /\]\(([^)\s#]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const c = canonicalUrl(m[1], baseUrl, startLocale);
    if (!c) continue;
    if (new URL(c).origin !== base.origin) continue;
    out.push(c);
  }
  return out;
}

/** Cheap FNV-1a hash of page text for content-level dedup. */
function contentHash(text: string): string {
  let h = 0x811c9dc5;
  const s = text.replace(/\s+/g, " ").slice(0, 8000);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36) + ":" + s.length;
}

async function fetchPage(url: string): Promise<{ html: string | null; isHtml?: boolean; error?: string }> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
    // Browser-like headers: many docs sites (e.g. docs.stripe.com) serve non-HTML
    // (markdown/JSON) or block requests with bot-looking UA / missing Accept.
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: {
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
        "accept-language": "en-US,en;q=0.9",
      },
    });
    clearTimeout(t);
    if (!res.ok) return { html: null, error: `HTTP ${res.status} ${res.statusText}` };
    const ct = (res.headers.get("content-type") || "").toLowerCase();
    // Reject clearly binary/asset types; accept html, markdown, plain text, or unknown.
    if (ct && !/html|xml|markdown|text\/plain|json|^text\//.test(ct) ) {
      return { html: null, error: `unsupported content-type: ${ct}` };
    }
    const body = await res.text();
    // Sniff: treat as HTML if it looks like markup, else index as plain text.
    const isHtml = /html/.test(ct) || /^\s*(<!doctype|<html|<head|<body)/i.test(body);
    if (!isHtml && !body.trim()) return { html: null, error: "empty response" };
    return { html: body, isHtml };
  } catch (e: any) {
    return { html: null, error: e?.name === "AbortError" ? "timed out" : String(e?.message || e) };
  }
}

function chunkText(text: string): string[] {
  const out: string[] = [];
  const paras = text.split(/\n\n+/);
  let buf = "";
  for (const p of paras) {
    if (buf.length + p.length > CHUNK_CHARS && buf.trim()) {
      out.push(buf.trim());
      buf = "";
    }
    buf += p + "\n\n";
  }
  if (buf.trim()) out.push(buf.trim());
  return out.filter((c) => c.length > 80); // drop nav crumbs
}

/**
 * Crawl + index one doc source. Returns {pages, chunks} on success.
 * Same-origin BFS from the start URL, scoped to the start path's directory.
 */
export async function indexDocSource(doc: DocSource): Promise<{ pages: number; chunks: number }> {
  if (!storageDir) throw new Error("docs storage not initialised");
  const fingerprint = getEmbedFingerprint();
  emit({ indexing: doc.id, done: 0, total: 1, error: undefined });
  docLogs.set(doc.id, []);
  log(doc.id, `Indexing "${doc.name}" — start URL: ${doc.url}`);
  try {
    const start = new URL(doc.url);
    // Scope crawl to the start path prefix (e.g. /docs/) so we don't wander the whole site.
    const scope = start.pathname.replace(/\/[^/]*$/, "/");
    const MAX_PAGES = Math.max(1, doc.maxPages || DEFAULT_MAX_PAGES);
    log(doc.id, `Crawl scope: ${start.origin}${scope}** (max ${MAX_PAGES} pages)`);
    const startLocale = localeOf(start.pathname);
    const queue: string[] = [canonicalUrl(start.toString(), start.toString(), startLocale) ?? start.toString()];
    const seen = new Set<string>(queue);
    const seenContent = new Set<string>();
    const chunks: DocChunk[] = [];
    let pages = 0;

    let firstError: string | undefined;
    let delay = BATCH_DELAY;
    while (queue.length && pages < MAX_PAGES) {
      // Fetch a batch of pages in parallel; adaptive backoff on rate limits.
      const batch = queue.splice(0, Math.min(BATCH_SIZE, MAX_PAGES - pages));
      emit({ done: pages, total: Math.min(MAX_PAGES, pages + queue.length + batch.length) });
      const results = await Promise.all(batch.map(async (url) => ({ url, ...(await fetchPage(url)) })));

      let rateLimited = false;
      for (const { url, html, isHtml, error } of results) {
        if (!html) {
          if (error && /HTTP (429|503)/.test(error)) rateLimited = true;
          log(doc.id, `SKIP ${url} — ${error}`);
          firstError ??= error && `${error} (${url})`;
          continue;
        }
        if (pages >= MAX_PAGES) break;
        const { title, text } = isHtml ? htmlToText(html) : { title: "", text: html };
        // Content-level dedup: same page reachable via different URLs.
        const hash = contentHash(text);
        if (seenContent.has(hash)) {
          log(doc.id, `DUP  ${url} — same content as an already-indexed page`);
          continue;
        }
        seenContent.add(hash);
        pages++;
        const pieces = chunkText(text);
        log(doc.id, `OK   ${url} — "${title || doc.name}", ${pieces.length} chunks`);
        if (pieces.length) {
          const vecs = await embedTexts(pieces);
          if (getEmbedFingerprint() !== fingerprint) throw new Error("Embedding configuration changed during indexing; retry this source.");
          if (!vecs || vecs.length !== pieces.length || vecs.some((v) => !Array.isArray(v) || !v.length || !v.every(Number.isFinite))) {
            log(doc.id, `FAIL embedding ${pieces.length} chunks — check the embedding model`);
            throw new Error("embedding failed — check the embedding model in Codebase Indexing");
          }
          pieces.forEach((p, i) => chunks.push({ url, title: title || doc.name, text: p, vec: vecs[i] }));
        }
        let added = 0;
        for (const link of extractLinks(html, url, !!isHtml, startLocale)) {
          if (seen.has(link)) continue;
          if (!new URL(link).pathname.startsWith(scope)) continue;
          seen.add(link);
          queue.push(link);
          added++;
        }
        if (added) log(doc.id, `     +${added} links queued (${queue.length} pending)`);
      }

      if (rateLimited) {
        delay = Math.min(delay * 2, 10000);
        log(doc.id, `Rate limited — backing off ${delay}ms`);
      } else if (delay > BATCH_DELAY) {
        delay = Math.max(BATCH_DELAY, Math.floor(delay / 2));
      }
      if (queue.length) await new Promise((r) => setTimeout(r, delay));
    }
    // Nothing fetched at all → surface the root failure instead of "0 pages".
    if (pages === 0) throw new Error(firstError || "no pages could be fetched");

    await fs.mkdir(storageDir, { recursive: true });
    if (getEmbedFingerprint() !== fingerprint) throw new Error("Embedding configuration changed during indexing; retry this source.");
    const destination = fileFor(doc.id);
    const temp = `${destination}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      await fs.writeFile(temp, JSON.stringify({ fingerprint, chunks } satisfies DocIndexFile), "utf8");
      await fs.rename(temp, destination);
    } finally { await fs.rm(temp, { force: true }).catch(() => {}); }
    log(doc.id, `Done: ${pages} pages, ${chunks.length} chunks indexed`);
    emit({ indexing: undefined, done: pages, total: pages, error: undefined });
    return { pages, chunks: chunks.length };
  } catch (e: any) {
    log(doc.id, `FAILED: ${String(e?.message || e)}`);
    emit({ indexing: undefined, error: String(e?.message || e) });
    throw e;
  }
}

export async function deleteDocIndex(id: string): Promise<void> {
  try { await fs.unlink(fileFor(id)); } catch { /* not indexed */ }
}

/** Cosine top-k over one doc source's chunks. */
export async function searchDocs(
  id: string,
  query: string,
  k = 6
): Promise<{ url: string; title: string; text: string; score: number }[]> {
  if (!storageDir) return [];
  let idx: DocIndexFile;
  try {
    idx = JSON.parse(await fs.readFile(fileFor(id), "utf8"));
  } catch {
    return [];
  }
  const fingerprint = getEmbedFingerprint();
  if (idx.fingerprint !== fingerprint) throw new Error("Documentation index uses a different embedding configuration. Reindex this source in Settings.");
  const qv = await embedQuery(query);
  if (!qv || !idx.chunks.length || getEmbedFingerprint() !== fingerprint) return [];
  const scored = idx.chunks
    .filter((c) => c.vec.length === qv.length)
    .map((c) => {
      let dot = 0;
      for (let i = 0; i < qv.length; i++) dot += qv[i] * c.vec[i];
      return { c, score: dot };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
  return scored.map(({ c, score }) => ({ url: c.url, title: c.title, text: c.text, score }));
}
