import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { BrowserExtension } from "../../shared/browser.js";

interface Loader {
  loadExtension(directory: string, options: { allowFileAccess: boolean }): Promise<{ id: string }>;
  removeExtension(id: string): void;
}
interface Package { name: string; version: string; sites: string[]; digest: string; files: Map<string, Buffer> }
interface SavedExtension extends BrowserExtension { digest: string }
const MAX_BYTES = 20 * 1024 * 1024;
const manifestKeys = new Set(["manifest_version", "name", "version", "description", "author", "short_name", "icons", "permissions", "content_scripts"]);
const scriptKeys = new Set(["matches", "exclude_matches", "js", "css", "run_at", "all_frames"]);
const object = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(s => typeof s === "string");
const sitePattern = (v: string) => /^https:\/\/(?:\*|(?:\*\.)?[a-z\d]+(?:[.-][a-z\d]+)*)\/[^\s]*$/i.test(v) || /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])\/[^\s]*$/i.test(v);

/** Inspect the exact bytes that will be approved and installed, never a mutable source path. */
export async function inspectExtension(directory: string): Promise<Package> {
  const files = new Map<string, Buffer>();
  let bytes = 0, entries = 0;
  async function walk(relative = "", depth = 0): Promise<void> {
    if (depth > 12) throw new Error("Extension directory nesting exceeds the limit.");
    for (const name of (await fs.readdir(path.join(directory, relative))).sort()) {
      if (++entries > 1000) throw new Error("Extension exceeds the 1,000 file limit.");
      const rel = path.posix.join(relative, name);
      const file = path.join(directory, rel);
      const stat = await fs.lstat(file);
      if (stat.isSymbolicLink()) throw new Error("Extensions cannot contain symbolic links.");
      if (stat.isDirectory()) { await walk(rel, depth + 1); continue; }
      if (!stat.isFile()) throw new Error("Extensions may contain only regular files.");
      if (bytes + stat.size > MAX_BYTES) throw new Error("Extension is too large (20 MB limit).");
      // O_NOFOLLOW also closes the lstat/open symlink race; read at most the remaining budget.
      const handle = await fs.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const buffer = Buffer.alloc(Math.min(stat.size + 1, MAX_BYTES - bytes + 1));
        let read = 0;
        while (read < buffer.length) {
          const chunk = await handle.read(buffer, read, buffer.length - read, null);
          if (!chunk.bytesRead) break;
          read += chunk.bytesRead;
        }
        if (read > stat.size || bytes + read > MAX_BYTES) throw new Error("Extension changed or exceeds the size limit.");
        bytes += read;
        files.set(rel, buffer.subarray(0, read));
      } finally { await handle.close(); }
    }
  }
  await walk();
  let manifest: unknown;
  try { manifest = JSON.parse(files.get("manifest.json")?.toString("utf8") ?? ""); }
  catch { throw new Error("Choose an unpacked extension folder containing a valid manifest.json."); }
  if (!object(manifest) || manifest.manifest_version !== 3 || typeof manifest.name !== "string" || !manifest.name.trim() || manifest.name.length > 100 || typeof manifest.version !== "string" || !/^\d+(?:\.\d+){0,3}$/.test(manifest.version)) throw new Error("Use a Manifest V3 extension with a name and numeric version.");
  const unsupported = Object.keys(manifest).filter(key => !manifestKeys.has(key));
  if (unsupported.length) throw new Error(`Unsupported extension capabilities: ${unsupported.join(", ")}. Only page scripts, styles and local storage are supported.`);
  if (manifest.permissions !== undefined && (!strings(manifest.permissions) || manifest.permissions.some(p => p !== "storage"))) throw new Error("Only the storage permission is supported. Native messaging and browser-wide APIs are unavailable.");
  const asset = (value: unknown) => typeof value === "string" && !value.includes("\\") && !value.split("/").some(part => !part || part === "." || part === "..") && files.has(value);
  if (manifest.icons !== undefined && (!object(manifest.icons) || Object.values(manifest.icons).some(value => !asset(value)))) throw new Error("Extension icons must name files inside the extension.");
  if (!Array.isArray(manifest.content_scripts) || !manifest.content_scripts.length || manifest.content_scripts.length > 50) throw new Error("This extension needs between 1 and 50 content scripts.");
  const sites = new Set<string>();
  for (const script of manifest.content_scripts) {
    if (!object(script) || Object.keys(script).some(key => !scriptKeys.has(key))) throw new Error("Unsupported content script options.");
    if (!strings(script.matches) || !script.matches.length || script.matches.length > 100 || script.matches.some(v => !sitePattern(v))) throw new Error("Extension sites must be HTTPS or an exact localhost HTTP host.");
    if (script.exclude_matches !== undefined && (!strings(script.exclude_matches) || script.exclude_matches.some(v => !sitePattern(v)))) throw new Error("Invalid excluded extension sites.");
    if (script.all_frames !== undefined && typeof script.all_frames !== "boolean") throw new Error("Invalid all_frames option.");
    if (script.run_at !== undefined && !["document_start", "document_end", "document_idle"].includes(String(script.run_at))) throw new Error("Invalid content script run time.");
    let assets = 0;
    for (const key of ["js", "css"]) {
      if (script[key] === undefined) continue;
      if (!strings(script[key]) || script[key].some(value => !asset(value))) throw new Error("Content scripts must name existing files inside the extension.");
      assets += script[key].length;
    }
    if (!assets) throw new Error("Each content script needs a script or stylesheet.");
    script.matches.forEach(site => sites.add(site));
  }
  const digest = createHash("sha256");
  for (const [file, content] of files) digest.update(file).update("\0").update(String(content.length)).update("\0").update(content);
  return { name: manifest.name.trim(), version: manifest.version, sites: [...sites].sort(), digest: digest.digest("hex"), files };
}

/** Approved packages live in an app-owned directory; only this browser's session loads them. */
export class BrowserExtensions {
  private entries: SavedExtension[] = [];
  private loaded = new Map<string, string>();
  private pending = Promise.resolve();
  constructor(private root: string, private loader: Loader) {}
  snapshot(): BrowserExtension[] { return this.entries.map(({ digest: _digest, ...entry }) => ({ ...entry, sites: [...entry.sites] })); }
  private directory(id: string): string { return path.join(this.root, "extensions", id); }
  private async save(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(this.root, "extensions.json.tmp"), JSON.stringify(this.entries), { mode: 0o600 });
    await fs.rename(path.join(this.root, "extensions.json.tmp"), path.join(this.root, "extensions.json"));
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation);
    this.pending = result.then(() => {}, () => {});
    return result;
  }
  async restore(): Promise<void> {
    let saved: unknown;
    try { saved = JSON.parse(await fs.readFile(path.join(this.root, "extensions.json"), "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw new Error("Browser extension settings could not be read."); }
    if (!Array.isArray(saved) || saved.length > 12 || saved.some(e => !object(e) || typeof e.id !== "string" || !/^[a-f\d-]{36}$/.test(e.id) || typeof e.digest !== "string" || !/^[a-f\d]{64}$/.test(e.digest) || typeof e.enabled !== "boolean" || typeof e.name !== "string" || typeof e.version !== "string" || !strings(e.sites)) || new Set(saved.map(e => e.id)).size !== saved.length) throw new Error("Browser extension settings are invalid.");
    this.entries = saved;
    for (const entry of this.entries) {
      if (!entry.enabled) continue;
      try { await this.enable(entry); }
      catch { entry.enabled = false; entry.error = "The extension is unavailable or its approved files changed. Remove it and install it again."; }
    }
  }
  private async enable(entry: SavedExtension): Promise<void> {
    const candidate = await inspectExtension(this.directory(entry.id));
    if (candidate.digest !== entry.digest) throw new Error("Extension files changed after approval. Remove it and install it again.");
    const loaded = await this.loader.loadExtension(this.directory(entry.id), { allowFileAccess: false });
    this.loaded.set(entry.id, loaded.id);
    entry.enabled = true;
    delete entry.error;
  }
  install(candidate: Package): Promise<BrowserExtension> {
    return this.serial(async () => {
      if (this.entries.length >= 12) throw new Error("Remove an extension before adding another (12 maximum).");
      const entry: SavedExtension = { id: randomUUID(), name: candidate.name, version: candidate.version, sites: candidate.sites, digest: candidate.digest, enabled: false };
      const directory = this.directory(entry.id);
      try {
        for (const [name, bytes] of candidate.files) {
          const file = path.join(directory, name);
          await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
          await fs.writeFile(file, bytes, { mode: 0o600 });
        }
        await this.enable(entry);
        this.entries.push(entry);
        await this.save();
        return this.snapshot().find(item => item.id === entry.id)!;
      } catch {
        const loaded = this.loaded.get(entry.id);
        if (loaded) this.loader.removeExtension(loaded);
        this.loaded.delete(entry.id);
        this.entries = this.entries.filter(item => item !== entry);
        await fs.rm(directory, { recursive: true, force: true });
        throw new Error("The extension could not be loaded or saved.");
      }
    });
  }
  update(id: string, action: "enable" | "disable" | "remove"): Promise<void> {
    return this.serial(async () => {
      const entry = this.entries.find(e => e.id === id);
      if (!entry || !["enable", "disable", "remove"].includes(action)) throw new Error("Unknown browser extension action.");
      if (action === "enable") { if (!this.loaded.has(id)) await this.enable(entry); }
      else {
        const loaded = this.loaded.get(id);
        if (loaded) this.loader.removeExtension(loaded);
        this.loaded.delete(id);
        entry.enabled = false;
      }
      if (action === "remove") this.entries = this.entries.filter(e => e !== entry);
      try { await this.save(); }
      catch { throw new Error("Extension settings could not be saved. Try again before restarting Modex."); }
      if (action === "remove") await fs.rm(this.directory(id), { recursive: true, force: true });
    });
  }
}
