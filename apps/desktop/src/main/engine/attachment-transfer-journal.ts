import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Attachment, AttachmentDraftOwner } from "../../shared/attachments.js";
import type { ComposerRecovery, UpdateRecoveryRecord } from "../../shared/update-recovery.js";
import type { AttachmentStore } from "./attachments.js";
import { PENDING_RECORD_BYTES, type PendingSends, type PendingSnapshot, type PendingTarget } from "./pending-sends.js";
import { copyComposerRecovery, copyUpdateRecoveryRecord, type ComposerRecoveryWriter, type DraftTransactionReceipt, type UpdateRecovery } from "./update-recovery.js";
import { AttachmentRecoveryFile, parseRecoveryJSON, recoveryJSON, type RecoveryFileSnapshot } from "./attachment-recovery-file.js";

const JOURNAL_BYTES = 3 * 1024 * 1024 + 128 * 1024;
const RECORD_BYTES = 2 * 1024 * 1024;
const fail = () => new Error("Attachment transfer recovery requires attention; existing messages and files were preserved.");
class UnstartedRefusal extends Error {
  constructor(cause: unknown) { super("Attachment transfer request was refused before starting.", { cause }); }
}
const digest = (value: unknown, limit = JOURNAL_BYTES) => createHash("sha256").update(recoveryJSON(value, limit)).digest("hex");
const equal = (a: unknown, b: unknown) => recoveryJSON(a, JOURNAL_BYTES) === recoveryJSON(b, JOURNAL_BYTES);
const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const id = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v) && v !== "staging";
const uuid = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
function shape(v: unknown, keys: string[]): asserts v is Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).length !== keys.length || keys.some(k => !Object.hasOwn(v, k))) throw fail();
}
function owner(v: unknown): asserts v is AttachmentDraftOwner {
  if (!v || typeof v !== "object") throw fail();
  shape(v, (v as Record<string, unknown>).kind === "thread" ? ["kind", "threadId"] : ["kind", "key", "projectId"]);
  if (v.kind === "thread") { if (!id(v.threadId)) throw fail(); return; }
  if (v.kind !== "project" || !id(v.projectId) || typeof v.key !== "string") throw fail();
  const match = v.key.match(/^draft:(0|[1-9]\d*):/);
  if (!match || !Number.isSafeInteger(Number(match[1])) || v.key !== `draft:${match[1]}:${v.projectId}`) throw fail();
}
function files(input: unknown, context: AttachmentDraftOwner): void {
  const snapshot: ComposerRecovery = context.kind === "thread"
    ? { threads: [{ threadId: context.threadId, text: "", attachments: input as Attachment[] }], selectedThreadId: null, projects: [], draft: null }
    : { threads: [], selectedThreadId: null, projects: [{ key: context.key, projectId: context.projectId, text: "", attachments: input as Attachment[] }],
      draft: { revision: Number(context.key.split(":")[1]), projectId: context.projectId, worktree: false, settings: { backend: "mock", mode: "agent", plan: false, auto: false, model: "" } } };
  copyComposerRecovery(snapshot);
}
interface FileProof { before: Attachment; after: Attachment; fingerprint: { dev: number; ino: number; size: number; sha256: string } }
interface Journal {
  schema: 1; id: string; intentId: string; source: AttachmentDraftOwner; target: PendingTarget;
  files: FileProof[];
  recovery: { beforeSha: string | null; beforeRevision: number; afterSha: string; after: UpdateRecoveryRecord };
  intent: { beforeSha: string; afterSha: string; files: Attachment[] };
}
function validate(value: unknown): asserts value is Journal {
  shape(value, ["schema", "id", "intentId", "source", "target", "files", "recovery", "intent"]);
  if (value.schema !== 1 || !uuid(value.id) || !uuid(value.intentId)) throw fail(); owner(value.source);
  shape(value.target, ["threadId", "projectId", "createdAt"]);
  if (!id(value.target.threadId) || !id(value.target.projectId) || typeof value.target.createdAt !== "string"
    || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.target.createdAt)
    || !Number.isFinite(Date.parse(value.target.createdAt)) || new Date(value.target.createdAt).toISOString() !== value.target.createdAt) throw fail();
  const target = { kind: "thread" as const, threadId: value.target.threadId };
  if (value.source.kind === "thread" ? value.source.threadId !== target.threadId : value.source.projectId !== value.target.projectId) throw fail();
  if (!Array.isArray(value.files) || value.files.length > 20) throw fail();
  const before: Attachment[] = [], after: Attachment[] = [];
  for (const entry of value.files) {
    shape(entry, ["before", "after", "fingerprint"]); shape(entry.fingerprint, ["dev", "ino", "size", "sha256"]);
    if (![entry.fingerprint.dev, entry.fingerprint.ino, entry.fingerprint.size].every(n => Number.isSafeInteger(n) && (n as number) >= 0) || !hash(entry.fingerprint.sha256)) throw fail();
    files([entry.before], value.source); files([entry.after], target);
    const b = entry.before as Attachment, a = entry.after as Attachment;
    if (entry.fingerprint.size !== b.size || !equal(a, { ...b, rel: b.rel.startsWith("staging/") ? `${target.threadId}/${b.rel.slice(8)}` : b.rel })) throw fail();
    before.push(b); after.push(a);
  }
  files(before, value.source); files(after, target);
  shape(value.recovery, ["beforeSha", "beforeRevision", "afterSha", "after"]);
  if (value.recovery.beforeSha !== null && !hash(value.recovery.beforeSha)) throw fail();
  if (!Number.isSafeInteger(value.recovery.beforeRevision) || (value.recovery.beforeRevision as number) < 0 || !hash(value.recovery.afterSha)) throw fail();
  const record = copyUpdateRecoveryRecord(value.recovery.after);
  if (!record.drafts || record.revision !== (value.recovery.beforeRevision as number) + 1
    || digest(record, RECORD_BYTES) !== value.recovery.afterSha || (record.attempt && record.attempt.outcome !== "installed")) throw fail();
  // Selected references in the after snapshot must use the authoritative target;
  // main's live registry separately proves its latest complete snapshot content.
  const selected = new Map(after.map(file => [file.id, file]));
  for (const draft of [...record.drafts.projects, ...record.drafts.threads]) {
    for (const file of draft.attachments) if (selected.has(file.id)
      && (!("threadId" in draft) || draft.threadId !== target.threadId || !equal(file, selected.get(file.id)))) throw fail();
  }
  shape(value.intent, ["beforeSha", "afterSha", "files"]);
  if (!hash(value.intent.beforeSha) || !hash(value.intent.afterSha)) throw fail(); files(value.intent.files, target);
  for (const file of value.intent.files as Attachment[]) if (!equal(file, selected.get(file.id) ?? null)) throw fail();
}
export interface TransferJournalOptions {
  attachments: AttachmentStore; pending: PendingSends; recovery: UpdateRecovery; writer: ComposerRecoveryWriter;
  /** Main-only durable Store proof, never a renderer-created target assertion. */
  proveTarget(target: Readonly<PendingTarget>): boolean;
}
export interface TransferAdmission { intentId: string; files: Attachment[]; authorize(): boolean }

/** One short synchronous ownership commit after async creation/picker work.
 * Startup replay runs before documents/cleanup and never creates a thread or
 * starts a CLI. Ordinary pending messages do not hold this journal open. */
export class AttachmentTransferJournal {
  private readonly file: AttachmentRecoveryFile<Journal>;
  private readonly options: Readonly<TransferJournalOptions>;
  private busy = false;
  private reentered = false;
  private attempted = false;
  private uncertain = false;
  constructor(home: string, options: TransferJournalOptions) {
    this.options = Object.freeze({ ...options });
    options.attachments.setRecoveryRetention(null);
    this.file = new AttachmentRecoveryFile(home, "attachment-transfer.json", JOURNAL_BYTES, validate);
  }
  private operation<T>(run: () => T): T {
    if (this.busy) { this.reentered = true; throw fail(); }
    if (this.uncertain) throw fail();
    this.busy = true; this.reentered = false;
    try { const result = run(); if (this.reentered) throw fail(); return result; }
    catch (error) { if (!(error instanceof UnstartedRefusal) || this.reentered) this.uncertain = true; throw error; }
    finally { this.busy = false; }
  }
  private noTemporary(): void {
    const directory = fs.opendirSync(path.dirname(this.file.file)); let count = 0;
    try { let entry: fs.Dirent | null; while ((entry = directory.readSync())) {
      if (++count > 10000 || entry.name.startsWith("attachment-transfer.json.")) throw fail();
    } } finally { directory.closeSync(); }
  }
  commit(request: unknown, admission: TransferAdmission): DraftTransactionReceipt {
    return this.operation(() => {
      this.attempted = true;
      this.noTemporary(); const empty = this.file.read(); if (empty.value) throw fail();
      let entered = false;
      try { return this.options.writer.transaction(request, (snapshot, before) => {
        entered = true;
        const { attachments, pending, recovery } = this.options;
        const intentId = admission.intentId, authorize = admission.authorize;
        // A current document may have harmlessly gone away before sealing. No
        // owned record has changed; the writer checks the complete R-before.
        if (authorize() !== true) { if (this.reentered) throw fail(); return { status: "unchanged" }; }
        const selected = parseRecoveryJSON(recoveryJSON(admission.files, 64 * 1024), 64 * 1024) as Attachment[];
        const intent = pending.read(intentId); if (!intent.value?.target) throw fail();
        const source = intent.value.owner, target = intent.value.target;
        files(selected, source);
        if (this.options.proveTarget(target) !== true || this.reentered) throw fail();
        const proof = recovery.capture();
        if (!equal(proof.value ?? { schema: 2, drafts: null, revision: 0, attempt: null }, before)) throw fail();
        const entries = selected.map(file => ({ before: file,
          after: { ...file, rel: file.rel.startsWith("staging/") ? `${target.threadId}/${file.rel.slice(8)}` : file.rel },
          fingerprint: attachments.fingerprint(file, source) }));
        const returned = new Map(entries.map(entry => [entry.before.id, entry.after]));
        const claimedIntent = intent.value.files.map(file => {
          const found = entries.find(entry => entry.before.id === file.id); if (!found || !equal(found.before, file)) throw fail();
          return returned.get(file.id)!;
        });
        const preview = pending.adoption(intentId, claimedIntent);
        if (preview.before.sha256 !== intent.sha256) throw fail();
        const after = copyUpdateRecoveryRecord({ ...before, drafts: snapshot, revision: before.revision + 1 });
        const journal: Journal = { schema: 1, id: randomUUID(), intentId,
          source: { ...source }, target: { ...target }, files: entries,
          recovery: { beforeSha: proof.sha256, beforeRevision: before.revision, afterSha: digest(after, RECORD_BYTES), after },
          intent: { beforeSha: intent.sha256!, afterSha: digest(preview.after, PENDING_RECORD_BYTES), files: claimedIntent } };
        // Fully validate and bound the journal before the first ownership write.
        validate(journal); recoveryJSON(journal, JOURNAL_BYTES);
        const sealed = this.file.write(empty, journal);
        this.finish(sealed, proof, intent);
        return { status: "committed", revision: after.revision };
      }); } catch (error) {
        // The writer rejects malformed/stale envelopes before entering its
        // mutation callback. This must not poison the journal for a later send.
        if (!entered && !this.reentered) throw new UnstartedRefusal(error);
        throw error;
      }
    });
  }
  replay(): { status: "none" } | { status: "committed"; intentId: string; revision: number } {
    return this.operation(() => {
      if (this.attempted) throw fail(); this.noTemporary();
      const journal = this.file.read(); if (!journal.value) return { status: "none" };
      this.file.checkpoint(journal);
      this.finish(journal);
      return { status: "committed", intentId: journal.value.intentId, revision: journal.value.recovery.after.revision };
    });
  }
  private finish(sealed: RecoveryFileSnapshot<Journal>, originalRecovery?: RecoveryFileSnapshot<UpdateRecoveryRecord>, originalIntent?: PendingSnapshot): void {
    const j = sealed.value; if (!j) throw fail();
    const { attachments, pending, recovery } = this.options;
    const targetOwner: AttachmentDraftOwner = { kind: "thread", threadId: j.target.threadId };
    if (this.options.proveTarget(j.target) !== true || this.reentered) throw fail();
    const r = originalRecovery ?? recovery.capture(), i = originalIntent ?? pending.read(j.intentId);
    const liveR = recovery.capture(), liveI = pending.read(j.intentId);
    if (liveR.sha256 !== r.sha256 || liveI.sha256 !== i.sha256 || !i.value || !equal(i.value.target, j.target)) throw fail();
    const rb = r.sha256 === j.recovery.beforeSha && (r.value?.revision ?? 0) === j.recovery.beforeRevision;
    const ra = r.sha256 === j.recovery.afterSha && r.value?.revision === j.recovery.after.revision;
    const ib = i.sha256 === j.intent.beforeSha, ia = i.sha256 === j.intent.afterSha;
    if ((!rb && !ra) || (!ib && !ia) || (ia && !ib && !ra)) throw fail();
    let transitions = 0, beforeCount = 0, afterCount = 0;
    for (const entry of j.files) {
      const matches = (file: Readonly<Attachment>, context: AttachmentDraftOwner, original: boolean) => {
        try {
          const f = attachments.fingerprint(file, context);
          return f.size === entry.fingerprint.size && f.sha256 === entry.fingerprint.sha256
            && (!original || (f.dev === entry.fingerprint.dev && f.ino === entry.fingerprint.ino));
        } catch { return false; }
      };
      if (entry.before.rel === entry.after.rel) { if (!matches(entry.after, targetOwner, true)) throw fail(); continue; }
      transitions++;
      if (matches(entry.before, j.source, true)) beforeCount++;
      else if (matches(entry.after, targetOwner, false)) afterCount++;
      else throw fail();
    }
    if (transitions && beforeCount !== transitions && afterCount !== transitions) throw fail();
    if (transitions && beforeCount === transitions && ra) throw fail();
    let nextIntent: unknown;
    if (ib) {
      const preview = pending.adoption(j.intentId, j.intent.files);
      if (preview.before.sha256 !== i.sha256 || digest(preview.after, PENDING_RECORD_BYTES) !== j.intent.afterSha) throw fail();
      nextIntent = preview.after;
    }
    if (transitions && beforeCount === transitions) {
      const draft = attachments.mintDraft(j.source);
      try {
        const transfer = j.source.kind === "project" ? attachments.mintTransfer(draft, j.target.threadId) : undefined;
        const claimed = attachments.claim(j.target.threadId, j.files.map(entry => ({ ...entry.before })), { draft, transfer });
        if (!equal(claimed, j.files.map(entry => entry.after))) throw fail();
      } finally { attachments.revokeDraft(draft); }
    }
    // The manifest must now prove the exact original content under the target.
    for (const entry of j.files) {
      const f = attachments.fingerprint(entry.after, targetOwner);
      if (f.sha256 !== entry.fingerprint.sha256 || f.size !== entry.fingerprint.size) throw fail();
    }
    if (this.reentered) throw fail();
    if (rb) {
      const revision = recovery.commitDrafts(r, j.recovery.after.drafts);
      if (revision !== j.recovery.after.revision || recovery.capture().sha256 !== j.recovery.afterSha) throw fail();
    } else recovery.checkpoint(r);
    if (ib && !ia) {
      const saved = pending.commitAdoption(j.intentId, i, nextIntent);
      if (saved.sha256 !== j.intent.afterSha) throw fail();
    } else pending.checkpoint(j.intentId, i);
    if (this.reentered || recovery.capture().sha256 !== j.recovery.afterSha || pending.read(j.intentId).sha256 !== j.intent.afterSha) throw fail();
    this.file.remove(sealed);
  }
}
