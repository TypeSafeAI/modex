import type { ComposerRecovery, DraftSaveReceipt } from "./update-recovery.js";

declare const transferBrand: unique symbol;
export type ComposerTransferHold = { readonly [transferBrand]: true };

function capture(input: ComposerRecovery): { body: string; snapshot: ComposerRecovery } {
  const body = JSON.stringify(input);
  const snapshot = JSON.parse(body) as ComposerRecovery;
  const freeze = (value: unknown): void => {
    if (value && typeof value === "object") {
      for (const child of Object.values(value)) freeze(child);
      Object.freeze(value);
    }
  };
  // Own the exact raw values represented by body. Neither callers nor save
  // callbacks may mutate what an eventual acknowledgment describes.
  freeze(snapshot);
  return { body, snapshot };
}

/** Owns acknowledgment truth across asynchronous autosaves and synchronous close saves. */
export class ComposerRecoveryQueue {
  private latest: { body: string; snapshot: ComposerRecovery };
  private acknowledged?: string;
  private revision = 0;
  private pending?: Promise<number>;
  private transfer?: { token: ComposerTransferHold; drained: boolean };
  constructor(snapshot: ComposerRecovery, private readonly save: (snapshot: ComposerRecovery) => Promise<DraftSaveReceipt>) {
    this.latest = capture(snapshot);
  }
  update(snapshot: ComposerRecovery): void {
    if (this.transfer) throw new Error("Composer recovery is held for attachment transfer.");
    this.latest = capture(snapshot);
  }
  get dirty(): boolean { return this.latest.body !== this.acknowledged; }
  get held(): boolean { return this.transfer !== undefined; }
  /** Stop retries immediately, then drain the already-issued save. App holds
   * edits/navigation only for this short phase, not asynchronous creation. */
  holdForTransfer(): Readonly<{ token: ComposerTransferHold; drained: Promise<number> }> {
    if (this.transfer) throw new Error("Composer recovery is already held for attachment transfer.");
    const token = Object.freeze({}) as ComposerTransferHold;
    const state: { token: ComposerTransferHold; drained: boolean } = { token, drained: false };
    this.transfer = state;
    const drained = (this.pending ?? Promise.resolve(this.revision)).then(revision => {
      if (this.transfer !== state) throw new Error("Composer transfer hold changed while draining.");
      state.drained = true; return revision;
    });
    return Object.freeze({ token, drained });
  }
  private requireTransfer(token: ComposerTransferHold): void {
    if (!this.transfer || this.transfer.token !== token || !this.transfer.drained || this.pending) throw new Error("Composer transfer hold is invalid or still draining.");
  }
  completeTransfer(token: ComposerTransferHold, snapshot: ComposerRecovery, revision: number): void {
    this.requireTransfer(token);
    if (!Number.isSafeInteger(revision) || revision <= this.revision) throw new Error("Composer transfer acknowledgment is stale.");
    const committed = capture(snapshot);
    this.latest = committed; this.acknowledged = committed.body; this.revision = revision; this.transfer = undefined;
  }
  /** Only a main-proven unchanged result may release an uncommitted hold. */
  refuseTransfer(token: ComposerTransferHold): void { this.requireTransfer(token); this.transfer = undefined; }
  flush(): Promise<number> {
    if (this.transfer) return Promise.reject(new Error("Composer recovery is held for attachment transfer."));
    if (this.pending) return this.pending;
    this.pending = Promise.resolve().then(async () => {
      while (this.dirty && !this.transfer) {
        const current = this.latest;
        const receipt = await this.save(current.snapshot);
        // A close-save may have superseded even a successful async write while
        // its acknowledgment was in transit. Only the newest actual write owns truth.
        if (receipt.saved && receipt.revision >= this.revision) this.acknowledged = current.body;
        this.revision = Math.max(this.revision, receipt.revision);
      }
      return this.revision;
    }).finally(() => { this.pending = undefined; });
    return this.pending;
  }
  saveBeforeClose(save: (snapshot: ComposerRecovery) => number | null | undefined): boolean {
    if (this.transfer) return false;
    if (!this.dirty) return true;
    const current = this.latest;
    const revision = save(current.snapshot);
    if (typeof revision !== "number") return false;
    this.revision = Math.max(this.revision, revision);
    this.acknowledged = current.body;
    return true;
  }
}
