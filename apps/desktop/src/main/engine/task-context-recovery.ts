import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Store } from "./store.js";
import { AttachmentRecoveryFile, recoveryJSON } from "./attachment-recovery-file.js";
import { PendingSends, PENDING_CONTEXT_NODES } from "./pending-sends.js";
import { contextDraftOwnerKey, sameContextDraftOwner, isContextDraftOwner, isPendingTaskContext, isTaskContextEvidence, taskContextBelongsTo, type ContextDraftOwner, type TaskContextEvidence } from "../../shared/task-context-evidence.js";

export interface ContextRecoveryScope { projectId: string; identity: string }
export interface ContextCreation { id: string; at: string }
export interface ContextReservation extends ContextCreation { worktree: boolean }
export interface ContextTransfer { kind: "user" | "pending"; threadId: string; threadCreatedAt: string; turnId: string }
interface ContextRecoveryRecord { schema: 1; owner: ContextDraftOwner; scope: string; projectId: string; context: TaskContextEvidence; created: ContextCreation | null; transfer: ContextTransfer | null; requested?: ContextReservation | null; previous?: TaskContextEvidence | null }
// A replacement retains its predecessor through an uncertain rename/fsync.
// Each selection still independently obeys the original 2 MiB metadata bound.
const LIMIT = 4 * 1024 * 1024 + 64 * 1024;
const NODES = 2 * PENDING_CONTEXT_NODES + 256;
const empty = (): TaskContextEvidence => ({ revision: 0, refs: [], captures: [], checks: [] });
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const encoded = (value: unknown) => recoveryJSON(value, LIMIT, NODES);
const equal = (a: unknown, b: unknown) => encoded(a) === encoded(b);
const fail = () => new Error("Task context recovery requires attention; the original selection was preserved.");
const shape = (v: unknown, keys: string[]): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every(key => Object.hasOwn(v, key));
const id = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v);
const date = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
function validate(value: unknown): asserts value is ContextRecoveryRecord {
  const keys = ["schema", "owner", "scope", "projectId", "context", "created", "transfer"];
  if (value && typeof value === "object" && Object.hasOwn(value, "requested")) keys.push("requested");
  if (value && typeof value === "object" && Object.hasOwn(value, "previous")) keys.push("previous");
  if (!shape(value, keys) || value.schema !== 1 || !isContextDraftOwner(value.owner)
    || typeof value.scope !== "string" || !/^[a-f0-9]{64}$/.test(value.scope) || !id(value.projectId)
    || !isPendingTaskContext({ owner: value.owner, projectId: value.projectId, evidence: value.context })
    || (value.owner.kind === "project" && value.owner.projectId !== value.projectId)) throw fail();
  if (Buffer.byteLength(JSON.stringify(value.context)) > 2 * 1024 * 1024) throw fail();
  if (value.previous !== undefined && value.previous !== null && (!isPendingTaskContext({ owner: value.owner, projectId: value.projectId, evidence: value.previous }) || Buffer.byteLength(JSON.stringify(value.previous)) > 2 * 1024 * 1024)) throw fail();
  if (value.created !== null && (!shape(value.created, ["id", "at"]) || !id(value.created.id) || !date(value.created.at) || value.owner.kind !== "project")) throw fail();
  if (value.requested !== undefined && value.requested !== null && (!shape(value.requested, ["id", "at", "worktree"]) || !id(value.requested.id) || !date(value.requested.at) || typeof value.requested.worktree !== "boolean" || value.owner.kind !== "project"
    || (value.created && (value.created.id !== value.requested.id || value.created.at !== value.requested.at)))) throw fail();
  if (value.transfer !== null && (!shape(value.transfer, ["kind", "threadId", "threadCreatedAt", "turnId"]) || (value.transfer.kind !== "user" && value.transfer.kind !== "pending")
    || !id(value.transfer.threadId) || !id(value.transfer.turnId) || !date(value.transfer.threadCreatedAt)
    || (value.owner.kind === "thread" && value.owner.threadId !== value.transfer.threadId))) throw fail();
  if (value.transfer?.kind === "user" && value.owner.kind === "project" && (!value.created || value.created.id !== value.transfer.threadId || value.created.at !== value.transfer.threadCreatedAt)) throw fail();
}

/** Later native/proposal receipts may extend a turn. Its original explicit
 * selection must remain byte-identical, including its observed capture IDs. */
function contains(recorded: unknown, selected: TaskContextEvidence): boolean {
  if (!isTaskContextEvidence(recorded)) return false;
  const refs = new Map(recorded.refs.map(ref => [ref.id, ref])), captures = new Map(recorded.captures.map(capture => [capture.id, capture]));
  return selected.refs.every(ref => {
    const actual = refs.get(ref.id);
    if (!actual || !equal(actual.target, ref.target)) return false;
    const ids = new Set(actual.captureIds), relations = new Set(actual.relations.map(encoded));
    return ref.captureIds.every(id => ids.has(id)) && ref.relations.every(relation => relations.has(encoded(relation)));
  }) && selected.captures.every(capture => captures.has(capture.id) && equal(captures.get(capture.id), capture));
}

/** Canonical local metadata, never renderer-supplied evidence or an editable
 * nonce. Prepared destinations resolve the crash gap between two durable files. */
export class TaskContextRecovery {
  private readonly files = new Map<string, AttachmentRecoveryFile<ContextRecoveryRecord>>();
  constructor(private readonly store: Store) {}
  private file(owner: ContextDraftOwner): AttachmentRecoveryFile<ContextRecoveryRecord> {
    const key = digest(contextDraftOwnerKey(owner));
    let file = this.files.get(key);
    if (!file) { file = new AttachmentRecoveryFile(path.join(this.store.dir, "context-drafts"), `${key}.json`, LIMIT, validate, NODES); this.files.set(key, file); }
    return file;
  }
  private read(owner: ContextDraftOwner, scope: ContextRecoveryScope) {
    const file = this.file(owner), snapshot = file.read(), value = snapshot.value;
    if (value && (!sameContextDraftOwner(value.owner, owner) || value.scope !== digest(scope.identity) || value.projectId !== scope.projectId)) throw fail();
    return { file, snapshot, record: value ? structuredClone(value) as ContextRecoveryRecord : { schema: 1 as const, owner: structuredClone(owner), scope: digest(scope.identity), projectId: scope.projectId, context: empty(), created: null, transfer: null } };
  }
  private delivered(record: ContextRecoveryRecord, checkpoint: boolean): boolean {
    const transfer = record.transfer; if (!transfer) return false;
    const thread = this.store.thread(transfer.threadId);
    if (thread && (thread.createdAt !== transfer.threadCreatedAt || thread.projectId !== record.projectId)) throw fail();
    const users = thread ? this.store.items(thread.id).filter(item => item.id === transfer.turnId) : [];
    if (users.length > 1) throw fail();
    const user = users[0];
    if (user && (user.kind !== "user" || !contains(user.contextEvidence, record.context) || !taskContextBelongsTo(user.contextEvidence!, thread!.id, transfer.turnId, record.projectId))) throw fail();
    let pendingDelivered = false;
    if (transfer.kind === "pending") {
      const pending = new PendingSends(this.store.dir), snapshot = pending.read(transfer.turnId), value = snapshot.value;
      if (value) {
        const target = value.target?.threadId ?? value.creation?.threadId ?? (value.source.kind === "thread" ? value.source.threadId : "");
        if (!value.context || !sameContextDraftOwner(value.source, record.owner) || target !== transfer.threadId || value.context.projectId !== record.projectId || !contains(value.context.evidence, record.context)) throw fail();
        if (checkpoint) pending.checkpoint(transfer.turnId, snapshot);
        pendingDelivered = true;
      }
    }
    if (user && checkpoint) this.store.saveItems(thread!.id, this.store.items(thread!.id));
    return !!user || pendingDelivered;
  }
  open(owner: ContextDraftOwner, scope: ContextRecoveryScope): { context: TaskContextEvidence; created?: ContextCreation; requested?: ContextReservation } {
    const { file, record, snapshot: initial } = this.read(owner, scope); let snapshot = initial;
    if (snapshot.value) file.checkpoint(snapshot);
    if (record.transfer) {
      const delivered = this.delivered(record, true);
      if (delivered) { record.context = empty(); record.previous = null; record.created = null; record.requested = null; }
      record.transfer = null; snapshot = file.write(snapshot, record);
    }
    if (record.requested && !record.created) {
      const thread = this.store.thread(record.requested.id);
      if (thread) {
        if (thread.retired || thread.createdAt !== record.requested.at || thread.projectId !== record.projectId) throw fail();
        this.store.checkpointThread(thread.id);
        record.created = { id: thread.id, at: thread.createdAt }; file.write(snapshot, record);
      }
    }
    if (record.created) {
      const thread = this.store.thread(record.created.id);
      if (!thread || thread.retired || thread.createdAt !== record.created.at || thread.projectId !== record.projectId) throw fail();
    }
    return { context: structuredClone(record.context), ...(record.created ? { created: structuredClone(record.created) } : {}), ...(record.requested ? { requested: structuredClone(record.requested) } : {}) };
  }
  reserve(owner: ContextDraftOwner, scope: ContextRecoveryScope, context: TaskContextEvidence, worktree: boolean): ContextReservation {
    const { file, snapshot, record } = this.read(owner, scope);
    if (owner.kind !== "project" || !equal(record.context, context) || (record.transfer && this.delivered(record, false))) throw fail();
    if (record.requested) {
      if (record.requested.worktree !== worktree) throw fail();
      if (worktree && !this.store.thread(record.requested.id)) throw new Error("Worktree creation is unresolved; the original context was preserved. Inspect its existing evidence before creating another worktree.");
      return structuredClone(record.requested);
    }
    const requested = { id: randomUUID(), at: new Date().toISOString(), worktree };
    file.write(snapshot, { ...record, requested, transfer: null }); return requested;
  }
  save(owner: ContextDraftOwner, scope: ContextRecoveryScope, previous: TaskContextEvidence, context: TaskContextEvidence, created?: ContextCreation): void {
    const { file, snapshot, record } = this.read(owner, scope);
    if (!equal(record.context, previous) || (record.transfer && this.delivered(record, false))) throw fail();
    file.write(snapshot, { ...record, context, previous: equal(previous, context) ? record.previous ?? null : previous, created: created ?? null, transfer: null });
  }
  prepare(owner: ContextDraftOwner, scope: ContextRecoveryScope, context: TaskContextEvidence, transfer: ContextTransfer): void {
    const { file, snapshot, record } = this.read(owner, scope);
    if (!equal(record.context, context) || (record.transfer && this.delivered(record, false))) throw fail();
    file.write(snapshot, { ...record, transfer });
  }
  complete(owner: ContextDraftOwner, scope: ContextRecoveryScope, transfer: ContextTransfer): void {
    const { file, snapshot, record } = this.read(owner, scope);
    if (!record.transfer || !equal(record.transfer, transfer) || !this.delivered(record, false)) throw fail();
    file.write(snapshot, { ...record, context: empty(), previous: null, created: null, requested: null, transfer: null });
  }
}
