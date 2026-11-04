/**
 * The renderer's pane layout, kept in localStorage under one versioned key so every panel toggle
 * survives a relaunch the same way. Add new panels here (with a default) rather than as loose keys.
 */
export type Layout = {
  /** Thread list beside the rail. */
  sidebar: boolean;
  sidebarWidth?: number;
  workspaceWidth?: number;
  /** Code Review: the PR pane's width beside Changes, and the file tree's width inside Changes. */
  codeReviewSplit?: number;
  codeReviewTree?: number;
  /** Tabbed workspace on the right of a thread (the key is kept for existing preferences). */
  changes: boolean;
  /** Opaque, fail-closed cover for screen sharing and livestreams. */
  streamerMode: boolean;
  /** Analytics' icon in the rail (Settings → General). */
  analytics: boolean;
  /** Code Review's destination in the rail (Settings → General), off by default until its live and human gates pass (#319). Turning it off hides it: main's records and any write already sent stay. */
  codeReview: boolean;
};

export const LAYOUT_KEY = "modex.layout";
/** Pre-layout key that stored only the sidebar as "open" | "closed"; read once and migrated. */
export const LEGACY_SIDEBAR_KEY = "modex.sidebar";
/** The per-home switch Code Review had before this setting: "on" showed it; read until the layout saves a choice. */
export const LEGACY_CODE_REVIEW_SWITCH = "modex.codeReview";
export const DEFAULT_LAYOUT: Layout = { sidebar: true, changes: true, streamerMode: false, analytics: true, codeReview: false };

type Storage = { getItem(key: string): string | null; setItem(key: string, value: string): void };

/** Reads the saved layout; unknown or malformed fields fall back to their defaults, never throw. Development builds show Code Review unless told otherwise. */
export function loadLayout(storage: Storage, development = false): Layout {
  const layout: Layout = { ...DEFAULT_LAYOUT, codeReview: development };
  // The old switch keeps its meaning: "on" shows Code Review, and any other value that was set hides it.
  try {
    const legacy = storage.getItem(LEGACY_CODE_REVIEW_SWITCH);
    if (legacy !== null) layout.codeReview = legacy === "on";
  } catch { /* Storage is blocked: the default stands. */ }
  let saved: unknown = null;
  try {
    saved = JSON.parse(storage.getItem(LAYOUT_KEY) ?? "null");
  } catch {
    saved = null;
  }
  if (saved && typeof saved === "object") {
    for (const key of Object.keys(DEFAULT_LAYOUT) as ("sidebar" | "changes" | "streamerMode" | "analytics" | "codeReview")[]) {
      const v = (saved as Record<string, unknown>)[key];
      if (typeof v === "boolean") layout[key] = v;
    }
    for (const key of ["sidebarWidth", "workspaceWidth", "codeReviewSplit", "codeReviewTree"] as const) {
      const value = (saved as Record<string, unknown>)[key];
      if (typeof value === "number" && Number.isFinite(value) && value > 0) layout[key] = Math.round(value);
    }
  } else {
    try {
      if (storage.getItem(LEGACY_SIDEBAR_KEY) === "closed") layout.sidebar = false;
    } catch { /* Storage is blocked: the default stands. */ }
  }
  return layout;
}

export function saveLayout(storage: Storage, layout: Layout): void {
  storage.setItem(LAYOUT_KEY, JSON.stringify({ v: 1, ...layout }));
}
