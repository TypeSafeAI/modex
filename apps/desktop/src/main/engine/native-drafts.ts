import type { Attachment, AttachmentDraftOwner } from "../../shared/attachments.js";
import type { ComposerRecovery, DraftSaveReceipt } from "../../shared/update-recovery.js";
import type { Thread } from "../../shared/types.js";
import type { Store } from "./store.js";
import type { ThreadRunner } from "./runner.js";
import type { AttachmentStore } from "./attachments.js";
import { PendingSends, type PendingSendInput, type PendingSendRecord, type PendingTarget, type PendingSnapshot } from "./pending-sends.js";
import { ComposerRecoveryWriter, UpdateRecovery, copyComposerRecovery } from "./update-recovery.js";
import { AttachmentDocuments, type AttachmentDocument } from "./attachment-documents.js";
import { AttachmentTransferJournal } from "./attachment-transfer-journal.js";
import { recoveryJSON, parseRecoveryJSON } from "./attachment-recovery-file.js";
export interface NativeDraftOptions { store: Store; runner: ThreadRunner; attachments: AttachmentStore }
export type { NativeTransferRequest, NativeTransferReply } from "../../shared/native-drafts.js";
import type { DraftRemovalScope, NativeTransferRequest, NativeTransferReply, PendingSendView } from "../../shared/native-drafts.js";
const fail = () => new Error("Native draft recovery is required; original messages and attachments were preserved.");
const equal = (a: unknown, b: unknown) => recoveryJSON(a, 3 * 1024 * 1024) === recoveryJSON(b, 3 * 1024 * 1024);
const key = (owner: AttachmentDraftOwner) => owner.kind === "thread" ? `thread:${owner.threadId}` : owner.key;
function entries(snapshot: ComposerRecovery): { owner: AttachmentDraftOwner; files: Attachment[] }[] {
  return [...snapshot.threads.map(row => ({ owner: { kind: "thread" as const, threadId: row.threadId }, files: row.attachments })),
    ...snapshot.projects.map(row => ({ owner: { kind: "project" as const, key: row.key, projectId: row.projectId }, files: row.attachments }))];
}

/** Main-local document adapter. No renderer-supplied capability or reserved
 * creation identity is accepted; index binds calls to its top-frame lifetime.
 * Construct before updater startup inspection, document restoration or cleanup. */
export class NativeDrafts {
  readonly recovery: UpdateRecovery;
  private readonly options: Readonly<NativeDraftOptions>;
  private readonly pending: PendingSends;
  private readonly writer: ComposerRecoveryWriter;
  private readonly documents: AttachmentDocuments;
  private readonly journal: AttachmentTransferJournal;
  private readonly recovered = new Set<string>();
  private readonly transferred = new Set<string>();
  private session?: string;
  private document?: AttachmentDocument;
  private sequence = 0;
  private revision = 0;
  private completed?: { signature: string; reply: NativeTransferReply };
  private restartHold?: symbol;
  private removalHold?: { token: symbol; document: AttachmentDocument; pruned: boolean };
  private removalUncertain = false;
  get requiresRecovery(): boolean { return this.removalUncertain; }

  constructor(options: NativeDraftOptions) {
    this.options = Object.freeze({ ...options });
    options.attachments.setRecoveryRetention(null);
    if (!options.store.supportsDurableAdmission) throw fail();
    this.recovery = new UpdateRecovery(options.store.dir, (file, owner) => options.attachments.validateRecovery(file, owner));
    this.writer = new ComposerRecoveryWriter(this.recovery);
    this.pending = new PendingSends(options.store.dir);
    // Validate every original record before replay is allowed to mutate any.
    for (const record of this.records()) this.recovered.add(record.id);
    this.documents = new AttachmentDocuments({ attachments: options.attachments,
      readSavedDrafts: () => this.recovery.read().drafts,
      readPendingAttachments: () => [...this.records()].flatMap(record => record.files),
      ownerExists: owner => this.ownerExists(owner),
    });
    this.journal = new AttachmentTransferJournal(options.store.dir, { attachments: options.attachments, pending: this.pending,
      recovery: this.recovery, writer: this.writer, proveTarget: target => this.proveTarget(target) });
    this.journal.replay();
    // A crash after the durable user write may leave I. Confirm exact bytes and
    // re-checkpoint the transcript before retiring I; never launch a turn.
    for (const record of this.records()) {
      if (!record.target) continue;
      if (!this.proveTarget(record.target)) throw fail();
      const items = options.store.items(record.target.threadId);
      if (!items.some(item => item.id === record.id)) continue;
      if (!this.proveUser(record)) throw fail();
      options.store.saveItems(record.target.threadId, items);
      this.pending.complete(record.id, value => this.proveUser(value));
    }
  }

  private *records(): Generator<PendingSendRecord> {
    const list = this.pending.list(); if (list.evidence.length) throw fail();
    for (const id of list.ids) {
      const record = this.pending.read(id).value; if (!record) throw fail();
      yield structuredClone(record) as PendingSendRecord;
    }
  }
  private ownerExists(owner: AttachmentDraftOwner): boolean {
    if (owner.kind === "project") return !!this.options.store.project(owner.projectId);
    const thread = this.options.store.thread(owner.threadId); return !!thread && !thread.retired;
  }
  private proveTarget(target: Readonly<PendingTarget>): boolean {
    const current = this.options.store.thread(target.threadId);
    if (!current || current.retired || current.projectId !== target.projectId || current.createdAt !== target.createdAt) return false;
    const proof = this.options.store.checkpointThread(target.threadId);
    return proof.projectId === target.projectId && proof.createdAt === target.createdAt;
  }
  private proveUser(record: NonNullable<PendingSnapshot["value"]>): boolean {
    if (!record.target) return false;
    const matches = this.options.store.items(record.target.threadId).filter(item => item.id === record.id);
    const item = matches[0];
    return matches.length === 1 && item?.kind === "user" && item.text === record.rawText && item.at === record.createdAt
      && equal(item.attachments ?? [], record.files);
  }
  private current(session: string): AttachmentDocument {
    if (!this.document || session !== this.session) throw fail();
    return this.document;
  }
  private requirePending(id: string): PendingSendRecord {
    const record = this.pending.read(id).value; if (!record) throw fail();
    return structuredClone(record) as PendingSendRecord;
  }
  private reserved(): Set<string> { return new Set([...this.records()].flatMap(record => record.files.map(file => file.id))); }

  holdForRestart(): () => void {
    this.assertEditing();
    if ([...this.records()].length) throw new Error("Retry saved messages before restarting; pending originals were preserved.");
    return this.holdEditing();
  }
  private holdEditing(): () => void {
    this.assertEditing();
    const releaseDocuments = this.documents.holdForRestart();
    const token = this.restartHold = Symbol();
    return () => { if (this.restartHold === token) { this.restartHold = undefined; releaseDocuments(); } };
  }
  private assertEditing(): void {
    if (this.removalUncertain) throw fail();
    if (this.restartHold) throw new Error("Modex is preparing to restart or remove a draft owner.");
  }

  /** Main holds this across live renderer preparation and the entire owner
   * mutation. Unrelated pending messages do not prevent removing an empty owner. */
  holdForOwnerRemoval(): () => void {
    const document = this.current(this.session ?? ""), release = this.holdEditing();
    const token = Symbol(); this.removalHold = { token, document, pruned: false };
    return () => {
      if (this.removalHold?.token !== token || this.removalUncertain) return;
      this.removalHold = undefined; release();
    };
  }

  /** Only empty references may disappear. Call after the exact live document
   * has saved and frozen, then adopt this canonical snapshot before releasing. */
  pruneEmptyOwner(scope: DraftRemovalScope, revision: number): { drafts: ComposerRecovery; revision: number } {
    const hold = this.removalHold;
    if (!hold || hold.pruned || hold.document !== this.document || this.removalUncertain) throw new Error("Owner removal must hold the current draft document.");
    if (!scope || !["thread", "project"].includes(scope.kind) || typeof scope.id !== "string" || !scope.id) throw fail();
    const store = this.options.store;
    if (scope.kind === "project" ? !store.project(scope.id) : !store.thread(scope.id)) throw fail();
    const threads = new Set(scope.kind === "thread" ? [scope.id] : store.snapshot().threads.filter(thread => thread.projectId === scope.id).map(thread => thread.id));
    const affected = (owner: AttachmentDraftOwner) => owner.kind === "thread" ? threads.has(owner.threadId) : scope.kind === "project" && owner.projectId === scope.id;
    const expected = this.recovery.capture();
    this.recovery.validateSavedDrafts(revision);
    const drafts = copyComposerRecovery(expected.value?.drafts);
    if (expected.value?.revision !== revision) throw fail();
    const records = [...this.records()]; // Validate every original, including unrelated records.
    if (records.some(record => affected(record.source) || affected(record.owner) || (record.target && threads.has(record.target.threadId)))) {
      throw new Error("Retry saved messages before removing their project or thread; pending originals were preserved.");
    }
    if (drafts.threads.some(row => threads.has(row.threadId) && (row.text.length || row.attachments.length))
      || drafts.projects.some(row => scope.kind === "project" && row.projectId === scope.id && (row.text.length || row.attachments.length))) {
      throw new Error("Send or clear unsent drafts before removing their project or thread.");
    }
    drafts.threads = drafts.threads.filter(row => !threads.has(row.threadId));
    if (drafts.selectedThreadId && threads.has(drafts.selectedThreadId)) drafts.selectedThreadId = null;
    if (scope.kind === "project") {
      drafts.projects = drafts.projects.filter(row => row.projectId !== scope.id);
      if (drafts.draft?.projectId === scope.id) {
        // The shared configuration also owns other project drafts in this
        // revision. Retain their settings and select a surviving owner.
        drafts.draft = drafts.projects[0] ? { ...drafts.draft, projectId: drafts.projects[0].projectId } : null;
      }
    }
    // Once publishing begins, an unacknowledged result requires recovery. A
    // release cannot turn an uncertain durable write into permission to edit.
    this.removalUncertain = true;
    this.revision = this.recovery.commitDrafts(expected, drafts);
    this.completed = undefined;
    if (!this.documents.refreshRetention()) throw fail();
    hold.pruned = true; this.removalUncertain = false;
    return { drafts: copyComposerRecovery(drafts), revision: this.revision };
  }

  /** Inspect preserved data without opening or replacing an editing document. */
  readOnly(): { drafts: ComposerRecovery | null; pending: PendingSendView[] } {
    const drafts = this.recovery.read().drafts;
    const pending = [...this.records()].map(({ creation: _mainOnly, ...view }) => view);
    return structuredClone({ drafts, pending });
  }

  open(): { session: string; drafts: ComposerRecovery | null; pendingIds: string[] } {
    this.assertEditing();
    this.invalidate();
    const session = this.writer.reset(), opened = this.documents.open(), pendingIds: string[] = [];
    try {
      for (const record of this.records()) {
        this.documents.restorePending(opened.document, record.owner, record.files);
        pendingIds.push(record.id);
      }
      if (!this.documents.refreshRetention()) throw fail();
      this.document = opened.document; this.session = session; this.sequence = 0; this.revision = 0;
      return { session, drafts: opened.drafts, pendingIds };
    } catch (error) { this.documents.invalidate(); this.options.attachments.setRecoveryRetention(null); throw error; }
  }
  invalidate(): void {
    this.session = undefined; this.document = undefined; this.completed = undefined; this.transferred.clear();
    this.documents.invalidate();
  }
  save(session: string, request: { sequence: number; snapshot: ComposerRecovery }): DraftSaveReceipt {
    if (this.removalUncertain || this.removalHold?.pruned) throw fail();
    const document = this.current(session);
    if (!Number.isSafeInteger(request.sequence) || request.sequence < 1) throw fail();
    if (request.sequence <= this.sequence) return { saved: false, revision: this.revision };
    const snapshot = copyComposerRecovery(request.snapshot), reserved = this.reserved();
    for (const { owner, files } of entries(snapshot)) {
      if (!this.ownerExists(owner) || files.some(file => reserved.has(file.id) || !this.documents.validate(document, owner, file))) throw fail();
    }
    const receipt = this.writer.save({ session, sequence: request.sequence, snapshot });
    if (receipt.saved) { this.sequence = request.sequence; this.revision = receipt.revision; this.completed = undefined; }
    if (!this.documents.refreshRetention()) throw fail();
    return receipt;
  }
  stage(session: string, owner: AttachmentDraftOwner, files: unknown): { staged: Attachment[]; errors: string[] } {
    return this.documents.stage(this.documents.register(this.current(session), owner), files);
  }
  pick(session: string, owner: AttachmentDraftOwner, remaining: number, choose: () => Promise<unknown>): Promise<{ staged: Attachment[]; errors: string[] }> {
    return this.documents.pick(this.documents.register(this.current(session), owner), remaining, choose);
  }
  discard(session: string, owner: AttachmentDraftOwner, ids: string[]): void {
    const document = this.current(session), reserved = this.reserved();
    if (!Array.isArray(ids) || ids.some(id => reserved.has(id))) throw fail();
    this.documents.discard(this.documents.capture(document, owner), ids);
  }
  retire(session: string, owner: AttachmentDraftOwner): void {
    const document = this.current(session);
    this.documents.retire(this.documents.register(document, owner));
  }
  begin(session: string, input: PendingSendInput): { id: string } {
    this.assertEditing();
    const document = this.current(session);
    const pending = this.pending.begin(input, record => {
      if (this.current(session) !== document || !this.ownerExists(record.source)) return false;
      for (const other of this.records()) if (key(other.owner) === key(record.source)
        || other.files.some(file => record.files.some(selected => selected.id === file.id))) return false;
      return record.files.every(file => this.documents.validate(document, record.source, file));
    });
    if (!this.documents.refreshRetention()) throw fail();
    return { id: pending.value!.id };
  }
  async create(session: string, intentId: string): Promise<Thread> {
    this.assertEditing();
    const document = this.current(session), record = this.requirePending(intentId);
    let thread: Thread | undefined;
    if (record.source.kind === "project") {
      if (!record.creation) throw fail();
      // A previous process may have partially run a worktree script. Absence of
      // a Store record is not proof that repeating that script is harmless.
      if (this.recovered.has(intentId) && record.configuration.worktree && !this.options.store.thread(record.creation.threadId)) throw fail();
      thread = await this.options.runner.createThreadForPending(record.source.projectId, record.creation, record.configuration);
    } else thread = this.options.store.thread(record.source.threadId);
    if (this.current(session) !== document || !thread) throw fail();
    const target = { threadId: thread.id, projectId: thread.projectId, createdAt: thread.createdAt };
    if (!this.proveTarget(target)) throw fail();
    this.pending.bind(intentId, () => target);
    // An explicit retry can revive a retired source only from the strictly
    // persisted original. A late picker still holds its revoked old handle.
    this.documents.restorePending(document, record.owner, record.files);
    return structuredClone(thread);
  }
  transfer(session: string, input: NativeTransferRequest): NativeTransferReply {
    this.assertEditing();
    const document = this.current(session);
    const signature = recoveryJSON(input, 3 * 1024 * 1024);
    if (this.completed?.signature === signature) return structuredClone(this.completed.reply);
    const request = parseRecoveryJSON(signature, 3 * 1024 * 1024) as NativeTransferRequest;
    const snapshot = copyComposerRecovery(request.snapshot);
    if (!Number.isSafeInteger(request.sequence) || request.sequence < 1) throw fail();
    if (request.sequence <= this.sequence) return { status: "stale", revision: this.revision };
    const record = this.requirePending(request.intentId); if (!record.target) throw fail();
    const token = this.documents.beginTransfer(this.documents.register(document, record.owner), record.target.threadId, request.files);
    const claimed = request.files.map(file => ({ ...file, rel: file.rel.startsWith("staging/") ? `${record.target!.threadId}/${file.rel.slice(8)}` : file.rel }));
    const selected = new Map(claimed.map(file => [file.id, file])), reserved = this.reserved(), included = new Set<string>();
    for (const { owner, files } of entries(snapshot)) {
      if (!this.ownerExists(owner)) throw fail();
      for (const file of files) {
        if (reserved.has(file.id)) throw fail();
        const moved = selected.get(file.id);
        if (moved) {
          if (owner.kind !== "thread" || owner.threadId !== record.target.threadId || !equal(moved, file)) throw fail();
          included.add(file.id);
        } else if (!this.documents.validate(document, owner, file)) throw fail();
      }
    }
    if (claimed.some(file => !reserved.has(file.id) && !included.has(file.id))) throw fail();
    const receipt = this.journal.commit({ session, id: request.id, sequence: request.sequence, snapshot }, {
      intentId: request.intentId, files: request.files,
      authorize: () => this.current(session) === document && this.documents.validateTransfer(token),
    });
    if (receipt.status !== "committed") return { status: receipt.status, revision: receipt.revision };
    this.documents.adoptTransfer(token, claimed, () => receipt.status === "committed");
    this.sequence = request.sequence; this.revision = receipt.revision; this.transferred.add(request.intentId);
    const reply: NativeTransferReply = { status: "committed", revision: receipt.revision, files: claimed };
    this.completed = { signature, reply: structuredClone(reply) };
    return reply;
  }
  async send(session: string, intentId: string): Promise<void> {
    this.assertEditing();
    const document = this.current(session), record = this.requirePending(intentId);
    if (!this.transferred.has(intentId) || !record.target || record.owner.kind !== "thread"
      || !this.proveTarget(record.target) || record.files.some(file => !this.documents.validate(document, record.owner, file))) throw fail();
    await this.options.runner.sendDurably(record.target.threadId, record.rawText, record.files, {
      id: record.id, at: record.createdAt, committed: () => {
        if (this.current(session) !== document) throw fail();
        this.pending.complete(intentId, value => this.proveUser(value));
        this.documents.discard(this.documents.capture(document, record.owner), record.files.map(file => file.id));
        this.transferred.delete(intentId);
        if (!this.documents.refreshRetention()) throw fail();
      },
    });
  }
  readPending(session: string, intentId: string): PendingSendRecord | null {
    this.current(session);
    return structuredClone(this.pending.read(intentId).value) as PendingSendRecord | null;
  }
}
