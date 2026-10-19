/**
 * Evidence a turn leaves behind (docs/conversation-evidence.md): what the CLI itself cited, the
 * command that actually ran, and tool output bounded for the transcript. Each piece says exactly as
 * much as the CLI reported. A citation shows where the model says something came from; it does not
 * prove the claim. Pure and shared by main and the renderer.
 */

/** The most tool output a transcript item keeps: its last 256 KiB. */
export const OUTPUT_PREVIEW_BYTES = 256 * 1024;

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
 */
export interface EvidenceCommands {
  "evidence:memory": { req: { path: string; lineStart: number; lineEnd: number }; res: MemoryExcerpt };
  "evidence:patch": { req: { threadId: string; itemId: string }; res: PatchCheck };
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
