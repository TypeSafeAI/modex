import { useState } from "react";
import type { AgentActivity, ThreadItem } from "../../shared/types";
import { Markdown } from "./Markdown";
import { formatElapsed } from "./transcript/TurnContent";
import { IconButton } from "./ui/IconButton";

type AgentTool = Extract<ThreadItem, { kind: "tool" }> & { agent: AgentActivity };

/** The delegated tasks a CLI reported in this thread, newest first. Only CLIs that report them have any. */
export function subagentsOf(items: ThreadItem[]): AgentTool[] {
  return items.filter((item): item is AgentTool => item.kind === "tool" && Boolean(item.agent)).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}
const live = (agent: AgentActivity) => agent.state === "running" || agent.state === "waiting";

const STATE: Record<AgentActivity["state"], string> = { running: "Working", waiting: "Waiting for approval or input", completed: "Done", failed: "Failed", stopped: "Stopped", unknown: "No final state" };

/** "now", "6m ago", "7h ago", "3d ago". */
function ago(at: string, now: number): string {
  const s = Math.max(0, Math.round((now - Date.parse(at)) / 1000));
  if (!Number.isFinite(s) || s < 45) return "now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}

/** A small mark that stays the same for the same subagent, so a row can be found again by sight. */
export function AgentMark({ id, size = 20 }: { id: string; size?: number }) {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 16777619) >>> 0;
  const hue = hash % 360, petals = 4 + (hash >>> 9) % 4, turn = (hash >>> 13) % 90;
  return (
    <svg className="agent-mark" width={size} height={size} viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      {Array.from({ length: petals }, (_, i) => <ellipse key={i} cx="10" cy="5.6" rx="3.1" ry="4.6" fill={`hsl(${hue} 70% 66%)`} opacity=".85" transform={`rotate(${turn + (360 / petals) * i} 10 10)`} />)}
      <circle cx="10" cy="10" r="2.2" fill={`hsl(${(hue + 40) % 360} 80% 40%)`} />
    </svg>
  );
}

const SHOWN = 10;

/** The Subagents tab of the side panel: who is working, who finished, and what each one reported. */
export function SubagentsPanel({ items }: { items: ThreadItem[] }) {
  const agents = subagentsOf(items);
  const [open, setOpen] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const now = Date.now();
  const selected = agents.find((item) => item.id === open);
  if (selected) {
    const { agent } = selected;
    return (
      <section className="subagents" data-testid="subagents" aria-label={`Subagent ${agent.label}`}>
        <header className="subagent-head">
          <IconButton icon="arrow-left" label="All subagents" size="md" data-testid="subagent-back" onClick={() => setOpen(null)} />
          <AgentMark id={agent.id} />
          <h2>{agent.label}</h2>
          <span className="spacer" />
          <span className="subagent-state" data-state={agent.state}>{STATE[agent.state]}</span>
        </header>
        <div className="subagent-body" data-testid="subagent-detail">
          <p className="subagent-worked">{live(agent) ? `Working for ${formatElapsed(now - Date.parse(selected.at))}` : selected.durationMs !== undefined ? `Worked for ${formatElapsed(selected.durationMs)}` : `Started ${ago(selected.at, now)}`}</p>
          {agent.detail && <p className="subagent-detail-line">{agent.detail}</p>}
          {selected.output?.trim() ? <Markdown text={selected.output} /> : <p className="hint">{live(agent) ? "Nothing reported yet." : "This subagent reported no text."}</p>}
        </div>
      </section>
    );
  }
  const active = agents.filter((item) => live(item.agent)), done = agents.filter((item) => !live(item.agent));
  const row = (item: AgentTool) => (
    <button key={item.id} type="button" className="subagent-row" data-testid="subagent-row" data-state={item.agent.state} aria-label={`${item.agent.label}, ${STATE[item.agent.state]}, ${ago(item.at, now)}`} onClick={() => setOpen(item.id)}>
      <AgentMark id={item.agent.id} />
      <span className="subagent-name">{item.agent.label}</span>
      {(item.agent.state === "failed" || item.agent.state === "stopped" || item.agent.state === "unknown" || item.agent.state === "waiting") && <span className="subagent-state" data-state={item.agent.state}>{STATE[item.agent.state]}</span>}
      <span className="subagent-when">{ago(item.at, now)}</span>
    </button>
  );
  return (
    <section className="subagents" data-testid="subagents" aria-label="Subagents">
      <div className="subagent-list">
        <h3>Active · {active.length}</h3>
        {active.length ? active.map(row) : <p className="hint">No active subagents</p>}
        <h3>Done · {done.length}</h3>
        {done.length ? (all ? done : done.slice(0, SHOWN)).map(row) : <p className="hint">{agents.length ? "None finished yet" : "This thread has run no subagents. They appear here when the model's CLI reports them."}</p>}
        {!all && done.length > SHOWN && <button type="button" className="subagent-more" data-testid="subagent-more" onClick={() => setAll(true)}>Show {done.length - SHOWN} more</button>}
      </div>
    </section>
  );
}
