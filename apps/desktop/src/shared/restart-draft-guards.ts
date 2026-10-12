/** Renderer editor participation in a main-owned restart. Holds remain in place
 * after failure until main confirms that service teardown has not started. */
export class RestartDraftGuards {
  private guards = new Map<string, { flush: () => Promise<void> }>();
  private held = false;
  private generation = 0;
  private waiting = new Set<() => void>();
  private invalidatePreparation?: () => void;
  private invalidateHeldPreparation?: () => void;
  get frozen(): boolean { return this.held; }
  assertOpen(): void { if (this.held) throw new Error("Modex is preparing to restart."); }
  register(name: string, flush: () => Promise<void>): () => void {
    if (this.guards.has(name)) throw new Error(`Duplicate restart editor: ${name}`);
    const registration = { flush };
    this.guards.set(name, registration);
    this.membershipChanged();
    return () => {
      if (this.guards.get(name) !== registration) return;
      this.guards.delete(name);
      this.membershipChanged();
    };
  }
  private membershipChanged(): void {
    if (!this.held) return;
    this.generation++;
    const invalidate = this.invalidatePreparation;
    const invalidateHeld = this.invalidateHeldPreparation;
    this.invalidatePreparation = undefined;
    this.invalidateHeldPreparation = undefined;
    try { invalidate?.(); } finally { invalidateHeld?.(); }
  }
  /** Bind invalidated to this attempt's main-owned token. It must invalidate
   * main's acknowledgment even after prepare resolves. Keep all editor/action
   * holds until main acknowledges cancellation and explicitly releases them;
   * merely queuing an invalidation message never authorizes resumed work. */
  async prepare(required: string[], invalidated: () => void): Promise<void> {
    this.assertOpen();
    if (typeof invalidated !== "function") throw new Error("Restart invalidation is unavailable.");
    this.held = true;
    this.invalidatePreparation = invalidated;
    const generation = ++this.generation;
    for (const name of required) if (!this.guards.has(name)) throw new Error("An editor is still loading. Wait before restarting.");
    await Promise.all([...this.guards.values()].map(({ flush }) => flush()));
    if (!this.held || generation !== this.generation) throw new Error("Restart preparation was cancelled.");
  }
  /** A fresh close proof while original restart holds remain in place. */
  async prepareHeld(required: string[], invalidated: () => void): Promise<void> {
    if (!this.held || this.invalidateHeldPreparation || typeof invalidated !== "function") throw new Error("Held recovery preparation is unavailable.");
    this.invalidateHeldPreparation = invalidated;
    const generation = this.generation;
    for (const name of required) if (!this.guards.has(name)) throw new Error("An editor is still loading. Wait before quitting.");
    await Promise.all([...this.guards.values()].map(({ flush }) => flush()));
    if (!this.held || generation !== this.generation || this.invalidateHeldPreparation !== invalidated) throw new Error("Recovery Quit preparation changed or was cancelled.");
  }
  releaseHeld(invalidated: () => void): void {
    if (this.invalidateHeldPreparation === invalidated) this.invalidateHeldPreparation = undefined;
  }
  /** Only already-started operations that themselves veto preparation may wait
   * here. New user actions must use assertOpen instead of queuing work for restart. */
  async waitUntilOpen(): Promise<void> {
    while (this.held) await new Promise<void>(resolve => { this.waiting.add(resolve); });
  }
  release(): void {
    const invalidateHeld = this.invalidateHeldPreparation;
    this.invalidateHeldPreparation = undefined;
    this.invalidatePreparation = undefined;
    this.held = false; this.generation++;
    const waiting = [...this.waiting]; this.waiting.clear();
    for (const resume of waiting) resume();
    invalidateHeld?.();
  }
}
