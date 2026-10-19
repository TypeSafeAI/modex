import { createContext, useContext, useState } from "react";
import { appliedPatch, type PatchCheck, type PatchFileState } from "../../../shared/evidence";
import type { ThreadItem } from "../../../shared/types";
import { bridge } from "../../bridge";
import { ErrorNotice } from "../ui/ErrorNotice";

/** The thread the transcript shows, for item actions that ask main about it. */
export const TranscriptThread = createContext<string | null>(null);

const LABELS: Record<PatchFileState, string> = {
  "as-left": "As this turn left it",
  "has-edit": "Still has this turn's edit",
  changed: "Changed since this turn",
  deleted: "Deleted since this turn",
  unknown: "Not compared",
};

/**
 * A turn's patch against the working tree now (docs/conversation-evidence.md). Main reads the files in
 * the thread's folder and answers per file; this shows those verdicts and nothing of the files.
 * Nothing is read until Compare is pressed, and nothing is written or run.
 */
export function PatchCompare({ item }: { item: Extract<ThreadItem, { kind: "tool" }> }) {
  const threadId = useContext(TranscriptThread);
  const [check, setCheck] = useState<PatchCheck | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!threadId || !appliedPatch(item)) return null;
  const compare = async () => {
    setBusy(true);
    setError(null);
    try { setCheck(await bridge.invoke("evidence:patch", { threadId, itemId: item.id })); }
    catch (err) { setError((err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "")); }
    finally { setBusy(false); }
  };
  return (
    <div className="patch-compare">
      <button type="button" className="evidence-action" data-testid="patch-compare" disabled={busy} onClick={() => void compare()}>{check ? "Check again" : "Compare with working tree"}</button>
      {check && (
        <div role="status" className="patch-check" data-testid="patch-state">
          <span className="patch-checked">Checked at {new Date(check.checkedAt).toLocaleTimeString()}</span>
          {check.files.length === 0 ? <p className="patch-file">This patch names no file to compare.</p> : (
            <ul className="patch-files">
              {check.files.map((f, i) => (
                <li key={`${f.path}:${i}`} className={`patch-file ${f.state}`} data-testid="patch-file" data-state={f.state}>
                  {f.path && <code>{f.path}</code>}
                  <span className="patch-file-state">{LABELS[f.state]}{f.reason ? `. ${f.reason}` : ""}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {error && <ErrorNotice testId="patch-error" where="Transcript · compare patch" message={error} onRetry={() => void compare()} context={{ itemId: item.id }} />}
    </div>
  );
}
