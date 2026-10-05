import fallback from "../release.json";
import { isCount, validRelease } from "../shared/release.mjs";

const REFRESH_MS = 5 * 60_000;
let currentVersion = fallback.version;
let lastAttempt = -Infinity;
let pending = false;
const format = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const exact = new Intl.NumberFormat("en");

async function refresh() {
  if (pending || document.hidden || Date.now() - lastAttempt < REFRESH_MS) return;
  pending = true;
  lastAttempt = Date.now();
  try {
    const response = await fetch("/api/release", { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) return;
    const feed = await response.json();
    if (validRelease(feed?.release, currentVersion)) {
      const release = feed.release;
      currentVersion = release.version;
      document.querySelectorAll<HTMLAnchorElement>("[data-mac-download]").forEach((a) => { a.href = release.downloadUrl; });
      document.querySelectorAll<HTMLAnchorElement>("[data-release-link]").forEach((a) => { a.href = release.url; });
      document.querySelectorAll<HTMLElement>("[data-release-version]").forEach((el) => { el.textContent = `v${release.version}`; });
    }
    const labels = { stars: "GitHub stars", downloads: "Mac downloads", forks: "GitHub forks" };
    let visible = false;
    for (const [name, label] of Object.entries(labels)) {
      const value = feed?.stats?.[name];
      if (!isCount(value)) continue;
      const item = document.querySelector<HTMLAnchorElement>(`[data-stat="${name}"]`)!;
      item.querySelector<HTMLElement>("[data-count]")!.textContent = format.format(value);
      item.setAttribute("aria-label", `${exact.format(value)} ${label}`);
      item.title = `${exact.format(value)} ${label}${name === "downloads" ? " across stable DMG and ZIP releases; not unique users" : ""}`;
      item.hidden = false;
      visible = true;
    }
    if (visible) {
      document.querySelector<HTMLElement>(".community-stats")!.hidden = false;
      const note = document.querySelector<HTMLElement>("[data-stats-note]")!;
      note.textContent = feed.stale ? "Last available GitHub counts" : "From GitHub · refreshed periodically";
    }
  } catch {
    // Static verified downloads and previously loaded counts stay usable offline.
  } finally { pending = false; }
}

void refresh();
setInterval(() => void refresh(), REFRESH_MS);
window.addEventListener("focus", () => void refresh());
document.addEventListener("visibilitychange", () => void refresh());
