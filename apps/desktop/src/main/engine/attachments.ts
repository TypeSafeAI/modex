import fs from "node:fs";
import path from "node:path";
import { newId } from "./store.js";
import { LIMITS, kindFor, mimeFor, rejectReason, safeName, type Attachment } from "../../shared/attachments.js";

type Identity = Pick<fs.Stats, "dev" | "ino">;
type OwnedFile = { attachment: Attachment; identity: Identity };
const identity = ({ dev, ino }: Identity): Identity => ({ dev, ino });
const sameIdentity = (a: Identity, b: Identity): boolean => a.dev === b.dev && a.ino === b.ino;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const attachmentShape = (a: unknown): a is Attachment => record(a)
  && ["id", "name", "mime", "rel"].every(key => typeof a[key] === "string" && !!a[key])
  && typeof a.size === "number" && Number.isFinite(a.size) && a.size >= 0
  && (a.kind === "image" || a.kind === "file");
const requestError = (files: unknown, limit = LIMITS.perTurn): string | null => !Array.isArray(files)
  ? "Attachments must be an array." : files.length > limit ? `A message can have at most ${limit} attachments.` : null;

/**
 * Owns `<home>/attachments`: `staging/` for files attached but not yet sent, one folder per thread
 * for the rest. Everything the renderer sees is a `rel` under this root; `resolve` is the only way
 * back to an absolute path and refuses anything that would leave the root.
 */
export class AttachmentStore {
  readonly staging: string;
  private readonly canonicalRoot: string;
  private readonly rootIdentity: fs.Stats;
  private readonly directoryIdentities = new Map<string, Identity>();
  private manifestIdentity?: Identity;
  private records = new Map<string, OwnedFile>();
  // Retire only after the new manifest is durable. Failed cleanup remains retryable after restart.
  private retired: OwnedFile[] = [];

  constructor(readonly root: string) {
    this.root = path.resolve(root);
    this.staging = path.join(this.root, "staging");
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    this.rootIdentity = fs.lstatSync(this.root);
    if (!this.rootIdentity.isDirectory()) throw new Error("attachment root is not a directory");
    this.canonicalRoot = fs.realpathSync(this.root);
    const staging = this.directory("staging", true);
    if (!staging) throw new Error("attachment staging directory is unavailable or changed");
    this.loadManifest();
  }

  /** IPC is untrusted: reject excessive requests before any per-file decoding or filesystem work. */
  stage(files: unknown, { bytesOnly = false }: { bytesOnly?: boolean } = {}): { staged: Attachment[]; errors: string[] } {
    const error = requestError(files);
    if (error) return { staged: [], errors: [error] };
    const staged: Attachment[] = [];
    const errors: string[] = [];
    for (const f of files as unknown[]) {
      let created: OwnedFile | undefined;
      try {
        if (bytesOnly && (!record(f) || f.path !== undefined || typeof f.data !== "string")) throw new Error("Browser attachments require bytes; source paths are not allowed.");
        if (!record(f) || typeof f.name !== "string") throw new Error("file name must be a string");
        if (f.mime !== undefined && typeof f.mime !== "string") throw new Error("MIME type must be a string");
        if (f.size !== undefined && (typeof f.size !== "number" || !Number.isFinite(f.size) || f.size < 0)) throw new Error("size must be a finite nonnegative number");
        if ((f.path !== undefined) === (f.data !== undefined)
          || (f.path !== undefined && (typeof f.path !== "string" || !f.path || f.path.includes("\0")))
          || (f.data !== undefined && typeof f.data !== "string")) throw new Error("provide exactly one file path or base64 data string");
        const name = safeName(f.name);
        const mime = mimeFor(name, f.mime as string | undefined);
        const kind = kindFor(mime);
        const limit = kind === "image" ? LIMITS.imageBytes : LIMITS.fileBytes;
        const checkSize = (size: number) => {
          const reason = rejectReason(name, size, kind);
          if (reason) throw new Error(reason);
        };
        let contents: Buffer;
        if (typeof f.data === "string") {
          // A bounded, linear check before Buffer.from (which otherwise tolerates malformed input).
          if (f.data.length > 4 * Math.ceil(limit / 3)) checkSize(limit + 1);
          if (!/^[A-Za-z0-9+/]*={0,2}$/.test(f.data) || f.data.length % 4 === 1
            || (f.data.includes("=") && f.data.length % 4 !== 0)) throw new Error("invalid base64 data");
          contents = Buffer.from(f.data, "base64");
          if (contents.toString("base64").replace(/=+$/, "") !== f.data.replace(/=+$/, "")) throw new Error("invalid base64 data");
          checkSize(contents.length);
        } else {
          // Opening follows an explicitly selected source symlink. Reads stay bounded even if it grows.
          const fd = fs.openSync(f.path as string, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
          try {
            const stat = fs.fstatSync(fd);
            if (!stat.isFile()) throw new Error(`${name} is not a file.`);
            checkSize(stat.size);
            const chunks: Buffer[] = [];
            let size = 0;
            while (true) {
              const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, limit + 1 - size));
              const read = fs.readSync(fd, chunk, 0, chunk.length, null);
              if (!read) break;
              size += read;
              checkSize(size);
              chunks.push(chunk.subarray(0, read));
            }
            contents = Buffer.concat(chunks, size);
          } finally { fs.closeSync(fd); }
        }
        if (bytesOnly && (!Number.isSafeInteger(f.size) || f.size !== contents.length)) throw new Error("Declared size does not match attachment bytes.");
        const id = newId();
        if (this.records.has(id)) throw new Error("attachment ID collision; attach the file again");
        const attachment: Attachment = { id, name, mime, size: contents.length, kind, rel: `staging/${id}-${name}` };
        const dir = this.directory("staging");
        if (!dir) throw new Error("attachment staging directory is unavailable or changed");
        const dest = path.join(dir, path.basename(attachment.rel));
        const fd = fs.openSync(dest, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        try {
          created = { attachment, identity: identity(fs.fstatSync(fd)) };
          fs.writeFileSync(fd, contents);
        } finally { fs.closeSync(fd); }
        const next = new Map(this.records).set(id, created);
        this.commit(next);
        staged.push({ ...attachment });
      } catch (err) {
        if (created) this.deleteOwned(created);
        const label = record(f) && typeof f.name === "string" && f.name ? f.name : "file";
        const code = (err as NodeJS.ErrnoException).code;
        const message = bytesOnly && code ? "Could not store attachment." : code === "ENOENT" ? "not found" : (err as Error).message;
        errors.push(message.startsWith(`${label} is `) ? message : `${label}: ${message}`);
      }
    }
    return { staged, errors };
  }

  /** Native picker paths share staging's limits, including the composer's remaining slots. */
  stagePaths(paths: unknown, remaining: unknown = LIMITS.perTurn): { staged: Attachment[]; errors: string[] } {
    if (typeof remaining !== "number" || !Number.isInteger(remaining) || remaining < 0 || remaining > LIMITS.perTurn) {
      return { staged: [], errors: ["Remaining attachment slots must be an integer from 0 to 20."] };
    }
    const error = requestError(paths, remaining);
    if (error) return { staged: [], errors: [error] };
    return this.stage((paths as unknown[]).map(p => typeof p === "string" ? { name: path.basename(p), path: p } : { name: "file", path: p }));
  }

  /** Drops staged files the user removed from the composer, never a sent file or an unowned path. */
  discard(ids: string[]): void {
    if (!Array.isArray(ids)) return;
    const selected = new Set(ids.filter(id => typeof id === "string"));
    this.retire([...this.records.values()].filter(file => selected.has(file.attachment.id)
      && file.attachment.rel.startsWith("staging/") && this.resolve(file.attachment.rel)));
  }

  /** Validate the entire request, then copy exclusively and commit ownership before retiring sources. */
  claim(threadId: string, attachments: unknown): Attachment[] {
    if (!this.isThreadId(threadId)) throw new Error(`bad thread id ${threadId}`);
    const error = requestError(attachments);
    if (error) throw new Error(error);
    this.assertManifest();
    const ids = new Set<string>();
    const paths = new Set<string>();
    const files = Array.from(attachments as unknown[], a => {
      if (!attachmentShape(a)) throw new Error("Invalid attachment metadata.");
      if (ids.has(a.id) || paths.has(a.rel)) throw new Error("Duplicate attachment ID or path.");
      ids.add(a.id); paths.add(a.rel);
      const owned = this.records.get(a.id);
      if (!owned) throw new Error(`Unknown attachment metadata for ${a.name}.`);
      if (Object.keys(owned.attachment).some(key => a[key as keyof Attachment] !== owned.attachment[key as keyof Attachment])) {
        throw new Error(`attachment ${a.name} is no longer staged or its metadata has changed`);
      }
      const folder = a.rel.split("/")[0];
      if (folder !== "staging" && folder !== threadId) throw new Error(`attachment ${a.name} belongs to another thread`);
      if (!this.resolve(a.rel)) throw new Error(`attachment ${a.name} is missing or changed`);
      return owned;
    });
    // Recover only main-recorded leftovers from earlier failed claims, after validating the whole input.
    this.cleanupRetired();
    for (const { attachment: a } of files) {
      if (!a.rel.startsWith("staging/")) continue;
      const dest = path.join(this.root, threadId, path.basename(a.rel));
      try { fs.lstatSync(dest); }
      catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") continue; throw err; }
      throw new Error(`attachment destination already exists for ${a.name}`);
    }
    if (!files.some(file => file.attachment.rel.startsWith("staging/"))) return files.map(file => ({ ...file.attachment }));
    const dir = this.directory(threadId, true);
    if (!dir) throw new Error(`attachment directory for ${threadId} is unavailable or changed`);
    const copied: OwnedFile[] = [];
    const temporary: OwnedFile[] = [];
    const sources: OwnedFile[] = [];
    const prepared: { source: OwnedFile; claimed: OwnedFile; temp: string; dest: string }[] = [];
    const priorRetired = this.retired;
    const next = new Map(this.records);
    try {
      for (const owned of files) {
        const a = owned.attachment;
        if (!a.rel.startsWith("staging/")) continue;
        const from = this.resolve(a.rel);
        if (!from || this.directory(threadId) !== dir) throw new Error(`attachment ${a.name} is missing or changed`);
        const dest = path.join(dir, path.basename(a.rel));
        // Establish identity on a unique temporary file before publishing the final path.
        // Even an initial fstat failure cannot leave a final-name collision that blocks retry.
        const tempAttachment = { ...a, rel: `${threadId}/.claim-${newId()}.tmp` };
        const temp = path.join(dir, path.basename(tempAttachment.rel));
        const fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        let tempOwned: OwnedFile | undefined;
        try {
          tempOwned = { attachment: tempAttachment, identity: identity(fs.fstatSync(fd)) };
          temporary.push(tempOwned);
          const source = fs.openSync(from, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
          try {
            const stat = fs.fstatSync(source);
            if (!stat.isFile() || !sameIdentity(stat, owned.identity) || stat.size !== a.size) throw new Error(`attachment ${a.name} changed during copying`);
            const buffer = Buffer.allocUnsafe(64 * 1024);
            let size = 0;
            while (true) {
              const read = fs.readSync(source, buffer, 0, Math.min(buffer.length, a.size + 1 - size), null);
              if (!read) break;
              size += read;
              if (size > a.size) throw new Error(`attachment ${a.name} changed during copying`);
              let written = 0;
              while (written < read) {
                const count = fs.writeSync(fd, buffer, written, read - written);
                if (!count) throw new Error(`attachment ${a.name} could not be copied`);
                written += count;
              }
            }
            if (size !== a.size) throw new Error(`attachment ${a.name} changed during copying`);
          } finally { fs.closeSync(source); }
          fs.fsyncSync(fd);
        } catch (err) {
          // Recover a transient first-stat failure while the owned fd is still open. If the
          // filesystem cannot identify it at all, leave only an empty unique temp, never a final path.
          if (!tempOwned) {
            try { temporary.push({ attachment: tempAttachment, identity: identity(fs.fstatSync(fd)) }); }
            catch { /* no bytes were written and no final path was published */ }
          }
          throw err;
        } finally { fs.closeSync(fd); }
        const claimed = { attachment: { ...a, rel: `${threadId}/${path.basename(a.rel)}` }, identity: tempOwned.identity };
        prepared.push({ source: owned, claimed, temp, dest });
        sources.push(owned);
        next.set(a.id, claimed);
      }
      // Write-ahead ownership keeps rollback recoverable even if cleanup AND the final metadata
      // commit fail. Until the final commit, every authoritative attachment still names staging.
      this.commit(this.records, [...priorRetired, ...temporary, ...prepared.map(file => file.claimed)]);
      for (const { source, claimed, temp, dest } of prepared) {
        const a = source.attachment;
        if (!this.resolve(a.rel) || this.directory(threadId) !== dir) throw new Error(`attachment ${a.name} changed during copying`);
        // link is exclusive; the checkpoint already owns this inode before any final path exists.
        fs.linkSync(temp, dest);
        copied.push(claimed);
        const stat = fs.lstatSync(dest);
        if (!stat.isFile() || !sameIdentity(stat, claimed.identity) || stat.size !== a.size) throw new Error(`attachment ${a.name} changed during copying`);
      }
      this.commit(next, [...priorRetired, ...sources, ...temporary]);
    } catch (err) {
      for (const file of copied) this.deleteOwned(file);
      this.cleanupRetired();
      throw err;
    } finally {
      for (const file of temporary) this.deleteOwned(file);
    }
    this.cleanupRetired();
    return files.map(file => ({ ...next.get(file.attachment.id)!.attachment }));
  }

  /** Only direct, regular files in owned directories may be served or handed to a backend. */
  resolve(rel: string): string | null {
    if (typeof rel !== "string" || !rel || rel.includes("\u0000") || rel.includes("\\") || path.isAbsolute(rel)) return null;
    const parts = rel.split("/");
    if (parts.length !== 2) return null;
    const [folder, name] = parts as [string, string];
    if (!/^[\w-]+$/.test(folder) || !name || name === "." || name === "..") return null;
    const dir = this.directory(folder);
    if (!dir) return null;
    const abs = path.resolve(dir, name);
    try {
      const stat = fs.lstatSync(abs);
      const owned = [...this.records.values()].find(file => file.attachment.rel === rel);
      return owned && stat.isFile() && sameIdentity(stat, owned.identity) && stat.size === owned.attachment.size ? abs : null;
    } catch {
      return null;
    }
  }

  /** Images only, read from a bounded no-follow descriptor and revalidated after reading. */
  readImage(rel: string): { data: Buffer; mime: string } | null {
    const abs = this.resolve(rel);
    const owned = [...this.records.values()].find(file => file.attachment.rel === rel);
    if (!abs || !owned || owned.attachment.kind !== "image" || kindFor(owned.attachment.mime) !== "image"
      || owned.attachment.size > LIMITS.imageBytes) return null;
    let fd: number | undefined;
    try {
      fd = fs.openSync(abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      const valid = () => {
        const stat = fs.fstatSync(fd!);
        return stat.isFile() && sameIdentity(stat, owned.identity) && stat.size === owned.attachment.size && this.resolve(rel) === abs;
      };
      if (!valid()) return null;
      const data = Buffer.alloc(owned.attachment.size);
      let offset = 0;
      while (offset < data.length) {
        const count = fs.readSync(fd, data, offset, data.length - offset, offset);
        if (!count) return null;
        offset += count;
      }
      if (!valid()) return null;
      const mime = owned.attachment.mime;
      // A caller's MIME hint alone must not turn a script/HTML/SVG into an image response.
      const signature = mime === "image/png" ? data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : mime === "image/jpeg" ? data[0] === 255 && data[1] === 216 && data[2] === 255
        : mime === "image/gif" ? ["GIF87a", "GIF89a"].includes(data.toString("ascii", 0, 6))
        : mime === "image/webp" && data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP";
      return signature ? { data, mime } : null;
    } catch { return null; }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  }

  removeThread(threadId: string): void {
    if (!this.isThreadId(threadId)) return;
    const dir = this.directory(threadId);
    if (!dir) return;
    this.assertManifest();
    this.retire([...this.records.values()].filter(file => file.attachment.rel.startsWith(`${threadId}/`)));
    // Metadata retirement precedes deletion; cleanup failures keep file identities for a later sweep.
    try {
      if (this.directory(threadId) !== dir) return;
      // Only identity-verified files above are ours to delete. Preserve replacements,
      // adjacent files, and directories by removing the thread directory only if empty.
      fs.rmdirSync(dir);
      this.directoryIdentities.delete(threadId);
    } catch { /* retained retirement records let the next sweep retry owned files */ }
  }

  /** Staged files older than `maxAgeMs` belong to composers that were never sent. */
  sweepStaging(maxAgeMs = 24 * 60 * 60 * 1000, now = Date.now()): number {
    const expired = [...this.records.values()].filter(({ attachment }) => {
      if (!attachment.rel.startsWith("staging/")) return false;
      const file = this.resolve(attachment.rel);
      try { return !!file && now - fs.lstatSync(file).mtimeMs > maxAgeMs; }
      catch { return false; }
    });
    this.retire(expired);
    this.cleanupRetired();
    return expired.length;
  }

  private retire(files: OwnedFile[]): void {
    if (!files.length) return;
    const next = new Map(this.records);
    for (const file of files) next.delete(file.attachment.id);
    this.commit(next, [...this.retired, ...files]);
    this.cleanupRetired();
  }

  /** The manifest is a main-owned sibling of staging and thread folders, outside backend addDirs. */
  private get manifest(): string { return path.join(this.root, ".manifest.json"); }

  private loadManifest(): void {
    let fd: number;
    try { fd = fs.openSync(this.manifest, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
    catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return; throw err; }
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) throw new Error("invalid attachment manifest");
      this.manifestIdentity = identity(stat);
      const data = JSON.parse(fs.readFileSync(fd, "utf8"));
      const validIdentity = (v: unknown): v is Identity => record(v) && typeof v.dev === "number" && typeof v.ino === "number";
      const validFile = (v: unknown): v is OwnedFile => record(v) && attachmentShape(v.attachment) && validIdentity(v.identity);
      if (!record(data) || data.version !== 1 || !validIdentity(data.root) || !sameIdentity(data.root, this.rootIdentity)
        || !Array.isArray(data.files) || !data.files.every(validFile) || !Array.isArray(data.retired) || !data.retired.every(validFile)
        || !Array.isArray(data.directories)) throw new Error("invalid attachment manifest");
      for (const entry of data.directories) {
        if (!Array.isArray(entry) || typeof entry[0] !== "string" || !/^[\w-]+$/.test(entry[0]) || !validIdentity(entry[1])) throw new Error("invalid attachment directory metadata");
        this.directoryIdentities.set(entry[0], entry[1]);
      }
      this.records = new Map(data.files.map(file => [file.attachment.id, file]));
      this.retired = data.retired;
    } finally { fs.closeSync(fd); }
  }

  private assertManifest(): void {
    try {
      const stat = fs.lstatSync(this.manifest);
      if (!stat.isFile() || !this.manifestIdentity || !sameIdentity(stat, this.manifestIdentity)) throw new Error("attachment metadata changed; reload before retrying");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      if (this.manifestIdentity) throw new Error("attachment metadata is missing");
    }
  }

  private commit(records: Map<string, OwnedFile>, retired = this.retired): void {
    if (!this.directory("staging")) throw new Error("attachment staging directory is unavailable or changed");
    this.assertManifest();
    const temp = path.join(this.root, `.manifest-${newId()}.tmp`);
    const fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    let tempIdentity: Identity | undefined;
    try {
      try {
        tempIdentity = identity(fs.fstatSync(fd));
        fs.writeFileSync(fd, JSON.stringify({ version: 1, root: identity(this.rootIdentity), directories: [...this.directoryIdentities], files: [...records.values()], retired }));
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      if (!this.directory("staging")) throw new Error("attachment directory changed during metadata commit");
      this.assertManifest();
      fs.renameSync(temp, this.manifest);
    } catch (err) {
      // Never follow a replaced root or delete another writer's temporary file.
      try {
        if (tempIdentity && this.directory("staging") && sameIdentity(fs.lstatSync(temp), tempIdentity)) fs.unlinkSync(temp);
      } catch { /* preserve the original commit failure */ }
      throw err;
    }
    this.manifestIdentity = tempIdentity;
    this.records = records;
    this.retired = retired;
  }

  private deleteOwned(file: OwnedFile): boolean {
    const [folder, name, extra] = file.attachment.rel.split("/");
    if (!folder || !name || extra !== undefined || name === "." || name === ".." || name.includes("\\") || !/^[\w-]+$/.test(folder)) return false;
    const dir = this.directory(folder);
    if (!dir) return false;
    const abs = path.join(dir, name);
    try {
      const stat = fs.lstatSync(abs);
      if (!stat.isFile() || !sameIdentity(stat, file.identity)) return false;
      fs.unlinkSync(abs);
      return true;
    } catch (err) { return (err as NodeJS.ErrnoException).code === "ENOENT"; }
  }

  private cleanupRetired(): void {
    if (!this.retired.length) return;
    try {
      if (!this.directory("staging")) return;
      this.assertManifest();
    } catch { return; } // A stale writer must not clean another owner's records, or reject a committed claim.
    this.retired = this.retired.filter(file => !this.deleteOwned(file));
  }

  private isThreadId(id: string): boolean {
    return typeof id === "string" && /^[\w-]+$/.test(id) && id !== "staging";
  }

  /** Node path operations cannot eliminate concurrent replacement races; recheck before each use. */
  private directory(name: string, create = false): string | null {
    try {
      const root = fs.lstatSync(this.root);
      if (!root.isDirectory() || root.dev !== this.rootIdentity.dev || root.ino !== this.rootIdentity.ino
        || fs.realpathSync(this.root) !== this.canonicalRoot) return null;
      const dir = path.join(this.root, name);
      let remembered = this.directoryIdentities.get(name);
      if (create && remembered && ![...this.records.values()].some(file => file.attachment.rel.startsWith(`${name}/`))) {
        // A retired empty thread can be recreated after restart. Existing replacements still fail identity checks.
        try { fs.lstatSync(dir); }
        catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
          this.directoryIdentities.delete(name);
          remembered = undefined;
        }
      }
      if (create && !remembered) {
        try { fs.mkdirSync(dir, { mode: 0o700 }); }
        catch (err) { if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err; }
      }
      const stat = fs.lstatSync(dir);
      if (!stat.isDirectory() || fs.realpathSync(dir) !== path.join(this.canonicalRoot, name)) return null;
      if (remembered && !sameIdentity(stat, remembered)) return null;
      if (!remembered) this.directoryIdentities.set(name, identity(stat));
      return dir;
    } catch {
      return null;
    }
  }
}
