import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { LIMITS, kindFor } from "../../shared/attachments.js";
import type { Attachment, AttachmentDraftOwner } from "../../shared/attachments.js";
import type { ComposerRecovery, DraftSaveReceipt, UpdateRecoveryRecord } from "../../shared/update-recovery.js";
import { AttachmentRecoveryFile, RecoveryFileWriteError, type RecoveryFileSnapshot } from "./attachment-recovery-file.js";
import { isBackendId } from "../../shared/types.js";

const MAX_BYTES = 2 * 1024 * 1024;
// Legacy reads add empty attachment arrays (at most 500 threads), one empty
// selected thread, and project-key metadata. Bound this in-memory expansion
// separately; all on-disk reads and new writes retain the original 2 MiB cap.
const MIGRATED_BYTES = MAX_BYTES + 64 * 1024;
const failure = () => new Error("Update recovery could not be saved or read. Existing recovery data has been preserved.");
const version = (value: unknown): value is string => typeof value === "string" && value.length <= 50 && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value);
function newer(a: string, b: string): boolean {
  const left = a.split(".").map(BigInt), right = b.split(".").map(BigInt);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i]! > right[i]!;
  return false;
}
function object(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw failure();
}
function string(value: unknown, max: number, empty = true): asserts value is string {
  if (typeof value !== "string" || value.length > max || (!empty && !value)) throw failure();
}
function id(value: unknown): asserts value is string {
  string(value, 128, false);
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw failure();
}
function validateLegacyDrafts(value: unknown): asserts value is LegacyDrafts {
  object(value, ["threads", "selectedThreadId", "draft"]);
  if (!Array.isArray(value.threads) || value.threads.length > 500) throw failure();
  const seen = new Set<string>();
  for (const thread of value.threads) {
    object(thread, ["threadId", "text"]);
    id(thread.threadId); string(thread.text, 1024 * 1024);
    if (seen.has(thread.threadId)) throw failure();
    seen.add(thread.threadId);
  }
  if (value.selectedThreadId !== null) id(value.selectedThreadId);
  if (value.draft !== null) {
    const draft = value.draft;
    object(draft, ["projectId", "worktree", "text", "settings"]);
    id(draft.projectId); string(draft.text, 1024 * 1024);
    if (typeof draft.worktree !== "boolean") throw failure();
    const settings = draft.settings;
    object(settings, ["backend", "mode", "plan", "auto", "model", "effort"]);
    if (!isBackendId(settings.backend)
      || !["chat", "agent", "full-access"].includes(settings.mode as string)
      || typeof settings.plan !== "boolean" || typeof settings.auto !== "boolean") throw failure();
    string(settings.model, 256);
    if (settings.effort !== undefined) string(settings.effort, 256);
  }
}
type LegacyDrafts = {
  threads: { threadId: string; text: string }[];
  selectedThreadId: string | null;
  draft: (Omit<NonNullable<ComposerRecovery["draft"]>, "revision"> & { text: string }) | null;
};

// Bound traversal and escaped UTF-8 output before allocating a serialized copy.
// IPC supplies plain data. Reject accessors/toJSON and malformed strings as well.
function boundedJSON(value: unknown, limit = MAX_BYTES): string {
  let bytes = 0, nodes = 0;
  const ancestors = new Set<object>();
  const add = (count: number) => { bytes += count; if (bytes > limit) throw failure(); };
  const text = (s: string) => {
    if (s.length > MAX_BYTES) throw failure();
    add(2);
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) {
        const low = s.charCodeAt(++i);
        if (!(low >= 0xdc00 && low <= 0xdfff)) throw failure();
        add(4);
      } else if (c >= 0xdc00 && c <= 0xdfff) throw failure();
      else if (c === 34 || c === 92 || [8, 9, 10, 12, 13].includes(c)) add(2);
      else add(c < 32 ? 6 : c < 128 ? 1 : c < 2048 ? 2 : 3);
    }
  };
  const visit = (v: unknown, depth: number): void => {
    if (++nodes > 20000 || depth > 12) throw failure();
    if (v === null) { add(4); return; }
    if (typeof v === "string") { text(v); return; }
    if (typeof v === "boolean") { add(v ? 4 : 5); return; }
    if (typeof v === "number" && Number.isFinite(v)) { add(String(v).length); return; }
    if (!v || typeof v !== "object" || ancestors.has(v)) throw failure();
    ancestors.add(v);
    const array = Array.isArray(v);
    const keys = Object.keys(v);
    if (Object.getOwnPropertyNames(v).length !== keys.length + (array ? 1 : 0)) throw failure();
    if (array ? v.length > 1000 || keys.length !== v.length :
      keys.length > 16 || (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null)) throw failure();
    if (Object.getOwnPropertySymbols(v).length) throw failure();
    add(2 + Math.max(0, keys.length - 1));
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]!;
      if (array && key !== String(i)) throw failure();
      const descriptor = Object.getOwnPropertyDescriptor(v, key)!;
      if (!("value" in descriptor)) throw failure();
      if (!array) { text(key); add(1); }
      visit(descriptor.value, depth + 1);
    }
    ancestors.delete(v);
  };
  visit(value, 0);
  const body = JSON.stringify(value);
  if (Buffer.byteLength(body) > limit) throw failure();
  return body;
}

/** JSON.parse silently keeps the last duplicate member. Check decoded names first
 * so an ambiguous file cannot lose earlier drafts through an ordinary later save.
 * JSON.parse still owns syntax validation; this scan only tracks container/key state. */
function parseRecord(body: string): unknown {
  const stack: ({ keys: Set<string>; expectingKey: boolean } | null)[] = [];
  for (let i = 0; i < body.length; i++) {
    const char = body[i];
    if (char === '"') {
      const start = i;
      for (i++; i < body.length; i++) {
        if (body[i] === "\\") i++;
        else if (body[i] === '"') break;
      }
      if (i >= body.length) throw failure();
      const object = stack.at(-1);
      if (object?.expectingKey) {
        const key: string = JSON.parse(body.slice(start, i + 1));
        if (object.keys.has(key) || object.keys.size >= 16) throw failure();
        object.keys.add(key); object.expectingKey = false;
      }
    } else if (char === "{" || char === "[") {
      if (stack.length >= 12) throw failure();
      stack.push(char === "{" ? { keys: new Set(), expectingKey: true } : null);
    } else if (char === "}" || char === "]") stack.pop();
    else if (char === ",") {
      const object = stack.at(-1);
      if (object) object.expectingKey = true;
    }
  }
  return JSON.parse(body);
}

function validateDrafts(value: unknown): asserts value is ComposerRecovery {
  object(value, ["threads", "selectedThreadId", "projects", "draft"]);
  if (!Array.isArray(value.threads) || !Array.isArray(value.projects)
    || value.threads.length + value.projects.length > 1000) throw failure();
  const threads = new Set<string>(), projects = new Set<string>(), attachments = new Set<string>();
  const files = (input: unknown, threadId?: string) => {
    if (!Array.isArray(input) || input.length > LIMITS.perTurn) throw failure();
    for (const file of input) {
      object(file, ["id", "name", "mime", "size", "kind", "rel"]);
      id(file.id); string(file.name, 120, false); string(file.mime, 256, false); string(file.rel, 512, false);
      if (/[\\/\u0000-\u001f\u007f]/.test(file.name) || file.name === "." || file.name === ".."
        || !["image", "file"].includes(file.kind as string) || file.kind !== kindFor(file.mime)
        || !Number.isSafeInteger(file.size) || (file.size as number) < 0
        || (file.size as number) > (file.kind === "image" ? LIMITS.imageBytes : LIMITS.fileBytes)
        || attachments.has(file.id) || attachments.size >= 2000) throw failure();
      const suffix = `${file.id}-${file.name}`;
      if (file.rel !== `staging/${suffix}` && (!threadId || file.rel !== `${threadId}/${suffix}`)) throw failure();
      attachments.add(file.id);
    }
  };
  for (const thread of value.threads) {
    object(thread, ["threadId", "text", "attachments"]);
    id(thread.threadId); string(thread.text, 1024 * 1024); files(thread.attachments, thread.threadId);
    if (threads.has(thread.threadId)) throw failure();
    threads.add(thread.threadId);
  }
  if (value.selectedThreadId !== null) {
    id(value.selectedThreadId);
    if (!threads.has(value.selectedThreadId)) throw failure();
  }
  if (value.draft !== null) {
    object(value.draft, ["revision", "projectId", "worktree", "settings"]);
    if (!Number.isSafeInteger(value.draft.revision) || (value.draft.revision as number) < 0) throw failure();
    validateLegacyDrafts({ threads: [], selectedThreadId: null, draft: {
      projectId: value.draft.projectId, text: "", worktree: value.draft.worktree, settings: value.draft.settings,
    } });
  }
  for (const project of value.projects) {
    object(project, ["key", "projectId", "text", "attachments"]);
    id(project.projectId); string(project.text, 1024 * 1024); files(project.attachments);
    if (!value.draft || project.key !== `draft:${value.draft.revision}:${project.projectId}` || projects.has(project.projectId)) throw failure();
    projects.add(project.projectId);
  }
  if (value.draft && !projects.has(value.draft.projectId as string)) throw failure();
}

/** Main-only validated copy for a pending recovery transaction. Uses the exact
 * save path limits/schema and preserves every raw value without writing a file. */
export function copyComposerRecovery(input: unknown): ComposerRecovery {
  const snapshot: unknown = JSON.parse(boundedJSON(input));
  validateDrafts(snapshot);
  return snapshot;
}

function validate(value: unknown): asserts value is UpdateRecoveryRecord {
  object(value, ["schema", "revision", "drafts", "attempt"]);
  if (value.schema !== 2 || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0) throw failure();
  if (value.drafts !== null) validateDrafts(value.drafts);
  if (value.attempt !== null) {
    const attempt = value.attempt;
    object(attempt, ["id", "from", "to", "sha512", "startedAt", "outcome"]);
    id(attempt.id);
    if (!version(attempt.from) || !version(attempt.to) || !newer(attempt.to, attempt.from)
      || typeof attempt.sha512 !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(attempt.sha512)
      || typeof attempt.startedAt !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(attempt.startedAt) || !Number.isFinite(Date.parse(attempt.startedAt))
      || !["uncertain", "staged", "installed"].includes(attempt.outcome as string)
      || value.drafts === null || value.revision === 0) throw failure();
  }
}

/** Strict schema-2 copy for a bounded journal's complete expected after-record. */
export function copyUpdateRecoveryRecord(input: unknown): UpdateRecoveryRecord {
  const value: unknown = JSON.parse(boundedJSON(input));
  validate(value); return value;
}

function normalize(value: unknown): UpdateRecoveryRecord {
  object(value, ["schema", "revision", "drafts", "attempt"]);
  const legacy = value.schema === 1;
  if (legacy) {
    if (value.drafts !== null) {
      validateLegacyDrafts(value.drafts);
      const old = value.drafts;
      const threads = old.threads.map(thread => ({ ...thread, attachments: [] }));
      if (old.selectedThreadId && !threads.some(thread => thread.threadId === old.selectedThreadId))
        threads.push({ threadId: old.selectedThreadId, text: "", attachments: [] });
      value.drafts = {
        threads, selectedThreadId: old.selectedThreadId,
        projects: old.draft ? [{ key: `draft:0:${old.draft.projectId}`, projectId: old.draft.projectId, text: old.draft.text, attachments: [] }] : [],
        draft: old.draft ? { revision: 0, projectId: old.draft.projectId, worktree: old.draft.worktree, settings: old.draft.settings } : null,
      };
    }
    value.schema = 2;
  }
  validate(value);
  boundedJSON(value, legacy ? MIGRATED_BYTES : MAX_BYTES);
  return value;
}

type Immutable<T> = T extends object ? { readonly [K in keyof T]: Immutable<T[K]> } : T;
export type RecoveryAttachmentContext = AttachmentDraftOwner;
/** Main-only synchronous capability. Confirm manifest metadata, file identity and
 * context ownership. Staged files need a separate draft-owner binding in the adapter;
 * a valid path or a successful read alone is not proof of ownership. */
export type ValidateRecoveryAttachment = (attachment: Readonly<Attachment>, context: RecoveryAttachmentContext,
  snapshot: Immutable<ComposerRecovery>) => boolean;
function freeze<T>(value: T): Immutable<T> {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value as Immutable<T>;
}

/** One main-process writer. Synchronous atomic replacement serializes IPC saves with
 * native receipts. Nothing is acknowledged until file and directory fsync succeed.
 * Unknown/corrupt data blocks updates instead of silently discarding recovery evidence.
 */
export class UpdateRecovery {
  private readonly file: string;
  private mutating = false;
  private reentered = false;
  private uncertain = false;
  private durableFile?: AttachmentRecoveryFile<UpdateRecoveryRecord>;
  constructor(private readonly home: string, private readonly validateAttachment?: ValidateRecoveryAttachment) { this.file = path.join(home, "update-recovery.json"); }

  read(): UpdateRecoveryRecord {
    let fd: number;
    try { fd = fs.openSync(this.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schema: 2, drafts: null, revision: 0, attempt: null };
      throw failure();
    }
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_BYTES) throw failure();
      const bytes = Buffer.alloc(MAX_BYTES + 1);
      let length = 0;
      while (length < bytes.length) {
        const count = fs.readSync(fd, bytes, length, bytes.length - length, null);
        if (!count) break;
        length += count;
      }
      if (length > MAX_BYTES) throw failure();
      const data = parseRecord(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)));
      boundedJSON(data);
      return normalize(data);
    } catch { throw failure(); }
    finally { fs.closeSync(fd); }
  }

  private mutation<T>(operation: () => T): T {
    if (this.mutating) { this.reentered = true; throw failure(); }
    if (this.uncertain) throw failure();
    this.mutating = true; this.reentered = false;
    try { return operation(); } finally { this.mutating = false; }
  }

  /** Only the sequenced transfer journal or startup replay uses this stronger
   * writer. Normal autosaves retain their existing API and platform behavior. */
  capture(): RecoveryFileSnapshot<UpdateRecoveryRecord> {
    this.durableFile ??= new AttachmentRecoveryFile(this.home, "update-recovery.json", MAX_BYTES, value => { normalize(value); });
    return this.durableFile.read();
  }
  private durable<T>(expected: RecoveryFileSnapshot<UpdateRecoveryRecord>, run: (file: AttachmentRecoveryFile<UpdateRecoveryRecord>) => T): T {
    const current = this.capture();
    if (current.sha256 !== expected.sha256 || boundedJSON(current.value, MIGRATED_BYTES) !== boundedJSON(expected.value, MIGRATED_BYTES)
      || this.reentered) throw failure();
    // The caller's original opaque proof, never this fresh read, reaches write
    // or checkpoint below. Equal bytes with a replaced inode are still refused.
    try { return run(this.durableFile!); }
    catch (error) {
      if (error instanceof RecoveryFileWriteError && !error.unchanged) this.uncertain = true;
      throw error;
    }
  }

  commitDrafts(expected: RecoveryFileSnapshot<UpdateRecoveryRecord>, input: unknown): number {
    return this.mutation(() => this.durable(expected, file => {
      const data = this.read(), snapshot = copyComposerRecovery(input);
      if (data.attempt && data.attempt.outcome !== "installed") throw failure();
      const next = { ...data, drafts: snapshot, revision: data.revision + 1 };
      validate(next); boundedJSON(next); this.checkAttachments(snapshot, data);
      file.write(expected, next);
      return next.revision;
    }));
  }

  checkpoint(expected: RecoveryFileSnapshot<UpdateRecoveryRecord>): void {
    this.mutation(() => this.durable(expected, file => {
      if (!expected.value) throw failure();
      file.checkpoint(expected);
    }));
  }

  private checkAttachments(drafts: ComposerRecovery, before: UpdateRecoveryRecord): void {
    const snapshot = freeze(JSON.parse(boundedJSON(drafts)) as ComposerRecovery);
    const check = (files: readonly Readonly<Attachment>[], context: RecoveryAttachmentContext) => {
      for (const file of files) {
        if (!this.validateAttachment || this.validateAttachment(file, Object.freeze(context), snapshot) !== true) throw failure();
      }
    };
    for (const thread of snapshot.threads) check(thread.attachments, { kind: "thread", threadId: thread.threadId });
    for (const project of snapshot.projects) check(project.attachments, { kind: "project", key: project.key, projectId: project.projectId });
    if (this.reentered || boundedJSON(this.read(), MIGRATED_BYTES) !== boundedJSON(before, MIGRATED_BYTES)) throw failure();
  }

  saveDrafts(input: unknown): number {
    return this.mutation(() => {
      const snapshot = copyComposerRecovery(input);
      const data = this.read();
      if (data.attempt && data.attempt.outcome !== "installed") throw new Error("Update recovery is required before editing drafts.");
      const next = { ...data, drafts: snapshot, revision: data.revision + 1 };
      validate(next); boundedJSON(next);
      this.checkAttachments(snapshot, data);
      this.write(next);
      return next.revision;
    });
  }

  /** Read-only preflight before service teardown. Keep the validator/revision
   * guard, and recheck again in beginAttempt at the native admission boundary. */
  validateSavedDrafts(revision: number): void {
    this.mutation(() => {
      const data = this.read();
      if (!data.drafts || data.revision !== revision) throw new Error("Composer drafts changed after restart preparation.");
      if (data.attempt && data.attempt.outcome !== "installed") throw new Error("An update attempt already requires recovery.");
      this.checkAttachments(data.drafts, data);
    });
  }

  /** Close-only proof after service/native admission. Never clears an attempt,
   * rewrites drafts, or authorizes another installation. */
  validateRecoveryClose(revision: number): void {
    this.mutation(() => {
      const data = this.read();
      if (!Number.isSafeInteger(revision) || revision < 1 || !data.drafts || data.revision !== revision) throw new Error("Composer drafts changed after restart preparation.");
      this.checkAttachments(data.drafts, data);
    });
  }

  beginAttempt(input: { id?: string; from: string; to: string; sha512: string; revision: number }): string {
    return this.mutation(() => {
      const data = this.read();
      if (data.attempt && data.attempt.outcome !== "installed") throw new Error("An update attempt already requires recovery.");
      if (!data.drafts || input.revision !== data.revision) throw new Error("Composer drafts changed after restart preparation.");
      const attempt = { id: input.id ?? randomUUID(), from: input.from, to: input.to, sha512: input.sha512, startedAt: new Date().toISOString(), outcome: "uncertain" as const };
      const next = { ...data, attempt };
      validate(next); boundedJSON(next);
      this.checkAttachments(data.drafts, data);
      this.write(next);
      return attempt.id;
    });
  }

  /** Main coordinator only: it must prove this process never called native
   * checkForUpdates for this ID. Never expose over IPC or use after relaunch.
   * Supply the ID to beginAttempt before writing so even a post-rename fsync
   * failure can be reconciled without guessing which receipt belongs to us.
   */
  releaseUnstartedAttempt(attemptId: string): void {
    return this.mutation(() => {
      const data = this.read();
      if (!data.attempt || data.attempt.id !== attemptId || data.attempt.outcome !== "uncertain") throw new Error("The unstarted update attempt does not match the recovery record.");
      this.write({ ...data, attempt: null });
    });
  }

  recordOutcome(attemptId: string, outcome: "staged" | "uncertain"): void {
    return this.mutation(() => {
      const data = this.read();
      if (!data.attempt || data.attempt.id !== attemptId) throw new Error("The update attempt does not match the recovery record.");
      if (data.attempt.outcome === "installed" || data.attempt.outcome === "staged") return;
      this.write({ ...data, attempt: { ...data.attempt, outcome } });
    });
  }

  /** Call only with the trusted running application's version, never renderer input. */
  inspect(installedVersion: string): UpdateRecoveryRecord {
    return this.mutation(() => {
      const data = this.read();
      if (data.attempt && data.attempt.to === installedVersion && data.attempt.outcome !== "installed") {
        data.attempt.outcome = "installed";
        this.write(data);
      }
      return data;
    });
  }

  private write(data: UpdateRecoveryRecord): void {
    validate(data);
    const body = boundedJSON(data);
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    let fd: number | undefined;
    try {
      fs.mkdirSync(this.home, { recursive: true, mode: 0o700 });
      fd = fs.openSync(temporary, "wx", 0o600);
      fs.writeFileSync(fd, body);
      fs.fsyncSync(fd);
      fs.closeSync(fd); fd = undefined;
      fs.renameSync(temporary, this.file);
      fd = fs.openSync(this.home, fs.constants.O_RDONLY);
      fs.fsyncSync(fd);
    } catch { throw failure(); }
    finally {
      if (fd !== undefined) fs.closeSync(fd);
      fs.rmSync(temporary, { force: true });
    }
  }
}

export type DraftTransactionOutcome = { status: "unchanged" } | { status: "committed"; revision: number };
export type DraftTransactionReceipt = Readonly<{ status: "unchanged" | "committed" | "stale"; revision: number }>;

export class ComposerRecoveryWriter {
  private session = randomUUID();
  private sequence = 0;
  private revision = 0;
  private transacting = false;
  private reentered = false;
  private uncertain = false;
  private completed?: { id: string; sequence: number; body: string; receipt: DraftTransactionReceipt };
  constructor(private readonly recovery: UpdateRecovery) {}
  private assertWritable(): void {
    if (this.transacting) this.reentered = true;
    if (this.transacting || this.uncertain) throw new Error("Draft transaction requires recovery before further writes.");
  }
  /** New trusted renderer document; called before its preload starts numbering writes. */
  reset(): string {
    this.assertWritable();
    this.session = randomUUID(); this.sequence = 0; this.revision = 0; this.completed = undefined;
    return this.session;
  }
  save(input: unknown): DraftSaveReceipt {
    this.assertWritable();
    if (!input || typeof input !== "object" || !("sequence" in input) || !("snapshot" in input)
      || !("session" in input) || input.session !== this.session
      || typeof input.sequence !== "number" || !Number.isSafeInteger(input.sequence) || input.sequence < 1) throw new Error("Invalid draft save sequence.");
    if (input.sequence <= this.sequence) return { revision: this.revision, saved: false };
    const revision = this.recovery.saveDrafts(input.snapshot);
    this.sequence = input.sequence;
    this.revision = revision;
    return { revision, saved: true };
  }

  /** Main-only synchronous journal/claim/save boundary. The callback must prove
   * journal and manifest unchanged before returning unchanged. A thrown error
   * is uncertain even when a subsequent read looks committed: reads do not
   * prove fsync succeeded. Startup replay, not reset(), resolves that state. */
  transaction(input: unknown, run: (snapshot: Immutable<ComposerRecovery>, before: Immutable<UpdateRecoveryRecord>) => DraftTransactionOutcome): DraftTransactionReceipt {
    this.assertWritable();
    if (!input || typeof input !== "object" || (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)
      || Reflect.ownKeys(input).length !== 4) throw new Error("Invalid draft transaction.");
    const fields = ["session", "sequence", "id", "snapshot"] as const;
    for (const key of fields) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw new Error("Invalid draft transaction.");
    }
    const request = input as { session: unknown; sequence: unknown; id: unknown; snapshot: unknown };
    if (request.session !== this.session || typeof request.sequence !== "number" || !Number.isSafeInteger(request.sequence) || request.sequence < 1
      || typeof request.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(request.id) || typeof run !== "function") throw new Error("Invalid draft transaction.");
    const sequence = request.sequence, transactionId = request.id;
    const snapshot = freeze(copyComposerRecovery(request.snapshot));
    const body = boundedJSON(snapshot);
    if (this.completed?.id === transactionId) {
      if (this.completed.sequence !== sequence || this.completed.body !== body) throw new Error("Draft transaction identity was reused.");
      if (this.sequence === sequence && this.revision === this.completed.receipt.revision) return this.completed.receipt;
    }
    if (sequence <= this.sequence) return Object.freeze({ status: "stale", revision: this.revision });
    const before = freeze(this.recovery.read());
    if (before.attempt && before.attempt.outcome !== "installed") throw new Error("Update recovery is required before editing drafts.");
    this.transacting = true; this.reentered = false;
    try {
      // Copy the result through the same data-only walker: async callbacks,
      // accessors and ambiguous result objects cannot acknowledge a commit.
      const outcome: unknown = JSON.parse(boundedJSON(run(snapshot, before), 256));
      const after = this.recovery.read();
      if (this.reentered || !outcome || typeof outcome !== "object" || !("status" in outcome)) throw failure();
      if (outcome.status === "unchanged" && Object.keys(outcome).length === 1
        && boundedJSON(after, MIGRATED_BYTES) === boundedJSON(before, MIGRATED_BYTES)) {
        return Object.freeze({ status: "unchanged", revision: this.revision });
      }
      const revision = before.revision + 1;
      if (outcome.status !== "committed" || Object.keys(outcome).length !== 2 || !("revision" in outcome) || outcome.revision !== revision
        || boundedJSON(after, MIGRATED_BYTES) !== boundedJSON({ ...before, drafts: snapshot, revision }, MIGRATED_BYTES)) throw failure();
      this.sequence = sequence; this.revision = revision;
      const receipt = Object.freeze({ status: "committed" as const, revision });
      this.completed = { id: transactionId, sequence, body, receipt };
      return receipt;
    } catch (error) { this.uncertain = true; throw error; }
    finally { this.transacting = false; }
  }
}
