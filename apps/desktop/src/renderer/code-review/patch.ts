import { sameKey, sameRevision, validateRequest, type LineAnchor, type PrFile, type PrKey, type PrRevision } from "../../shared/code-review.js";

export type { LineAnchor };
export { PATCH_LIMITS, hunkBounds, parsePatch, type PatchHunk, type PatchModel, type PatchRow } from "../../shared/code-review-patch.js";

/** Use the shared request validator for path, revision, key and range validation, never local paths. */
export function anchorFor(key: PrKey, revision: PrRevision, file: PrFile, side: "base" | "head", start: number, end = start, diffBaseSha?: string): LineAnchor | null {
  const commitSha = side === "head" ? revision.headSha : diffBaseSha;
  if (!commitSha || !/^[0-9a-f]{40}$/.test(commitSha)) return null;
  const path = side === "base" ? file.previousPath ?? file.path : file.path;
  const request = validateRequest({ op: "context", requestId: "anchor", key, revision, path, side, start, end });
  if (!request || request.op !== "context") return null;
  return { key: { ...key }, revision: { ...revision }, commitSha, path, side, start, end };
}

export function anchorState(anchor: LineAnchor, key: PrKey, revision: PrRevision): "current" | "outdated" {
  return sameKey(anchor.key, key) && sameRevision(anchor.revision, revision) ? "current" : "outdated";
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
