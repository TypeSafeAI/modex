import { useState } from "react";
import type { Capability, PrOverview } from "../../shared/code-review.js";
import { AGENT_LIMITS, RUN_REASONS, SEVERITY_LABELS, type AgentFinding, type AgentRun } from "../../shared/code-review-agent.js";
import type { WriteInline } from "../../shared/code-review-write.js";
import { Markdown } from "../components/Markdown";
import type { Agent } from "./agent.js";
import { agentCapability, useAgent } from "./AgentPanel";
import { useWrite } from "./ReviewComposer";
import type { Writes } from "./writes.js";

/**
 * CR-6 (#325): what the agent said, shown as the model's claims about one head, never as evidence. A finding
 * main could anchor in the diff may be copied into the review draft, where CR-7's preview and submit still
 * stand between it and GitHub. The question composer (C57) starts a run the same way the panel does.
 */
const short = (sha: string) => sha.slice(0, 8);
const STATES: Record<AgentRun["state"], string> = { running: "Running", completed: "Completed", failed: "Failed", stopped: "Stopped", unknown: "Unknown" };
const REFERENCE: Record<AgentFinding["reference"], string> = { anchored: "In the diff", unverified: "Not found in the diff", none: "No location given" };

export function AgentReview({ agent, overview, writes, fallback }: { agent: Agent; overview: PrOverview; writes: Writes; fallback: Capability }) {
  const entry = useAgent(agent, overview);
  const capability = agentCapability(entry, fallback);
  const status = entry?.status ?? null;
  const [shown, setShown] = useState(3);
  const runs = status?.runs ?? [];
  if (!fallback.available) return null;
  return <section className="cr-agent" data-testid="cr-agent" aria-labelledby="cr-agent-heading">
    <div className="cr-section-heading"><h2 id="cr-agent-heading">Claude's review</h2></div>
    <p className="cr-evidence">What Claude Code said about a snapshot of this pull request, on this Mac. Claims about the code, not checks: nothing here approves, merges or is sent to GitHub.</p>
    {!status && <p className="cr-evidence" role="status">{entry?.error ?? "Checking whether Claude Code can review here…"}</p>}
    {status && !runs.length && <p className="cr-evidence">No runs yet for this pull request.</p>}
    {runs.slice(0, shown).map((run) => <Run key={run.id} run={run} agent={agent} overview={overview} writes={writes} />)}
    {runs.length > shown && <button className="btn" type="button" onClick={() => setShown(runs.length)}>Show all {runs.length} runs</button>}
    <AskComposer agent={agent} overview={overview} capability={capability} active={!!status?.active} />
  </section>;
}

function Run({ run, agent, overview, writes }: { run: AgentRun; agent: Agent; overview: PrOverview; writes: Writes }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const outdated = run.revision.headSha !== overview.revision.headSha || run.revision.baseSha !== overview.revision.baseSha;
  const total = run.coverage.filesTotal ?? run.coverage.included.length + run.coverage.omitted.length;
  const stop = async () => {
    setBusy(true);
    const done = await agent.stop(overview.key, run.id);
    setBusy(false);
    if (!done.ok) setNote(done.detail);
  };
  return <article className={`cr-agent-run cr-agent-${run.state}`} data-testid="cr-agent-run" data-run-state={run.state} data-run-id={run.id}>
    <header className="cr-agent-run-head">
      <strong>{run.kind === "review" ? "Review" : "Question"}</strong>
      <span className="cr-agent-state" data-testid="cr-agent-run-state">{STATES[run.state]}</span>
      {outdated && <span className="cr-agent-outdated" data-testid="cr-agent-outdated">Outdated · made for head {short(run.revision.headSha)}</span>}
      <span className="cr-evidence">{run.backend.model} · instructions v{run.instructionsVersion} · <time dateTime={run.startedAt}>{new Date(run.startedAt).toLocaleString()}</time></span>
    </header>
    {run.question && <blockquote className="cr-agent-question">{run.question}</blockquote>}
    {run.state === "running" && <p className="cr-evidence" role="status">Running · {run.toolCalls} tool {run.toolCalls === 1 ? "call" : "calls"} so far <button className="btn" type="button" disabled={busy} onClick={() => void stop()}>Stop</button></p>}
    {run.reason && <p className={run.state === "stopped" ? "cr-evidence" : "cr-error"} role={run.state === "stopped" ? undefined : "alert"} data-testid="cr-agent-run-reason">{RUN_REASONS[run.reason]}{run.detail ? ` ${run.detail}` : ""}</p>}
    {note && <p className="cr-error" role="alert">{note}</p>}
    <details className="cr-agent-coverage">
      <summary data-testid="cr-agent-coverage">{run.coverage.included.length} of {total} changed files in the snapshot{run.coverage.omitted.length ? ` · ${run.coverage.omitted.length} not included` : ""}{run.coverage.listComplete ? "" : " · file list cut short"}</summary>
      {run.coverage.omitted.length > 0 && <ul>{run.coverage.omitted.map((o) => <li key={o.path}><bdi dir="ltr">{o.path}</bdi> · {OMITTED[o.reason]}</li>)}</ul>}
      {!run.coverage.listComplete && <p className="cr-evidence">GitHub's file list was not read to the end; files beyond it were not reviewed.</p>}
    </details>
    {run.promptsRefused > 0 && <p className="cr-error" role="alert">Claude Code asked for permission {run.promptsRefused} {run.promptsRefused === 1 ? "time" : "times"}; Modex refused each. The confinement should allow no prompt.</p>}
    {run.reply && <div className="cr-agent-reply" data-testid="cr-agent-reply"><Markdown text={run.reply} />{run.replyTruncated && <p className="cr-evidence">The reply was longer than Modex keeps; the end was cut.</p>}</div>}
    {run.findingsMalformed && <p className="cr-evidence">Part of the findings block couldn't be read, so some findings may be missing.</p>}
    {run.findings.length > 0 && <ol className="cr-agent-findings" aria-label="Findings">{run.findings.map((f) => <Finding key={f.id} finding={f} run={run} overview={overview} writes={writes} outdated={outdated} />)}</ol>}
    {run.trail.length > 0 && <details><summary>{run.toolCalls} tool {run.toolCalls === 1 ? "call" : "calls"}</summary><ul className="cr-agent-trail">{run.trail.map((t, i) => <li key={i}><code>{t.name}</code> {t.title} · {t.outcome}</li>)}</ul>{run.toolCalls > run.trail.length && <p className="cr-evidence">Only the first {run.trail.length} are kept.</p>}</details>}
  </article>;
}

const OMITTED: Record<AgentRun["coverage"]["omitted"][number]["reason"], string> = {
  binary: "binary or empty change", "too-large": "patch too large", provider: "GitHub supplied no patch", budget: "over the snapshot's size budget", "file-cap": "over the snapshot's file count",
};

function Finding({ finding, run, overview, writes, outdated }: { finding: AgentFinding; run: AgentRun; overview: PrOverview; writes: Writes; outdated: boolean }) {
  const entry = useWrite(writes, overview);
  const [added, setAdded] = useState<string | null>(null);
  const place = finding.path ? `${finding.path}${finding.line ? `:${finding.line}${finding.endLine && finding.endLine > finding.line ? `–${finding.endLine}` : ""}` : ""}` : null;
  const draft = entry?.status?.drafts.review;
  const canAdd = finding.anchor !== null && !outdated && !!entry?.status && run.revision.headSha === overview.revision.headSha;
  const add = async () => {
    if (!finding.anchor) return;
    const comments: WriteInline[] = [...(draft?.comments ?? []), { anchor: finding.anchor, body: `${finding.title}\n\n${finding.detail}`.trim() }];
    const done = await writes.save(overview.key, overview.revision, "review", draft?.body ?? "", comments);
    setAdded(done.ok ? "Added to the review draft. It's sent only when you preview and submit that review." : done.detail);
  };
  return <li className={`cr-agent-finding cr-severity-${finding.severity}`} data-testid="cr-agent-finding" data-reference={finding.reference}>
    <div className="cr-agent-finding-head"><span className="cr-agent-severity">{SEVERITY_LABELS[finding.severity]}</span><strong>{finding.title}</strong></div>
    {place && <p className="cr-evidence"><bdi dir="ltr">{place}</bdi> · {REFERENCE[finding.reference]}</p>}
    {!place && <p className="cr-evidence">{REFERENCE.none}</p>}
    {finding.detail && <p className="cr-agent-finding-detail">{finding.detail}</p>}
    {finding.anchor && <div className="cr-compose-buttons">
      <button className="btn" type="button" disabled={!canAdd} title={canAdd ? undefined : outdated ? "This finding is about an older head." : "The review draft isn't available."} onClick={() => void add()}>Add to review draft</button>
      {added && <span className="cr-evidence" role="status">{added}</span>}
    </div>}
  </li>;
}

/** C57: a question about this pull request, answered by a run of its own. */
function AskComposer({ agent, overview, capability, active }: { agent: Agent; overview: PrOverview; capability: Capability; active: boolean }) {
  const entry = useAgent(agent, overview);
  const question = entry?.question ?? "";
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const ask = async () => {
    setBusy(true); setMessage(null);
    const done = await agent.start(overview.key, overview.revision, "ask", question.trim());
    setBusy(false);
    if (!done.ok) setMessage(done.detail);
  };
  const blocked = !capability.available || active;
  return <div className="cr-agent-ask" data-testid="cr-agent-ask">
    <label className="cr-field">Ask about this pull request
      <textarea className="cr-textarea" rows={3} maxLength={AGENT_LIMITS.question} value={question} placeholder="What does this change do to the retry path?" onChange={(e) => agent.setQuestion(overview.key, e.target.value)} />
    </label>
    <p className="cr-evidence">Answered by Claude Code from the same read-only snapshot, under your account. The question and the answer stay on this Mac.</p>
    <div className="cr-compose-buttons">
      <button className="btn primary" type="button" disabled={busy || blocked || !question.trim()} title={!capability.available ? capability.reason : active ? "A run is already going for this pull request." : undefined} onClick={() => void ask()}>Ask</button>
    </div>
    {message && <p className="cr-error" role="alert">{message}</p>}
  </div>;
}
