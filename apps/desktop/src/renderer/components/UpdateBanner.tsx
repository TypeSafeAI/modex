import { useState } from "react";
import type { UpdateController } from "../useUpdateState";
import { Icon } from "./ui/Icon";

const DISMISSED = "modex.dismissedUpdate";
export function UpdateBanner({ update, installation, busy, error, run }: UpdateController) {
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem(DISMISSED); } catch { return null; }
  });
  const phase = installation?.phase;
  const preparing = phase === "checking" || phase === "downloading" || phase === "verifying" || phase === "cancelling";
  const recover = phase === "preparing" || phase === "staged" || phase === "uncertain" || phase === "recovery";
  // A dismissed ready update still installs the next time Modex quits.
  if (!update || recover || (update.version === dismissed && !preparing && phase !== "error")) return null;
  const dismiss = () => {
    setDismissed(update.version);
    try { localStorage.setItem(DISMISSED, update.version); } catch { /* Keep this session dismissible without storage. */ }
  };
  return <aside className="update-banner" data-testid="update-banner" aria-label="Modex update">
    <span className="update-banner-icon"><Icon name="download" /></span>
    <div className="update-banner-copy" role="status">
      <strong>Modex {update.version} {phase === "ready" ? "is ready to install" : "is available"}</strong>
      <span>{error ?? installation?.message ?? (phase === "ready" ? "Restart now, or it installs the next time you quit. Your work is saved first."
        : phase === "checking" ? "Checking the latest release…" : phase === "downloading" ? "Downloading the update…"
        : phase === "verifying" ? "Verifying the publisher and update…" : phase === "cancelling" ? "Cancelling download…"
        : installation?.installable ? "Download it to install with one click." : "See what’s new and download the latest version.")}</span>
      {phase === "error" && installation?.detail && <small className="update-banner-detail" data-testid="update-error-detail">{installation.detail}</small>}
      {phase === "downloading" && <progress aria-label="Update download" max={installation?.total || 1} value={installation?.received ?? 0} />}
    </div>
    <div className="update-banner-actions">
      {installation?.installable && (phase === "available" || phase === "error") && <button className="btn small" disabled={busy} onClick={() => void run("updates:download")}>Download update</button>}
      {phase === "ready" && <button className="btn small" disabled={busy} onClick={() => void run("updates:install")}>Restart to update</button>}
      {preparing && <button className="btn small" disabled={busy || phase === "cancelling"} onClick={() => void run("updates:cancel")}>Cancel download</button>}
      <a href={update.url} target="_blank" rel="noreferrer">What’s new <Icon name="arrow-right" size={14} /></a>
    </div>
    {!preparing && <button type="button" className="icon-btn" aria-label="Dismiss update notification" onClick={dismiss}><Icon name="close" /></button>}
  </aside>;
}
