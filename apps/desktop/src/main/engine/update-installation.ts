import type { UpdateInstallState } from "../../shared/updates.js";
import type { ReleaseChecker } from "./updates.js";
import { downloadReleaseArchive } from "./update-download.js";
import { stageUpdateArchive } from "./update-archive.js";
import { verifyMacUpdateBundle } from "./update-mac-verification.js";
import type { RestartPhase, RestartResult } from "./update-restart-coordinator.js";

export interface VerifiedUpdate { archive: string; version: string; size: number; sha512: string }
interface Options {
  enabled: boolean;
  parent: string;
  runningApp: string;
  arch: "arm64" | "x64";
  checker: Pick<ReleaseChecker, "check" | "archive">;
  changed: (state: UpdateInstallState) => void;
  /** Owns renderer persistence, admission fencing, service drain, durable receipt and
   * native handoff. Only a definite pre-handoff refusal may return blocked.
   */
  restart: (candidate: VerifiedUpdate) => Promise<RestartResult>;
  download?: typeof downloadReleaseArchive;
  stage?: typeof stageUpdateArchive;
  verify?: typeof verifyMacUpdateBundle;
}

/** Main-owned download/verification lifecycle. No renderer-supplied path, hash or feed. */
export class UpdateInstallation {
  private current: UpdateInstallState;
  private downloading?: Promise<UpdateInstallState>;
  private installing?: Promise<UpdateInstallState>;
  private abort?: AbortController;
  private verified?: VerifiedUpdate & { dispose(): Promise<void> };
  private disposed = false;

  constructor(private readonly options: Options) {
    this.current = { phase: options.enabled ? "idle" : "disabled", release: null, installable: false, canRestart: false, received: 0, total: 0 };
  }

  state(): UpdateInstallState { return { ...this.current, release: this.current.release ? { ...this.current.release } : null }; }
  private publish(patch: Partial<UpdateInstallState>): UpdateInstallState {
    this.current = { ...this.current, ...patch };
    try { this.options.changed(this.state()); } catch { console.error("[modex] update state observer failed"); }
    return this.state();
  }

  async check(): Promise<UpdateInstallState> {
    if (!this.options.enabled || this.disposed) return this.state();
    const release = await this.options.checker.check();
    if (["idle", "available"].includes(this.current.phase)) {
      this.publish({ phase: release ? "available" : "idle", release, installable: Boolean(this.options.checker.archive()) });
    }
    return this.state();
  }

  download(): Promise<UpdateInstallState> {
    if (this.disposed || !this.options.enabled) return Promise.reject(new Error("Automatic updates are disabled."));
    if (this.downloading) return this.downloading;
    if (this.installing || ["staged", "uncertain", "recovery"].includes(this.current.phase)) return Promise.reject(new Error("Update restart recovery is required."));
    if (this.current.phase === "ready") return Promise.resolve(this.state());
    const abort = this.abort = new AbortController();
    this.downloading = Promise.resolve().then(() => this.prepare(abort.signal)).finally(() => {
      this.downloading = undefined;
      if (this.abort === abort) this.abort = undefined;
    });
    return this.downloading;
  }

  cancel(): void {
    if (!this.abort || this.abort.signal.aborted) return;
    this.abort.abort();
    this.publish({ phase: "cancelling", message: "Cancelling update preparation…" });
  }

  private async prepare(signal: AbortSignal): Promise<UpdateInstallState> {
    let downloaded: Awaited<ReturnType<typeof downloadReleaseArchive>> | undefined;
    let staged: Awaited<ReturnType<typeof stageUpdateArchive>> | undefined;
    try {
      this.publish({ phase: "checking", message: undefined, received: 0, total: 0 });
      signal.throwIfAborted();
      const release = await this.options.checker.check();
      signal.throwIfAborted();
      const candidate = this.options.checker.archive();
      if (!candidate || !release || candidate.version !== release.version) throw new Error("Automatic installation metadata is unavailable.");
      this.publish({ phase: "downloading", release, installable: true, total: candidate.size });
      downloaded = await (this.options.download ?? downloadReleaseArchive)(candidate, {
        parent: this.options.parent, signal, progress: received => {
          if (!signal.aborted) this.publish({ received: Math.max(0, Math.min(candidate.size, received)) });
        },
      });
      signal.throwIfAborted();
      this.publish({ phase: "verifying" });
      staged = await (this.options.stage ?? stageUpdateArchive)(downloaded.file, { parent: this.options.parent, sha512: downloaded.sha512, size: candidate.size });
      signal.throwIfAborted();
      await (this.options.verify ?? verifyMacUpdateBundle)({ runningApp: this.options.runningApp, candidate: staged.bundle, version: candidate.version, arch: this.options.arch });
      signal.throwIfAborted();
      const sha512 = downloaded.sha512;
      await downloaded.dispose();
      downloaded = undefined;
      signal.throwIfAborted();
      this.verified = { archive: staged.archive, version: candidate.version, size: candidate.size, sha512, dispose: staged.dispose };
      staged = undefined;
      if (this.abort?.signal === signal) this.abort = undefined;
      return this.publish({ phase: "ready", message: undefined });
    } catch {
      if (this.abort?.signal === signal) this.abort = undefined;
      return this.publish({ phase: signal.aborted ? (this.current.release ? "available" : "idle") : "error",
        received: 0, message: signal.aborted ? "Update preparation cancelled." : "The update could not be downloaded or verified. Try again, or open the release page to update manually." });
    } finally {
      await Promise.all([downloaded?.dispose(), staged?.dispose()]);
    }
  }

  install(): Promise<UpdateInstallState> {
    if (this.installing) return this.installing;
    if (this.disposed || this.current.phase !== "ready" || !this.verified) return Promise.reject(new Error("The update is not ready to install."));
    const { dispose: _dispose, ...candidate } = this.verified;
    this.installing = Promise.resolve().then(async () => {
      this.publish({ phase: "preparing", message: undefined });
      try {
        const result = await this.options.restart(candidate);
        if (result.outcome === "blocked") return this.publish({ phase: "ready", message: result.message });
        this.observeRestart(result.outcome);
        return this.state();
      } catch {
        // Once the coordinator was entered, an unknown exception cannot prove that
        // Squirrel did not arm the next quit. Do not offer another native attempt.
        this.observeRestart("uncertain");
        return this.state();
      }
    }).finally(() => { this.installing = undefined; });
    return this.installing;
  }

  /** Main coordinator observations only. Late success changes the recovery UI,
   * never starts a new native attempt or initiates a quit from this controller. */
  observeRestart(phase: RestartPhase): void {
    if (!["preparing", "staged", "uncertain", "recovery"].includes(this.current.phase)) return;
    if (phase !== "staged" && phase !== "uncertain" && phase !== "recovery") return;
    if (this.current.phase === "staged") return;
    this.publish({ phase, canRestart: phase === "staged", message: phase === "recovery" ? "Modex could not finish preparing to restart. Quit and reopen Modex to recover your saved work."
      : phase === "uncertain" ? "The update handoff could not be confirmed. Restart recovery is required." : undefined });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.cancel();
    await Promise.allSettled([this.downloading, this.installing]);
    const verified = this.verified;
    this.verified = undefined;
    await verified?.dispose();
  }
}
