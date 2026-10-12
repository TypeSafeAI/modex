import { randomUUID } from "node:crypto";

export type RestartRequest = { id: string; type: "prepare" | "release" };
type Preparation = { id: string; prepared: boolean; resolve?: (revision: number) => void; reject?: (error: Error) => void; timer?: ReturnType<typeof setTimeout> };

/** One handshake per main-frame document. Main owns the token, deadline and
 * navigation invalidation; a renderer reply alone never starts an installation. */
export class RendererRestartPreflight {
  private current?: Preparation;
  constructor(private readonly send: (request: RestartRequest) => void, private readonly timeoutMs = 15_000) {}
  get preparing(): boolean { return Boolean(this.current?.resolve); }

  prepare(): Promise<number> {
    if (this.current) return Promise.reject(new Error("Restart preparation is already active."));
    return new Promise((resolve, reject) => {
      const request: Preparation = this.current = { id: randomUUID(), prepared: false, resolve, reject };
      request.timer = setTimeout(() => this.fail(new Error("The workspace did not respond. Keep Modex open and try again.")), this.timeoutMs);
      try { this.send({ id: request.id, type: "prepare" }); }
      catch { this.fail(new Error("The workspace is unavailable. Keep Modex open and try again.")); }
    });
  }
  reply(value: unknown): boolean {
    if (!value || typeof value !== "object") return false;
    const reply = value as Record<string, unknown>;
    const request = this.current;
    if (!request || reply.id !== request.id) return false;
    // A matching negative acknowledgment may revoke an already prepared
    // document. A later positive reply must never revive that attempt.
    if (typeof reply.error === "string" && reply.error.length > 0) {
      this.fail(new Error(reply.error.slice(0, 300)));
      return true;
    }
    if (!request.resolve) return false;
    if (!Number.isSafeInteger(reply.revision) || (reply.revision as number) < 1) return false;
    clearTimeout(request.timer);
    request.prepared = true;
    request.resolve(reply.revision as number);
    request.resolve = undefined; request.reject = undefined;
    return true;
  }
  assertPrepared(): void {
    if (!this.current?.prepared) throw new Error("The workspace changed or is not ready to restart.");
  }
  private fail(error: Error): void {
    const request = this.current;
    if (!request) return;
    clearTimeout(request.timer);
    request.prepared = false;
    request.reject?.(error);
    request.resolve = undefined; request.reject = undefined;
  }
  release(): void {
    const request = this.current;
    if (!request) return;
    this.fail(new Error("Restart preparation was cancelled."));
    this.current = undefined;
    this.send({ id: request.id, type: "release" });
  }
  invalidate(): void {
    this.fail(new Error("The workspace changed while preparing to restart."));
    this.current = undefined;
  }
}

/** Bind the handshake and its narrow persistence exception to one main-owned
 * document object. A same-URL replacement never inherits the old acknowledgment. */
export class DocumentRestartPreflight<Document extends object> {
  private document?: Document;
  private readonly gate: RendererRestartPreflight;
  constructor(private readonly current: () => Document | null | undefined, send: (document: Document, request: RestartRequest) => void, timeoutMs?: number) {
    this.gate = new RendererRestartPreflight(request => {
      if (this.document && this.document === this.current()) send(this.document, request);
      else if (request.type === "prepare") throw new Error("The workspace is unavailable.");
    }, timeoutMs);
  }
  prepare(): Promise<number> {
    if (this.document) return Promise.reject(new Error("Restart preparation is already active."));
    const document = this.current();
    if (!document) return Promise.reject(new Error("The workspace is unavailable."));
    this.document = document;
    return this.gate.prepare();
  }
  private isCurrent(document: Document | null | undefined): boolean {
    return Boolean(document && document === this.document && document === this.current());
  }
  allowsPersistence(document: Document | null | undefined): boolean {
    return this.isCurrent(document) && this.gate.preparing;
  }
  reply(document: Document | null | undefined, value: unknown): boolean {
    return this.isCurrent(document) && this.gate.reply(value);
  }
  assertPrepared(): void {
    if (!this.isCurrent(this.document)) throw new Error("The workspace changed while preparing to restart.");
    this.gate.assertPrepared();
  }
  release(): void { try { this.gate.release(); } finally { this.document = undefined; } }
  invalidate(): void { this.gate.invalidate(); this.document = undefined; }
}
