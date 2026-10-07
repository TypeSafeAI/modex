import type { AgentActivity } from "../../shared/types";

export interface ActiveAgent {
  threadId: string;
  threadTitle: string;
  agent: AgentActivity;
}

/** Kept above project filtering so running work cannot disappear inside a collapsed project. */
export function ActiveAgents({ agents, onSelect }: { agents: ActiveAgent[]; onSelect: (threadId: string) => void }) {
  if (!agents.length) return null;
  return (
    <section className="active-agents" aria-label="Active agents" data-testid="active-agents">
      <div className="section-label"><span>Agents</span><span className="agent-count" aria-live="polite" aria-atomic="true">{agents.length} active</span></div>
      <nav className="agent-list" aria-label="Running agents">
        {agents.map(({ threadId, threadTitle, agent }) => (
          <button key={`${threadId}:${agent.id}`} className="agent-row" data-testid="active-agent" data-state={agent.state}
            title={`${agent.label}\n${agent.detail ?? (agent.state === "waiting" ? "Waiting for approval or input" : "Working")}\n${threadTitle}`}
            aria-label={`${agent.label} · ${agent.state === "waiting" ? "Waiting" : "Working"} · ${threadTitle}`} onClick={() => onSelect(threadId)}>
            <span className={`row-status ${agent.state}`} aria-hidden="true" />
            <span className="agent-copy">
              <span className="agent-name">{agent.label}</span>
              <span className="agent-detail">{agent.detail || (agent.state === "waiting" ? "Waiting for approval or input" : "Working…")}</span>
              <span className="agent-parent">{threadTitle}</span>
            </span>
          </button>
        ))}
      </nav>
    </section>
  );
}
