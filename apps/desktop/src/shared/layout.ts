/**
 * The renderer's pane layout, kept in localStorage under one versioned key so every panel toggle
 * survives a relaunch the same way. Add new panels here (with a default) rather than as loose keys.
 */
export type Layout = {
  /** Thread list beside the rail. */
  sidebar: boolean;
  /** Changes panel on the right of a thread. */
  changes: boolean;
};

export const LAYOUT_KEY = "modex.layout";
/** Pre-layout key that stored only the sidebar as "open" | "closed"; read once and migrated. */
export const LEGACY_SIDEBAR_KEY = "modex.sidebar";
export const DEFAULT_LAYOUT: Layout = { sidebar: true, changes: true };

type Storage = { getItem(key: string): string | null; setItem(key: string, value: string): void };

/** Reads the saved layout; unknown or malformed fields fall back to their defaults, never throw. */
export function loadLayout(storage: Storage): Layout {
  const layout: Layout = { ...DEFAULT_LAYOUT };
  let saved: unknown = null;
  try {
    saved = JSON.parse(storage.getItem(LAYOUT_KEY) ?? "null");
  } catch {
    saved = null;
  }
  if (saved && typeof saved === "object") {
    for (const key of Object.keys(DEFAULT_LAYOUT) as (keyof Layout)[]) {
      const v = (saved as Record<string, unknown>)[key];
      if (typeof v === "boolean") layout[key] = v;
    }
  } else if (storage.getItem(LEGACY_SIDEBAR_KEY) === "closed") {
    layout.sidebar = false;
  }
  return layout;
}

export function saveLayout(storage: Storage, layout: Layout): void {
  storage.setItem(LAYOUT_KEY, JSON.stringify({ v: 1, ...layout }));
}
