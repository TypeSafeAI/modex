import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Attachment, AttachmentDraftOwner } from "../../shared/attachments.js";
import type { ComposerRecovery } from "../../shared/update-recovery.js";
import { copyComposerRecovery } from "./update-recovery.js";
import { AttachmentRecoveryFile, RecoveryFileWriteError, parseRecoveryJSON, recoveryJSON, type RecoveryFileSnapshot } from "./attachment-recovery-file.js";

export const PENDING_TEXT_CHARACTERS = 1024 * 1024;
// Composer accepts up to 2 MiB encoded snapshots, including escaping/UTF-8.
// Add bounded intent identity/configuration metadata without narrowing that text.
export const PENDING_RECORD_BYTES = 2 * 1024 * 1024 + 64 * 1024;
const MAX_PENDING = 1000;
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const id = (value: unknown): value is string => typeof value === "string" && value.length <= 128 && /^[A-Za-z0-9_-]+$/.test(value) && value !== "staging";
const fail = () => new Error("Pending message recovery requires attention; original messages were preserved.");
export type { PendingTarget, PendingCreation, PendingSendRecord, PendingSendInput } from "../../shared/native-drafts.js";
import type { PendingTarget, PendingSendRecord } from "../../shared/native-drafts.js";
export type PendingSnapshot = RecoveryFileSnapshot<PendingSendRecord>;
const equal = (left: unknown, right: unknown) => recoveryJSON(left, PENDING_RECORD_BYTES) === recoveryJSON(right, PENDING_RECORD_BYTES);
function shape(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw fail();
}
function date(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw fail();
}
function owner(value: unknown): asserts value is AttachmentDraftOwner {
  if (!value || typeof value !== "object") throw fail();
  shape(value, (value as Record<string, unknown>).kind === "thread" ? ["kind", "threadId"] : ["kind", "key", "projectId"]);
  if (value.kind === "thread") { if (!id(value.threadId)) throw fail(); return; }
  if (value.kind !== "project" || !id(value.projectId) || typeof value.key !== "string") throw fail();
  const revision = value.key.match(/^draft:(0|[1-9]\d*):/);
  if (!revision || !Number.isSafeInteger(Number(revision[1])) || value.key !== `draft:${revision[1]}:${value.projectId}`) throw fail();
}
function validateTarget(value: unknown): asserts value is PendingTarget {
  shape(value, ["threadId", "projectId", "createdAt"]);
  if (!id(value.threadId) || !id(value.projectId)) throw fail(); date(value.createdAt);
}
function validateRecord(value: unknown): asserts value is PendingSendRecord {
  shape(value, ["schema", "id", "createdAt", "source", "owner", "rawText", "configuration", "files", "creation", "target"]);
  if (value.schema !== 1 || !uuid(value.id) || typeof value.rawText !== "string") throw fail();
  date(value.createdAt); owner(value.source); owner(value.owner);
  if (value.rawText.length > PENDING_TEXT_CHARACTERS) throw fail();
  shape(value.configuration, ["worktree", "settings"]);
  // Validate settings separately so synthetic configuration overhead cannot
  // narrow the 2-MiB allowance of an existing thread's accepted composer text.
  copyComposerRecovery({ threads: [], selectedThreadId: null,
    projects: [{ key: "draft:0:pending-settings", projectId: "pending-settings", text: "", attachments: [] }],
    draft: { revision: 0, projectId: "pending-settings", ...value.configuration } });
  if (value.owner.kind === "thread") {
    copyComposerRecovery({ threads: [{ threadId: value.owner.threadId, text: value.rawText, attachments: value.files }],
      projects: [], selectedThreadId: null, draft: null });
  } else {
    const projectId = value.owner.projectId, revision = Number(value.owner.key.split(":")[1]);
    copyComposerRecovery({ threads: [], selectedThreadId: null,
      projects: [{ key: value.owner.key, projectId, text: value.rawText, attachments: value.files }],
      draft: { revision, projectId, ...value.configuration } });
  }
  if (value.creation !== null) {
    shape(value.creation, ["threadId", "createdAt"]);
    if (!uuid(value.creation.threadId)) throw fail(); date(value.creation.createdAt);
  }
  if (value.target !== null) validateTarget(value.target);
  if (value.source.kind === "project") {
    if (!value.creation) throw fail();
    if (value.target && (value.target.threadId !== value.creation.threadId || value.target.createdAt !== value.creation.createdAt
      || value.target.projectId !== value.source.projectId)) throw fail();
  } else if (value.creation !== null || (value.target && value.target.threadId !== value.source.threadId)) throw fail();
  if (!equal(value.owner, value.source) && (value.owner.kind !== "thread" || !value.target || value.owner.threadId !== value.target.threadId)) throw fail();
}
function copyRecord(value: unknown): PendingSendRecord {
  const copied = parseRecoveryJSON(recoveryJSON(value, PENDING_RECORD_BYTES), PENDING_RECORD_BYTES);
  validateRecord(copied); return copied;
}

/** Persistence only for main's admitted original messages. Dispatcher/transaction
 * adapter supplies live document authority and file-content proofs; no method
 * starts a CLI, creates a worktree, or treats a planned target as authority. */
export class PendingSends {
  private readonly directory: string;
  private readonly identity: { dev: number; ino: number };
  private readonly files = new Map<string, AttachmentRecoveryFile<PendingSendRecord>>();
  private busy = false;
  private reentered = false;
  constructor(home: string) {
    const directory = path.join(home, "pending-sends");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(directory); if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail();
    this.directory = fs.realpathSync(directory); this.identity = { dev: stat.dev, ino: stat.ino };
  }
  private assertDirectory(): void {
    const stat = fs.lstatSync(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== this.identity.dev || stat.ino !== this.identity.ino) throw fail();
  }
  private operation<T>(run: () => T): T {
    if (this.busy) { this.reentered = true; throw fail(); }
    this.busy = true; this.reentered = false;
    try { const value = run(); if (this.reentered) throw fail(); return value; } finally { this.busy = false; }
  }
  /** Enumerate names only; callers load raw messages individually, avoiding an
   * unbounded in-memory collection of up to 1000 one-MiB messages. Unknown/temp
   * entries are preserved and stop new admissions until explicitly reconciled. */
  list(): { ids: string[]; evidence: string[] } {
    this.assertDirectory();
    const dir = fs.opendirSync(this.directory), ids: string[] = [], evidence: string[] = [];
    try {
      let entry: fs.Dirent | null;
      while ((entry = dir.readSync())) {
        if (ids.length + evidence.length >= MAX_PENDING) throw fail();
        const stem = entry.name.endsWith(".json") ? entry.name.slice(0, -5) : "";
        if (uuid(stem) && entry.isFile() && !entry.isSymbolicLink()) ids.push(stem); else evidence.push(entry.name);
      }
    } finally { dir.closeSync(); }
    this.assertDirectory(); return { ids, evidence };
  }
  private file(id: string): AttachmentRecoveryFile<PendingSendRecord> {
    if (!uuid(id)) throw fail(); this.assertDirectory();
    let file = this.files.get(id);
    if (!file) {
      file = new AttachmentRecoveryFile(this.directory, `${id}.json`, PENDING_RECORD_BYTES, value => {
        validateRecord(value); if (value.id !== id) throw fail();
      });
      this.files.set(id, file);
    }
    return file;
  }
  read(id: string): PendingSnapshot {
    const snapshot = this.file(id).read();
    if (!snapshot.value) this.files.delete(id);
    return snapshot;
  }
  checkpoint(id: string, expected: PendingSnapshot): void {
    this.operation(() => {
      if (!expected.value || expected.value.id !== id) throw fail();
      this.file(id).checkpoint(expected);
    });
  }
  begin(input: unknown, authorize: (record: NonNullable<PendingSnapshot["value"]>) => boolean): PendingSnapshot {
    return this.operation(() => {
      const copied: unknown = parseRecoveryJSON(recoveryJSON(input, PENDING_RECORD_BYTES), PENDING_RECORD_BYTES);
      shape(copied, ["source", "rawText", "configuration", "files"]); owner(copied.source);
      const id = randomUUID(), createdAt = new Date().toISOString();
      const record = copyRecord({ schema: 1, id, createdAt, ...copied, owner: copied.source,
        creation: copied.source.kind === "project" ? { threadId: randomUUID(), createdAt } : null, target: null });
      const admitted = JSON.parse(recoveryJSON(record, PENDING_RECORD_BYTES)) as PendingSendRecord;
      const freeze = (value: unknown): void => { if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } };
      freeze(admitted);
      if (authorize(admitted) !== true || this.reentered) throw fail();
      const entries = this.list(); if (entries.evidence.length || entries.ids.length >= MAX_PENDING) throw fail();
      const file = this.file(id), before = file.read(); if (before.value !== null) throw fail();
      try { return file.write(before, record); }
      catch (error) { if (error instanceof RecoveryFileWriteError && error.unchanged) this.files.delete(id); throw error; }
    });
  }
  /** resolve is a main-only Store checkpoint/result lookup, never IPC input. */
  bind(id: string, resolve: (record: NonNullable<PendingSnapshot["value"]>) => PendingTarget): PendingSnapshot {
    return this.operation(() => {
      const file = this.file(id), before = file.read(); if (!before.value) throw fail();
      const target: unknown = parseRecoveryJSON(recoveryJSON(resolve(before.value), 2048), 2048);
      validateTarget(target); if (this.reentered) throw fail();
      if (before.value.target && !equal(before.value.target, target)) throw fail();
      const next = copyRecord({ ...before.value, target });
      return equal(before.value, next) ? before : file.write(before, next);
    });
  }
  /** Build a bounded after-record for the transfer journal without persisting it.
   * The transaction adapter must independently prove manifest identity/content. */
  adoption(id: string, claimed: unknown): { before: PendingSnapshot; after: PendingSendRecord } {
    const before = this.read(id); if (!before.value?.target) throw fail();
    const target = before.value.target;
    const after = copyRecord({ ...before.value, owner: { kind: "thread", threadId: target.threadId }, files: claimed });
    if (after.files.length !== before.value.files.length) throw fail();
    const returned = new Map(after.files.map(file => [file.id, file]));
    for (const old of before.value.files) {
      const file = returned.get(old.id), rel = old.rel.startsWith("staging/") ? `${target.threadId}/${old.rel.slice(8)}` : old.rel;
      if (!file || file.rel !== rel || file.name !== old.name || file.mime !== old.mime || file.size !== old.size || file.kind !== old.kind) throw fail();
    }
    return { before, after };
  }
  /** Only the sealed three-record journal calls this after its composer commit. */
  commitAdoption(id: string, expected: PendingSnapshot, input: unknown): PendingSnapshot {
    return this.operation(() => {
      if (!expected.value || expected.value.id !== id) throw fail();
      const next = copyRecord(input), built = this.adoption(id, next.files);
      if (!equal(next, built.after) || built.before.sha256 !== expected.sha256) throw fail();
      return this.file(id).write(expected, next);
    });
  }
  /** A main-owned durable user-item proof is required; absence/cancellation or a
   * newer independent draft never authorizes deleting the original message. */
  complete(id: string, proveUserItem: (record: NonNullable<PendingSnapshot["value"]>) => boolean): void {
    this.operation(() => {
      const file = this.file(id), before = file.read(); if (!before.value) return;
      if (!before.value.target || before.value.owner.kind !== "thread" || before.value.owner.threadId !== before.value.target.threadId
        || before.value.files.some(file => !file.rel.startsWith(`${before.value!.target!.threadId}/`))) throw fail();
      if (proveUserItem(before.value) !== true || this.reentered) throw fail();
      file.remove(before); this.files.delete(id);
    });
  }
}
