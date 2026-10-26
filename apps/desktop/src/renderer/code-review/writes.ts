import { prKeyId, sameKey, type PrKey, type PrRevision } from "../../shared/code-review.js";
import { REFUSALS, type MergeCheck, type MergeMethod, type PrAction, type WriteDraft, type WriteInline, type WriteKind, type WritePreview, type WriteReceipt, type WriteReply, type WriteRequest, type WriteStatus } from "../../shared/code-review-write.js";

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
  private readonly bodies = new Map<string, { body: string; error: string | null; timer?: ReturnType<typeof setTimeout> }>();
  private readonly saving = new Map<string, Promise<Done<WriteDraft>>>();

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
    for (const pending of this.bodies.values()) clearTimeout(pending.timer);
    this.bodies.clear();
    this.saving.clear();
    this.entries.clear();
    this.emit();
  }

  pendingBody(key: PrKey, revision: PrRevision, kind: WriteKind): string | undefined {
    return this.bodies.get(`${id(key, revision)}:${kind}`)?.body;
  }

  bodyError(key: PrKey, revision: PrRevision, kind: WriteKind): string | null {
    return this.bodies.get(`${id(key, revision)}:${kind}`)?.error ?? null;
  }

  /** Own the debounce outside a mounted composer so navigation cannot discard the last edit. */
  editBody(key: PrKey, revision: PrRevision, kind: WriteKind, body: string): void {
    const slot = `${id(key, revision)}:${kind}`;
    clearTimeout(this.bodies.get(slot)?.timer);
    const pending = { body, error: null, timer: setTimeout(() => { void this.flushBody(key, revision, kind); }, 400) };
    this.bodies.set(slot, pending);
    this.touch(key, revision);
  }

  async flushBody(key: PrKey, revision: PrRevision, kind: WriteKind): Promise<Done<WriteDraft>> {
    const slot = `${id(key, revision)}:${kind}`, generation = this.generation;
    const running = this.saving.get(slot);
    if (running) {
      const done = await running;
      if (generation !== this.generation || !done.ok || !this.bodies.has(slot)) return done;
      return this.flushBody(key, revision, kind);
    }
    const pending = this.bodies.get(slot), current = this.entry(key, revision)?.status?.drafts[kind];
    if (!pending && current) return { ok: true, value: current };
    if (pending) clearTimeout(pending.timer);
    const work = this.save(key, revision, kind, pending?.body ?? "", current?.comments ?? []).then((done) => {
      if (generation !== this.generation) return done;
      if (pending && this.bodies.get(slot) === pending) {
        if (done.ok) this.bodies.delete(slot);
        else pending.error = done.detail;
      }
      this.touch(key, revision);
      return done;
    });
    this.saving.set(slot, work);
    try { return await work; }
    finally { if (this.saving.get(slot) === work) this.saving.delete(slot); }
  }

  private touch(key: PrKey, revision: PrRevision): void {
    const slot = id(key, revision);
    this.set(slot, { ...(this.entries.get(slot) ?? { status: null, error: null, loading: false }) });
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
    const generation = this.generation;
    const expectedVersion = this.entry(key, revision)?.status?.drafts[kind]?.version ?? 0;
    const done = await this.ask<"save">({ op: "save", key, revision, kind, expectedVersion, body, comments });
    if (generation !== this.generation) return { ok: false, reason: "account-changed", detail: REFUSALS["account-changed"] };
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

  /** A state change, an edit or a reviewer request, checked by main against GitHub's PR now. */
  prepareAction(key: PrKey, revision: PrRevision, action: PrAction): Promise<Done<WritePreview>> {
    return this.ask<"prepare-action">({ op: "prepare-action", key, revision, action });
  }

  async settle(op: "submit" | "cancel" | "reconcile" | "abandon", key: PrKey, revision: PrRevision, intentId: string): Promise<Done<WriteReceipt>> {
    const done = await this.ask({ op, key, intentId } as Ask) as Done<WriteReceipt>;
    await this.refresh(key, revision);
    return done;
  }

  private async ask<K extends WriteRequest["op"]>(ask: Omit<Extract<WriteRequest, { op: K }>, "requestId">): Promise<Done<Extract<WriteReply<K>["result"], { state: "ok" }>["value"]>> {
    const request: WriteRequest = { ...(ask as Ask), requestId: `${this.prefix}-${++this.seq}` };
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
