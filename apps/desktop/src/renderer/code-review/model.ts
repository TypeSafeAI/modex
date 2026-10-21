import { canonicalPrUrl, inboxGroup, mergePages, parsePrLocator, type Inbox, type InboxGroup, type PrKey, type PrLocator, type PrOverview, type PrState, type PrSummary, type ReadResult } from "../../shared/code-review.js";

/** An open PR: how it was named, and its overview read (which carries the totals and state). */
export interface OpenPr { key: PrKey; locator: PrLocator; title: string | null; state: PrState | null; overview: ReadResult<PrOverview> | null }

/** Page reads keyed by cursor. Retain earlier stale/partial evidence until that page is retried. */
export type GroupPages = Partial<Record<InboxGroup, { reads: Record<string, ReadResult<PrSummary[]>> }>>;

export function titleOf(pr: OpenPr): string {
  if (pr.title) return pr.title;
  if (pr.overview && pr.overview.state !== "unavailable") return pr.overview.value.title;
  return `${pr.locator.repo} #${pr.locator.number}`;
}

/** Every row the inbox has shown this session, first pages and later ones. */
export function rowsOf(inbox: ReadResult<Inbox> | null, pages: GroupPages): PrSummary[] {
  if (!inbox) return [];
  return (["authored", "review-requested"] as const).flatMap((group) => {
    const result = inboxGroup(inbox, group);
    return mergePages([result, ...Object.values(pages[group]?.reads ?? {})]).rows;
  });
}

/** A validated link for Copy link and Open in GitHub: built from the locator, then parsed back. */
export function prUrl(locator: PrLocator): string | null {
  const url = canonicalPrUrl(locator);
  return parsePrLocator(url) ? url : null;
}
