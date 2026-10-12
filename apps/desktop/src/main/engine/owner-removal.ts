import type { DraftRemovalScope } from "../../shared/native-drafts.js";
import type { ComposerRecovery } from "../../shared/update-recovery.js";
import { DocumentRestartPreflight, type RestartRequest } from "./update-renderer-preflight.js";

type Canonical<State> = { drafts: ComposerRecovery; revision: number; state: State };
type Request<State> = RestartRequest & ({ phase: "prepare"; scope: DraftRemovalScope } | { phase: "adopt"; result: Canonical<State> });
interface OwnerRemovalOptions<Document extends object, State> {
  current(): Document | null | undefined;
  send(document: Document, request: Request<State>): void;
  holds: (() => () => void)[];
  prune(scope: DraftRemovalScope, revision: number): { drafts: ComposerRecovery; revision: number };
  snapshot(): State;
  requiresRecovery(): boolean;
  recover(error: Error): void;
  timeoutMs?: number;
}

/** Main-only deletion transaction. A document ACK proves a saved/frozen draft;
 * a second ACK proves canonical state adoption before any editing fence opens. */
export class OwnerRemoval<Document extends object, State> {
  private operation?: { scope: DraftRemovalScope; result?: Canonical<State> };
  private readonly prepare: DocumentRestartPreflight<Document>;
  private readonly adopt: DocumentRestartPreflight<Document>;
  constructor(private readonly options: OwnerRemovalOptions<Document, State>) {
    this.prepare = new DocumentRestartPreflight(options.current, (document, request) => {
      if (!this.operation) throw new Error("Owner removal is no longer active.");
      options.send(document, { ...request, phase: "prepare", scope: this.operation.scope });
    }, options.timeoutMs);
    this.adopt = new DocumentRestartPreflight(options.current, (document, request) => {
      if (!this.operation?.result) throw new Error("Owner removal has no canonical result.");
      options.send(document, { ...request, phase: "adopt", result: this.operation.result });
    }, options.timeoutMs);
  }
  get active(): boolean { return Boolean(this.operation); }
  allowsPersistence(document: Document | null | undefined): boolean { return this.prepare.allowsPersistence(document); }
  reply(document: Document | null | undefined, reply: unknown): boolean {
    if (!reply || typeof reply !== "object" || !("phase" in reply)) return false;
    return reply.phase === "prepare" ? this.prepare.reply(document, reply) : reply.phase === "adopt" && this.adopt.reply(document, reply);
  }
  invalidate(): void { this.prepare.invalidate(); this.adopt.invalidate(); }

  async run(scope: DraftRemovalScope, remove: () => Promise<void>): Promise<void> {
    if (this.operation) throw new Error("Owner removal is already in progress.");
    if (!this.options.current()) throw new Error("Open the workspace before removing this project or thread.");
    const operation: NonNullable<OwnerRemoval<Document, State>["operation"]> = this.operation = { scope: { ...scope } };
    const releases: (() => void)[] = [];
    let published = false, adopted = false, recovery = false;
    try {
      for (const hold of this.options.holds) releases.push(hold());
      const revision = await this.prepare.prepare();
      this.prepare.assertPrepared();
      const result = this.options.prune(operation.scope, revision); published = true;
      // Every child operation must settle before remove() rejects. Runner owns
      // that lifetime; partially removed projects still need canonical adoption.
      let failed = false, failure: unknown;
      try { await remove(); } catch (error) { failed = true; failure = error; }
      this.prepare.assertPrepared();
      operation.result = { ...result, state: this.options.snapshot() };
      const acknowledged = await this.adopt.prepare();
      this.prepare.assertPrepared(); this.adopt.assertPrepared();
      if (acknowledged !== result.revision) throw new Error("The adopted draft revision does not match owner removal.");
      adopted = true;
      if (failed) throw failure;
    } catch (error) {
      recovery = (published && !adopted) || this.options.requiresRecovery();
      if (recovery) this.options.recover(error instanceof Error ? error : new Error(String(error)));
      throw error;
    } finally {
      try {
        if (recovery) this.invalidate();
        else {
          for (const release of releases.reverse()) release();
          try { this.adopt.release(); } finally { this.prepare.release(); }
        }
      } finally { this.operation = undefined; }
    }
  }
}
