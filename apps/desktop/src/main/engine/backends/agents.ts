import type { AgentActivity } from "../../../shared/types.js";
import type { TurnSink } from "./types.js";

const line = (text: string, max: number) => text.replace(/\s+/g, " ").trim().slice(0, max);

/** One transcript row per actual child, independent of its launch/wait tool calls. */
export class AgentTracker {
  private readonly agents = new Map<string, { value: AgentActivity; started: number }>();
  constructor(private readonly sink: TurnSink) {}

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
    if (!prior) this.sink.toolStart({ id: `agent:${id}`, name: "subagent", title, args: args ?? {}, agent: value });
    const running = value.state === "running" || value.state === "waiting";
    this.sink.toolUpdate(`agent:${id}`, {
      ...(args ? { args } : {}),
      agent: value, title, status: running ? "running" : "done",
      ok: value.state === "completed" ? true : value.state === "failed" ? false : undefined,
      ...(output !== undefined ? { output } : {}),
      ...(!running ? { durationMs: Date.now() - started } : {}),
    });
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
