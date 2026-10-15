export class RestartAdmission {
  private hold?: symbol;
  private readonly pending = new Set<symbol>();
  private readonly drained = new Set<() => void>();
  get held(): boolean { return this.hold !== undefined; }
  assertOpen(): void { if (this.hold) throw new Error("Modex is preparing to restart."); }
  async run<T>(operation: () => T | Promise<T>): Promise<T> {
    this.assertOpen();
    const token = Symbol();
    this.pending.add(token);
    try { return await operation(); }
    finally {
      this.pending.delete(token);
      if (!this.pending.size) for (const notify of [...this.drained]) notify();
    }
  }
  /** Deletion fences new requests immediately, then lets already-admitted
   * requests settle before freezing the renderer's owner snapshot. */
  holdForOwnerRemoval(timeoutMs = 15_000): (() => void) | Promise<() => void> {
    this.assertOpen();
    const token = this.hold = Symbol();
    const release = () => { if (this.hold === token) this.hold = undefined; };
    if (!this.pending.size) return release;
    return new Promise((resolve, reject) => {
      const done = () => { clearTimeout(timer); this.drained.delete(done); resolve(release); };
      const timer = setTimeout(() => {
        this.drained.delete(done);
        release();
        reject(new Error("Current requests did not finish in time. Try removing the thread or project again."));
      }, timeoutMs);
      this.drained.add(done);
    });
  }
  /** Refusal is reversible and leaves admitted work running to its normal result. */
  holdForRestart(): () => void {
    if (this.hold) throw new Error("Modex is preparing to restart.");
    if (this.pending.size) throw new Error("Let current requests finish before restarting.");
    const token = this.hold = Symbol();
    return () => { if (this.hold === token) this.hold = undefined; };
  }
}
