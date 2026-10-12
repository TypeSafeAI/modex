import type { ComposerRecovery } from "./update-recovery.js";
import type { ComposerRecoveryQueue, ComposerTransferHold } from "./composer-recovery-queue.js";
import type { RestartDraftGuards } from "./restart-draft-guards.js";

export interface ComposerRestartOptions {
  queue: ComposerRecoveryQueue;
  guards: RestartDraftGuards;
  validate(): void;
  snapshot(): ComposerRecovery;
  requiredEditors(): string[];
  freezeAttachments(): boolean;
  releaseAttachments(): void;
  held(value: boolean): void;
}

/** Renderer-side composer/editor hold; only main's release callback may reopen it. */
export class ComposerRestartPreparation {
  private current?: { valid: boolean; prepared: boolean; invalidated: () => void; body?: string; revision?: number;
    hold?: Readonly<{ token: ComposerTransferHold; drained: Promise<number> }>; releasing?: Promise<void> };
  private quitting?: { attempt: NonNullable<ComposerRestartPreparation["current"]>; valid: boolean; prepared: boolean; revoke: () => void };
  constructor(private readonly options: ComposerRestartOptions) {}
  private matchesSaved(attempt: NonNullable<ComposerRestartPreparation["current"]>): boolean {
    try { return Boolean(attempt.body && attempt.revision && this.options.queue.held && this.options.guards.frozen
      && !this.options.queue.dirty && JSON.stringify(this.options.snapshot()) === attempt.body); }
    catch { return false; }
  }
  get canClose(): boolean {
    const attempt = this.current;
    return Boolean(attempt?.prepared && this.matchesSaved(attempt) && (attempt.valid
      || (this.quitting?.attempt === attempt && this.quitting.valid && this.quitting.prepared)));
  }
  async prepare(invalidated: () => void): Promise<number> {
    if (this.current || this.options.queue.held) throw new Error("Composer restart preparation is already active.");
    this.options.validate();
    if (!this.options.freezeAttachments()) throw new Error("Let attachment requests and pending sends finish before restarting.");
    const attempt: NonNullable<ComposerRestartPreparation["current"]> = this.current = { valid: true, prepared: false, invalidated };
    this.options.held(true);
    const check = () => { if (this.current !== attempt || !attempt.valid) throw new Error("Restart preparation was cancelled or changed."); };
    const revoke = () => { if (this.current === attempt && attempt.valid) { attempt.valid = false; invalidated(); } };
    await this.options.guards.prepare(this.options.requiredEditors(), revoke);
    check();
    const snapshot = this.options.snapshot(), body = JSON.stringify(snapshot);
    this.options.queue.update(snapshot);
    const revision = await this.options.queue.flush();
    check();
    attempt.hold = this.options.queue.holdForTransfer();
    await attempt.hold.drained;
    check();
    if (!Number.isSafeInteger(revision) || revision < 1 || this.options.queue.dirty) throw new Error("Composer drafts have not been saved for restart.");
    if (JSON.stringify(this.options.snapshot()) !== body) throw new Error("Composer drafts changed while preparing to restart.");
    attempt.body = body; attempt.revision = revision;
    attempt.prepared = true;
    return revision;
  }
  async prepareQuit(invalidated: () => void): Promise<number> {
    const attempt = this.current;
    if (!attempt?.prepared || !attempt.hold || !attempt.body || !attempt.revision || this.quitting || typeof invalidated !== "function") {
      throw new Error("A saved restart preparation is required for recovery Quit.");
    }
    // The original ACK remains revoked even if this separate close proof succeeds.
    if (attempt.valid) { attempt.valid = false; attempt.invalidated(); }
    const proof = { attempt, valid: true, prepared: false, revoke: () => {} };
    proof.revoke = () => {
      if (this.quitting === proof && proof.valid) { proof.valid = false; invalidated(); }
    };
    this.quitting = proof;
    await this.options.guards.prepareHeld(this.options.requiredEditors(), proof.revoke);
    await attempt.hold.drained;
    if (this.current !== attempt || this.quitting !== proof || !proof.valid || !this.matchesSaved(attempt)) throw new Error("Saved drafts or editors changed during recovery Quit.");
    proof.prepared = true;
    return attempt.revision;
  }
  releaseQuit(): void {
    const proof = this.quitting;
    if (!proof) return;
    proof.valid = false;
    this.options.guards.releaseHeld(proof.revoke);
    this.quitting = undefined;
  }
  /** Revoke close permission synchronously; main still owns every editing hold. */
  invalidate(): void {
    const attempt = this.current;
    try { if (attempt?.valid) { attempt.valid = false; attempt.invalidated(); } }
    finally { this.quitting?.revoke(); }
  }
  release(): Promise<void> {
    this.releaseQuit();
    const attempt = this.current;
    if (!attempt) return Promise.resolve();
    if (attempt.releasing) return attempt.releasing;
    attempt.valid = false;
    return attempt.releasing = Promise.resolve().then(async () => {
      if (attempt.hold) {
        await attempt.hold.drained;
        this.options.queue.refuseTransfer(attempt.hold.token);
      }
      this.options.guards.release();
      this.options.releaseAttachments();
      this.current = undefined;
      this.options.held(false);
    });
  }
}
