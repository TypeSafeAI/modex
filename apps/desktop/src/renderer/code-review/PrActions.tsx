import { useEffect, useRef, useState } from "react";
import type { Capability, PrOverview } from "../../shared/code-review.js";
import { WRITE_LIMITS, type PrAction, type PrStateChange, type WritePreview } from "../../shared/code-review-write.js";
import { Icon } from "../components/ui/Icon";
import { Markdown } from "../components/Markdown";
import { useWrite, writeCapability } from "./ReviewComposer";
import { STATE_LABELS } from "./text.js";
import type { Writes } from "./writes.js";

/**
 * CR-7 decisions 2–4 (#326, Val, 2026-10-25): the state menu (C21), editing the title and description (C31,
 * C35) and requesting reviewers (C38, C43). Each is previewed with where it goes and as whom, and confirmed
 * once; main checks permission and the PR's current state at preview and again before sending. An edit
 * names the text it replaces, so main refuses it if someone else changed that text meanwhile.
 */
const short = (sha: string) => sha.slice(0, 8);

const STATE_ACTIONS: Record<PrStateChange, string> = { closed: "Close pull request", open: "Reopen pull request", draft: "Convert to draft", ready: "Ready for review" };

/** What a preview's confirm button says, and the one-line summary of the change. */
export function describe(action: PrAction): { title: string; confirm: string } {
  if (action.kind === "state") return { title: STATE_ACTIONS[action.to], confirm: STATE_ACTIONS[action.to] };
  if (action.kind === "edit") return { title: action.title !== null && action.body !== null ? "Edit the title and description" : action.title !== null ? "Edit the title" : "Edit the description", confirm: "Save changes" };
  return { title: `Request review from ${action.logins.join(", ")}`, confirm: "Request review" };
}

type Message = { text: string; tone: "ok" | "error" };

/**
 * Prepare → preview → confirm, once. A second click in the same frame never asks main again. When GitHub's PR
 * has moved on (`refresh`), it is read again so the person starts from what is there now.
 */
function useActionFlow(writes: Writes, overview: PrOverview, done: string, onDone: () => void, refresh: () => void = onDone) {
  const { key, revision } = overview;
  const [preview, setPreview] = useState<WritePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const inFlight = useRef(false);
  const once = async (work: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true);
    try { await work(); } finally { inFlight.current = false; setBusy(false); }
  };
  return {
    preview, busy, message,
    prepare: (action: PrAction) => once(async () => {
      setMessage(null);
      const result = await writes.prepareAction(key, revision, action);
      if (result.ok) return setPreview(result.value);
      setMessage({ text: result.detail, tone: "error" });
      if (["edit-conflict", "state-conflict", "head-changed", "target-changed"].includes(result.reason)) refresh();
    }),
    confirm: () => once(async () => {
      if (!preview) return;
      const result = await writes.settle("submit", key, revision, preview.intentId);
      setPreview(null);
      if (!result.ok) return setMessage({ text: result.detail, tone: "error" });
      const receipt = result.value;
      if (receipt.state === "confirmed") { setMessage({ text: done, tone: "ok" }); onDone(); }
      else if (receipt.state === "unknown") setMessage({ text: "Modex can't tell whether GitHub made this change. It won't be tried again on its own; check it under the activity.", tone: "error" });
      else setMessage({ text: receipt.reason === "denied" ? "GitHub refused this change." : "GitHub didn't make this change. The pull request may have changed: check it and try again.", tone: "error" });
    }),
    back: () => once(async () => {
      if (preview) await writes.settle("cancel", key, revision, preview.intentId);
      setPreview(null);
    }),
  };
}

function ActionPreview({ preview, busy, confirm, back }: { preview: WritePreview; busy: boolean; confirm: () => void; back: () => void }) {
  const action = preview.operation as PrAction;
  const { title, confirm: label } = describe(action);
  return <div className="cr-preview" role="region" aria-label={`Preview: ${title}`} data-testid="cr-preview-action">
    <p><strong>{title}</strong></p>
    <p data-testid="cr-preview-destination">As <strong>{preview.account.login}</strong> on <strong>{preview.destination.owner}/{preview.destination.repo} #{preview.destination.number}</strong></p>
    <p className="cr-evidence" data-testid="cr-preview-revision">Head <code>{short(preview.revision.headSha)}</code> into <code>{preview.revision.baseRef}</code></p>
    {action.kind === "edit" && action.title !== null && <p>Title: <strong>{action.title}</strong></p>}
    {action.kind === "edit" && action.body !== null && (action.body.trim() ? <Markdown text={action.body} /> : <p className="cr-evidence">The description will be empty.</p>)}
    <div className="cr-compose-buttons">
      <button className="btn primary" type="button" disabled={busy} onClick={confirm}>{label}</button>
      <button className="btn" type="button" disabled={busy} onClick={back}>Back</button>
    </div>
  </div>;
}

function Note({ message }: { message: Message | null }) {
  return message ? <p className={message.tone === "error" ? "cr-error" : "cr-evidence"} role={message.tone === "error" ? "alert" : "status"}>{message.text}</p> : null;
}

/** The changes a PR in this state may make. A merged PR makes none. */
function changes(state: PrOverview["state"]): PrStateChange[] {
  return state === "open" ? ["draft", "closed"] : state === "draft" ? ["ready", "closed"] : state === "closed" ? ["open"] : [];
}

/** C21: the header's state pill, as a menu once main has answered for this account. */
export function StateMenu({ writes, overview, fallback, onPick }: { writes: Writes; overview: PrOverview; fallback: Capability; onPick: (to: PrStateChange) => void }) {
  const capability = writeCapability(useWrite(writes, overview), fallback);
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const options = changes(overview.state);
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLButtonElement>("[role=menuitem]")?.focus();
    const close = (event: MouseEvent) => { if (!menu.current?.parentElement?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const pill = <><Icon name="pull-request" size={14} />{STATE_LABELS[overview.state]}</>;
  if (!capability.available || !options.length) return <span className={`cr-state cr-state-${overview.state}`} data-testid="code-review-state" title={capability.available ? undefined : capability.reason}>{pill}</span>;
  return <span className="cr-state-menu">
    <button type="button" className={`cr-state cr-state-${overview.state}`} data-testid="code-review-state" aria-haspopup="menu" aria-expanded={open}
      aria-label={`${STATE_LABELS[overview.state]}: change state`} onClick={() => setOpen((v) => !v)}>{pill}</button>
    {open && <div ref={menu} className="cr-state-options" role="menu" aria-label="Change state" onKeyDown={(event) => {
      if (event.key === "Escape") { setOpen(false); (menu.current?.previousElementSibling as HTMLElement | null)?.focus(); }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=menuitem]")];
        const i = items.indexOf(document.activeElement as HTMLButtonElement);
        items[(i + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
        event.preventDefault();
      }
    }}>
      {options.map((to) => <button key={to} type="button" role="menuitem" className="cr-state-option" onClick={() => { setOpen(false); onPick(to); }}>{STATE_ACTIONS[to]}</button>)}
    </div>}
  </span>;
}

/** C21's change, previewed under the header. */
export function StatePanel({ writes, overview, to, onClose, onDone }: { writes: Writes; overview: PrOverview; to: PrStateChange; onClose: () => void; onDone: () => void }) {
  const flow = useActionFlow(writes, overview, `${STATE_ACTIONS[to]}: done.`, onDone);
  useEffect(() => { void flow.prepare({ kind: "state", to }); }, [to]); // eslint-disable-line react-hooks/exhaustive-deps
  return <section className="cr-merge" role="region" aria-label="Change pull request state" data-testid="cr-state-panel">
    <div className="cr-merge-head"><strong>{STATE_ACTIONS[to]}</strong><span className="spacer" /><button className="btn" type="button" onClick={onClose}>Close</button></div>
    {!flow.preview && flow.busy && <p className="cr-evidence" role="status">Checking with GitHub…</p>}
    {flow.preview && <ActionPreview preview={flow.preview} busy={flow.busy} confirm={() => void flow.confirm()} back={() => { void flow.back(); onClose(); }} />}
    <Note message={flow.message} />
  </section>;
}

/** C31 and C35: the title and description, edited here, saved only after a preview. */
export function EditPullRequest({ writes, overview, fallback, onDone }: { writes: Writes; overview: PrOverview; fallback: Capability; onDone: () => void }) {
  const capability = writeCapability(useWrite(writes, overview), fallback);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(overview.title);
  const [body, setBody] = useState(overview.body);
  // The text the edit replaces: what this pane read, not what GitHub has now.
  const [expected, setExpected] = useState({ title: overview.title, body: overview.body });
  const flow = useActionFlow(writes, overview, "Pull request updated.", () => { setOpen(false); onDone(); }, onDone);
  const start = () => { setTitle(overview.title); setBody(overview.body); setExpected({ title: overview.title, body: overview.body }); setOpen(true); };
  const changed = { title: title !== expected.title, body: body !== expected.body };
  const valid = title.trim().length > 0 && title.length <= WRITE_LIMITS.title && !/[\r\n]/.test(title);
  if (!open) return <>
    <button className="btn" type="button" aria-disabled={!capability.available || undefined} title={capability.available ? "Edit pull request" : capability.reason}
      onClick={capability.available ? start : undefined}>Edit pull request</button>
    <Note message={flow.message} />
  </>;
  return <section className="cr-composer" aria-label="Edit pull request" data-testid="cr-edit">
    {flow.preview ? <ActionPreview preview={flow.preview} busy={flow.busy} confirm={() => void flow.confirm()} back={() => void flow.back()} />
      : <div className="cr-editor">
        <label className="cr-field">Title<input className="cr-input" type="text" value={title} maxLength={WRITE_LIMITS.title} onChange={(e) => setTitle(e.target.value.replace(/[\r\n]+/g, " "))} /></label>
        <label className="cr-field">Description<textarea className="cr-textarea" rows={8} maxLength={WRITE_LIMITS.body} value={body} onChange={(e) => setBody(e.target.value)} /></label>
        <p className="cr-evidence">Nothing changes on GitHub until you preview and save. If someone else edits this pull request first, Modex won't overwrite it.</p>
        <div className="cr-compose-buttons">
          <button className="btn primary" type="button" disabled={flow.busy || !valid || (!changed.title && !changed.body)}
            onClick={() => void flow.prepare({ kind: "edit", title: changed.title ? title : null, body: changed.body ? body : null, expected })}>Preview changes</button>
          <button className="btn" type="button" disabled={flow.busy} onClick={() => setOpen(false)}>Cancel</button>
        </div>
      </div>}
    <Note message={flow.message} />
  </section>;
}

/** C38 and C43: request reviews by login. GitHub decides who may review; main refuses the author and you. */
export function RequestReviewers({ writes, overview, fallback, onDone }: { writes: Writes; overview: PrOverview; fallback: Capability; onDone: () => void }) {
  const capability = writeCapability(useWrite(writes, overview), fallback);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const flow = useActionFlow(writes, overview, "Review requested.", () => { setOpen(false); setText(""); onDone(); }, onDone);
  const logins = [...new Set(text.split(/[\s,]+/).map((l) => l.replace(/^@/, "")).filter(Boolean))];
  const valid = logins.length > 0 && logins.length <= WRITE_LIMITS.reviewers && logins.every((l) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(l));
  if (!open) return <>
    <button className="btn" type="button" aria-disabled={!capability.available || undefined} title={capability.available ? "Request reviewers" : capability.reason}
      onClick={capability.available ? () => setOpen(true) : undefined}>Request reviewers</button>
    <Note message={flow.message} />
  </>;
  return <div className="cr-reviewers" data-testid="cr-reviewers">
    {flow.preview ? <ActionPreview preview={flow.preview} busy={flow.busy} confirm={() => void flow.confirm()} back={() => void flow.back()} />
      : <>
        <label className="cr-field">Reviewer logins<input className="cr-input" type="text" value={text} placeholder="grace, lin" onChange={(e) => setText(e.target.value)} /></label>
        <div className="cr-compose-buttons">
          <button className="btn primary" type="button" disabled={flow.busy || !valid} onClick={() => void flow.prepare({ kind: "reviewers", logins })}>Preview request</button>
          <button className="btn" type="button" disabled={flow.busy} onClick={() => setOpen(false)}>Cancel</button>
        </div>
      </>}
    <Note message={flow.message} />
  </div>;
}
