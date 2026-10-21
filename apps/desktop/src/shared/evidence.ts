/**
 * Evidence a turn leaves behind (docs/conversation-evidence.md): what the CLI itself cited, the
 * command that actually ran, and tool output bounded for the transcript. Each piece says exactly as
 * much as the CLI reported. A citation shows where the model says something came from; it does not
 * prove the claim. Pure and shared by main and the renderer.
 */

import { domainOf, safeHref } from "./inline.js";

/** The most tool output a transcript item keeps: its last 256 KiB. */
export const OUTPUT_PREVIEW_BYTES = 256 * 1024;

/** The most raw output main keeps for one tool item, from its first byte (main/engine/tool-logs.ts). */
export const TOOL_LOG_MAX_BYTES = 10 * 1024 * 1024;
/** The most text one read of a kept log returns. */
export const TOOL_LOG_PAGE_BYTES = 256 * 1024;

/**
 * One page of a tool's kept log. `next` is where the following page starts, or null at the end. `total`
 * is the output the tool produced and `cut` whether some of it is not kept; both are absent when the
 * tool never finished, since Modex then does not know how much there was.
 */
export interface ToolLogPage {
  text: string;
  offset: number;
  next: number | null;
  kept: number;
  total?: number;
  cut?: boolean;
}

/** A byte count as the transcript writes it: "256 KB", "3.1 MB". */
export function formatBytes(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * A web search as Codex reported it (a `webSearch` item, codex-cli 0.163.0): the query, what the search
 * did, and the results it returned. The results are what Codex's search found; Modex has not checked
 * them, and a result is not proof that it supports anything the reply says.
 */
export interface NativeWebSearch {
  source: "codex";
  query: string;
  action?: { kind: "search"; queries: string[] } | { kind: "openPage"; url: string } | { kind: "findInPage"; url: string; pattern?: string };
  results: { title: string; url: string; domain: string; snippet?: string }[];
  /** Results Codex sent that Modex cannot show: not an object, or no http(s) link. */
  dropped?: number;
}

/** The longest query, title or snippet a search keeps, in characters. */
const SEARCH_TEXT = 500;
/** The most results one search keeps. */
const SEARCH_RESULTS = 50;

const bounded = (text: string): string => (text.length > SEARCH_TEXT ? `${text.slice(0, SEARCH_TEXT)}…` : text);
const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? bounded(value.trim()) : undefined);

/**
 * A Codex `webSearch` item's search, or null when it reports none yet (0.163.0 starts the item with
 * an empty query and no action or results). Codex documents `results` as opaque JSON: an entry is
 * kept only as an object with an http(s) `url`, its title falling back to the domain. Anything else
 * is counted in `dropped`, never shown.
 */
export function codexWebSearch(item: Record<string, unknown>): NativeWebSearch | null {
  const query = text(item.query) ?? "";
  const a = item.action && typeof item.action === "object" ? item.action as Record<string, unknown> : undefined;
  const page = typeof a?.url === "string" ? safeHref(a.url) : null;
  const action: NativeWebSearch["action"] =
    a?.type === "search" ? { kind: "search", queries: (Array.isArray(a.queries) ? a.queries : [a.query]).flatMap((q) => text(q) ?? []) }
    : a?.type === "openPage" && page ? { kind: "openPage", url: page }
    : a?.type === "findInPage" && page ? { kind: "findInPage", url: page, ...(text(a.pattern) ? { pattern: text(a.pattern)! } : {}) }
    : undefined;
  const raw = Array.isArray(item.results) ? item.results : [];
  const results: NativeWebSearch["results"] = [];
  for (const entry of raw.slice(0, SEARCH_RESULTS)) {
    const e = entry && typeof entry === "object" ? entry as Record<string, unknown> : undefined;
    const url = typeof e?.url === "string" ? safeHref(e.url) : null;
    if (!e || !url) continue;
    const domain = text(e.domain) ?? domainOf(url);
    const snippet = text(e.snippet);
    results.push({ title: text(e.title) ?? domain, url, domain, ...(snippet ? { snippet } : {}) });
  }
  const dropped = Math.min(raw.length, SEARCH_RESULTS) - results.length;
  if (!query && !action && !results.length) return null;
  return { source: "codex", query, ...(action ? { action } : {}), results, ...(dropped ? { dropped } : {}) };
}

/** A Codex memory citation (`agentMessage.memoryCitation`, codex-cli 0.163.0): a line range in a memory file. */
export interface MemoryEvidence {
  kind: "memory";
  source: "codex";
  path: string;
  lineStart: number;
  lineEnd: number;
  note: string;
  threadIds?: string[];
}

/**
 * The lines a memory citation points to, as main read them from Codex's memories folder: 1-based and
 * inclusive. `beyondEnd`: the citation ran past the file's end and was cut to it. `cut`: the excerpt
 * was longer than the window is sent and ends early.
 */
export interface MemoryExcerpt {
  path: string;
  lineStart: number;
  lineEnd: number;
  text: string;
  totalLines: number;
  beyondEnd?: true;
  cut?: true;
}

/** Tools whose output is a patch: what the turn applied then, which the working tree may no longer match. */
export const PATCH_TOOLS: ReadonlySet<string> = new Set(["apply_patch", "Edit", "MultiEdit", "Write", "NotebookEdit"]);

/** A finished patch the CLI reported as applied. Items saved before outcomes were recorded say so with `ok`. */
export function appliedPatch(item: { name: string; status: string; outcome?: string; ok?: boolean }): boolean {
  if (!PATCH_TOOLS.has(item.name) || item.status !== "done") return false;
  return item.outcome !== undefined ? item.outcome === "succeeded" : item.ok === true;
}

/**
 * One file of a Codex `fileChange`, kept in the tool's `args.files` beside the joined `args.patch`.
 * `path` and `movePath` are as codex-cli 0.163.0 sends them (absolute). `lines` counts the lines of
 * `patch` that are this file's diff, in order, so each diff is stored once.
 */
export interface CodexPatchFile {
  path: string;
  kind: string;
  movePath?: string;
  lines: number;
}

/**
 * How one file a turn's patch touched compares with the working tree now. `as-left`: exactly what the
 * turn wrote, or still absent after a delete. `has-edit`: the text the turn put in is still there (the
 * rest of the file is not known). `changed` and `deleted`: since the turn. `unknown` says why.
 */
export type PatchFileState = "as-left" | "has-edit" | "changed" | "deleted" | "unknown";

export interface PatchFileCheck {
  path: string;
  state: PatchFileState;
  reason?: string;
}

/** A comparison main made at `checkedAt`. It carries verdicts only, never file contents. */
export interface PatchCheck {
  files: PatchFileCheck[];
  checkedAt: string;
}

/**
 * Main-owned evidence reads. `evidence:memory` reads a memory citation's lines, on the Mac only and
 * never for a paired desktop. `evidence:patch` compares a turn's patch item with the thread's folder.
 * `evidence:tool-log` reads back a long tool's kept output.
 */
export interface EvidenceCommands {
  "evidence:memory": { req: { path: string; lineStart: number; lineEnd: number }; res: MemoryExcerpt };
  "evidence:patch": { req: { threadId: string; itemId: string }; res: PatchCheck };
  /** A page of a tool's kept raw output, from `offset`; null when its output fit in the transcript. */
  "evidence:tool-log": { req: { threadId: string; itemId: string; offset?: number }; res: ToolLogPage | null };
}

/** Native evidence attached to an assistant message. Links the model wrote are not evidence of this kind. */
export type Evidence = MemoryEvidence;

/** The command a tool actually ran, apart from its display title. `cwd` only when the CLI reported it. */
export interface Exec {
  command: string;
  cwd?: string;
}

/** Codex's `memoryCitation` as evidence; entries that are not well formed are dropped, never guessed at. */
export function memoryEvidence(value: unknown): Evidence[] {
  if (!isRecord(value) || !Array.isArray(value.entries)) return [];
  const threadIds = Array.isArray(value.threadIds) && value.threadIds.every((id) => typeof id === "string") ? value.threadIds as string[] : undefined;
  return value.entries.flatMap((entry): Evidence[] => {
    if (!isRecord(entry)) return [];
    const { path, lineStart, lineEnd, note } = entry;
    if (typeof path !== "string" || !path || typeof note !== "string") return [];
    if (!Number.isSafeInteger(lineStart) || !Number.isSafeInteger(lineEnd) || (lineStart as number) < 0 || (lineEnd as number) < (lineStart as number)) return [];
    return [{ kind: "memory", source: "codex", path, lineStart: lineStart as number, lineEnd: lineEnd as number, note, ...(threadIds ? { threadIds } : {}) }];
  });
}

/**
 * `text` cut to its last `limit` bytes of UTF-8, starting on a character boundary. When it was cut,
 * `truncated` says how much there was and how much is shown.
 */
export function boundOutput(text: string, limit = OUTPUT_PREVIEW_BYTES): { text: string; truncated?: { totalBytes: number; shownBytes: number } } {
  if (text.length * 3 <= limit) return { text };
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= limit) return { text };
  let start = bytes.length - limit;
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
  const shown = bytes.subarray(start);
  return { text: new TextDecoder().decode(shown), truncated: { totalBytes: bytes.length, shownBytes: shown.length } };
}

/** UTF-8 length of `text`. */
export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
