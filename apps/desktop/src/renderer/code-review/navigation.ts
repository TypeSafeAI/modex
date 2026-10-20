/**
 * Where the Code Review workspace is: which PR (by `prKeyId`), and how that PR's tabs are arranged.
 * Pure, so the navigation rules are tested without a window.
 */

/** Selected PRs, oldest first. `null` is the workspace with no PR open. */
export interface History { entries: (string | null)[]; index: number }

const HISTORY_LIMIT = 100;

export const EMPTY_HISTORY: History = { entries: [], index: -1 };

export function current(h: History): string | null {
  return h.entries[h.index] ?? null;
}

/** Selecting a PR; the same PR twice is one entry, and going somewhere new drops the forward entries. */
export function visit(h: History, keyId: string | null): History {
  if (h.index >= 0 && h.entries[h.index] === keyId) return h;
  const entries = [...h.entries.slice(0, h.index + 1), keyId].slice(-HISTORY_LIMIT);
  return { entries, index: entries.length - 1 };
}

export const canBack = (h: History) => h.index > 0;
export const canForward = (h: History) => h.index < h.entries.length - 1;
export const back = (h: History): History => canBack(h) ? { ...h, index: h.index - 1 } : h;
export const forward = (h: History): History => canForward(h) ? { ...h, index: h.index + 1 } : h;

export type Pane = "overview" | "changes";

/**
 * A PR's arrangement: the PR tab alone, its Changes tab alone, or both side by side (R4).
 * `changes` is whether the Changes tab is open; `focus` is the pane a split falls back to when narrow.
 */
export interface PrView { mode: "overview" | "changes" | "split"; changes: boolean; focus: Pane }

export const DEFAULT_VIEW: PrView = { mode: "overview", changes: true, focus: "overview" };

/** Choosing a tab shows its pane, or, in the split, focuses it. */
export function showTab(view: PrView, tab: Pane): PrView {
  if (view.mode === "split") return { ...view, focus: tab };
  return { mode: tab, changes: view.changes || tab === "changes", focus: tab };
}

/** Closing Changes leaves the PR tab as it was. */
export function closeChanges(_view: PrView): PrView {
  return { mode: "overview", changes: false, focus: "overview" };
}

/** Side by side, or back to the pane in focus. Entering the split opens Changes if it was closed. */
export function toggleSplit(view: PrView): PrView {
  if (view.mode === "split") return { mode: view.focus, changes: true, focus: view.focus };
  return { mode: "split", changes: true, focus: view.changes ? view.focus : "changes" };
}

/**
 * Pane minimums, in CSS px, from R4's split (PR pane 659, diff 470, file tree 290 at 1764 wide).
 * Below `min` the split shows its focused pane alone, with both tabs still in the strip.
 */
export const SPLIT = { overviewMin: 360, changesMin: 360, diffMin: 300, treeMin: 180, tree: 290, ratio: 0.465, get min() { return this.overviewMin + 1 + this.changesMin; } };

export function panesFor(view: PrView, width: number): Pane[] {
  if (view.mode !== "split") return [view.mode];
  return width >= SPLIT.min ? ["overview", "changes"] : [view.focus];
}

/** The PR pane's width in the split: the saved preference fitted to this window, never written back. */
export function fitSplit(saved: number | undefined, width: number): number {
  const max = Math.max(SPLIT.overviewMin, width - 1 - SPLIT.changesMin);
  return Math.max(SPLIT.overviewMin, Math.min(max, saved ?? Math.round((width - 1) * SPLIT.ratio)));
}

/** The file tree's width inside Changes, or null when Changes has no room for it beside the diff. */
export function fitTree(saved: number | undefined, width: number): number | null {
  if (width < SPLIT.diffMin + 1 + SPLIT.treeMin) return null;
  return Math.max(SPLIT.treeMin, Math.min(width - 1 - SPLIT.diffMin, saved ?? SPLIT.tree));
}
