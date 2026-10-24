import type { PrFile, PrFiles, ReadResult } from "../../shared/code-review.js";
import { PATCH_LIMITS } from "./patch.js";

/** Retention bounds, separate from transport size and mounted-content limits. */
export const FILE_LIMITS = { files: 1000, pages: 10, characters: 8 * 1024 * 1024 } as const;
export interface FilePage { cursor: string | null; result: ReadResult<PrFiles> }

/** Replace by cursor, then discard duplicate files and oversized payloads before saving private data. */
export function retainFilePage(pages: readonly FilePage[], cursor: string | null, result: ReadResult<PrFiles>, replace = false): FilePage[] {
  const existing = pages.find(page => page.result.state !== "unavailable")?.result;
  if (!replace && result.state !== "unavailable" && existing && existing.state !== "unavailable" && existing.value.diffBaseSha !== result.value.diffBaseSha) {
    result = { state: "unavailable", reason: "failed", fetchedAt: result.fetchedAt };
  }
  const next = replace ? [] : [...pages];
  const index = next.findIndex(p => p.cursor === cursor);
  if (index >= 0) next[index] = { cursor, result };
  else if (next.length < FILE_LIMITS.pages) next.push({ cursor, result });
  let characters = 0;
  const seen = new Set<string>();
  return next.map(page => {
    const read = page.result;
    if (read.state === "unavailable") return page;
    const files: PrFile[] = [];
    for (const file of read.value.files) {
      if (seen.has(file.path) || seen.size >= FILE_LIMITS.files) continue;
      seen.add(file.path);
      if (file.patch.kind === "text") {
        const size = file.patch.patch.length;
        if (size > PATCH_LIMITS.characters || characters + size > FILE_LIMITS.characters) {
          files.push({ ...file, patch: { kind: "omitted", reason: "too-large" } });
          continue;
        }
        characters += size;
      }
      files.push(file);
    }
    return { cursor: page.cursor, result: { ...read, value: { revision: read.value.revision, diffBaseSha: read.value.diffBaseSha, files } } };
  });
}

export function filePageRows(pages: readonly FilePage[]): PrFile[] {
  return pages.flatMap(page => page.result.state === "unavailable" ? [] : page.result.value.files);
}

/** A no-progress/looping provider must not cause unbounded cursor retention or repeated fetching. */
export function pageStopReason(pages: readonly FilePage[]): string | null {
  const last = pages.at(-1);
  if (!last || last.result.state === "unavailable") return null;
  const next = last.result.coverage?.next;
  if (!next) return null;
  if (pages.some(page => page.cursor === next)) return "The provider repeated a page cursor. Refresh or open the remaining files in GitHub.";
  if (pages.length > 1 && last.result.value.files.length === 0) return "The provider page added no new files. Refresh or open the remaining files in GitHub.";
  if (pages.length >= FILE_LIMITS.pages) return `Display limited to ${FILE_LIMITS.pages} file pages. Open remaining files in GitHub.`;
  return null;
}
