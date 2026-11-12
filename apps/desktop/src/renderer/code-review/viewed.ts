import type { PrKey, PrRevision } from "../../shared/code-review.js";

/**
 * Viewed files (C65, decision 5): a local mark per signed-in account, never GitHub's viewed state and never
 * a write. A mark belongs to the revision it was made at: when the head or the base moves, the files may
 * have changed, so the marks for the earlier revision are not shown and the next mark replaces them.
 */
export const VIEWED_KEY = "modex.codeReview.viewed";
const PRS = 200, PATHS = 3000;

type Storage = { getItem(key: string): string | null; setItem(key: string, value: string): void };
interface Entry { baseSha: string; headSha: string; paths: string[] }
// Only failed writes need a session fallback. Successful writes resume ordinary storage reads.
const pending = new WeakMap<Storage, Record<string, unknown>>();

const ACCOUNT = /^[1-9][0-9]{0,19}$/;
const SHA = /^[0-9a-f]{40}$/;
const id = (key: PrKey) => `${key.repoId}#${key.number}`;

function read(storage: Storage): Record<string, unknown> {
  const unsaved = pending.get(storage);
  if (unsaved) return unsaved;
  try {
    const value: unknown = JSON.parse(storage.getItem(VIEWED_KEY) ?? "null");
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function entries(storage: Storage, account: string): Record<string, unknown> {
  const mine = ACCOUNT.test(account) ? read(storage)[account] : null;
  return mine && typeof mine === "object" && !Array.isArray(mine) ? mine as Record<string, unknown> : {};
}

function valid(value: unknown, revision: PrRevision): string[] {
  if (!value || typeof value !== "object") return [];
  const { baseSha, headSha, paths } = value as Partial<Entry>;
  if (typeof baseSha !== "string" || typeof headSha !== "string" || !SHA.test(baseSha) || !SHA.test(headSha) || !Array.isArray(paths)) return [];
  if (baseSha !== revision.baseSha || headSha !== revision.headSha) return [];
  return [...new Set(paths.filter((path): path is string => typeof path === "string" && path.length > 0 && path.length <= 4096))].slice(0, PATHS);
}

/** The paths marked viewed at exactly this revision; none for any other. */
export function loadViewed(storage: Storage, key: PrKey, revision: PrRevision): string[] {
  return valid(entries(storage, key.account)[id(key)], revision);
}

/** Marks or unmarks one path at this revision and returns the paths as saved. */
export function setViewed(storage: Storage, key: PrKey, revision: PrRevision, path: string, viewed: boolean): string[] {
  if (!ACCOUNT.test(key.account) || !SHA.test(revision.baseSha) || !SHA.test(revision.headSha)) return [];
  const mine = entries(storage, key.account);
  const current = valid(mine[id(key)], revision).filter((p) => p !== path);
  const paths = viewed ? [...current, path].slice(-PATHS) : current;
  // Newest last; the oldest pull requests' marks go first when the list is full.
  const rest = Object.entries(mine).filter(([other]) => other !== id(key)).slice(-(PRS - 1));
  const next = paths.length ? [...rest, [id(key), { baseSha: revision.baseSha, headSha: revision.headSha, paths } satisfies Entry]] : rest;
  const document = { ...read(storage), [key.account]: Object.fromEntries(next) };
  try {
    storage.setItem(VIEWED_KEY, JSON.stringify(document));
    pending.delete(storage);
  } catch {
    pending.set(storage, document);
  }
  return paths;
}
