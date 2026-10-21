import { acceptsReply, scopeOf, type CodeReviewOp, type CodeReviewReads, type CodeReviewReply, type CodeReviewRequest, type ReadResult, type ReplyScope } from "../../shared/code-review.js";

/** One way to ask main: the bridge's `code-review:read` in the app, a fake in tests. */
export type Send = (request: CodeReviewRequest) => Promise<CodeReviewReply | null>;

type Reads = Exclude<CodeReviewRequest, { op: "cancel" }>;
/** A read without its request id, which the reader assigns. */
export type Ask = Reads extends infer R ? R extends Reads ? Omit<R, "requestId"> : never : never;

/**
 * `applied`: the reply answers what this slot asked, under the account and PR it asked for.
 * `superseded`: a newer read took the slot, or it was cancelled; the reply is dropped unseen.
 * `mismatch`: an answer arrived, but not for this request's account, PR or revision.
 */
export type Outcome<K extends keyof CodeReviewReads> =
  | { status: "applied"; result: ReadResult<CodeReviewReads[K]>; scope: ReplyScope }
  | { status: "superseded" }
  | { status: "mismatch" };

/**
 * Reads by slot ("inbox", "overview:<PR key>"): each slot holds one read at a time. A new read in a
 * slot cancels the one it replaces, and only the latest read's reply is ever applied. Main owns the
 * transport, timeouts and cancellation; this side owns which answer the view may show.
 */
export class Reader {
  private seq = 0;
  private readonly live = new Map<string, { requestId: string; op: CodeReviewOp; scope: ReplyScope }>();

  constructor(private readonly send: Send, private readonly now: () => string = () => new Date().toISOString(), private readonly prefix = "cr") {}

  async read<A extends Ask>(slot: string, ask: A, account: string | null): Promise<Outcome<A["op"]>> {
    this.cancel(slot);
    const request = { ...ask, requestId: `${this.prefix}-${++this.seq}` } as CodeReviewRequest;
    const asked = { requestId: request.requestId, op: request.op, scope: scopeOf(request, account) };
    this.live.set(slot, asked);
    let reply: CodeReviewReply | null;
    try {
      reply = await this.send(request);
    } catch {
      reply = null;
    }
    if (this.live.get(slot) !== asked) return { status: "superseded" };
    this.live.delete(slot);
    // No answer at all (a rejected invoke, no handler yet) is a failed read, never silence.
    if (!reply) return { status: "applied", result: { state: "unavailable", reason: "failed", fetchedAt: this.now() }, scope: asked.scope };
    if (!acceptsReply(asked, reply)) return { status: "mismatch" };
    return { status: "applied", result: reply.result as ReadResult<CodeReviewReads[A["op"]]>, scope: reply.scope };
  }

  pending(slot: string): boolean {
    return this.live.has(slot);
  }

  cancel(slot: string): void {
    const previous = this.live.get(slot);
    if (!previous) return;
    this.live.delete(slot);
    void this.send({ op: "cancel", requestId: previous.requestId }).catch(() => {});
  }

  /** On an account change or when the surface goes away: nothing asked before may land after. */
  cancelAll(): void {
    for (const slot of [...this.live.keys()]) this.cancel(slot);
  }
}
