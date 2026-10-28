import { prKeyId, sameKey, type PrKey, type PrRevision } from "../../shared/code-review.js";
import { AGENT_REFUSALS, type AgentInstructions, type AgentKind, type AgentRefusal, type AgentReply, type AgentRequest, type AgentRun, type AgentStatus } from "../../shared/code-review-agent.js";
import type { Done } from "./writes.js";

/** One way to ask main: the bridge's `code-review:agent` in the app, a fake in tests. */
export type AgentSend = (request: AgentRequest) => Promise<AgentReply>;
type Ask = AgentRequest extends infer R ? R extends AgentRequest ? Omit<R, "requestId"> : never : never;

/** What the views show for one PR. `error` is main's fixed refusal text, or a failed call; `reason` its code. */
export interface AgentEntry {
  status: AgentStatus | null;
  error: string | null;
  reason: AgentRefusal | "failed" | null;
  loading: boolean;
  /** The model picked in the panel; null means the backend's default. */
  model: string | null;
  /** The question being written, kept here so "Add to chat" and the composer share it. */
  question: string;
}

const FAILED = "Modex couldn't reach its review-agent service.";
const POLL_MS = 800;
const EMPTY: AgentEntry = { status: null, error: null, reason: null, loading: false, model: null, question: "" };
const STOP_POLLING = new Set(["disabled", "no-cli", "signed-out", "account-changed", "offline", "rate-limited"]);

/**
 * CR-6 (#325): the renderer's side of `code-review:agent`. Main is the source of truth: a run starts only when
 * main says it did, and the views show main's status, polled while a run is going. Nothing here decides what
 * the CLI may do, and nothing here retries a start.
 */
export class Agent {
  private seq = 0;
  private readonly entries = new Map<string, AgentEntry>();
  private readonly listeners = new Set<() => void>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly inFlight = new Map<string, Promise<void>>();
  /** Status calls that failed in a row, per PR: polling stops after a few, and on refusals that polling can't mend. */
  private readonly failures = new Map<string, number>();
  private generation = 0;

  constructor(private readonly send: AgentSend, private readonly prefix = "ca") {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  entry(key: PrKey): AgentEntry | undefined {
    return this.entries.get(prKeyId(key));
  }

  /** On an account change: nothing answered for the old account may land after, and no poll goes on. */
  clear(): void {
    this.generation++;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.inFlight.clear();
    this.failures.clear();
    this.entries.clear();
    this.emit();
  }

  setModel(key: PrKey, model: string | null): void {
    this.set(key, { ...(this.entry(key) ?? EMPTY), model });
  }

  setQuestion(key: PrKey, question: string): void {
    this.set(key, { ...(this.entry(key) ?? EMPTY), question });
  }

  /** "Add to chat": the comment, quoted, under whatever question is being written. */
  quote(key: PrKey, text: string): void {
    const current = this.entry(key)?.question ?? "";
    const quoted = text.trim().split(/\r?\n/).map((line) => `> ${line}`).join("\n");
    this.setQuestion(key, `${current.trim() ? `${current.trimEnd()}\n\n` : ""}${quoted}\n\n`);
  }

  /** The model a start would use: the pick, or the backend's default. */
  model(key: PrKey): string | null {
    const entry = this.entry(key);
    const models = entry?.status?.backend.models ?? [];
    if (entry?.model && models.some((m) => m.id === entry.model)) return entry.model;
    return models.find((m) => m.isDefault)?.id ?? models[0]?.id ?? null;
  }

  /** One status read per PR at a time: several views mounting together share the same answer. */
  refresh(key: PrKey): Promise<void> {
    const slot = prKeyId(key);
    const running = this.inFlight.get(slot);
    if (running) return running;
    const work = this.read(key).finally(() => { if (this.inFlight.get(slot) === work) this.inFlight.delete(slot); });
    this.inFlight.set(slot, work);
    return work;
  }

  private async read(key: PrKey): Promise<void> {
    const slot = prKeyId(key), generation = this.generation;
    this.set(key, { ...(this.entries.get(slot) ?? EMPTY), loading: true });
    const done = await this.ask<"status">({ op: "status", key });
    if (generation !== this.generation) return;
    const entry = this.entries.get(slot) ?? EMPTY;
    if (done.ok && done.value.account.id !== key.account) return this.set(key, { ...entry, loading: false });
    this.failures.set(slot, done.ok ? 0 : (this.failures.get(slot) ?? 0) + 1);
    this.set(key, done.ok ? { ...entry, status: done.value, error: null, reason: null, loading: false } : { ...entry, error: done.detail, reason: done.reason as AgentRefusal, loading: false });
    this.watch(key, done.ok ? null : done.reason);
  }

  /** Saves against the version on screen; a conflict means another save won, so main's newest is shown instead. */
  async saveInstructions(key: PrKey, text: string, expectedVersion: number): Promise<Done<AgentInstructions>> {
    const generation = this.generation;
    const done = await this.ask<"instructions">({ op: "instructions", key, text, expectedVersion });
    if (generation !== this.generation) return { ok: false, reason: "account-changed", detail: AGENT_REFUSALS["account-changed"] };
    if (done.ok) this.patch(key, (status) => ({ ...status, instructions: done.value }));
    else if (done.reason === "instructions-conflict") await this.refresh(key);
    return done;
  }

  /** Explicit start. The model is the panel's pick; the revision is the one on screen, which main checks is still the PR's. */
  async start(key: PrKey, revision: PrRevision, kind: AgentKind, question: string | null): Promise<Done<AgentRun>> {
    const model = this.model(key);
    if (!model) return { ok: false, reason: "backend-unavailable", detail: AGENT_REFUSALS["backend-unavailable"] };
    const generation = this.generation;
    const done = await this.ask<"start">({ op: "start", key, revision, kind, question, model });
    if (generation !== this.generation) return { ok: false, reason: "account-changed", detail: AGENT_REFUSALS["account-changed"] };
    if (done.ok) {
      this.patch(key, (status) => ({ ...status, runs: [done.value, ...status.runs.filter((r) => r.id !== done.value.id)], active: done.value.id }));
      if (kind === "ask") this.setQuestion(key, "");
      this.watch(key);
    } else if (done.reason === "busy" || done.reason === "backend-unavailable") await this.refresh(key);
    return done;
  }

  async stop(key: PrKey, runId: string): Promise<Done<AgentRun>> {
    const generation = this.generation;
    const done = await this.ask<"stop">({ op: "stop", key, runId });
    if (generation !== this.generation) return { ok: false, reason: "account-changed", detail: AGENT_REFUSALS["account-changed"] };
    if (done.ok) this.patch(key, (status) => ({ ...status, runs: status.runs.map((r) => r.id === done.value.id ? done.value : r), active: status.active === done.value.id ? null : status.active }));
    await this.refresh(key);
    return done;
  }

  /**
   * While main says a run is going, ask again soon. The timer ends with the run, an account change, a refusal
   * polling cannot mend, or a few failures in a row; the next mount or action asks again.
   */
  private watch(key: PrKey, failed: string | null = null): void {
    const slot = prKeyId(key);
    clearTimeout(this.timers.get(slot));
    this.timers.delete(slot);
    if (!this.entries.get(slot)?.status?.active) return;
    if (failed && (STOP_POLLING.has(failed) || (this.failures.get(slot) ?? 0) >= 5)) return;
    this.timers.set(slot, setTimeout(() => { this.timers.delete(slot); void this.refresh(key); }, POLL_MS));
  }

  private async ask<K extends AgentRequest["op"]>(ask: Omit<Extract<AgentRequest, { op: K }>, "requestId">): Promise<Done<Extract<AgentReply<K>["result"], { state: "ok" }>["value"]>> {
    const request: AgentRequest = { ...(ask as Ask), requestId: `${this.prefix}-${++this.seq}` };
    let reply: AgentReply;
    try {
      reply = await this.send(request);
    } catch {
      return { ok: false, reason: "failed", detail: FAILED };
    }
    // An answer for another request or PR is not this one's.
    if (!reply || !reply.result || reply.requestId !== request.requestId || reply.op !== request.op || !sameKey(reply.key, request.key)) return { ok: false, reason: "failed", detail: FAILED };
    return reply.result.state === "ok" ? { ok: true, value: reply.result.value as never } : { ok: false, reason: reply.result.reason, detail: reply.result.detail };
  }

  private patch(key: PrKey, change: (status: AgentStatus) => AgentStatus): void {
    const entry = this.entry(key);
    if (entry?.status) this.set(key, { ...entry, status: change(entry.status) });
  }

  private set(key: PrKey, entry: AgentEntry): void {
    this.entries.set(prKeyId(key), entry);
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
