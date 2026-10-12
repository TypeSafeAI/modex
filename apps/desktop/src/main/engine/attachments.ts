import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { newId } from "./store.js";
import { LIMITS, kindFor, mimeFor, rejectReason, safeName, type Attachment, type AttachmentDraftOwner } from "../../shared/attachments.js";

type Identity = Pick<fs.Stats, "dev" | "ino">;
type OwnedFile = { attachment: Attachment; identity: Identity; owner?: AttachmentDraftOwner };
declare const draftBrand: unique symbol;
declare const transferBrand: unique symbol;
/** Opaque, instance-local main-process handles. Never serialize these over IPC. */
export type AttachmentDraft = { readonly [draftBrand]: true };
export type AttachmentTransfer = { readonly [transferBrand]: true };
type DraftState = { owner: AttachmentDraftOwner; revoked: boolean };
type DraftOptions = { draft?: AttachmentDraft };
type ClaimOptions = DraftOptions & { transfer?: AttachmentTransfer };
type Authorities = {
  authorizeDraft?: (owner: AttachmentDraftOwner) => boolean;
  authorizeTransfer?: (owner: AttachmentDraftOwner, threadId: string) => boolean;
};
const identity = ({ dev, ino }: Identity): Identity => ({ dev, ino });
const sameIdentity = (a: Identity, b: Identity): boolean => a.dev === b.dev && a.ino === b.ino;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const copyOwner = (value: unknown): AttachmentDraftOwner => {
  if (!record(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw new Error("Invalid attachment draft owner.");
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => !Object.getOwnPropertyDescriptor(value, key)?.enumerable
    || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, "value"))) throw new Error("Invalid attachment draft owner.");
  const id = (v: unknown): v is string => typeof v === "string" && v.length <= 128 && /^[\w-]+$/.test(v) && v !== "staging";
  if (keys.length === 2 && keys.includes("kind") && keys.includes("threadId") && value.kind === "thread" && id(value.threadId)) return Object.freeze({ kind: "thread", threadId: value.threadId });
  if (keys.length === 3 && keys.includes("kind") && keys.includes("key") && keys.includes("projectId")
    && value.kind === "project" && id(value.projectId) && typeof value.key === "string") {
    const revision = value.key.match(/^draft:(0|[1-9]\d*):/);
    if (revision && Number.isSafeInteger(Number(revision[1])) && value.key === `draft:${revision[1]}:${value.projectId}`) {
      return Object.freeze({ kind: "project", key: value.key, projectId: value.projectId });
    }
  }
  throw new Error("Invalid attachment draft owner.");
};
const sameOwner = (a: AttachmentDraftOwner, b: AttachmentDraftOwner): boolean => a.kind === "thread"
  ? b.kind === "thread" && a.threadId === b.threadId
  : b.kind === "project" && a.key === b.key && a.projectId === b.projectId;
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
  private uncertain = false;
  // Null preserves all evidence when recovery cannot be read or resolved safely.
  private recoveryRetention: Set<string> | null = new Set();
  private readonly drafts = new WeakMap<AttachmentDraft, DraftState>();
  private readonly transfers = new WeakMap<AttachmentTransfer, { draft: DraftState; threadId: string }>();
  private authorizing = false;
  private authorizationReentered = false;
  // Retire only after the new manifest is durable. Failed cleanup remains retryable after restart.
  private retired: OwnedFile[] = [];

  constructor(readonly root: string, private readonly authorities: Authorities = {}) {
    this.authorities = Object.freeze({ ...authorities });
    this.root = path.resolve(root);
    this.staging = path.join(this.root, "staging");
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    this.rootIdentity = fs.lstatSync(this.root);
    if (!this.rootIdentity.isDirectory()) throw new Error("attachment root is not a directory");
    this.canonicalRoot = fs.realpathSync(this.root);
    const staging = this.directory("staging", true);
    if (!staging) throw new Error("attachment staging directory is unavailable or changed");
    this.loadManifest();
    this.syncDirectory(this.root, this.rootIdentity);
    const parent = path.dirname(this.canonicalRoot);
    this.syncDirectory(parent, fs.lstatSync(parent));
  }

  mintDraft(owner: AttachmentDraftOwner): AttachmentDraft {
    this.assertReady();
    const copied = copyOwner(owner);
    this.authorize(copied);
    const handle = Object.freeze({}) as AttachmentDraft;
    this.drafts.set(handle, { owner: copied, revoked: false });
    return handle;
  }

  revokeDraft(handle: AttachmentDraft): void {
    this.assertReady();
    const state = this.drafts.get(handle);
    if (state) state.revoked = true;
  }

  mintTransfer(handle: AttachmentDraft, threadId: string): AttachmentTransfer {
    const draft = this.requireDraft(handle);
    if (!this.isThreadId(threadId)) throw new Error("Invalid attachment transfer target.");
    this.authorize(draft.owner, threadId);
    const transfer = Object.freeze({}) as AttachmentTransfer;
    this.transfers.set(transfer, { draft, threadId });
    return transfer;
  }

  private requireDraft(handle: AttachmentDraft): DraftState {
    this.assertReady();
    const draft = this.drafts.get(handle);
    if (!draft || draft.revoked) throw new Error("Attachment draft capability is invalid or revoked.");
    this.authorize(draft.owner);
    return draft;
  }

  private authorize(owner: AttachmentDraftOwner, threadId?: string): void {
    this.assertManifest();
    this.authorizing = true;
    this.authorizationReentered = false;
    let allowed = false;
    try {
      allowed = this.authorities.authorizeDraft?.(owner) === true;
      if (allowed && threadId !== undefined) allowed = this.authorities.authorizeDraft?.(Object.freeze({ kind: "thread", threadId })) === true
        && this.authorities.authorizeTransfer?.(owner, threadId) === true;
    } finally { this.authorizing = false; }
    this.assertManifest();
    if (!allowed || this.authorizationReentered || !this.directory("staging")) throw new Error("Attachment draft or transfer is no longer authorized.");
  }

  /** Read-only validation: snapshot metadata cannot adopt or rebind a staged file. */
  validateRecovery(attachment: Readonly<Attachment>, owner: AttachmentDraftOwner): boolean {
    try {
      const context = copyOwner(owner);
      this.authorize(context);
      const file = this.records.get(attachment.id);
      if (!file || Object.keys(file.attachment).some(key => file.attachment[key as keyof Attachment] !== attachment[key as keyof Attachment])) return false;
      if (attachment.rel.startsWith("staging/")) {
        if (!file.owner || !sameOwner(file.owner, context)) return false;
      } else if (context.kind !== "thread" || !attachment.rel.startsWith(`${context.threadId}/`)
        || (file.owner && !sameOwner(file.owner, context))) return false;
      return !!this.resolve(attachment.rel);
    } catch { return false; }
  }

  /** Main-only content proof for durable claim replay. Never trust metadata/path
   * alone or return a raw file descriptor to renderer/IPC code. */
  fingerprint(attachment: Readonly<Attachment>, owner: AttachmentDraftOwner): Readonly<{ dev: number; ino: number; size: number; sha256: string }> {
    if (!Number.isSafeInteger(attachment.size) || attachment.size < 0
      || attachment.size > (attachment.kind === "image" ? LIMITS.imageBytes : LIMITS.fileBytes)
      || !this.validateRecovery(attachment, owner)) throw new Error("Attachment ownership or identity changed.");
    const owned = this.records.get(attachment.id)!;
    const file = this.resolve(attachment.rel);
    if (!file) throw new Error("Attachment is missing or changed.");
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const before = fs.fstatSync(fd);
      if (!before.isFile() || !sameIdentity(before, owned.identity) || before.size !== attachment.size) throw new Error("Attachment identity changed before reading.");
      const hash = createHash("sha256");
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let size = 0;
      while (true) {
        const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, attachment.size + 1 - size), null);
        if (!count) break;
        size += count;
        if (size > attachment.size) throw new Error("Attachment grew while reading.");
        hash.update(buffer.subarray(0, count));
      }
      const after = fs.fstatSync(fd);
      if (size !== attachment.size || !sameIdentity(before, after) || before.size !== after.size
        || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
        || !this.validateRecovery(attachment, owner)) throw new Error("Attachment changed while reading.");
      return Object.freeze({ dev: after.dev, ino: after.ino, size, sha256: hash.digest("hex") });
    } finally { fs.closeSync(fd); }
  }

  /** IPC is untrusted: reject excessive requests before any per-file decoding or filesystem work. */
  stage(files: unknown, { bytesOnly = false, draft }: { bytesOnly?: boolean } & DraftOptions = {}): { staged: Attachment[]; errors: string[] } {
    const error = requestError(files);
    if (error) return { staged: [], errors: [error] };
    const staged: Attachment[] = [];
    const errors: string[] = [];
    for (const f of files as unknown[]) {
      let created: OwnedFile | undefined;
      try {
        this.assertReady();
        const owner = draft === undefined ? undefined : this.requireDraft(draft).owner;
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
          created = { attachment, identity: identity(fs.fstatSync(fd)), ...(owner ? { owner } : {}) };
          fs.writeFileSync(fd, contents);
          fs.fsyncSync(fd);
        } finally { fs.closeSync(fd); }
        this.syncDirectory(dir, this.directoryIdentities.get("staging")!);
        const next = new Map(this.records).set(id, created);
        if (draft !== undefined) this.requireDraft(draft);
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
  stagePaths(paths: unknown, remaining: unknown = LIMITS.perTurn, options: DraftOptions = {}): { staged: Attachment[]; errors: string[] } {
    if (typeof remaining !== "number" || !Number.isInteger(remaining) || remaining < 0 || remaining > LIMITS.perTurn) {
      return { staged: [], errors: ["Remaining attachment slots must be an integer from 0 to 20."] };
    }
    const error = requestError(paths, remaining);
    if (error) return { staged: [], errors: [error] };
    return this.stage((paths as unknown[]).map(p => typeof p === "string" ? { name: path.basename(p), path: p } : { name: "file", path: p }), options);
  }

  /** Drops staged files the user removed from the composer, never a sent file or an unowned path. */
  discard(ids: string[], { draft }: DraftOptions = {}): void {
    this.assertReady();
    if (!Array.isArray(ids)) return;
    const selected = new Set(ids.filter(id => typeof id === "string"));
    const files = [...this.records.values()].filter(file => selected.has(file.attachment.id) && file.attachment.rel.startsWith("staging/"));
    const context = draft === undefined ? undefined : this.requireDraft(draft).owner;
    if (files.some(file => file.owner && (!context || !sameOwner(file.owner, context)))) throw new Error("Attachment draft owner is not authorized.");
    this.retire(files.filter(file => this.resolve(file.attachment.rel)));
  }

  /** Validate the entire request, then copy exclusively and commit ownership before retiring sources. */
  claim(threadId: string, attachments: unknown, options: ClaimOptions = {}): Attachment[] {
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
    const authorizeClaim = () => {
      const draft = options.draft === undefined ? undefined : this.requireDraft(options.draft);
      for (const file of files) {
        if (!file.owner) continue;
        if (!draft || !sameOwner(file.owner, draft.owner)) throw new Error("Attachment draft owner is not authorized.");
        if (draft.owner.kind === "thread" && draft.owner.threadId === threadId) continue;
        const transfer = options.transfer === undefined ? undefined : this.transfers.get(options.transfer);
        if (!transfer || transfer.draft !== draft || transfer.threadId !== threadId) throw new Error("Attachment transfer capability is required.");
        this.authorize(draft.owner, threadId);
      }
    };
    authorizeClaim();
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
          tempOwned = { attachment: tempAttachment, identity: identity(fs.fstatSync(fd)), ...(owned.owner ? { owner: owned.owner } : {}) };
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
            try { temporary.push({ attachment: tempAttachment, identity: identity(fs.fstatSync(fd)), ...(owned.owner ? { owner: owned.owner } : {}) }); }
            catch { /* no bytes were written and no final path was published */ }
          }
          throw err;
        } finally { fs.closeSync(fd); }
        const claimed: OwnedFile = { attachment: { ...a, rel: `${threadId}/${path.basename(a.rel)}` }, identity: tempOwned.identity,
          ...(owned.owner ? { owner: Object.freeze({ kind: "thread" as const, threadId }) } : {}) };
        prepared.push({ source: owned, claimed, temp, dest });
        sources.push(owned);
        next.set(a.id, claimed);
      }
      this.syncDirectory(dir, this.directoryIdentities.get(threadId)!);
      authorizeClaim();
      // Write-ahead ownership keeps rollback recoverable even if cleanup AND the final metadata
      // commit fail. Until the final commit, every authoritative attachment still names staging.
      this.commit(this.records, [...priorRetired, ...temporary, ...prepared.map(file => ({ ...file.claimed,
        ...(file.source.owner ? { owner: file.source.owner } : {}) }))]);
      for (const { source, claimed, temp, dest } of prepared) {
        const a = source.attachment;
        if (!this.resolve(a.rel) || this.directory(threadId) !== dir) throw new Error(`attachment ${a.name} changed during copying`);
        // link is exclusive; the checkpoint already owns this inode before any final path exists.
        fs.linkSync(temp, dest);
        copied.push(claimed);
        const stat = fs.lstatSync(dest);
        if (!stat.isFile() || !sameIdentity(stat, claimed.identity) || stat.size !== a.size) throw new Error(`attachment ${a.name} changed during copying`);
      }
      this.syncDirectory(dir, this.directoryIdentities.get(threadId)!);
      authorizeClaim();
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
    this.assertReady();
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

  /** Main installs recovery protection before any startup or incidental cleanup.
   * Paths supplied by a snapshot never establish ownership or update admission. */
  setRecoveryRetention(references: readonly Attachment[] | null): boolean {
    try {
      this.assertReady();
      this.recoveryRetention = null;
      if (!Array.isArray(references)) return false;
      this.assertManifest();
      const retained = new Set<string>();
      const owned = [...this.records.values(), ...this.retired];
      for (const reference of references) {
        if (!attachmentShape(reference)) return false;
        const matches = owned.filter(file => Object.keys(file.attachment)
          .every(key => file.attachment[key as keyof Attachment] === reference[key as keyof Attachment]));
        const identities = new Set(matches.map(file => this.retentionKey(file)));
        if (identities.size !== 1) return false;
        const file = matches[0]!;
        const [folder, name, extra] = file.attachment.rel.split("/");
        if (!folder || !name || extra !== undefined || name === "." || name === ".."
          || name.includes("\\") || name.includes("\0") || !/^[\w-]+$/.test(folder)) return false;
        const directory = this.directory(folder);
        if (!directory) return false;
        const stat = fs.lstatSync(path.join(directory, name));
        if (!stat.isFile() || !sameIdentity(stat, file.identity) || stat.size !== file.attachment.size) return false;
        retained.add(this.retentionKey(file));
      }
      this.assertManifest();
      this.recoveryRetention = retained;
      return true;
    } catch { return false; }
  }

  private retentionKey(file: OwnedFile): string {
    return JSON.stringify([file.attachment.rel, file.identity.dev, file.identity.ino]);
  }

  private retainedForRecovery(file: OwnedFile): boolean {
    return this.recoveryRetention === null || this.recoveryRetention.has(this.retentionKey(file));
  }

  /** Only unreferenced staged files older than `maxAgeMs` can expire. */
  sweepStaging(maxAgeMs = 24 * 60 * 60 * 1000, now = Date.now()): number {
    this.assertReady();
    const expired = [...this.records.values()].filter(owned => {
      if (this.retainedForRecovery(owned)) return false;
      const { attachment } = owned;
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
      const exactKeys = (v: object, keys: string[]) => Object.keys(v).length === keys.length && keys.every(key => Object.hasOwn(v, key));
      const validIdentity = (v: unknown): v is Identity => record(v) && exactKeys(v, ["dev", "ino"])
        && typeof v.dev === "number" && Number.isSafeInteger(v.dev) && typeof v.ino === "number" && Number.isSafeInteger(v.ino);
      const validFile = (v: unknown): v is OwnedFile => {
        if (!record(v) || !attachmentShape(v.attachment) || !exactKeys(v.attachment, ["id", "name", "mime", "size", "kind", "rel"])
          || !validIdentity(v.identity) || !exactKeys(v, Object.hasOwn(v, "owner") ? ["attachment", "identity", "owner"] : ["attachment", "identity"])) return false;
        if (Object.hasOwn(v, "owner")) {
          if (data.version !== 2) return false;
          v.owner = copyOwner(v.owner);
        }
        return true;
      };
      if (!record(data) || !exactKeys(data, ["version", "root", "directories", "files", "retired"])
        || (data.version !== 1 && data.version !== 2) || !validIdentity(data.root) || !sameIdentity(data.root, this.rootIdentity)
        || !Array.isArray(data.files) || !data.files.every(validFile) || !Array.isArray(data.retired) || !data.retired.every(validFile)
        || !Array.isArray(data.directories)) throw new Error("invalid attachment manifest");
      if (new Set(data.files.map(file => file.attachment.id)).size !== data.files.length
        || new Set(data.files.map(file => file.attachment.rel)).size !== data.files.length) throw new Error("ambiguous attachment manifest ownership");
      const directories = new Set<string>();
      for (const entry of data.directories) {
        if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || !/^[\w-]+$/.test(entry[0])
          || directories.has(entry[0]) || !validIdentity(entry[1])) throw new Error("invalid attachment directory metadata");
        directories.add(entry[0]);
        this.directoryIdentities.set(entry[0], entry[1]);
      }
      this.records = new Map(data.files.map(file => [file.attachment.id, file]));
      this.retired = data.retired;
    } finally { fs.closeSync(fd); }
  }

  private assertManifest(): void {
    this.assertReady();
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
    let published = false;
    const adopt = () => {
      this.manifestIdentity = tempIdentity;
      this.records = records;
      this.retired = retired;
    };
    try {
      try {
        tempIdentity = identity(fs.fstatSync(fd));
        fs.writeFileSync(fd, JSON.stringify({ version: 2, root: identity(this.rootIdentity), directories: [...this.directoryIdentities], files: [...records.values()], retired }));
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      if (!this.directory("staging")) throw new Error("attachment directory changed during metadata commit");
      this.assertManifest();
      fs.renameSync(temp, this.manifest);
      published = true;
      adopt();
      this.syncDirectory(this.root, this.rootIdentity);
    } catch (err) {
      // A failed parent sync does not undo rename. Preserve the published files,
      // write-ahead sources and temporary copies; never run ordinary rollback on
      // a manifest that may already name the new files. Refuse further mutations
      // until a fresh instance can read the surviving authoritative manifest.
      if (!published && tempIdentity && this.directory("staging")) {
        try { published = sameIdentity(fs.lstatSync(this.manifest), tempIdentity); }
        catch { /* no observed publication; retain the original failure */ }
      }
      if (published) { adopt(); this.uncertain = true; throw err; }
      // Never follow a replaced root or delete another writer's temporary file.
      try {
        if (tempIdentity && this.directory("staging") && sameIdentity(fs.lstatSync(temp), tempIdentity)) fs.unlinkSync(temp);
      } catch { /* preserve the original commit failure */ }
      throw err;
    }
  }

  private deleteOwned(file: OwnedFile): boolean {
    if (this.uncertain || this.retainedForRecovery(file)) return false;
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

  private assertReady(): void {
    if (this.authorizing) {
      this.authorizationReentered = true;
      throw new Error("Attachment authorization cannot reenter a mutation.");
    }
    if (this.uncertain) throw new Error("Attachment storage durability is uncertain. Reload before retrying; existing files were preserved.");
  }

  /** Windows keeps ordinary attachment support; native update durability is
   * admitted only on the POSIX path with directory synchronization available. */
  private syncDirectory(directory: string, expected: Identity): void {
    if (process.platform === "win32") return;
    const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isDirectory() || !sameIdentity(stat, expected)) throw new Error("attachment directory changed before synchronization");
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
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
