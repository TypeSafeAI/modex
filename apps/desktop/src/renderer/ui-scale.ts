/**
 * Interface size: the whole app drawn larger, as a zoom on the root element. It is this window's own choice,
 * kept in local storage. Measured rectangles come back in zoomed pixels while a fixed position is given in
 * unzoomed ones, so anything placed from a measurement divides by `uiScale()`.
 */
export const UI_SCALES = [1, 1.1, 1.25] as const;
const KEY = "modex.ui.scale";

export function uiScale(): number {
  const value = Number(document.documentElement.style.zoom || 1);
  return value > 0 ? value : 1;
}

/** The saved size, or the default: 100% in the desktop app, 110% in a browser tab, where windows run large. */
export function savedUiScale(): number {
  try {
    const saved = Number(localStorage.getItem(KEY));
    if ((UI_SCALES as readonly number[]).includes(saved)) return saved;
  } catch { /* Blocked storage: the default. */ }
  return window.modex ? 1 : 1.1;
}

export function applyUiScale(scale: number, save = false): void {
  document.documentElement.style.zoom = scale === 1 ? "" : String(scale);
  if (save) try { localStorage.setItem(KEY, String(scale)); } catch { /* This session only. */ }
}
