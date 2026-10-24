import type { PrActivity, PrStack, ReadResult } from "./code-review.js";
import { canonicalPrUrl } from "./code-review.js";
import { safeHref } from "./inline.js";

/** Ordered, contiguous page reads. Failed pages preserve their predecessor's remaining cursor. */
export function activityPages(pages: ReadResult<PrActivity[]>[]) {
  const unique = new Map<string, PrActivity>();
  let next: string | null = null;
  let complete = false;
  let fresh = true;
  for (const page of pages) {
    if (page.state === "unavailable") { complete = false; break; }
    for (const row of page.value) unique.set(`${row.kind}:${row.id}`, row);
    fresh = fresh && page.state === "ready";
    next = page.coverage?.next ?? null;
    complete = fresh && page.coverage?.complete === true;
  }
  const rows = [...unique.values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`));
  return { rows, next, complete };
}

/** Show the actual destination, never a bot's claim about where a preview goes. */
export function externalDestination(raw: string | null): string | null {
  if (!raw || /[\u0000-\u0020\u007f]/.test(raw)) return null;
  const safe = safeHref(raw);
  if (!safe) return null;
  const url = new URL(safe);
  return url.username || url.password ? null : safe;
}

/** A serial ordering must not duplicate a member or name a nonexistent current position. */
export function stackOrder(stack: PrStack): boolean {
  const identities = stack.members.map(m => canonicalPrUrl(m.locator));
  return Number.isInteger(stack.position) && stack.position >= 0 && stack.position < identities.length && new Set(identities).size === identities.length;
}

/** A transient IPC/transport failure may retain prior evidence, never after loss of visibility. */
export function retainRead<T>(previous: ReadResult<T> | undefined, next: ReadResult<T>): ReadResult<T> {
  return next.state === "unavailable" && ["offline", "timeout", "rate-limited", "failed", "head-changed"].includes(next.reason) && previous && previous.state !== "unavailable"
    ? { ...previous, state: "stale", reason: next.reason }
    : next;
}
export function refreshingRead<T>(read: ReadResult<T>): ReadResult<T> {
  return read.state === "unavailable" ? read : { ...read, state: "stale", reason: "failed" };
}
