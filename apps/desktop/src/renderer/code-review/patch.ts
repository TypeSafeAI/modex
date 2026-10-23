import { sameKey, sameRevision, validateRequest, type PrFile, type PrKey, type PrRevision } from "../../shared/code-review.js";

/** Product limits, independent of any provider's limits. Checked before splitting or parsing. */
export const PATCH_LIMITS = { characters: 512 * 1024, rows: 4000 } as const;
export interface PatchRow { kind: "context" | "add" | "del"; text: string; oldLine: number | null; newLine: number | null; noNewline: boolean }
export interface PatchHunk { oldStart: number; newStart: number; oldCount: number; newCount: number; rows: PatchRow[] }
export interface PatchModel { state: "text" | "binary" | "provider" | "too-large"; hunks: PatchHunk[]; complete: boolean }
export interface LineAnchor { key: PrKey; revision: PrRevision; path: string; side: "base" | "head"; start: number; end: number }

/** A zero-count range is an insertion point after its start line, not that line itself. */
export function hunkBounds(hunk: PatchHunk): { oldStart: number; newStart: number; oldEnd: number; newEnd: number } {
  return { oldStart: hunk.oldStart + (hunk.oldCount === 0 ? 1 : 0), newStart: hunk.newStart + (hunk.newCount === 0 ? 1 : 0), oldEnd: hunk.oldStart + Math.max(1, hunk.oldCount), newEnd: hunk.newStart + Math.max(1, hunk.newCount) };
}

/** Use the shared request validator for path, revision, key and range validation, never local paths. */
export function anchorFor(key: PrKey, revision: PrRevision, file: PrFile, side: "base" | "head", start: number, end = start): LineAnchor | null {
  const path = side === "base" ? file.previousPath ?? file.path : file.path;
  const request = validateRequest({ op: "context", requestId: "anchor", key, revision, path, side, start, end });
  if (!request || request.op !== "context") return null;
  return { key: { ...key }, revision: { ...revision }, path, side, start, end };
}

export function anchorState(anchor: LineAnchor, key: PrKey, revision: PrRevision): "current" | "outdated" {
  return sameKey(anchor.key, key) && sameRevision(anchor.revision, revision) ? "current" : "outdated";
}

/** Parse only provider hunks; never infer code from filenames, headers or missing data. */
export function parsePatch(file: PrFile): PatchModel {
  if (file.patch.kind === "omitted") return { state: file.patch.reason, hunks: [], complete: file.patch.reason === "binary" };
  const text = file.patch.patch;
  if (text.length > PATCH_LIMITS.characters) return { state: "too-large", hunks: [], complete: false };
  const hunks: PatchHunk[] = [];
  let hunk: PatchHunk | null = null;
  let oldLine = 0, newLine = 0, additions = 0, deletions = 0, rows = 0, valid = true;
  const finish = () => {
    if (hunk && (oldLine !== hunk.oldStart + hunk.oldCount || newLine !== hunk.newStart + hunk.newCount)) valid = false;
  };
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/.exec(line);
    if (header) {
      finish();
      const oldStart = Number(header[1]), oldCount = header[2] === undefined ? 1 : Number(header[2]);
      const newStart = Number(header[3]), newCount = header[4] === undefined ? 1 : Number(header[4]);
      if (![oldStart, newStart, oldCount, newCount].every(Number.isSafeInteger)
        || oldStart + oldCount > 10_000_000 || newStart + newCount > 10_000_000
        || (oldCount > 0 && oldStart < 1) || (newCount > 0 && newStart < 1)
        || (oldCount === 0 && newCount === 0)) { valid = false; break; }
      const bounds = hunkBounds({ oldStart, oldCount, newStart, newCount, rows: [] });
      const previous = hunk ? hunkBounds(hunk) : { oldEnd: 1, newEnd: 1 };
      if (bounds.oldStart < previous.oldEnd || bounds.newStart < previous.newEnd || bounds.oldStart - previous.oldEnd !== bounds.newStart - previous.newEnd) { valid = false; break; }
      hunk = { oldStart, newStart, oldCount, newCount, rows: [] };
      hunks.push(hunk); oldLine = oldStart; newLine = newStart;
      continue;
    }
    if (!hunk) {
      if (/^(diff --git |index |--- |\+\+\+ |new file mode |deleted file mode |similarity index |rename from |rename to |old mode |new mode |$)/.test(line)) continue;
      valid = false; continue;
    }
    if (line === "\\ No newline at end of file") {
      const previous = hunk.rows.at(-1);
      if (previous) previous.noNewline = true; else valid = false;
      continue;
    }
    if (line === "" && i === lines.length - 1) continue;
    const kind = line[0] === "+" ? "add" : line[0] === "-" ? "del" : line[0] === " " ? "context" : null;
    if (!kind) { valid = false; break; }
    if (++rows > PATCH_LIMITS.rows) return { state: "too-large", hunks: [], complete: false };
    if ((kind !== "add" && oldLine >= hunk.oldStart + hunk.oldCount) || (kind !== "del" && newLine >= hunk.newStart + hunk.newCount)) { valid = false; break; }
    hunk.rows.push({ kind, text: line.slice(1), oldLine: kind === "add" ? null : oldLine++, newLine: kind === "del" ? null : newLine++, noNewline: false });
    if (kind === "add") additions++;
    if (kind === "del") deletions++;
  }
  finish();
  return { state: "text", hunks, complete: valid && additions === file.additions && deletions === file.deletions };
}

/** Reveal adjacent context from either end of a gap without crossing already displayed lines. */
export function contextWindow({ oldStart, newStart, count, top, bottom, budget, direction }: { oldStart: number; newStart: number; count: number | null; top: number; bottom: number; budget: number; direction: "before" | "after" }): { start: number; end: number; oldStart: number; length: number } | null {
  if (count === null && direction === "before") return null;
  const remaining = count === null ? 40 : count - top - bottom;
  const length = Math.min(40, budget, remaining);
  if (length <= 0) return null;
  const offset = direction === "before" ? count! - bottom - length : top;
  const start = newStart + offset;
  if (start < 1 || start + length - 1 > 10_000_000) return null;
  return { start, end: start + length - 1, oldStart: oldStart + offset, length };
}
