import type { ComposerRecovery } from "./update-recovery.js";
import type { ComposerRecoveryQueue, ComposerTransferHold } from "./composer-recovery-queue.js";

interface RemovalOptions<State> {
  queue: ComposerRecoveryQueue;
  validate(): void;
  snapshot(): ComposerRecovery;
  prepareEditors(invalidated: () => void): Promise<void>;
  releaseEditors(): void;
  freezeAttachments(): boolean;
  releaseAttachments(): void;
  held(value: boolean): void;
  /** Update both synchronous refs and rendered state before queue adoption. */
  apply(drafts: ComposerRecovery, state: State): void;
}

/** Removing an owner requires a saved composer, but never permission to close
 * the window. Main owns release, including after preparation is refused. */
export class ComposerOwnerRemoval<State> {
  private current?: { valid: boolean; body?: string; revision?: number;
    hold?: Readonly<{ token: ComposerTransferHold; drained: Promise<number> }>; releasing?: Promise<void> };
  constructor(private readonly options: RemovalOptions<State>) {}

  async prepare(invalidated: () => void = () => {}): Promise<number> {
    if (this.current || this.options.queue.held) throw new Error("Draft owner removal is already active.");
    this.options.validate();
    if (!this.options.freezeAttachments()) throw new Error("Let attachment requests finish before removing this project or thread.");
    const attempt: NonNullable<ComposerOwnerRemoval<State>["current"]> = this.current = { valid: true };
    this.options.held(true);
    const check = () => { if (this.current !== attempt || !attempt.valid) throw new Error("Owner removal was cancelled or changed."); };
    await this.options.prepareEditors(() => {
      if (this.current === attempt && attempt.valid) { attempt.valid = false; invalidated(); }
    });
    check();
    const snapshot = this.options.snapshot(), body = JSON.stringify(snapshot);
    this.options.queue.update(snapshot);
    const revision = await this.options.queue.flush();
    check();
    attempt.hold = this.options.queue.holdForTransfer();
    await attempt.hold.drained;
    check();
    if (!Number.isSafeInteger(revision) || revision < 1 || this.options.queue.dirty || JSON.stringify(this.options.snapshot()) !== body) {
      throw new Error("Composer drafts changed while preparing owner removal.");
    }
    attempt.body = body; attempt.revision = revision;
    return revision;
  }

  async adopt(input: { drafts: ComposerRecovery; revision: number; state: State }): Promise<number> {
    const attempt = this.current;
    if (!attempt?.valid || !attempt.hold || !attempt.revision || !attempt.body) throw new Error("Owner removal has no prepared draft snapshot.");
    if (!Number.isSafeInteger(input.revision) || input.revision <= attempt.revision) throw new Error("Owner removal revision is stale.");
    if (JSON.stringify(this.options.snapshot()) !== attempt.body) throw new Error("Composer drafts changed during owner removal.");
    this.options.apply(input.drafts, input.state);
    if (JSON.stringify(this.options.snapshot()) !== JSON.stringify(input.drafts)) throw new Error("The canonical draft snapshot was not applied.");
    this.options.queue.completeTransfer(attempt.hold.token, input.drafts, input.revision);
    // Keep autosaves/close-save fenced until main receives the adoption ACK.
    attempt.hold = this.options.queue.holdForTransfer();
    await attempt.hold.drained;
    if (this.current !== attempt || !attempt.valid) throw new Error("Owner removal was cancelled or changed.");
    attempt.body = JSON.stringify(input.drafts); attempt.revision = input.revision;
    return input.revision;
  }

  release(): Promise<void> {
    const attempt = this.current;
    if (!attempt) return Promise.resolve();
    if (attempt.releasing) return attempt.releasing;
    attempt.valid = false;
    return attempt.releasing = Promise.resolve().then(async () => {
      if (attempt.hold) { await attempt.hold.drained; this.options.queue.refuseTransfer(attempt.hold.token); }
      this.options.releaseEditors(); this.options.releaseAttachments(); this.current = undefined; this.options.held(false);
    });
  }
}
