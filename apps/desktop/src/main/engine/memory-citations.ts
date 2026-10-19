import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { MemoryExcerpt } from "../../shared/evidence.js";

/**
 * Reads the lines a Codex memory citation points to (docs/conversation-evidence.md). codex-cli 0.163.0
 * cites files by a path relative to its memories folder, with 1-based, inclusive line numbers. Main
 * reads only inside that folder: an absolute path, `..`, or a symlink that leads out is refused, and
 * nothing is opened, executed or fetched. Only the cited lines leave main, bounded.
 */

/** The most text one excerpt carries to the window. */
export const MEMORY_EXCERPT_BYTES = 64 * 1024;
/** A memory file larger than this is not read. */
export const MEMORY_FILE_MAX_BYTES = 8 * 1024 * 1024;

/** `$CODEX_HOME/memories`, or `~/.codex/memories` when CODEX_HOME is unset, as the Codex CLI resolves it. */
export function codexMemoriesDir(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  return path.join(env.CODEX_HOME || path.join(home, ".codex"), "memories");
}

export async function readMemoryCitation(root: string, req: { path: unknown; lineStart: unknown; lineEnd: unknown }): Promise<MemoryExcerpt> {
  const { lineStart, lineEnd } = req;
  if (!Number.isSafeInteger(lineStart) || !Number.isSafeInteger(lineEnd) || (lineStart as number) < 1 || (lineEnd as number) < (lineStart as number)) {
    throw new Error("This citation has no valid line range.");
  }
  const rel = req.path;
  if (typeof rel !== "string" || !rel || rel.includes("\0") || path.isAbsolute(rel) || rel.split(/[\\/]/).includes("..")) {
    throw new Error("This citation does not point inside Codex's memory folder.");
  }
  let rootReal: string;
  try { rootReal = await fs.realpath(root); }
  catch { throw new Error("Codex's memories folder was not found."); }
  let file: string;
  try { file = await fs.realpath(path.join(rootReal, rel)); }
  catch { throw new Error(`The memory file ${rel} was not found.`); }
  if (!file.startsWith(rootReal + path.sep)) throw new Error("This citation leads outside Codex's memory folder.");
  const info = await fs.stat(file);
  if (!info.isFile()) throw new Error("This citation does not point to a memory file.");
  if (info.size > MEMORY_FILE_MAX_BYTES) throw new Error(`The memory file ${rel} is too large to show.`);

  const content = await fs.readFile(file, "utf8");
  const lines = content.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const start = lineStart as number;
  if (start > lines.length) throw new Error(`Line ${start} is past the end of ${rel} (${lines.length} lines).`);
  const end = Math.min(lineEnd as number, lines.length);
  let text = lines.slice(start - 1, end).join("\n");
  let cut = false;
  if (Buffer.byteLength(text) > MEMORY_EXCERPT_BYTES) {
    // Cut on a character boundary: step back over UTF-8 continuation bytes.
    const bytes = Buffer.from(text);
    let stop = MEMORY_EXCERPT_BYTES;
    while (stop > 0 && (bytes[stop]! & 0xc0) === 0x80) stop--;
    text = bytes.subarray(0, stop).toString("utf8");
    cut = true;
  }
  return { path: rel, lineStart: start, lineEnd: end, text, totalLines: lines.length, ...(end < (lineEnd as number) ? { beyondEnd: true } : {}), ...(cut ? { cut: true } : {}) };
}
