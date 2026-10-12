import { useState } from "react";
import type { NativeDraftReadOnlyOpen } from "../../shared/native-drafts";
import type { Attachment } from "../../shared/attachments";
import { bridge } from "../bridge";
import { SecretTextarea } from "../streamer";

export function UpdateRecoveryView({ recovery: { drafts, pending, recovery } }: { recovery: NativeDraftReadOnlyOpen }) {
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const run = async (channel: "updates:quit" | "updates:recovery-folder") => {
    setBusy(true); setError(undefined);
    try { await bridge.invoke(channel, undefined); }
    catch { setError("The action could not finish. Your recovery files are preserved. Try again."); }
    finally { setBusy(false); }
  };
  const version = recovery.targetVersion;
  const url = version && /^\d+\.\d+\.\d+$/.test(version)
    ? `https://github.com/TypeSafeAI/modex/releases/tag/v${version}` : "https://github.com/TypeSafeAI/modex/releases/latest";
  const saved = (label: string, text: string, files: Attachment[], key: string) => <div className="update-recovery-draft" key={key}>
    <label>{label}<SecretTextarea readOnly aria-label={label} value={text} rows={3} /></label>
    {files.length > 0 && <ul aria-label={`Attachments for ${label}`}>{files.map(file => <li key={file.id}>{file.name}</li>)}</ul>}
  </div>;
  return <section className="update-recovery" data-testid="update-recovery" data-restart-controls aria-label="Update recovery">
    <div className="update-recovery-content">
      <h1>Recover your saved work</h1>
      <p role="status">{recovery.message}</p>
      {drafts && <div className="update-recovery-drafts">
        <h2>Saved drafts</h2><p>You can select and copy this text. Editing resumes after recovery.</p>
        {drafts.projects.map(draft => saved(`New chat draft for ${draft.projectId}`, draft.text, draft.attachments, draft.key))}
        {drafts.threads.map(draft => saved(`Draft for ${draft.threadId}`, draft.text, draft.attachments, draft.threadId))}
      </div>}
      {pending.length > 0 && <div className="update-recovery-drafts">
        <h2>Saved messages</h2><p>These original messages have been preserved. They will not be sent automatically.</p>
        {pending.map(record => saved(`Saved message ${record.id}`, record.rawText, record.files, record.id))}
      </div>}
      {error && <p role="alert">{error}</p>}
      <div className="update-recovery-actions">
        <button className="btn" disabled={busy} onClick={() => void run("updates:quit")}>Quit Modex</button>
        <a className="btn" href={url} target="_blank" rel="noreferrer">Open release page</a>
        <button className="btn" disabled={busy} onClick={() => void run("updates:recovery-folder")}>Open recovery folder</button>
      </div>
    </div>
  </section>;
}
