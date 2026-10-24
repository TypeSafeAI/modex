import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { sameKey, sameRevision, validateRequest, type PrKey, type PrRevision } from "../../../shared/code-review.js";
import { AttachmentRecoveryFile, recoveryJSON, type RecoveryFileSnapshot } from "../attachment-recovery-file.js";

/** Main-only preparation, deliberately not wired to IPC or a mutation transport.
 * A future adapter must obtain this context from fresh trusted identity/policy
 * checks. A caller-supplied `permitted` flag is not provider authorization. */
export interface ReviewContext { account: string; session: string; permitted: boolean; key: PrKey; revision: PrRevision }
export interface ReviewAnchor { key: PrKey; revision: PrRevision; path: string; side: "base" | "head"; start: number; end: number }
export interface InlineComment { anchor: ReviewAnchor; body: string }
export type DraftKind = "comment" | "review";
export type ReviewOperation = { kind: "comment" } | { kind: "review"; event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES" }
  | { kind: "merge"; method: "merge" | "squash" | "rebase" };
export interface ReviewDraft { key: PrKey; revision: PrRevision; kind: DraftKind; version: number; body: string; comments: InlineComment[] }
export type IntentState = "prepared" | "dispatched" | "confirmed" | "rejected" | "unknown";
export type ReviewOutcome = { state: "confirmed"; remoteId: string } | { state: "rejected"; reason: "denied" | "failed" } | { state: "unknown" };
export interface ReviewIntent {
  id: string; key: PrKey; revision: PrRevision; operation: ReviewOperation;
  payload: { body: string; comments: InlineComment[] } | null; draftVersion: number | null;
  state: IntentState; digest: string; remoteId: string | null; reason: "denied" | "failed" | "restart" | "cancelled" | null;
}
/** `matched` is an adapter's exact correlation assertion, not a text search hit.
 * Absence (including a complete empty read) cannot prove a request was unsent. */
export type ReviewReconciliation = { kind: "absent" | "ambiguous" }
  | { kind: "matched"; key: PrKey; revision: PrRevision; digest: string; remoteId: string };
interface Document { schema: 1; drafts: ReviewDraft[]; intents: ReviewIntent[] }
const BYTES = 2 * 1024 * 1024, MAX_RECORDS = 128, TEXT = 64 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const failure = () => new Error("Review action data is invalid; existing records were preserved.");
const copy = <T>(value: T): T => structuredClone(value);
function shape(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));
}
function validText(value: unknown, empty = true): value is string {
  return typeof value === "string" && value.length <= TEXT && (empty || value.trim().length > 0)
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}
function target(value: { key: PrKey; revision: PrRevision }): boolean {
  return validateRequest({ op: "checks", requestId: "intent", key: value.key, revision: value.revision }) !== null;
}
function context(value: ReviewContext): boolean {
  return !!value && target(value) && value.account === value.key.account && typeof value.session === "string"
    && /^[A-Za-z0-9_-]{1,128}$/.test(value.session) && typeof value.permitted === "boolean";
}
function scoped(a: { key: PrKey; revision: PrRevision }, b: { key: PrKey; revision: PrRevision }): boolean {
  return sameKey(a.key, b.key) && sameRevision(a.revision, b.revision);
}
function operation(value: unknown): value is ReviewOperation {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return v.kind === "comment" ? shape(v, ["kind"])
    : v.kind === "review" ? shape(v, ["kind", "event"]) && ["COMMENT", "APPROVE", "REQUEST_CHANGES"].includes(v.event as string)
      : v.kind === "merge" && shape(v, ["kind", "method"]) && ["merge", "squash", "rebase"].includes(v.method as string);
}
function payload(scope: { key: PrKey; revision: PrRevision }, kind: DraftKind, body: unknown, comments: unknown): boolean {
  if (!validText(body) || !Array.isArray(comments) || comments.length > 100 || (kind === "comment" && comments.length > 0)) return false;
  return comments.every(c => {
    if (!shape(c, ["anchor", "body"]) || !validText(c.body, false) || !shape(c.anchor, ["key", "revision", "path", "side", "start", "end"])) return false;
    const a = c.anchor as unknown as ReviewAnchor;
    return target(a) && scoped(a, scope) && validateRequest({ op: "context", requestId: "anchor", ...a }) !== null;
  });
}
function digest(intent: Pick<ReviewIntent, "id" | "key" | "revision" | "operation" | "payload" | "draftVersion">): string {
  // Canonical fields/order, independent of the persisted record's key order.
  const k = intent.key, r = intent.revision, op = intent.operation;
  const operation = op.kind === "comment" ? { kind: op.kind } : op.kind === "merge" ? { kind: op.kind, method: op.method } : { kind: op.kind, event: op.event };
  const anchor = (a: ReviewAnchor) => ({ key: { account: a.key.account, host: a.key.host, repoId: a.key.repoId, number: a.key.number }, revision: { baseRef: a.revision.baseRef, baseSha: a.revision.baseSha, headSha: a.revision.headSha }, path: a.path, side: a.side, start: a.start, end: a.end });
  return createHash("sha256").update(JSON.stringify({ id: intent.id, key: { account: k.account, host: k.host, repoId: k.repoId, number: k.number },
    revision: { baseRef: r.baseRef, baseSha: r.baseSha, headSha: r.headSha }, operation,
    payload: intent.payload && { body: intent.payload.body, comments: intent.payload.comments.map(c => ({ anchor: anchor(c.anchor), body: c.body })) }, draftVersion: intent.draftVersion })).digest("hex");
}
function validDraft(value: unknown): value is ReviewDraft {
  if (!shape(value, ["key", "revision", "kind", "version", "body", "comments"])) return false;
  const v = value as unknown as ReviewDraft;
  return target(v) && ["comment", "review"].includes(v.kind) && Number.isSafeInteger(v.version) && v.version > 0 && payload(v, v.kind, v.body, v.comments);
}
function validIntent(value: unknown): value is ReviewIntent {
  if (!shape(value, ["id", "key", "revision", "operation", "payload", "draftVersion", "state", "digest", "remoteId", "reason"])) return false;
  const v = value as unknown as ReviewIntent;
  if (!UUID.test(v.id) || !target(v) || !operation(v.operation) || !["prepared", "dispatched", "confirmed", "rejected", "unknown"].includes(v.state)) return false;
  if (v.operation.kind === "merge") { if (v.payload !== null || v.draftVersion !== null) return false; }
  else if (!shape(v.payload, ["body", "comments"]) || !payload(v, v.operation.kind, v.payload.body, v.payload.comments)
    || !Number.isSafeInteger(v.draftVersion) || v.draftVersion! < 1 || (!v.payload.body.trim() && !v.payload.comments.length && (v.operation.kind === "comment" || v.operation.event !== "APPROVE"))) return false;
  return v.digest === digest(v) && (v.state === "confirmed" ? validText(v.remoteId, false) : v.remoteId === null)
    && (v.state === "rejected" ? ["denied", "failed", "restart", "cancelled"].includes(v.reason!) : v.reason === null);
}
function validate(value: unknown): void {
  if (!shape(value, ["schema", "drafts", "intents"]) || value.schema !== 1 || !Array.isArray(value.drafts) || !Array.isArray(value.intents)
    || value.drafts.length > MAX_RECORDS || value.intents.length > MAX_RECORDS || !value.drafts.every(validDraft) || !value.intents.every(validIntent)) throw failure();
  const drafts = value.drafts as ReviewDraft[], intents = value.intents as ReviewIntent[];
  if (drafts.some((d, i) => drafts.slice(0, i).some(p => scoped(p, d) && p.kind === d.kind)) || new Set(intents.map(i => i.id)).size !== intents.length) throw failure();
  const active = intents.filter(i => ["prepared", "dispatched", "unknown"].includes(i.state));
  if (active.some((d, i) => active.slice(0, i).some(p => sameKey(p.key, d.key)))) throw failure();
}

/** One main-process owner, bounded local data only. Existing recovery-file CAS,
 * symlink checks and durability are reused; this is not a second runner/journal.
 * Windows durable writes are unavailable in that adapter and fail closed here. */
export class ReviewActions {
  private readonly file: AttachmentRecoveryFile<Document>;
  private snapshot: RecoveryFileSnapshot<Document>;
  private blocked = false;
  private readonly confirmations = new WeakMap<object, { id: string; session: string }>();
  private readonly live = new Map<string, string>();
  constructor(home: string) {
    this.file = new AttachmentRecoveryFile(path.join(home, "review-actions"), "state.json", BYTES, validate);
    this.snapshot = this.file.read();
    const data = this.data(); let changed = false;
    for (const intent of data.intents) {
      if (intent.state === "dispatched") { intent.state = "unknown"; changed = true; }
      if (intent.state === "prepared") { intent.state = "rejected"; intent.reason = "restart"; changed = true; }
    }
    if (changed) this.commit(data);
  }
  private data(): Document { return this.snapshot.value ? copy(this.snapshot.value) as Document : { schema: 1, drafts: [], intents: [] }; }
  private commit(data: Document): void {
    if (this.blocked) throw new Error("Review action storage requires recovery.");
    try { this.snapshot = this.file.write(this.snapshot, data); }
    catch (cause) { this.blocked = true; throw new Error("Review action storage requires recovery; no dispatch was admitted.", { cause }); }
  }
  getDraft(ctx: ReviewContext, kind: DraftKind): ReviewDraft | null {
    if (!context(ctx)) return null;
    return this.data().drafts.find(d => d.kind === kind && scoped(d, ctx)) ?? null;
  }
  /** CAS also guards delayed asynchronous editor responses. No outcome erases a draft. */
  saveDraft(ctx: ReviewContext, kind: DraftKind, expectedVersion: number, body: string, comments: InlineComment[] = []): ReviewDraft | null {
    // Strip prototypes/accessors and enforce encoded size before inspecting caller data.
    let next: ReviewDraft;
    try { next = JSON.parse(recoveryJSON({ key: ctx.key, revision: ctx.revision, kind, version: expectedVersion + 1, body, comments }, BYTES)); }
    catch { return null; }
    if (!context(ctx) || !validDraft(next) || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0) return null;
    const data = this.data(), index = data.drafts.findIndex(d => d.kind === kind && scoped(d, ctx));
    if ((index < 0 ? 0 : data.drafts[index]!.version) !== expectedVersion || (index < 0 && data.drafts.length >= MAX_RECORDS)) return null;
    if (index < 0) data.drafts.push(next); else data.drafts[index] = next;
    this.commit(data); return copy(next);
  }
  prepare(ctx: ReviewContext, input: ReviewOperation, draftVersion?: number): { intent: ReviewIntent; confirmation: object } | null {
    let op: ReviewOperation;
    try { op = JSON.parse(recoveryJSON(input, 1024)); } catch { return null; }
    if (!context(ctx) || !ctx.permitted || !operation(op)) return null;
    const data = this.data();
    if (data.intents.length >= MAX_RECORDS || data.intents.some(i => sameKey(i.key, ctx.key) && ["prepared", "dispatched", "unknown"].includes(i.state))) return null;
    const draft = op.kind === "merge" ? null : data.drafts.find(d => scoped(d, ctx) && d.kind === op.kind && d.version === draftVersion);
    if (op.kind !== "merge" && (!draft || (!draft.body.trim() && !draft.comments.length && (op.kind === "comment" || op.event !== "APPROVE")))) return null;
    const intent: ReviewIntent = { id: randomUUID(), key: copy(ctx.key), revision: copy(ctx.revision), operation: op,
      payload: draft ? { body: draft.body, comments: copy(draft.comments) } : null, draftVersion: draft?.version ?? null,
      state: "prepared", digest: "", remoteId: null, reason: null };
    intent.digest = digest(intent); data.intents.push(intent); this.commit(data);
    const confirmation = Object.freeze({});
    this.confirmations.set(confirmation, { id: intent.id, session: ctx.session }); this.live.set(intent.id, ctx.session);
    return { intent: copy(intent), confirmation };
  }
  /** Return at most one permit only AFTER durable dispatch admission. A crash
   * after this point, even before a remote call, remains conservatively unknown. */
  dispatch(ctx: ReviewContext, confirmation: object): ReviewIntent | null {
    const proof = this.confirmations.get(confirmation);
    if (!proof || !context(ctx) || !ctx.permitted || proof.session !== ctx.session) return null;
    const data = this.data(), intent = data.intents.find(i => i.id === proof.id);
    if (!intent || intent.state !== "prepared" || !scoped(intent, ctx)) return null;
    intent.state = "dispatched"; this.commit(data); this.confirmations.delete(confirmation);
    return copy(intent);
  }
  /** Explicit abandonment/invalidation of a preview only. A new trusted document
   * for the same account/PR can discard an old preview after its head changes;
   * this never retracts a dispatched or uncertain remote operation. */
  cancel(ctx: ReviewContext, id: string): ReviewIntent | null {
    if (!context(ctx)) return null;
    const data = this.data(), intent = data.intents.find(i => i.id === id);
    if (!intent || intent.state !== "prepared" || !sameKey(intent.key, ctx.key)) return null;
    intent.state = "rejected"; intent.reason = "cancelled";
    this.commit(data); this.live.delete(id); return copy(intent);
  }
  complete(ctx: ReviewContext, id: string, outcome: ReviewOutcome): ReviewIntent | null {
    if (!context(ctx) || this.live.get(id) !== ctx.session) return null;
    let result: ReviewOutcome;
    try { result = JSON.parse(recoveryJSON(outcome, TEXT + 1024)); } catch { return null; }
    if (!(shape(result, ["state"]) && result.state === "unknown")
      && !(shape(result, ["state", "remoteId"]) && result.state === "confirmed" && validText(result.remoteId, false))
      && !(shape(result, ["state", "reason"]) && result.state === "rejected" && ["denied", "failed"].includes(result.reason))) return null;
    const data = this.data(), intent = data.intents.find(i => i.id === id);
    if (!intent || intent.state !== "dispatched" || !scoped(intent, ctx)) return null;
    intent.state = result.state; intent.remoteId = result.state === "confirmed" ? result.remoteId : null;
    intent.reason = result.state === "rejected" ? result.reason : null;
    this.commit(data); this.live.delete(id); return copy(intent);
  }
  reconcile(ctx: ReviewContext, id: string, input: ReviewReconciliation): ReviewIntent | null {
    if (!context(ctx)) return null;
    const data = this.data(), intent = data.intents.find(i => i.id === id);
    if (!intent || intent.state !== "unknown" || !scoped(intent, ctx)) return null;
    let evidence: ReviewReconciliation;
    try { evidence = JSON.parse(recoveryJSON(input, TEXT + 4096)); } catch { return copy(intent); }
    if (shape(evidence, ["kind", "key", "revision", "digest", "remoteId"]) && evidence.kind === "matched"
      && target(evidence) && scoped(evidence, intent) && evidence.digest === intent.digest && validText(evidence.remoteId, false)
      && !data.intents.some(i => i.id !== intent.id && sameKey(i.key, intent.key) && i.operation.kind === intent.operation.kind && i.remoteId === evidence.remoteId)) {
      intent.state = "confirmed"; intent.remoteId = evidence.remoteId; this.commit(data);
    }
    return copy(intent);
  }
  /** Same PR only; older revision receipts remain inspectable, never dispatchable. */
  list(ctx: ReviewContext): ReviewIntent[] {
    return context(ctx) ? this.data().intents.filter(i => sameKey(i.key, ctx.key)) : [];
  }
}
