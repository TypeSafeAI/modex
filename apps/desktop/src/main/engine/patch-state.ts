import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { appliedPatch, PATCH_TOOLS, type PatchCheck, type PatchFileCheck } from "../../shared/evidence.js";
import type { ThreadItem } from "../../shared/types.js";

/**
 * Compares a turn's patch with the working tree now (docs/conversation-evidence.md). The tool item
 * says what the turn left in each file: a whole file (Claude Write, a Codex add), text that must still
 * be there (Claude Edit, each Codex hunk's new lines), or no file (a Codex delete). Main reads those
 * files inside the thread's folder only, and sends back one verdict per file, never the contents.
 * Nothing is written, run or fetched.
 */

/** A file larger than this is not compared. */
export const PATCH_FILE_MAX_BYTES = 8 * 1024 * 1024;

type Tool = Extract<ThreadItem, { kind: "tool" }>;

/** What the turn left at `path`. `gone`: a moved file's old path, which must stay absent. */
type Expectation =
  | { path: string; whole: string; gone?: string }
  | { path: string; contains: string[]; byLine?: true; gone?: string }
  | { path: string; absent: true }
  | { path: string; unknown: string };

const REMOVED_ONLY = "This edit only removed text, so Modex can't tell from it whether the text is still removed.";
const NO_RECORD = "This patch was recorded with no per-file record, so Modex can't compare it file by file.";
const OUTSIDE = "This file is outside this thread's folder, so Modex does not read it.";
const ESCAPES = "This path leads outside this thread's folder through a link, so Modex does not read it.";

export async function checkPatch(cwd: string, item: ThreadItem | undefined, now: () => Date = () => new Date()): Promise<PatchCheck> {
  if (!item) throw new Error("That patch is no longer in this thread.");
  if (item.kind !== "tool" || !PATCH_TOOLS.has(item.name)) throw new Error("That item is not a patch.");
  if (!appliedPatch(item)) throw new Error("This patch was not reported as applied, so there is nothing to compare.");
  let real: string;
  try { real = await fs.realpath(cwd); }
  catch { throw new Error("This thread's folder is no longer there."); }
  const root = { lexical: path.resolve(cwd), real };
  const files: PatchFileCheck[] = [];
  for (const expectation of expectations(item)) {
    try { files.push(await check(root, expectation)); }
    catch (err) { files.push({ path: display(root, expectation.path), state: "unknown", reason: `This file could not be read (${(err as NodeJS.ErrnoException).code ?? "error"}).` }); }
  }
  return { files, checkedAt: now().toISOString() };
}

function expectations(item: Tool): Expectation[] {
  const args = item.args;
  const file = text(args.file_path);
  switch (item.name) {
    case "Write":
      return file ? [text(args.content) !== undefined ? { path: file, whole: text(args.content)! } : { path: file, unknown: "This write has no recorded content." }] : [];
    case "Edit": {
      const added = text(args.new_string);
      return file ? [added ? { path: file, contains: [added] } : { path: file, unknown: REMOVED_ONLY }] : [];
    }
    case "MultiEdit": {
      const added = (Array.isArray(args.edits) ? args.edits : []).map((e) => text((e as Record<string, unknown> | null)?.new_string)).filter((t): t is string => Boolean(t));
      return file ? [added.length ? { path: file, contains: added } : { path: file, unknown: REMOVED_ONLY }] : [];
    }
    case "NotebookEdit": {
      const notebook = text(args.notebook_path);
      return notebook ? [{ path: notebook, unknown: "Modex does not compare notebook edits." }] : [];
    }
    default:
      return codexExpectations(args);
  }
}

/** Codex's fileChange, split back into each file's diff by `files[].lines` (codex.ts). */
function codexExpectations(args: Record<string, unknown>): Expectation[] {
  const patch = text(args.patch);
  const files = Array.isArray(args.files) ? args.files as Record<string, unknown>[] : null;
  const valid = files?.every((f) => f && typeof f.path === "string" && f.path && typeof f.kind === "string" && Number.isSafeInteger(f.lines) && (f.lines as number) > 0);
  const lines = patch?.split("\n") ?? [];
  if (patch === undefined || !files || !valid || files.reduce((n, f) => n + (f.lines as number), 0) !== lines.length) return [{ path: "", unknown: NO_RECORD }];
  let at = 0;
  return files.map((f): Expectation => {
    const diff = lines.slice(at, (at += f.lines as number)).join("\n");
    const file = f.path as string;
    const moved = text(f.movePath);
    if (f.kind === "add") return { path: file, whole: diff };
    if (f.kind === "delete") return { path: file, absent: true };
    if (f.kind !== "update") return { path: file, unknown: `Modex does not know this kind of change: ${f.kind}.` };
    const blocks = hunkBlocks(diff);
    if (!blocks.length) return { path: moved ?? file, unknown: "This change only removed lines, so Modex can't tell from it whether they are still removed." };
    return { path: moved ?? file, contains: blocks, byLine: true, ...(moved ? { gone: file } : {}) };
  });
}

/**
 * Each hunk's new side, as whole lines: its context and added lines, in order. codex-cli 0.163.0
 * sends an update as hunks only (`@@ -a,b +c,d @@`); anything before the first hunk is skipped.
 */
function hunkBlocks(diff: string): string[] {
  const lines = diff.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const blocks: string[][] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    if (line.startsWith("@@")) blocks.push((current = []));
    else if (!current || line.startsWith("-") || line.startsWith("\\")) continue;
    else if (line.startsWith("+") || line.startsWith(" ")) current.push(line.slice(1));
    else if (line === "") current.push("");
  }
  return blocks.filter((b) => b.length).map((b) => b.join("\n"));
}

type Root = { lexical: string; real: string };
type Located = { outside: true } | { escapes: true; rel: string } | { missing: true; rel: string } | { real: string; rel: string };

async function check(root: Root, e: Expectation): Promise<PatchFileCheck> {
  const shown = e.path ? display(root, e.path) : "";
  if ("unknown" in e) return { path: shown, state: "unknown", reason: e.unknown };
  const at = await locate(root, e.path);
  if ("outside" in at) return { path: shown, state: "unknown", reason: OUTSIDE };
  if ("escapes" in at) return { path: at.rel, state: "unknown", reason: ESCAPES };
  if ("absent" in e) return { path: at.rel, state: "missing" in at ? "as-left" : "changed" };
  if ("missing" in at) return { path: at.rel, state: "deleted" };
  const read = await readBounded(at.real);
  if (typeof read !== "string") return { path: at.rel, state: "unknown", reason: read.reason };
  const left = "whole" in e ? read === e.whole : e.contains.every((t) => (e.byLine ? `\n${read}\n`.includes(`\n${t}\n`) : read.includes(t)));
  // A moved file's old path counts only when a file is back there, inside the folder.
  if (left && e.gone && "real" in (await locate(root, e.gone))) return { path: at.rel, state: "changed" };
  return { path: at.rel, state: left ? ("whole" in e ? "as-left" : "has-edit") : "changed" };
}

/** Where a recorded path is, without leaving the thread's folder: by name first, then through links. */
async function locate(root: Root, file: string): Promise<Located> {
  const lexical = path.resolve(root.lexical, file);
  const rel = inside(root.lexical, lexical) ?? inside(root.real, lexical);
  if (rel === null) return { outside: true };
  let real: string;
  try { real = await fs.realpath(lexical); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT" || (err as NodeJS.ErrnoException).code === "ENOTDIR") return { missing: true, rel };
    throw err;
  }
  const realRel = inside(root.real, real);
  return realRel === null ? { escapes: true, rel } : { real, rel: realRel };
}

/** The file's text, or why it was not read. Never follows a link at the last step. */
async function readBounded(file: string): Promise<string | { reason: string }> {
  const info = await fs.stat(file);
  if (!info.isFile()) return { reason: "This path is not a file." };
  if (info.size > PATCH_FILE_MAX_BYTES) return { reason: "This file is too large to compare (8 MB limit)." };
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const bytes = await handle.readFile();
    return bytes.length > PATCH_FILE_MAX_BYTES ? { reason: "This file is too large to compare (8 MB limit)." } : bytes.toString("utf8");
  } finally { await handle.close(); }
}

/** `target` relative to `base`, with forward slashes, or null when it is not inside it. */
function inside(base: string, target: string): string | null {
  const rel = path.relative(base, target);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
  return rel ? rel.split(path.sep).join("/") : ".";
}

function display(root: Root, file: string): string {
  const lexical = path.resolve(root.lexical, file);
  return inside(root.lexical, lexical) ?? inside(root.real, lexical) ?? file;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
