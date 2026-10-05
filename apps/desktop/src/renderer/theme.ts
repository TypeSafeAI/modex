import { normalizeTheme, type Theme } from "../shared/theme";

const CACHE_KEY = "modex.theme";
/** A paint cache only; persisted Settings remain authoritative after state:get. */
export function restoreTheme(): void {
  let theme: Theme = "jev";
  try { theme = normalizeTheme(localStorage.getItem(CACHE_KEY)); } catch { /* Storage may be unavailable. */ }
  applyTheme(theme);
}

export function applyTheme(theme: Theme): void {
  try { localStorage.setItem(CACHE_KEY, theme); } catch { /* Settings still persist in main. */ }
  const root = document.documentElement;
  if (root.dataset.theme === theme) return;
  const style = document.createElement("style");
  style.textContent = "*,*::before,*::after{transition:none !important}";
  document.head.append(style);
  root.dataset.theme = theme;
  void document.body.offsetHeight;
  requestAnimationFrame(() => requestAnimationFrame(() => style.remove()));
}
