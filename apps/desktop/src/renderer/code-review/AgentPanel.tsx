import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Capability, PrOverview } from "../../shared/code-review.js";
import { AGENT_LIMITS } from "../../shared/code-review-agent.js";
import { Icon } from "../components/ui/Icon";
import { Tooltip } from "../components/ui/Tooltip";
import type { Agent, AgentEntry } from "./agent.js";

/**
 * CR-6 (#325): the header's Review button (C27), the gear's instructions popover (C28, R3; C56) and the
 * panel a review is started from. The panel says what will run, where it can read and what it cannot do,
 * before the person starts it; main checks all of that again itself.
 */
const CHECKING_TEXT = "Checking whether Claude Code can review here…";
const CHECKING: Capability = { available: false, reason: CHECKING_TEXT, owner: null };

export function useAgent(agent: Agent, overview: PrOverview): AgentEntry | undefined {
  const entry = useSyncExternalStore(agent.subscribe, () => agent.entry(overview.key));
  const { key } = overview;
  useEffect(() => { void agent.refresh(key); }, [agent, key.account, key.host, key.repoId, key.number]); // eslint-disable-line react-hooks/exhaustive-deps
  return entry;
}

/** Whether a review can be started: a connection, main's answer for this account, and a usable Claude Code. */
export function agentCapability(entry: AgentEntry | undefined, fallback: Capability): Capability {
  if (!fallback.available) return fallback;
  if (entry?.status) return entry.status.backend.available ? { available: true } : { available: false, reason: entry.status.backend.reason ?? "Claude Code isn't available for review runs.", owner: null };
  return entry?.error ? { available: false, reason: entry.error, owner: null } : CHECKING;
}

const short = (sha: string) => sha.slice(0, 8);

/** C27: opens the review panel. Disabled, with its reason, until main has said a run could start. */
export function ReviewButton({ agent, overview, fallback, open, onToggle }: { agent: Agent; overview: PrOverview; fallback: Capability; open: boolean; onToggle: () => void }) {
  const entry = useAgent(agent, overview);
  const capability = agentCapability(entry, fallback);
  const active = entry?.status?.runs.find((run) => run.id === entry.status?.active);
  const label = active?.state === "running" ? "Review running" : active ? "Review exit unconfirmed" : "Review with Claude";
  return <Tooltip label={capability.available ? label : capability.reason}>
    <button type="button" className="cr-action" aria-label={label} aria-expanded={open} aria-disabled={capability.available ? undefined : "true"} data-testid="code-review-review"
      onClick={(event) => { if (!capability.available) event.preventDefault(); else onToggle(); }}>
      <Icon name="review" size={14} className="cr-narrow-icon" />
      <span className="cr-action-label">{label}</span>
    </button>
  </Tooltip>;
}

/** C28 and R3: the person's standing instructions, with their scope stated where they are edited. */
export function InstructionsButton({ agent, overview, fallback }: { agent: Agent; overview: PrOverview; fallback: Capability }) {
  const entry = useAgent(agent, overview);
  const status = entry?.status ?? null;
  const capability: Capability = !fallback.available ? fallback : status ? { available: true } : entry?.error ? { available: false, reason: entry.error, owner: null } : CHECKING;
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const instructions = status?.instructions ?? null;
  const show = () => { setText(instructions?.text ?? ""); setError(null); setOpen(true); };
  const close = (focus: boolean) => { setOpen(false); if (focus) button.current?.focus(); };
  useEffect(() => {
    if (!open) return;
    popover.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
    const away = (event: MouseEvent) => { if (!popover.current?.contains(event.target as Node) && event.target !== button.current) setOpen(false); };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);
  const save = async () => {
    if (!instructions) return;
    setBusy(true);
    const done = await agent.saveInstructions(overview.key, text, instructions.version);
    setBusy(false);
    if (!done.ok) return setError(done.detail);
    close(true);
  };
  const changed = text !== (instructions?.text ?? "");
  return <span className="cr-instructions">
    <Tooltip label={capability.available ? "Review instructions" : capability.reason}>
      <button ref={button} type="button" className="cr-action icon-only" aria-label="Review instructions" aria-haspopup="dialog" aria-expanded={open} aria-disabled={capability.available ? undefined : "true"} data-testid="code-review-instructions"
        onClick={(event) => { if (!capability.available) event.preventDefault(); else if (open) close(false); else show(); }}>
        <Icon name="gear" size={14} />
      </button>
    </Tooltip>
    {open && instructions && <div ref={popover} className="cr-instructions-popover" role="dialog" aria-labelledby="cr-instructions-title" data-testid="cr-instructions"
      onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); close(true); } }}>
      <h2 id="cr-instructions-title">Review instructions</h2>
      <p className="cr-evidence" data-testid="cr-instructions-scope">Apply to every pull request you review in Modex, on any repository. Saved on this Mac only, as version {instructions.version}; each run records the version it used.</p>
      <textarea className="cr-textarea" aria-label="Review instructions" rows={6} maxLength={AGENT_LIMITS.instructions} value={text} placeholder="What the reviewer should look for, or leave out." onChange={(e) => setText(e.target.value)} />
      <p className="cr-evidence">These are given to Claude Code as your instructions, apart from the pull request's own text. They never grant it anything beyond reading the snapshot.</p>
      {error && <p className="cr-error" role="alert">{error}</p>}
      <div className="cr-compose-buttons">
        <button className="btn primary" type="button" disabled={busy || !changed} onClick={() => void save()}>Save</button>
        <button className="btn" type="button" disabled={busy} onClick={() => close(true)}>Cancel</button>
      </div>
    </div>}
  </span>;
}

/** The panel under the header: what a review run is, and its explicit Start and Stop. */
export function AgentPanel({ agent, overview, onClose, onReload }: { agent: Agent; overview: PrOverview; onClose: () => void; onReload: () => void }) {
  const entry = useAgent(agent, overview);
  const status = entry?.status ?? null;
  const [message, setMessage] = useState<{ text: string; reload?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const active = status?.runs.find((r) => r.id === status.active) ?? null;
  const model = agent.model(overview.key);
  const start = async () => {
    setBusy(true); setMessage(null);
    const done = await agent.start(overview.key, overview.revision, "review", null);
    setBusy(false);
    if (!done.ok) setMessage({ text: done.detail, reload: done.reason === "head-changed" || done.reason === "target-changed" });
  };
  const stop = async () => {
    if (!active) return;
    setBusy(true);
    const done = await agent.stop(overview.key, active.id);
    setBusy(false);
    if (!done.ok) setMessage({ text: done.detail });
  };
  return <section className="cr-merge cr-agent-panel" role="region" aria-label="Review with Claude" data-testid="cr-agent-panel">
    <div className="cr-merge-head"><strong>Review with Claude</strong><span className="spacer" /><button className="btn" type="button" onClick={onClose}>Close</button></div>
    <p data-testid="cr-agent-scope">Runs the Claude Code CLI installed on this Mac, under your Claude account, on a snapshot of this pull request's diff at head <code>{short(overview.revision.headSha)}</code>{status?.backend.version ? ` (Claude Code ${status.backend.version})` : ""}.</p>
    <p className="cr-evidence">It can only read that snapshot: no shell or network tools, no checkout, no other files, no questions back. Claude Code sends the snapshot and your review instructions to its configured inference provider under your account. Nothing it says is posted to GitHub, counted as a check or used to merge. {status ? status.instructions.text.trim() ? `Your instructions, version ${status.instructions.version}, apply.` : "You have no review instructions." : ""}</p>
    {status && <label className="cr-field cr-agent-model">Model
      <select aria-label="Model" value={model ?? ""} disabled={!!active || !status.backend.models.length} onChange={(e) => agent.setModel(overview.key, e.target.value)}>
        {status.backend.models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
      </select>
    </label>}
    {!status && <p className="cr-evidence" role="status">{entry?.error ?? CHECKING_TEXT}</p>}
    {status && !status.backend.available && <p className="cr-error" role="alert">{status.backend.reason}</p>}
    <div className="cr-compose-buttons">
      {active?.state === "unknown"
        ? <span className="cr-error" role="status">Claude Code has not confirmed its exit. Another run cannot start yet.</span>
        : active
        ? <><span className="cr-evidence" role="status">Running since {new Date(active.startedAt).toLocaleTimeString()} · {active.toolCalls} tool {active.toolCalls === 1 ? "call" : "calls"}</span>
          <button className="btn" type="button" disabled={busy} data-testid="cr-agent-stop" onClick={() => void stop()}>Stop</button></>
        : <button className="btn primary" type="button" disabled={busy || !status?.backend.available || !model} data-testid="cr-agent-start" onClick={() => void start()}>Start review</button>}
    </div>
    {message && <p className="cr-error" role="alert">{message.text}{message.reload && <> <button className="btn" type="button" onClick={onReload}>Reload</button></>}</p>}
    <p className="cr-evidence">Results appear under the description in the overview, bound to the head they were made for.</p>
  </section>;
}
