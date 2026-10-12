import type { ComposerRecovery, UpdateStartupRecovery } from "../../shared/update-recovery.js";
import type { RestartPhase } from "./update-restart-coordinator.js";
import type { UpdateRecovery } from "./update-recovery.js";

/** Read before starting external services. An unreadable receipt is a recovery
 * condition too; neither case permits new writes or another native attempt. A new
 * renderer must also respect services already disposed in this still-running process. */
export function readUpdateStartup(store: UpdateRecovery, runningVersion: string, restartPhase: RestartPhase = "idle"): { drafts: ComposerRecovery | null; recovery: UpdateStartupRecovery | null } {
  try {
    const record = store.inspect(runningVersion);
    const attempt = record.attempt;
    return { drafts: record.drafts, recovery: attempt && attempt.outcome !== "installed" ? {
      outcome: attempt.outcome, targetVersion: attempt.to,
      message: `The update to Modex ${attempt.to} has not been confirmed. Your saved drafts are preserved. Quit Modex, then reopen it. If this screen returns, install that version from its release page.`,
    } : !["idle", "preparing"].includes(restartPhase) ? {
      outcome: restartPhase === "staged" || restartPhase === "uncertain" ? restartPhase : "recovery",
      message: "Modex has already started restarting. Your saved drafts are preserved below. Quit and reopen Modex to continue.",
    } : null };
  } catch {
    return { drafts: null, recovery: { outcome: "unreadable", message: "Modex could not read its update recovery file. The original file has been preserved. Quit Modex and repair or restore the recovery file before continuing." } };
  }
}
