import { parsePrLocator, canonicalPrUrl, type PrKey, type PrLocator } from "../../shared/code-review.js";

/**
 * Pinned PRs (C24, D2): a local list per signed-in account, never synced to GitHub or another device.
 * A pin keeps what is needed to find the PR again; opening one resolves its link first, since main
 * learns a repository's name only from its own reads.
 */
export interface Pin { key: PrKey; locator: PrLocator; title: string }

export const PINS_KEY = "modex.codeReview.pins";
const LIMIT = 50;

type Storage = { getItem(key: string): string | null; setItem(key: string, value: string): void };

const ACCOUNT = /^[1-9][0-9]{0,19}$/;
const REPO_ID = /^[A-Za-z0-9_=-]{1,100}$/;

function read(storage: Storage): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(storage.getItem(PINS_KEY) ?? "null");
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function valid(value: unknown, account: string): Pin | null {
  if (!value || typeof value !== "object") return null;
  const { key, locator, title } = value as Partial<Pin>;
  if (!key || key.host !== "github.com" || key.account !== account || !ACCOUNT.test(account) || typeof key.repoId !== "string" || !REPO_ID.test(key.repoId)) return null;
  if (!Number.isSafeInteger(key.number) || key.number <= 0 || typeof title !== "string") return null;
  // A locator is accepted only in the form `parsePrLocator` would produce for its own link.
  const parsed = locator && typeof locator === "object" && typeof locator.owner === "string" && typeof locator.repo === "string" && Number.isSafeInteger(locator.number)
    ? parsePrLocator(canonicalPrUrl({ host: "github.com", owner: locator.owner, repo: locator.repo, number: locator.number })) : null;
  if (!parsed || parsed.number !== key.number || parsed.owner !== locator!.owner || parsed.repo !== locator!.repo) return null;
  return { key: { account, host: "github.com", repoId: key.repoId, number: key.number }, locator: parsed, title: title.slice(0, 512) };
}

export function loadPins(storage: Storage, account: string): Pin[] {
  const list = read(storage)[account];
  return Array.isArray(list) ? list.map((pin) => valid(pin, account)).filter((pin): pin is Pin => pin !== null).slice(0, LIMIT) : [];
}

const same = (a: PrKey, b: PrKey) => a.account === b.account && a.repoId === b.repoId && a.number === b.number;

export function isPinned(pins: Pin[], key: PrKey): boolean {
  return pins.some((pin) => same(pin.key, key));
}

/** Pins or unpins, newest first, and returns the account's list as saved. */
export function togglePin(storage: Storage, account: string, pin: Pin): Pin[] {
  const pins = loadPins(storage, account);
  const next = isPinned(pins, pin.key) ? pins.filter((p) => !same(p.key, pin.key)) : [pin, ...pins].slice(0, LIMIT);
  try {
    storage.setItem(PINS_KEY, JSON.stringify({ ...read(storage), [account]: next }));
  } catch { /* A full or blocked store keeps the pin for this session only. */ }
  return next;
}
