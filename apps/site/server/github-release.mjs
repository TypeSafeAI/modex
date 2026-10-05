import fallback from "../release.json" with { type: "json" };
import { isCount, isVersion, releaseLinks, validRelease } from "../shared/release.mjs";

const API = "https://api.github.com/repos/TypeSafeAI/modex";
export const REFRESH_MS = 5 * 60_000;

export function publishedRelease(value, current) {
  if (!value || value.draft !== false || value.prerelease !== false
    || typeof value.tag_name !== "string" || !value.tag_name.startsWith("v")) return null;
  const version = value.tag_name.slice(1);
  if (!isVersion(version)) return null;
  const links = releaseLinks(version);
  if (!validRelease(links, current) || value.html_url !== links.url
    || !Array.isArray(value.assets)) return null;
  const installer = value.assets.find((asset) => asset.name === `Modex-${version}-arm64.dmg`
    && asset.browser_download_url === links.downloadUrl && asset.state === "uploaded"
    && Number.isSafeInteger(asset.size) && asset.size > 0);
  if (!installer || !Number.isFinite(Date.parse(value.published_at))) return null;
  return { ...links, publishedAt: value.published_at };
}

// A per-process cache also coalesces concurrent requests on a cold CDN edge.
// Only fixed public endpoints are queried; visitor headers and credentials are never forwarded.
export function createReleaseFeed({ fetchImpl = fetch, now = Date.now } = {}) {
  let cached = {
    release: { ...releaseLinks(fallback.version), publishedAt: null },
    stats: { stars: null, downloads: null, forks: null },
    checkedAt: null,
    stale: true,
  };
  let lastAttempt = -Infinity;
  let pending;

  async function refresh() {
    const signal = AbortSignal.timeout(12_000);
    async function get(path) {
      const response = await fetchImpl(`${API}${path}`, {
        headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "Modex-Website" },
        signal, redirect: "error",
      });
      if (!response.ok) throw new Error("GitHub metadata unavailable");
      return response.json();
    }

    async function downloads() {
      let total = 0;
      const seen = new Set();
      for (let page = 1; page <= 10; page++) {
        const releases = await get(`/releases?per_page=100&page=${page}`);
        if (!Array.isArray(releases)) throw new Error("Invalid releases response");
        for (const release of releases) {
          if (release.draft !== false || release.prerelease !== false) continue;
          if (!Array.isArray(release.assets)) throw new Error("Invalid release assets");
          for (const asset of release.assets) {
            // Count installer downloads, not checksums, logs, source archives or beta releases.
            if (!/^Modex-\d+\.\d+\.\d+-(arm64|x64)\.(dmg|zip)$/.test(asset.name)
              || asset.state !== "uploaded") continue;
            if (!isCount(asset.id) || !isCount(asset.download_count)) throw new Error("Invalid download count");
            if (!seen.has(asset.id)) { total += asset.download_count; seen.add(asset.id); }
          }
        }
        if (!isCount(total)) throw new Error("Invalid total download count");
        if (releases.length < 100) return total;
      }
      // Never label a partial page sum as the all-release total.
      throw new Error("Release pagination exceeded limit");
    }

    const results = await Promise.allSettled([get("/releases/latest"), get(""), downloads()]);
    const [latest, repository, count] = results;
    const release = latest.status === "fulfilled" ? publishedRelease(latest.value, cached.release.version) : null;
    const repo = repository.status === "fulfilled" ? repository.value : null;
    const stars = isCount(repo?.stargazers_count) ? repo.stargazers_count : null;
    const forks = isCount(repo?.forks_count) ? repo.forks_count : null;
    const complete = !!release && stars !== null && forks !== null && count.status === "fulfilled";
    cached = {
      release: release ?? cached.release,
      stats: {
        stars: stars ?? cached.stats.stars,
        forks: forks ?? cached.stats.forks,
        downloads: count.status === "fulfilled" ? count.value : cached.stats.downloads,
      },
      // This is the last fully successful snapshot; retained counts are explicitly marked stale.
      checkedAt: complete ? new Date(now()).toISOString() : cached.checkedAt,
      stale: !complete,
    };
    return cached;
  }

  return async () => {
    if (pending) return pending;
    if (now() - lastAttempt < REFRESH_MS) return cached;
    lastAttempt = now();
    pending = refresh().finally(() => { pending = undefined; });
    return pending;
  };
}

export const getReleaseFeed = createReleaseFeed();
