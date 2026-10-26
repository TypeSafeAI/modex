import { useEffect, useRef, useState } from "react";
import type { Capability, PrOverview } from "../../shared/code-review.js";
import { MERGE_LABELS, type MergeCheck, type MergeMethod, type WritePreview } from "../../shared/code-review-write.js";
import { Icon } from "../components/ui/Icon";
import { Tooltip } from "../components/ui/Tooltip";
import { useWrite, writeCapability } from "./ReviewComposer";
import type { Done, Writes } from "./writes.js";

/**
 * CR-7 (#326): Merge, for the head the person reviewed. Main reads GitHub when the panel opens and offers
 * only the methods the repository allows; anything it can't establish (conflicts, required reviews or
 * checks, a merge queue, unreadable settings) leaves GitHub as the way to merge. The preview names the
 * account, destination and head, and main sends that head with the merge, so a moved branch is refused.
 */
const short = (sha: string) => sha.slice(0, 8);

/** The header's Merge: opens the panel once main has answered for this account. */
export function MergeAction({ writes, overview, fallback, open, onToggle }: { writes: Writes; overview: PrOverview; fallback: Capability; open: boolean; onToggle: () => void }) {
  const capability = writeCapability(useWrite(writes, overview), fallback);
  return (
    <Tooltip label={capability.available ? "Merge" : capability.reason}>
      <button type="button" className="cr-action primary" aria-label="Merge" aria-expanded={capability.available ? open : undefined} aria-controls={capability.available ? "cr-merge-panel" : undefined}
        aria-disabled={capability.available ? undefined : "true"} data-testid="code-review-merge" onClick={(event) => { if (!capability.available) event.preventDefault(); else onToggle(); }}>
        <Icon name="branch" size={14} />
        <span className="cr-action-label">Merge</span>
      </button>
    </Tooltip>
  );
}

export function MergePanel({ writes, overview, onClose, onMerged }: { writes: Writes; overview: PrOverview; onClose: () => void; onMerged: () => void }) {
  const { key, revision } = overview;
  const [check, setCheck] = useState<Done<MergeCheck> | null>(null);
  const [method, setMethod] = useState<MergeMethod | null>(null);
  const [preview, setPreview] = useState<WritePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; url?: string | null; tone: "ok" | "error" } | null>(null);
  // A second click in the same frame, before React disables the button, must not ask main again.
  const inFlight = useRef(false);
  const once = async (work: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true);
    try { await work(); } finally { inFlight.current = false; setBusy(false); }
  };
  const look = () => once(async () => {
    setPreview(null); setMessage(null);
    const done = await writes.mergeCheck(key, revision);
    setCheck(done);
    if (done.ok && done.value.kind === "offer") { const methods = done.value.methods; setMethod((m) => m && methods.includes(m) ? m : methods[0]!); }
  });
  useEffect(() => { void look(); }, [key.account, key.repoId, key.number, revision.baseRef, revision.baseSha, revision.headSha]); // eslint-disable-line react-hooks/exhaustive-deps
  const show = () => once(async () => {
    if (!method) return;
    setMessage(null);
    const done = await writes.prepareMerge(key, revision, method);
    if (done.ok) setPreview(done.value);
    else setMessage({ text: done.detail, tone: "error" });
  });
  const submit = () => once(async () => {
    if (!preview) return;
    const done = await writes.settle("submit", key, revision, preview.intentId);
    setPreview(null);
    if (!done.ok) return setMessage({ text: done.detail, tone: "error" });
    const receipt = done.value;
    if (receipt.state === "confirmed") { setCheck(null); setMessage({ text: "Pull request merged.", url: receipt.remoteUrl, tone: "ok" }); onMerged(); }
    else if (receipt.state === "unknown") setMessage({ text: "Modex can't tell whether GitHub merged this. It won't be tried again on its own; check it under the activity.", tone: "error" });
    else setMessage({ text: receipt.reason === "denied" ? "GitHub refused this merge." : "GitHub didn't merge this pull request. It may have changed since: check again.", tone: "error" });
  });
  const back = () => once(async () => {
    if (preview) await writes.settle("cancel", key, revision, preview.intentId);
    setPreview(null);
  });
  const offer = check?.ok && check.value.kind === "offer" ? check.value : null;
  return <section id="cr-merge-panel" className="cr-merge" role="region" aria-label="Merge this pull request" data-testid="cr-merge">
    <div className="cr-merge-head"><strong>Merge</strong><span className="spacer" /><button className="btn" type="button" onClick={onClose}>Close</button></div>
    {!check && busy && <p className="cr-evidence" role="status">Checking with GitHub…</p>}
    {check && !check.ok && <p className="cr-error" role="alert">{check.detail}</p>}
    {check?.ok && check.value.kind === "unavailable" && <div data-testid="cr-merge-unavailable">
      <p>{check.value.detail}</p>
      <p><a href={check.value.url} target="_blank" rel="noreferrer">Open on GitHub</a> <button className="btn" type="button" disabled={busy} onClick={() => void look()}>Check again</button></p>
    </div>}
    {offer && !preview && <div className="cr-editor">
      <fieldset className="cr-events"><legend>Merge method</legend>{offer.methods.map((m) => <label key={m}>
        <input type="radio" name={`cr-merge-${key.number}`} value={m} checked={method === m} onChange={() => setMethod(m)} />{MERGE_LABELS[m]}
      </label>)}</fieldset>
      {offer.unstable && <p className="cr-evidence">Some checks that aren't required are failing on this head.</p>}
      <p className="cr-evidence">Merges head <code>{short(offer.revision.headSha)}</code>, the one you reviewed. Nothing is merged until you preview and confirm.</p>
      <div className="cr-compose-buttons"><button className="btn primary" type="button" disabled={busy || !method} onClick={() => void show()}>Preview merge</button></div>
    </div>}
    {preview && preview.operation.kind === "merge" && <div className="cr-preview" role="region" aria-label="Preview merge" data-testid="cr-preview-merge">
      <p><strong>Merge pull request · {MERGE_LABELS[preview.operation.method]}</strong></p>
      <p data-testid="cr-preview-destination">As <strong>{preview.account.login}</strong> on <strong>{preview.destination.owner}/{preview.destination.repo} #{preview.destination.number}</strong></p>
      <p className="cr-evidence" data-testid="cr-preview-revision">Head <code>{short(preview.revision.headSha)}</code> into <code>{preview.revision.baseRef}</code>. GitHub refuses the merge if the branch has moved.</p>
      <div className="cr-compose-buttons">
        <button className="btn primary" type="button" disabled={busy} onClick={() => void submit()}>Merge pull request</button>
        <button className="btn" type="button" disabled={busy} onClick={() => void back()}>Back</button>
      </div>
    </div>}
    {message && <p className={message.tone === "error" ? "cr-error" : "cr-evidence"} role={message.tone === "error" ? "alert" : "status"}>{message.text}{message.url && <> <a href={message.url} target="_blank" rel="noreferrer">View on GitHub</a></>}</p>}
  </section>;
}
