import { prKeyId, sameKey, type PrKey, type PrRevision } from "../../shared/code-review.js";
import type { MergeCheck, MergeMethod, WriteDraft, WriteInline, WriteKind, WritePreview, WriteReceipt, WriteReply, WriteRequest, WriteStatus } from "../../shared/code-review-write.js";

/** One way to ask main: the bridge's `code-review:write` in the app, a fake in tests. */
export type WriteSend = (request: WriteRequest) => Promise<WriteReply>;
type Ask = WriteRequest extends infer R ? R extends WriteRequest ? Omit<R, "requestId"> : never : never;

/** What a view shows for one PR at one revision. `error` is main's fixed refusal text, or a failed call. */
export interface WriteEntry { status: WriteStatus | null; error: string | null; loading: boolean }
export type Done<T> = { ok: true; value: T } | { ok: false; reason: string; detail: string };

const FAILED = "Modex couldn't reach its review-actions service.";

/**
 * The renderer's side of `code-review:write`: status per PR and revision, shared by the overview and the
 * Changes pane so a line comment added in one shows in the other. Main is the source of truth: every
 * change is a request, and the view shows main's answer. Nothing here decides permission.
 */
export class Writes {
  private seq = 0;
  private readonly entries = new Map<string, WriteEntry>();
  private readonly listeners = new Set<() => void>();
  private generation = 0;

  constructor(private readonly send: WriteSend, private readonly prefix = "cw") {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  entry(key: PrKey, revision: PrRevision): WriteEntry | undefined {
    return this.entries.get(id(key, revision));
  }

  /** On an account change: nothing answered for the old account may land after. */
  clear(): void {
    this.generation++;
    this.entries.clear();
    this.emit();
  }

  async refresh(key: PrKey, revision: PrRevision): Promise<void> {
    const slot = id(key, revision);
    this.set(slot, { ...(this.entries.get(slot) ?? { status: null, error: null }), loading: true });
    const generation = this.generation;
    const done = await this.ask<"status">({ op: "status", key, revision });
    if (generation !== this.generation) return;
    if (done.ok && done.value.account.id !== key.account) return;
    this.set(slot, done.ok ? { status: done.value, error: null, loading: false } : { status: this.entries.get(slot)?.status ?? null, error: done.detail, loading: false });
  }

  /** Saves against the version on screen. A conflict means another save won: show main's newest instead. */
  async save(key: PrKey, revision: PrRevision, kind: WriteKind, body: string, comments: WriteInline[]): Promise<Done<WriteDraft>> {
    const expectedVersion = this.entry(key, revision)?.status?.drafts[kind]?.version ?? 0;
    const done = await this.ask<"save">({ op: "save", key, revision, kind, expectedVersion, body, comments });
    if (done.ok) this.patch(key, revision, (status) => ({ ...status, drafts: { ...status.drafts, [kind]: done.value } }));
    else if (done.reason === "draft-conflict") await this.refresh(key, revision);
    return done;
  }

  async carry(key: PrKey, revision: PrRevision, kind: WriteKind, from: PrRevision): Promise<Done<WriteDraft>> {
    const done = await this.ask<"carry">({ op: "carry", key, revision, kind, from });
    await this.refresh(key, revision);
    return done;
  }

  prepare(key: PrKey, revision: PrRevision, operation: Extract<WriteRequest, { op: "prepare" }>["operation"], draftVersion: number): Promise<Done<WritePreview>> {
    return this.ask<"prepare">({ op: "prepare", key, revision, operation, draftVersion });
  }

  /** Main reads GitHub now and says whether, and how, the reviewed head may be merged. */
  mergeCheck(key: PrKey, revision: PrRevision): Promise<Done<MergeCheck>> {
    return this.ask<"merge-check">({ op: "merge-check", key, revision });
  }

  prepareMerge(key: PrKey, revision: PrRevision, method: MergeMethod): Promise<Done<WritePreview>> {
    return this.ask<"prepare-merge">({ op: "prepare-merge", key, revision, method });
  }

  async settle(op: "submit" | "cancel" | "reconcile" | "abandon", key: PrKey, revision: PrRevision, intentId: string): Promise<Done<WriteReceipt>> {
    const done = await this.ask({ op, key, intentId } as Ask) as Done<WriteReceipt>;
    await this.refresh(key, revision);
    return done;
  }

  private async ask<K extends WriteRequest["op"]>(ask: Omit<Extract<WriteRequest, { op: K }>, "requestId">): Promise<Done<Extract<WriteReply<K>["result"], { state: "ok" }>["value"]>> {
    const request = { ...ask, requestId: `${this.prefix}-${++this.seq}` } as WriteRequest;
    let reply: WriteReply;
    try {
      reply = await this.send(request);
    } catch {
      return { ok: false, reason: "failed", detail: FAILED };
    }
    // An answer for another request or PR is not this one's.
    if (!reply || reply.requestId !== request.requestId || reply.op !== request.op || !sameKey(reply.key, request.key)) return { ok: false, reason: "failed", detail: FAILED };
    return reply.result.state === "ok" ? { ok: true, value: reply.result.value as never } : { ok: false, reason: reply.result.reason, detail: reply.result.detail };
  }

  private patch(key: PrKey, revision: PrRevision, change: (status: WriteStatus) => WriteStatus): void {
    const slot = id(key, revision), entry = this.entries.get(slot);
    if (entry?.status) this.set(slot, { ...entry, status: change(entry.status) });
  }

  private set(slot: string, entry: WriteEntry): void {
    this.entries.set(slot, entry);
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

function id(key: PrKey, revision: PrRevision): string {
  return `${prKeyId(key)}@${revision.baseRef}:${revision.baseSha}:${revision.headSha}`;
}
