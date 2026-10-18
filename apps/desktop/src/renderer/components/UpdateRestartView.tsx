import { useEffect, useRef } from "react";
import type { UpdateController } from "../useUpdateState";
import { ErrorNotice } from "./ui/ErrorNotice";

/** Keep editors mounted behind this panel: their guards still own saved-work proof. */
export function UpdateRestartView({ installation, update, busy, error, run }: UpdateController) {
  const panel = useRef<HTMLElement>(null);
  useEffect(() => { panel.current?.focus(); }, []);
  const preparing = installation?.phase === "preparing";
  return <section ref={panel} tabIndex={-1} className="update-restart-panel" data-testid="update-restart-status" data-restart-controls aria-label="Update restart">
    <div className="update-recovery-content">
      <h1>{preparing ? "Preparing to restart" : "Your saved work is preserved"}</h1>
      <p role="status">{installation?.message ?? (preparing ? "Saving your drafts and preparing the update. Keep Modex open."
        : "Quit and reopen Modex to finish recovery. If recovery appears again, install the update from its release page.")}</p>
      {error && <ErrorNotice testId="update-restart-error" where="Update · restart" message={error} context={{ phase: installation?.phase, target: update?.version }} />}
      {!preparing && <div className="update-recovery-actions">
        <button className="btn" disabled={busy} onClick={() => void run("updates:quit")}>Quit Modex</button>
        <a className="btn" href={update?.url ?? "https://github.com/TypeSafeAI/modex/releases/latest"} target="_blank" rel="noreferrer">Open release page</a>
      </div>}
    </div>
  </section>;
}
