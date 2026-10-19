import type { MacHandoffState, MacUpdateHandoff } from "./update-mac-handoff.js";
import type { UpdateRecovery } from "./update-recovery.js";
import type { VerifiedUpdate } from "./update-installation.js";

export type RestartPhase = "idle" | "preparing" | "draining" | "staging" | "staged" | "uncertain" | "recovery";
/** `relaunch: false` stages the update without quitAndInstall: the caller is already
 * quitting, and Squirrel installs a staged update when the app exits. */
export interface RestartOptions { relaunch?: boolean }
export type RestartResult = { outcome: "blocked"; message: string } | { outcome: "staged" | "uncertain" | "recovery" };
export interface RestartCoordinatorOptions {
  currentVersion: string;
  recovery: UpdateRecovery;
  native: Pick<MacUpdateHandoff, "stage" | "state">;
  holds: (() => () => void)[];
  prepareRenderer(): Promise<number>;
  assertRendererPrepared(): void;
  releaseRenderer(): void;
  drainServices(): Promise<void>;
  changed(state: RestartPhase): void;
  quitAndInstall(): void;
}
export class UpdateRestartCoordinator {
  private phase: RestartPhase = "idle";
  private pending?: Promise<RestartResult>;
  private attemptId?: string;
  constructor(private readonly options: RestartCoordinatorOptions) {}
  get state(): RestartPhase { return this.phase; }

  private publish(phase: RestartPhase): void {
    if (this.phase === "staged" && phase === "uncertain") return;
    this.phase = phase;
    try { this.options.changed(phase); } catch { console.error("[modex] restart state observer failed"); }
  }

  restart(candidate: VerifiedUpdate, options: RestartOptions = {}): Promise<RestartResult> {
    if (this.pending) return this.pending;
    if (this.phase !== "idle") return Promise.reject(new Error("Restart recovery is required; a restart has already started."));
    // Assign the coalescing promise before calling user/renderer observers.
    this.pending = Promise.resolve().then(() => this.prepare(candidate, options)).finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private async prepare(candidate: VerifiedUpdate, options: RestartOptions): Promise<RestartResult> {
    const releases: (() => void)[] = [];
    let rendererEntered = false;
    let servicesTouched = false;
    try {
      // Every acquisition is synchronous, before any renderer or native await.
      for (const hold of this.options.holds) releases.push(hold());
      this.publish("preparing");
      rendererEntered = true;
      const revision = await this.options.prepareRenderer();
      this.options.assertRendererPrepared();
      if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("Composer drafts have not been saved for restart.");
      this.options.recovery.validateSavedDrafts(revision);
      this.publish("draining");
      // Disposal may be partial on failure. Never release admission onto disposed services.
      servicesTouched = true;
      await this.options.drainServices();
      this.options.assertRendererPrepared();
      this.publish("staging");
      this.attemptId = randomUUID();
      const outcome = await this.options.native.stage(candidate, async receipt => {
        this.options.assertRendererPrepared();
        if (receipt.version !== candidate.version || receipt.sha512 !== candidate.sha512) throw new Error("The update handoff does not match the verified candidate.");
        this.options.recovery.beginAttempt({ id: this.attemptId!, from: this.options.currentVersion, to: candidate.version, sha512: candidate.sha512, revision });
      });
      const persisted = this.observeNative(outcome);
      // A timeout followed by late success may already have published staged. The
      // original timeout still requires an explicit recovery action; never auto-quit it.
      if (outcome === "staged" && persisted && options.relaunch !== false) {
        try { this.options.assertRendererPrepared(); this.options.quitAndInstall(); }
        catch { console.error("[modex] update is staged but restarting failed"); }
      }
      return { outcome: this.phase === "staged" ? "staged" : "uncertain" };
    } catch (error) {
      if (!servicesTouched) {
        for (const release of releases.reverse()) release();
        if (rendererEntered) {
          try { this.options.releaseRenderer(); } catch { console.error("[modex] restart renderer release failed"); }
        }
        this.publish("idle");
        return { outcome: "blocked", message: error instanceof Error ? error.message.slice(0, 300) : "Modex could not prepare to restart. Try again." };
      }

      // MacUpdateHandoff only returns to idle for a failure before checkForUpdates.
      // This proof belongs to this still-running process, never a startup receipt.
      if (this.options.native.state === "idle") {
        if (this.attemptId) {
          try {
            if (this.options.recovery.read().attempt?.id === this.attemptId) this.options.recovery.releaseUnstartedAttempt(this.attemptId);
          } catch { console.error("[modex] unstarted update receipt could not be released"); }
        }
        this.publish("recovery");
        return { outcome: "recovery" };
      }
      this.observeNative("uncertain");
      return { outcome: this.phase === "staged" ? "staged" : "uncertain" };
    }
  }

  /** Observer only: late outcomes may update recovery evidence but never quit. */
  observeNative(state: MacHandoffState): boolean {
    if (!this.attemptId || (state !== "staged" && state !== "uncertain")) return false;
    try {
      this.options.recovery.recordOutcome(this.attemptId, state);
      this.publish(state);
      return true;
    } catch {
      this.publish("uncertain");
      console.error("[modex] native update outcome could not be saved");
      return false;
    }
  }
}
import { randomUUID } from "node:crypto";
