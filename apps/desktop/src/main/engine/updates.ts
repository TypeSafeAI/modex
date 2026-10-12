import type { ReleaseUpdate } from "../../shared/types.js";

const LATEST_RELEASE = "https://api.github.com/repos/TypeSafeAI/modex/releases/latest";
const RELEASE_PAGE = "https://github.com/TypeSafeAI/modex/releases/tag/";
const HOUR = 60 * 60 * 1000;
const versionParts = (value: string): number[] | null => {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) return null;
  const parts = value.split(".").map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
};
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object";
export interface ReleaseArchive { version: string; arch: "arm64" | "x64"; size: number; sha256: string }

/** Only offer a newer stable release with an uploaded installer for this Mac. */
export function releaseUpdate(value: unknown, current: string, platform: string, arch: string): ReleaseUpdate | null {
  if (platform !== "darwin" || !["arm64", "x64"].includes(arch) || !record(value)) return null;
  if (value.draft !== false || value.prerelease !== false || typeof value.published_at !== "string" || !Number.isFinite(Date.parse(value.published_at))) return null;
  if (typeof value.tag_name !== "string" || !value.tag_name.startsWith("v")) return null;
  const version = value.tag_name.slice(1);
  const next = versionParts(version), installed = versionParts(current);
  if (!next || !installed) return null;
  const difference = next.findIndex((part, i) => part !== installed[i]);
  if (difference < 0 || next[difference]! < installed[difference]!) return null;
  if (!Array.isArray(value.assets) || !value.assets.some((asset) => record(asset)
    && asset.name === `Modex-${version}-${arch}.dmg` && asset.state === "uploaded"
    && typeof asset.size === "number" && Number.isFinite(asset.size) && asset.size > 0)) return null;
  // Construct the destination ourselves; release metadata never chooses an external host.
  return { version, url: `${RELEASE_PAGE}${value.tag_name}` };
}

/** Download integrity metadata only; the app signature authenticates its publisher. */
export function releaseArchive(value: unknown, current: string, platform: string, arch: string): ReleaseArchive | null {
  const update = releaseUpdate(value, current, platform, arch);
  if (!update || !record(value) || !Array.isArray(value.assets) || (arch !== "arm64" && arch !== "x64")) return null;
  const matches = value.assets.filter(asset => record(asset) && asset.name === `Modex-${update.version}-${arch}.zip`);
  const asset = matches[0];
  if (matches.length !== 1 || !record(asset) || asset.state !== "uploaded"
    || typeof asset.size !== "number" || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > 512 * 1024 * 1024
    || typeof asset.digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(asset.digest)) return null;
  return { version: update.version, arch, size: asset.size, sha256: asset.digest.slice(7) };
}

async function releaseJSON(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("Release metadata is missing");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 1024 * 1024) throw new Error("Release metadata exceeds the size limit");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** Coalesce callers and keep network failures out of the workspace. */
export class ReleaseChecker {
  private available: ReleaseUpdate | null = null;
  private downloadable: ReleaseArchive | null = null;
  private nextCheck = 0;
  private pending?: Promise<ReleaseUpdate | null>;
  constructor(private readonly options: {
    currentVersion: string; platform: string; arch: string; enabled: boolean;
    fetcher?: typeof fetch; now?: () => number;
  }) {}
  private now(): number { return (this.options.now ?? Date.now)(); }
  archive(): ReleaseArchive | null { return this.downloadable ? { ...this.downloadable } : null; }
  check(): Promise<ReleaseUpdate | null> {
    if (!this.options.enabled || this.options.platform !== "darwin") return Promise.resolve(null);
    if (this.pending) return this.pending;
    if (this.now() < this.nextCheck) return Promise.resolve(this.available);
    this.pending = this.load().finally(() => { this.pending = undefined; });
    return this.pending;
  }
  private async load(): Promise<ReleaseUpdate | null> {
    const startedAt = this.now();
    try {
      const response = await (this.options.fetcher ?? fetch)(LATEST_RELEASE, {
        headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2026-03-10", "User-Agent": `Modex/${this.options.currentVersion}` },
        redirect: "error", signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error("Release check unavailable");
      }
      const metadata = await releaseJSON(response);
      this.available = releaseUpdate(metadata, this.options.currentVersion, this.options.platform, this.options.arch);
      this.downloadable = releaseArchive(metadata, this.options.currentVersion, this.options.platform, this.options.arch);
      this.nextCheck = startedAt + HOUR;
    } catch {
      this.nextCheck = startedAt + 15 * 60 * 1000;
    }
    return this.available;
  }
}
