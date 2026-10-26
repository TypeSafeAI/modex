import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Capability, LineAnchor, PrOverview } from "../../shared/code-review.js";
import { REFUSALS, type ReviewEvent, type WriteInline, type WriteKind, type WritePreview, type WriteReceipt, type WriteStatus } from "../../shared/code-review-write.js";
import { Markdown } from "../components/Markdown";
import { anchorState } from "./patch.js";
import type { Done, WriteEntry, Writes } from "./writes.js";

/**
 * CR-7 (#326): comments and reviews, written here and kept as local drafts until the person previews one
 * and submits that preview. The preview shows exactly where it goes, as whom, and for which head; main
 * checks all of it again before anything is sent. A send main can't confirm stays on screen, unsent again.
 */
const CHECKING: Capability = { available: false, reason: "Checking what this account can do here…", owner: null };
const EVENTS: { event: ReviewEvent; label: string }[] = [
  { event: "COMMENT", label: "Comment" }, { event: "APPROVE", label: "Approve" }, { event: "REQUEST_CHANGES", label: "Request changes" },
];
const OUTCOME: Record<string, string> = {
  denied: "GitHub refused this. The draft is kept.",
  failed: "GitHub didn't accept this. The draft is kept.",
  cancelled: "Preview discarded.",
  restart: "That preview ended when Modex restarted.",
  abandoned: "No longer tracked. It may still appear on GitHub.",
};

export function useWrite(writes: Writes, overview: PrOverview) {
  const entry = useSyncExternalStore(writes.subscribe, () => writes.entry(overview.key, overview.revision));
  const { key, revision } = overview;
  useEffect(() => { void writes.refresh(key, revision); }, [writes, key.account, key.repoId, key.number, revision.baseRef, revision.baseSha, revision.headSha]); // eslint-disable-line react-hooks/exhaustive-deps
  return entry;
}

const short = (sha: string) => sha.slice(0, 8);
const noun = (kind: WriteKind) => kind === "comment" ? "comment" : "review";
/** What a send in doubt was, in the sentence "Modex can't tell whether GitHub …". */
const DOUBT: Record<WriteReceipt["operation"]["kind"], string> = {
  comment: "received a comment", review: "received a review", merge: "merged this pull request",
  state: "changed this pull request's state", edit: "saved this edit", reviewers: "requested these reviewers",
};

/** The comment and review composers, and any send still in doubt, under the activity. */
export function ReviewComposer({ writes, overview, fallback }: { writes: Writes; overview: PrOverview; fallback: Capability }) {
  const entry = useWrite(writes, overview);
  const status = entry?.status ?? null;
  const doubtful = status?.receipts.filter((r) => r.state === "unknown") ?? [];
  const capability = writeCapability(entry, fallback);
  // A hint from what was read; main refuses a self-review itself at preview and at submit.
  const own = !!status && overview.author.id === status.account.id;
  const approve: Capability = own ? { available: false, reason: REFUSALS["self-review"], owner: null } : { available: true };
  return <div className="cr-compose" data-testid="cr-compose">
    {doubtful.map((receipt) => <Doubt key={receipt.id} receipt={receipt} writes={writes} overview={overview} />)}
    <Composer kind="comment" writes={writes} overview={overview} status={status} capability={capability} blocked={doubtful.length > 0} />
    <Composer kind="review" writes={writes} overview={overview} status={status} capability={capability} approve={approve} blocked={doubtful.length > 0} />
  </div>;
}

/** Whether the composers can be used at all: a connection, and main's answer for this account. Permission is checked when previewing. */
export function writeCapability(entry: WriteEntry | undefined, fallback: Capability): Capability {
  if (!fallback.available) return fallback;
  if (entry?.status) return { available: true };
  return entry?.error ? { available: false, reason: entry.error, owner: null } : CHECKING;
}

function Composer({ kind, writes, overview, status, capability, approve, blocked }: { kind: WriteKind; writes: Writes; overview: PrOverview; status: WriteStatus | null; capability: Capability; approve?: Capability; blocked: boolean }) {
  const { key, revision } = overview;
  const draft = status?.drafts[kind];
  const pendingBody = writes.pendingBody(key, revision, kind);
  const [open, setOpen] = useState(pendingBody !== undefined);
  const [text, setTextState] = useState(pendingBody ?? draft?.body ?? "");
  // The latest text, for a debounced save that runs after the render it was scheduled in.
  const latest = useRef(text);
  const setText = (value: string) => { latest.current = value; setTextState(value); };
  const [event, setEvent] = useState<ReviewEvent>("COMMENT");
  const [preview, setPreview] = useState<WritePreview | null>(null);
  const [message, setMessage] = useState<{ text: string; url?: string | null; tone: "ok" | "error" } | null>(null);
  const [busy, setBusy] = useState(false);
  const saved = useRef(draft?.body ?? "");
  // A second click in the same frame, before React disables the button, must not ask main again.
  const inFlight = useRef(false);
  // Main's newer draft (another pane, a cleared send) replaces the text unless the person has typed since.
  useEffect(() => {
    const body = draft?.body ?? "";
    if (latest.current === saved.current) setText(body);
    saved.current = body;
    if (draft && (draft.body.trim() || draft.comments.length)) setOpen(true);
  }, [draft?.version]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => {
    if (writes.pendingBody(key, revision, kind) !== undefined) void writes.flushBody(key, revision, kind);
  }, [writes, key.account, key.host, key.repoId, key.number, revision.baseRef, revision.baseSha, revision.headSha, kind]);
  const comments = draft?.comments ?? [];
  const flush = async (): Promise<number | null> => {
    const done = await writes.flushBody(key, revision, kind);
    if (!done.ok) { setMessage({ text: done.detail, tone: "error" }); return null; }
    saved.current = done.value.body;
    return done.value.version;
  };
  const edit = (value: string) => {
    setText(value); setMessage(null);
    writes.editBody(key, revision, kind, value);
  };
  const removeComment = async (index: number) => {
    const done = await writes.save(key, revision, kind, latest.current, comments.filter((_, i) => i !== index));
    if (done.ok) saved.current = done.value.body;
  };
  const show = async () => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setMessage(null);
    const version = await flush();
    const done = version === null ? null : await writes.prepare(key, revision, kind === "comment" ? { kind } : { kind, event }, version);
    inFlight.current = false; setBusy(false);
    if (done && !done.ok) setMessage({ text: done.detail, tone: "error" });
    else if (done) setPreview(done.value);
  };
  const submit = async () => {
    if (!preview || inFlight.current) return;
    inFlight.current = true; setBusy(true);
    const done = await writes.settle("submit", key, revision, preview.intentId);
    inFlight.current = false; setBusy(false); setPreview(null);
    report(done, setMessage, kind);
  };
  const back = async () => {
    if (preview) await writes.settle("cancel", key, revision, preview.intentId);
    setPreview(null);
  };
  const earlier = !draft?.body.trim() && !comments.length ? status?.earlier.find((d) => d.kind === kind && d.bodyLength > 0) : undefined;
  const label = kind === "comment" ? "Comment" : "Review";
  const unavailable = !capability.available || blocked;
  const reason = !capability.available ? capability.reason : "Resolve the send above first.";
  return <section className="cr-composer" aria-label={kind === "comment" ? "Comment on this pull request" : "Review this pull request"} data-testid={`cr-composer-${kind}`}>
    {!open ? <div className="cr-comment-slot">
      <p>{kind === "comment" ? "Comment on this pull request" : "Review the changes"}</p>
      <button className="btn" type="button" aria-disabled={unavailable || undefined} title={unavailable ? reason : label} onClick={unavailable ? undefined : () => setOpen(true)}>{label}</button>
      {unavailable && <p className="cr-evidence">{reason}</p>}
    </div> : preview ? <div className="cr-preview" role="region" aria-label={`Preview ${noun(kind)}`} data-testid={`cr-preview-${kind}`}>
      <p><strong>{kind === "comment" ? "Post a comment" : `Submit a review · ${EVENTS.find((e) => e.event === (preview.operation.kind === "review" ? preview.operation.event : "COMMENT"))!.label}`}</strong></p>
      <p data-testid="cr-preview-destination">As <strong>{preview.account.login}</strong> on <strong>{preview.destination.owner}/{preview.destination.repo} #{preview.destination.number}</strong></p>
      <p className="cr-evidence" data-testid="cr-preview-revision">Head <code>{short(preview.revision.headSha)}</code> into <code>{preview.revision.baseRef}</code>{preview.comments ? ` · ${preview.comments} line ${preview.comments === 1 ? "comment" : "comments"}` : ""}</p>
      {preview.body.trim() ? <Markdown text={preview.body} /> : <p className="cr-evidence">No summary.</p>}
      {preview.inlineComments.length > 0 && <ul className="cr-line-comments" aria-label="Line comments to submit">{preview.inlineComments.map((c, i) => <li key={i}>
        <span><bdi dir="ltr">{c.path}</bdi> · {c.side} {c.start}{c.end > c.start ? `–${c.end}` : ""}</span>
        <Markdown text={c.body} />
      </li>)}</ul>}
      <div className="cr-compose-buttons">
        <button className="btn primary" type="button" disabled={busy} onClick={() => void submit()}>{kind === "comment" ? "Post comment" : "Submit review"}</button>
        <button className="btn" type="button" disabled={busy} onClick={() => void back()}>Back to editing</button>
      </div>
    </div> : <div className="cr-editor">
      {earlier && <p className="cr-evidence" data-testid={`cr-earlier-${kind}`}>A draft from an earlier revision (head <code>{short(earlier.revision.headSha)}</code>) is kept.{earlier.comments ? " Its line comments refer to that revision and stay with it." : ""} <button className="btn" type="button" onClick={() => void writes.carry(key, revision, kind, earlier.revision)}>Use its text</button></p>}
      {kind === "review" && <fieldset className="cr-events"><legend>Review</legend>{EVENTS.map(({ event: value, label: text }) => {
        const off = value !== "COMMENT" && approve && !approve.available;
        return <label key={value} title={off ? approve!.reason : undefined}><input type="radio" name={`cr-event-${overview.key.number}`} value={value} checked={event === value} disabled={off} onChange={() => setEvent(value)} />{text}</label>;
      })}</fieldset>}
      <textarea className="cr-textarea" aria-label={kind === "comment" ? "Comment text" : "Review summary"} rows={4} maxLength={65_536} value={text} onChange={(e) => edit(e.target.value)} placeholder={kind === "comment" ? "Leave a comment" : "Summarize your review (optional when approving)"} />
      {kind === "review" && comments.length > 0 && <ul className="cr-line-comments" aria-label="Line comments">{comments.map((c, i) => <li key={`${c.anchor.path}:${c.anchor.side}:${c.anchor.start}:${i}`}>
        <span><bdi dir="ltr">{c.anchor.path}</bdi> · {c.anchor.side} {c.anchor.start}{c.anchor.end > c.anchor.start ? `–${c.anchor.end}` : ""}{anchorState(c.anchor, overview.key, overview.revision) === "outdated" ? " · Outdated" : ""}</span>
        <p>{c.body}</p><button className="btn" type="button" aria-label={`Remove line comment on ${c.anchor.path}`} onClick={() => void removeComment(i)}>Remove</button>
      </li>)}</ul>}
      <p className="cr-evidence">{pendingBody === undefined ? "Saved on this Mac only." : "Saving draft on this Mac…"} Nothing is sent until you preview and submit it.</p>
      {writes.bodyError(key, revision, kind) && <p role="alert">{writes.bodyError(key, revision, kind)}</p>}
      <div className="cr-compose-buttons">
        <button className="btn primary" type="button" disabled={busy || unavailable} title={unavailable ? reason : undefined} onClick={() => void show()}>{kind === "comment" ? "Preview comment" : "Preview review"}</button>
      </div>
      {unavailable && <p className="cr-evidence">{reason}</p>}
    </div>}
    {message && <p className={message.tone === "error" ? "cr-error" : "cr-evidence"} role={message.tone === "error" ? "alert" : "status"}>{message.text}{message.url && <> <a href={message.url} target="_blank" rel="noreferrer">View on GitHub</a></>}</p>}
  </section>;
}

function report(done: Done<WriteReceipt>, setMessage: (m: { text: string; url?: string | null; tone: "ok" | "error" }) => void, kind: WriteKind): void {
  if (!done.ok) return setMessage({ text: done.detail, tone: "error" });
  const receipt = done.value;
  if (receipt.state === "confirmed") setMessage({ text: kind === "comment" ? "Comment posted." : "Review submitted.", url: receipt.remoteUrl, tone: "ok" });
  else if (receipt.state === "unknown") setMessage({ text: "Modex can't tell whether GitHub received this. It won't be sent again on its own.", tone: "error" });
  else setMessage({ text: OUTCOME[receipt.reason ?? "failed"] ?? OUTCOME.failed!, tone: "error" });
}

/** A send whose outcome is unknown: Modex checks GitHub for it, or the person stops tracking it. Never a resend. */
function Doubt({ receipt, writes, overview }: { receipt: WriteReceipt; writes: Writes; overview: PrOverview }) {
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const act = async (op: "reconcile" | "abandon") => {
    setBusy(true);
    const done = await writes.settle(op, overview.key, overview.revision, receipt.id);
    setBusy(false);
    if (!done.ok) return setNote(done.detail);
    if (op === "reconcile" && done.value.state === "unknown") setNote("Modex didn't find it on GitHub. That doesn't prove it wasn't sent.");
  };
  return <div className="cr-doubt" role="alert" data-testid="cr-doubt">
    <p><strong>Modex can't tell whether GitHub {DOUBT[receipt.operation.kind]}</strong> (head <code>{short(receipt.revision.headSha)}</code>). It won't be sent again on its own.</p>
    <div className="cr-compose-buttons">
      <button className="btn" type="button" disabled={busy} onClick={() => void act("reconcile")}>Check GitHub</button>
      <button className="btn" type="button" disabled={busy} onClick={() => void act("abandon")}>Stop tracking</button>
    </div>
    <p className="cr-evidence">Stop tracking only if you've checked GitHub yourself. It may still appear there.</p>
    {note && <p className="cr-evidence" role="status">{note}</p>}
  </div>;
}

/** Changes' line anchor, offered as a line comment on the review draft. An outdated anchor is never added. */
export function LineComment({ writes, overview, anchor }: { writes: Writes; overview: PrOverview; anchor: LineAnchor }) {
  const entry = useWrite(writes, overview);
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (anchorState(anchor, overview.key, overview.revision) === "outdated") return null;
  if (!entry?.status) return entry?.error ? <span className="cr-evidence">{entry.error}</span> : null;
  const add = async () => {
    const draft = entry!.status!.drafts.review;
    const comments: WriteInline[] = [...(draft?.comments ?? []), { anchor, body: text }];
    const done = await writes.save(overview.key, overview.revision, "review", draft?.body ?? "", comments);
    if (!done.ok) return setError(done.detail);
    setText(""); setOpen(false); setError(null);
  };
  return !open ? <button className="btn" type="button" onClick={() => setOpen(true)}>Comment on this line</button>
    : <span className="cr-line-composer">
      <textarea className="cr-textarea" aria-label="Line comment" rows={2} value={text} onChange={(e) => setText(e.target.value)} />
      <button className="btn primary" type="button" disabled={!text.trim()} onClick={() => void add()}>Add to review</button>
      <button className="btn" type="button" onClick={() => setOpen(false)}>Cancel</button>
      {error && <span className="cr-error" role="alert">{error}</span>}
    </span>;
}
