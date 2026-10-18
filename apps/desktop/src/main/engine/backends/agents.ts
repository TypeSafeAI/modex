import type { AgentActivity } from "../../../shared/types.js";
import type { SettledOutcome } from "../../../shared/conversation-events.js";
import type { TurnSink } from "./types.js";

const line = (text: string, max: number) => text.replace(/\s+/g, " ").trim().slice(0, max);

/** One transcript row per actual child, independent of its launch/wait tool calls. */
export class AgentTracker {
  private readonly agents = new Map<string, { value: AgentActivity; started: number }>();
  /** `runtime` is the CLI runtime that reported these agents; it scopes their ids. */
  constructor(private readonly sink: TurnSink, private readonly runtime: string) {}

  has(id: string): boolean { return this.agents.has(id); }

  update(id: string, patch: Partial<Omit<AgentActivity, "id">>, output?: string, args?: Record<string, unknown>): void {
    if (!id) return;
    const prior = this.agents.get(id);
    const value: AgentActivity = { id, label: `Agent ${id.slice(0, 8)}`, state: "unknown", ...prior?.value, ...patch };
    value.label = line(value.label, 140) || `Agent ${id.slice(0, 8)}`;
    if (value.detail) value.detail = line(value.detail, 240);
    const started = prior?.started ?? Date.now();
    this.agents.set(id, { value, started });
    const title = `agent: ${value.label}`;
    const native = { runtime: this.runtime, item: `agent:${id}` };
    if (!prior) this.sink.observe({ type: "tool.start", native, tool: { name: "subagent", title, args: args ?? {}, agent: value } });
    const running = value.state === "running" || value.state === "waiting";
    const progress = { ...(args ? { args } : {}), agent: value, title, ...(output !== undefined ? { output } : {}) };
    if (running) this.sink.observe({ type: "tool.update", native, progress });
    else this.sink.observe({ type: "tool.done", native, outcome: agentOutcome(value.state), progress: { ...progress, durationMs: Date.now() - started } });
  }

  finish(interrupted: boolean): void {
    for (const [id, { value }] of this.agents) {
      if (value.state === "running" || value.state === "waiting") this.update(id, {
        state: interrupted ? "stopped" : "unknown",
        detail: interrupted ? "Parent turn stopped" : "The CLI stream ended without a final agent status",
      });
    }
  }
}

/** An agent's final state as an execution outcome. A stopped agent was interrupted; any other end is unknown. */
function agentOutcome(state: AgentActivity["state"]): SettledOutcome {
  return state === "completed" ? "succeeded" : state === "failed" ? "failed" : state === "stopped" ? "interrupted" : "unknown";
}
