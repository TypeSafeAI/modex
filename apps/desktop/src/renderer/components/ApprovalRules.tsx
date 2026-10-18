import { SecretOption, SecretInput } from "../streamer";
import { useEffect, useState } from "react";
import type { ApprovalPreview, ApprovalRule, Mode, Project, RoutingStatus, RuleDecision } from "../../shared/types";
import { bridge } from "../bridge";
import { ErrorNotice } from "./ui/ErrorNotice";

interface Props {
  rules: ApprovalRule[];
  projects: Project[];
  currentProjectId?: string;
  gateEnabled: boolean;
  routing: RoutingStatus | null;
  onChange: (rules: ApprovalRule[]) => void;
}

export function ApprovalRules({ rules, projects, currentProjectId, gateEnabled, routing, onChange }: Props) {
  const [projectId, setProjectId] = useState(currentProjectId ?? projects[0]?.id ?? "");
  const [backend, setBackend] = useState<"claude" | "codex">("claude");
  const [tool, setTool] = useState("Bash");
  const [title, setTitle] = useState("npm test");
  const [mode, setMode] = useState<Mode>("agent");
  const [escalation, setEscalation] = useState(false);
  const [result, setResult] = useState<{ key: string; pending?: boolean; value?: ApprovalPreview; error?: string } | null>(null);
  const request = { projectId, rules, backend, tool, title, mode, escalation };
  const key = JSON.stringify([request, routing, gateEnabled]);
  useEffect(() => setResult(null), [key]);
  const shown = result?.key === key ? result : null;
  const update = (id: string, patch: Partial<ApprovalRule>) => onChange(rules.map((r) => r.id === id ? { ...r, ...patch } : r));
  const add = () => {
    const project = projects.find((p) => p.id === (currentProjectId ?? projectId));
    if (!project) return;
    onChange([...rules, { id: crypto.randomUUID(), when: "", decision: "ask", enabled: true, project: project.path }]);
  };
  const run = async () => {
    setResult({ key, pending: true });
    try {
      const value = await bridge.invoke("approvals:try", request);
      setResult((r) => r?.key === key ? { key, value } : r);
    } catch (err) {
      setResult((r) => r?.key === key ? { key, error: (err as Error).message } : r);
    }
  };

  return <section className="approval-settings" aria-labelledby="approval-rules-heading" data-testid="approval-settings">
    <h3 id="approval-rules-heading" className="section-title">Approval rules</h3>
    <p className="hint">Rules answer approvals the CLI asks for. Allow approves once; Ask leaves the decision to you; Never refuses. Rules cannot widen the CLI’s permissions.</p>
    {!gateEnabled && <p className="warn" data-testid="approval-gate-status">Rules are not active in this release. You can save rules and preview them with Try it.</p>}
    <p className="hint" data-testid="approval-jev-status">{routing === null ? "Checking Jev availability…" : routing.live ? "Language rules use the saved Jev configuration. Save transport changes before trying them." : "Jev unavailable: language-only rules are inactive. Exact-match rules can still apply when the gate is enabled."}</p>
    {rules.map((rule, i) => <fieldset className="approval-rule" key={rule.id} data-testid="approval-rule">
      <legend>Rule {i + 1}</legend>
      <label className="field"><span>When the agent wants to</span><SecretInput value={rule.when} maxLength={500} onChange={(e) => update(rule.id, { when: e.target.value })} placeholder="run the test suite" /></label>
      <div className="grid2">
        <label className="field"><span>Decision</span><select value={rule.decision} onChange={(e) => update(rule.id, { decision: e.target.value as RuleDecision })}><SecretOption value="allow">Allow once</SecretOption><SecretOption value="ask">Ask me</SecretOption><SecretOption value="never">Never allow</SecretOption></select></label>
        <label className="field"><span>Scope</span><select value={rule.project ?? ""} onChange={(e) => update(rule.id, { project: e.target.value || undefined })}>
          <SecretOption value="">All projects</SecretOption>
          {projects.map((p) => <SecretOption key={p.id} value={p.path}>{p.name}</SecretOption>)}
          {rule.project && !projects.some((p) => p.path === rule.project) && <SecretOption value={rule.project}>{rule.project} (project not open)</SecretOption>}
        </select></label>
      </div>
      <label className="field"><span>Exact match (optional)</span><SecretInput value={rule.match ?? ""} maxLength={500} onChange={(e) => update(rule.id, { match: e.target.value || undefined })} placeholder="Bash: npm test*" spellCheck={false} /><small>Tool name, colon, then a case-sensitive pattern. * matches any text. Claude uses Bash; Codex uses command.</small></label>
      <div className="row"><label className="check"><SecretInput type="checkbox" checked={rule.enabled} onChange={(e) => update(rule.id, { enabled: e.target.checked })} /><span>Enabled</span></label>
        <span className="spacer" />
        {rule.enabled && !rule.match?.trim() && routing && !routing.live && <span className="warn" data-testid="rule-inactive">Inactive without Jev</span>}
        <button type="button" className="btn small danger" aria-label={`Delete rule ${i + 1}`} onClick={() => onChange(rules.filter((r) => r.id !== rule.id))}>Delete</button>
      </div>
    </fieldset>)}
    <button type="button" className="btn small" onClick={add} disabled={!projects.length || rules.length >= 100}>Add rule</button>
    {!projects.length && <p className="hint">Open a project to add or try a rule.</p>}
    <h4>Try it</h4>
    <p className="hint">Preview the rules above without saving them or running the action. This may ask the configured Jev judge about the sample.</p>
    <div className="grid2">
      <label className="field"><span>Preview project</span><select value={projectId} onChange={(e) => setProjectId(e.target.value)}>{projects.map((p) => <SecretOption key={p.id} value={p.id}>{p.name}</SecretOption>)}</select></label>
      <label className="field"><span>Preview backend</span><select value={backend} onChange={(e) => { const b = e.target.value as typeof backend; setBackend(b); setTool(b === "claude" ? "Bash" : "command"); }}><SecretOption value="claude">Claude</SecretOption><SecretOption value="codex">Codex</SecretOption></select></label>
      <label className="field"><span>Tool</span><SecretInput value={tool} onChange={(e) => setTool(e.target.value)} /></label>
      <label className="field"><span>Preview mode</span><select value={mode} onChange={(e) => setMode(e.target.value as Mode)}><SecretOption value="chat">Chat</SecretOption><SecretOption value="agent">Agent</SecretOption><SecretOption value="full-access">Full access</SecretOption></select></label>
    </div>
    <label className="field"><span>Sample action</span><SecretInput value={title} maxLength={2000} onChange={(e) => setTitle(e.target.value)} placeholder="npm test" /></label>
    <label className="check"><SecretInput type="checkbox" checked={escalation} onChange={(e) => setEscalation(e.target.checked)} /><span>Requests additional sandbox permissions</span></label>
    <button type="button" className="btn small" disabled={!projectId || !tool.trim() || !title.trim() || shown?.pending} onClick={() => void run()}>{shown?.pending ? "Checking…" : "Try it"}</button>
    <div aria-live="polite" aria-atomic="true">
      {shown?.error && <ErrorNotice className="warn" testId="approval-preview-error" where="Settings · approval rule preview" message={shown.error} onRetry={shown.pending ? undefined : () => void run()} context={{ tool, projectId }} />}
      {shown?.value && <PreviewReceipt result={shown.value} />}
    </div>
  </section>;
}

function PreviewReceipt({ result: r }: { result: ApprovalPreview }) {
  const labels = { allow: "Allow once", ask: "Ask me", never: "Never allow" };
  return <div className="approval-preview" data-testid="approval-preview" data-decision={r.decision}>
    <strong>{labels[r.decision]}</strong>{r.rule ? ` · rule “${r.rule.when}”` : " · No applicable rule; ask a human."}
    <div>{r.source === "match" ? "Exact match" : r.source === "jev" ? `Jev ${r.p?.toFixed(2) ?? ""}` : "No match"} · {r.ms} ms{r.destructive !== undefined ? ` · destructive ${r.destructive.toFixed(2)}` : ""}</div>
    {r.downgraded === "destructive" && <p>Allow became Ask because the action may be destructive.</p>}
    {r.downgraded === "escalation" && <p>Allow became Ask because only you can grant additional permissions.</p>}
    {r.downgraded === "compound" && <p>Allow became Ask because the command chains several commands.</p>}
    {r.downgraded === "incomplete" && <p>Allow became Ask because Jev could not see the whole command.</p>}
    {(!r.jevAvailable || r.jevNotConsulted) && <p>Jev not consulted; only exact-match rules were considered.{r.jevError ? ` ${r.jevError}` : ""}</p>}
    {!r.gateEnabled && <p>Preview only — the approval gate is off.</p>}
  </div>;
}
