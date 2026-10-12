export class RestartAdmission {
  private hold?: symbol;
  private readonly pending = new Set<symbol>();
  get held(): boolean { return this.hold !== undefined; }
  assertOpen(): void { if (this.hold) throw new Error("Modex is preparing to restart."); }
  async run<T>(operation: () => T | Promise<T>): Promise<T> {
    this.assertOpen();
    const token = Symbol();
    this.pending.add(token);
    try { return await operation(); }
    finally { this.pending.delete(token); }
  }
  /** Refusal is reversible and leaves admitted work running to its normal result. */
  holdForRestart(): () => void {
    if (this.hold) throw new Error("Modex is preparing to restart.");
    if (this.pending.size) throw new Error("Let current requests finish before restarting.");
    const token = this.hold = Symbol();
    return () => { if (this.hold === token) this.hold = undefined; };
  }
}
