/**
 * The conversation-event contract (docs/conversation-events.md).
 *
 * Backends report what a native CLI said as typed observations, each naming the native item (and
 * part) it belongs to. The runner stamps each one with Modex's identity for the turn and attempt,
 * an event id and its ingress order, and folds it into transcript items with
 * `applyConversationEvent`, a pure function of serializable data. Replaying the same events gives
 * the same items.
 *
 * The phase, reasoning-representation and outcome values are Modex's own design values. Adapters
 * map native values onto them (the tables are in the doc); a native value with no mapping stays
 * unspecified, unavailable or unknown, never guessed.
 */
import type { AgentActivity, BackendId, ThreadItem } from "./types.js";
import type { Evidence, Exec } from "./evidence.js";

export const CONVERSATION_SCHEMA = 1 as const;

/** What assistant text is for. `unspecified` when the CLI does not say (Claude, older Codex models). */
export type MessagePhase = "commentary" | "final" | "unspecified";
/**
 * What a reasoning item's text is. `summary`: a summary the provider publishes as such.
 * `provider-text`: reasoning text the provider sent in the clear, with no claim that it is a summary.
 * `unavailable`: the model reasoned but no readable text came (omitted, redacted or opaque).
 */
export type ReasoningRepresentation = "summary" | "provider-text" | "unavailable";
/** How a piece of work ended. A connection going idle or away establishes none of these. */
export type ExecutionOutcome = "running" | "succeeded" | "failed" | "denied" | "interrupted" | "unknown";
export type SettledOutcome = Exclude<ExecutionOutcome, "running">;

/**
 * Native identifiers exactly as the CLI reported them. They are unique only within their runtime:
 * `runtime` is an opaque id Modex gives each CLI process or app-server it starts.
 */
export interface NativeRef {
  runtime: string;
  /** Codex thread id; Claude session id. */
  thread?: string;
  /** Codex turn id. Claude reports none. */
  turn?: string;
  /** Codex item id; Claude message id (text and thinking blocks) or tool_use id. */
  item: string;
  /** A part of the item: Claude's content-block index. */
  part?: string;
}

/** Modex's identity for one attempt at one turn. */
export interface TurnRef {
  /** Modex thread id. */
  thread: string;
  /** Modex turn: the id of the user message being answered. Retry keeps it. */
  turn: string;
  /** One run of the backend for this turn. Retry and the credit fallback start a new one. */
  attempt: string;
  backend: BackendId;
  /** Opaque account binding (a ChatGPT registration id or "cli"); never a credential. */
  account?: string;
}

/** Where a transcript item came from. Items saved before this contract have none. */
export interface ItemOrigin extends TurnRef {
  native: NativeRef;
}

/**
 * A plan step's status as the CLI reported it. `completed` means the CLI reported the step done; it
 * is not a check. A status Modex does not know is `unknown`.
 */
export type PlanStepStatus = "pending" | "in-progress" | "completed" | "unknown";
export interface PlanStep { text: string; status: PlanStepStatus }
/** Where a plan came from: Codex's `turn/plan/updated`, or Claude Code's `TodoWrite` tool. */
export type PlanSource = "codex-plan" | "claude-todo";

export interface ToolCall {
  name: string;
  title: string;
  args: Record<string, unknown>;
  agent?: AgentActivity;
  /** The command that actually ran, apart from the display title (shared/evidence.ts). */
  exec?: Exec;
}

export interface ToolProgress {
  args?: Record<string, unknown>;
  title?: string;
  agent?: AgentActivity;
  /** The whole output so far, not an increment; the runner keeps at most its last 256 KiB. */
  output?: string;
  /** How many bytes of output there were, when more than `output` holds. */
  outputBytes?: number;
  outputTruncated?: boolean;
  /** The exit code the CLI reported; null when it reported that there is none. Absent: not reported. */
  exitCode?: number | null;
  durationMs?: number;
}

/** What a backend reports. `source` is the CLI's own event id, when it gives one. */
export type Observation = (
  /** An assistant message (or message part) began. Nothing shows until it has text. */
  | { type: "message.start"; native: NativeRef; phase: MessagePhase; nativePhase?: string }
  | { type: "message.delta"; native: NativeRef; text: string }
  /** The message ended. `text`, when given, is the final snapshot and replaces what streamed. */
  | { type: "message.done"; native: NativeRef; text?: string; phase?: MessagePhase; nativePhase?: string; evidence?: Evidence[] }
  | { type: "reasoning.start"; native: NativeRef }
  /** Reasoning text for one part (Codex `summaryIndex` or `contentIndex`) of one representation. */
  | { type: "reasoning.delta"; native: NativeRef; representation: "summary" | "provider-text"; index: number; text: string }
  /** The reasoning item ended; `summary` and `text`, when non-empty, are final snapshots by part. */
  | { type: "reasoning.done"; native: NativeRef; summary?: string[]; text?: string[] }
  | { type: "tool.start"; native: NativeRef; tool: ToolCall }
  | { type: "tool.update"; native: NativeRef; progress: ToolProgress }
  | { type: "tool.done"; native: NativeRef; outcome: SettledOutcome; progress?: ToolProgress }
  /** The whole plan as the CLI now reports it; each update is a new revision of the same plan. */
  | { type: "plan.update"; native: NativeRef; from: PlanSource; steps: PlanStep[]; explanation?: string }
) & { source?: string };

/** Attempt boundaries, issued by the runner, never by a backend. */
export type AttemptMark = { type: "attempt.start" } | { type: "attempt.end"; outcome: SettledOutcome };

interface Stamp {
  schema: typeof CONVERSATION_SCHEMA;
  /** The event's identity: the CLI's own event id when it gave one, otherwise assigned at ingress. */
  id: string;
  /** Ingress order within the attempt, from 1. */
  seq: number;
  /** Ingress time. */
  at: string;
  turn: TurnRef;
}

export type ConversationEvent = (Observation | AttemptMark) & Stamp;

type Item<K extends ThreadItem["kind"]> = Extract<ThreadItem, { kind: K }> & { origin: ItemOrigin; outcome: ExecutionOutcome };
/** A transcript item the projector produced. Every one carries its origin and outcome. */
export type ConversationItem =
  | (Item<"assistant"> & { phase: MessagePhase })
  | (Item<"thinking"> & { reasoning: ReasoningRepresentation })
  | Item<"tool">
  | Item<"plan">;

interface Entry {
  kind: "message" | "reasoning" | "tool" | "plan";
  turn: string;
  attempt: string;
  done: boolean;
  phase?: MessagePhase;
  nativePhase?: string;
  /** Item ids: `message`, `tool`, a reasoning representation, or `placeholder` (a reasoning row with no text yet). */
  ids: Record<string, string>;
  /** Reasoning text by representation, then by part index. */
  parts: Record<string, Record<string, string>>;
}

export interface ConversationState {
  schema: typeof CONVERSATION_SCHEMA;
  /** Projected items in ingress order. */
  items: ConversationItem[];
  /** The current attempt of each Modex turn, and how it ended. */
  attempts: Record<string, { attempt: string; outcome: ExecutionOutcome }>;
  /** The highest `seq` applied per attempt. An event at or below it is a duplicate. */
  cursors: Record<string, number>;
  /** Native identity → bookkeeping. */
  entries: Record<string, Entry>;
}

export function initialConversation(): ConversationState {
  return { schema: CONVERSATION_SCHEMA, items: [], attempts: {}, cursors: {}, entries: {} };
}

/** Folds events into a state, in order. */
export function projectConversation(events: readonly ConversationEvent[], state: ConversationState = initialConversation()): ConversationState {
  return events.reduce(applyConversationEvent, state);
}

/**
 * Applies one event. Pure: returns `state` itself when the event changes nothing, so a caller can
 * tell by identity. Rules:
 * - events of one attempt apply in `seq` order; one at or below the attempt's cursor is a duplicate;
 * - observations apply only to the attempt most recently started for their turn, while it runs;
 * - native ids are scoped by thread, account, attempt and runtime, so a reused id never collides;
 * - text is never deduplicated by content: two deltas with the same text are two tokens.
 */
export function applyConversationEvent(state: ConversationState, event: ConversationEvent): ConversationState {
  const { turn } = event;
  if (event.seq <= (state.cursors[turn.attempt] ?? 0)) return state;
  const current = state.attempts[turn.turn];
  const s: ConversationState = { ...state, cursors: { ...state.cursors, [turn.attempt]: event.seq } };
  if (event.type === "attempt.start") {
    let next = s;
    if (current && current.outcome === "running" && current.attempt !== turn.attempt) next = settle(next, turn.turn, current.attempt, "unknown", event.at);
    return { ...next, attempts: { ...next.attempts, [turn.turn]: { attempt: turn.attempt, outcome: "running" } } };
  }
  if (!current || current.attempt !== turn.attempt || current.outcome !== "running") return state;
  if (event.type === "attempt.end") {
    const next = settle(s, turn.turn, turn.attempt, event.outcome === "interrupted" ? "interrupted" : "unknown", event.at, event.outcome);
    return { ...next, attempts: { ...next.attempts, [turn.turn]: { attempt: turn.attempt, outcome: event.outcome } } };
  }
  const key = nativeKey(turn, event.native);
  const entry = state.entries[key];
  const origin: ItemOrigin = { ...turn, native: { ...event.native } };
  const newId = `${turn.attempt}:${event.seq}`;
  const draft = new Draft(s);
  switch (event.type) {
    case "message.start": {
      if (entry) return entry.done ? state : draft.entry(key, { ...entry, phase: event.phase, ...(event.nativePhase !== undefined ? { nativePhase: event.nativePhase } : {}) }).done();
      return draft.entry(key, { ...fresh("message", turn), phase: event.phase, ...(event.nativePhase !== undefined ? { nativePhase: event.nativePhase } : {}) }).done();
    }
    case "message.delta": {
      if (entry?.done || !event.text) return state;
      const e = entry ?? fresh("message", turn);
      const id = e.ids.message;
      if (id) return draft.patch(id, (item) => item.kind === "assistant" ? { ...item, text: item.text + event.text } : item).entry(key, e).done();
      return draft.add(message(newId, e, event.text, "running", origin, event.at)).entry(key, { ...e, ids: { message: newId } }).done();
    }
    case "message.done": {
      if (entry?.done) return state;
      const e = { ...(entry ?? fresh("message", turn)), done: true, ...(event.phase ? { phase: event.phase } : {}), ...(event.nativePhase !== undefined ? { nativePhase: event.nativePhase } : {}) };
      const id = e.ids.message;
      const evidence = event.evidence?.length ? { evidence: event.evidence } : {};
      if (id) return draft.patch(id, (item) => item.kind === "assistant" ? { ...item, ...(event.text !== undefined ? { text: event.text } : {}), phase: e.phase ?? "unspecified", ...(e.nativePhase !== undefined ? { nativePhase: e.nativePhase } : {}), outcome: "succeeded", ...evidence } : item).entry(key, e).done();
      if (!event.text?.trim()) return draft.entry(key, e).done();
      return draft.add({ ...message(newId, e, event.text, "succeeded", origin, event.at), ...evidence } as ConversationItem).entry(key, { ...e, ids: { message: newId } }).done();
    }
    case "reasoning.start": {
      if (entry) return state;
      const item: ConversationItem = { id: newId, kind: "thinking", text: "", reasoning: "unavailable", status: "running", outcome: "running", origin, at: event.at };
      return draft.add(item).entry(key, { ...fresh("reasoning", turn), ids: { placeholder: newId } }).done();
    }
    case "reasoning.delta": {
      if (entry?.done || !event.text) return state;
      const e = entry ?? fresh("reasoning", turn);
      const parts = { ...e.parts[event.representation] };
      parts[event.index] = (parts[event.index] ?? "") + event.text;
      return reasoning(draft, key, e, event.representation, parts, newId, origin, event.at).done();
    }
    case "reasoning.done": {
      if (entry?.done) return state;
      let e = entry ?? fresh("reasoning", turn);
      for (const [representation, snapshot] of [["summary", event.summary], ["provider-text", event.text]] as const) {
        if (!snapshot?.some((part) => part)) continue;
        reasoning(draft, key, e, representation, Object.fromEntries(snapshot.map((part, i) => [i, part])), newId, origin, event.at);
        e = draft.entries[key]!;
      }
      for (const id of Object.values(e.ids)) draft.patch(id, (item) => ({ ...item, status: "done", outcome: "succeeded", durationMs: elapsed(item.at, event.at) }));
      return draft.entry(key, { ...e, done: true }).done();
    }
    case "tool.start": {
      if (entry) return state;
      const item: ConversationItem = { id: newId, kind: "tool", name: event.tool.name, title: event.tool.title, args: event.tool.args, ...(event.tool.agent ? { agent: event.tool.agent } : {}), ...(event.tool.exec ? { exec: event.tool.exec } : {}), status: "running", outcome: "running", origin, at: event.at };
      return draft.add(item).entry(key, { ...fresh("tool", turn), ids: { tool: newId } }).done();
    }
    case "plan.update": {
      const steps = event.steps.map((step) => ({ text: step.text, status: step.status }));
      const id = entry?.ids.plan;
      if (id) return draft.patch(id, (item) => {
        if (item.kind !== "plan") return item;
        const { explanation: _old, ...rest } = item;
        return { ...rest, steps, ...(event.explanation ? { explanation: event.explanation } : {}), from: event.from, revision: item.revision + 1 };
      }).done();
      const item: ConversationItem = { id: newId, kind: "plan", steps, ...(event.explanation ? { explanation: event.explanation } : {}), from: event.from, revision: 1, outcome: "running", origin, at: event.at };
      return draft.add(item).entry(key, { ...fresh("plan", turn), ids: { plan: newId } }).done();
    }
    case "tool.update":
    case "tool.done": {
      const id = entry?.ids.tool;
      if (!id) return state;
      const progress = event.progress ?? {};
      draft.patch(id, (item) => ({
        ...item, ...defined(progress),
        ...(event.type === "tool.done" ? { status: "done", outcome: event.outcome, ok: okFor(event.outcome), durationMs: progress.durationMs ?? elapsed(item.at, event.at) } : {}),
      }));
      return (event.type === "tool.done" ? draft.entry(key, { ...entry, done: true }) : draft).done();
    }
  }
}

/**
 * The tool `ok` older readers use, from an outcome: only success is `true`, only a failure or a
 * denial is `false`. Interrupted and unknown work is neither.
 */
export function okFor(outcome: ExecutionOutcome): boolean | undefined {
  return outcome === "succeeded" ? true : outcome === "failed" || outcome === "denied" ? false : undefined;
}

/** What is known about a transcript item, through one reader for items from before and after this contract. */
export interface ItemFacts {
  /** False for items saved before this contract: their identity, phase and representation were never recorded. */
  observed: boolean;
  origin?: ItemOrigin;
  phase: MessagePhase;
  /** Thinking items with a recorded representation only. */
  reasoning?: ReasoningRepresentation;
  outcome: ExecutionOutcome;
}

/**
 * The explicit legacy adapter. An item without an origin keeps its text and gets no invented
 * provenance: phase unspecified, outcome unknown, except a tool that recorded `ok: true`, which only
 * a backend's success report ever set.
 */
export function itemFacts(item: ThreadItem): ItemFacts {
  const typed = item as ThreadItem & { origin?: ItemOrigin; phase?: MessagePhase; reasoning?: ReasoningRepresentation; outcome?: ExecutionOutcome };
  if (!typed.origin) return { observed: false, phase: "unspecified", outcome: item.kind === "tool" && item.status === "done" && item.ok === true ? "succeeded" : "unknown" };
  return {
    observed: true, origin: typed.origin, phase: typed.phase ?? "unspecified",
    ...(item.kind === "thinking" && typed.reasoning ? { reasoning: typed.reasoning } : {}),
    outcome: typed.outcome ?? "unknown",
  };
}

/**
 * Which of one turn's items is its final answer. A turn whose CLI typed its messages answers with
 * its last `final` message, or has none (-1). Without typed phases (history from before this
 * contract, Claude, older Codex models) the historical heuristic stands: the last assistant item.
 */
export function finalAnswerIndex(items: readonly ThreadItem[]): number {
  const phases = items.map((item) => item.kind === "assistant" ? (item as { phase?: MessagePhase }).phase : undefined);
  if (phases.some((phase) => phase === "final" || phase === "commentary")) return phases.lastIndexOf("final");
  return items.map((item) => item.kind).lastIndexOf("assistant");
}

const PHASES: readonly string[] = ["commentary", "final", "unspecified"];
const SETTLED: readonly string[] = ["succeeded", "failed", "denied", "interrupted", "unknown"];
const BACKEND_IDS: readonly string[] = ["claude", "codex", "mock"];
const PLAN_STATUSES: readonly string[] = ["pending", "in-progress", "completed", "unknown"];

/** A conversation event read from outside the process (a file, a paired client), or null when malformed. */
export function parseConversationEvent(value: unknown): ConversationEvent | null {
  if (!isRecord(value) || value.schema !== CONVERSATION_SCHEMA || !text(value.id) || !Number.isSafeInteger(value.seq) || (value.seq as number) < 1 || !text(value.at)) return null;
  const turn = value.turn;
  if (!isRecord(turn) || !text(turn.thread) || !text(turn.turn) || !text(turn.attempt) || !BACKEND_IDS.includes(turn.backend as string) || !optional(turn.account, text)) return null;
  if (value.type === "attempt.start") return value as unknown as ConversationEvent;
  if (value.type === "attempt.end") return SETTLED.includes(value.outcome as string) ? value as unknown as ConversationEvent : null;
  const native = value.native;
  if (!isRecord(native) || !text(native.runtime) || !text(native.item) || !optional(native.thread, text) || !optional(native.turn, text) || !optional(native.part, text) || !optional(value.source, text)) return null;
  const ok = (() => {
    switch (value.type) {
      case "message.start": return PHASES.includes(value.phase as string) && optional(value.nativePhase, isString);
      case "message.delta": return isString(value.text);
      case "message.done": return optional(value.text, isString) && optional(value.phase, (p) => PHASES.includes(p as string)) && optional(value.nativePhase, isString) && optional(value.evidence, (e) => Array.isArray(e) && e.every(isRecord));
      case "reasoning.start": return true;
      case "reasoning.delta": return (value.representation === "summary" || value.representation === "provider-text") && Number.isSafeInteger(value.index) && (value.index as number) >= 0 && isString(value.text);
      case "reasoning.done": return optional(value.summary, strings) && optional(value.text, strings);
      case "tool.start": return isRecord(value.tool) && isString(value.tool.name) && isString(value.tool.title) && isRecord(value.tool.args) && optional(value.tool.agent, isRecord)
        && optional(value.tool.exec, (x) => isRecord(x) && isString(x.command) && optional(x.cwd, isString));
      case "tool.update": return progress(value.progress);
      case "tool.done": return SETTLED.includes(value.outcome as string) && optional(value.progress, progress);
      case "plan.update": return (value.from === "codex-plan" || value.from === "claude-todo") && optional(value.explanation, isString)
        && Array.isArray(value.steps) && value.steps.every((step) => isRecord(step) && isString(step.text) && PLAN_STATUSES.includes(step.status as string));
      default: return false;
    }
  })();
  return ok ? value as unknown as ConversationEvent : null;
}

function nativeKey(turn: TurnRef, native: NativeRef): string {
  return JSON.stringify([turn.thread, turn.account ?? null, turn.attempt, native.runtime, native.thread ?? null, native.turn ?? null, native.item, native.part ?? null]);
}

function fresh(kind: Entry["kind"], turn: TurnRef): Entry {
  return { kind, turn: turn.turn, attempt: turn.attempt, done: false, ids: {}, parts: {} };
}

function message(id: string, e: Entry, text: string, outcome: ExecutionOutcome, origin: ItemOrigin, at: string): ConversationItem {
  return { id, kind: "assistant", text, phase: e.phase ?? "unspecified", ...(e.nativePhase !== undefined ? { nativePhase: e.nativePhase } : {}), outcome, origin, at };
}

/** Writes one representation's parts to its own item: the reasoning row's placeholder if unclaimed, else a new item. */
function reasoning(draft: Draft, key: string, e: Entry, representation: "summary" | "provider-text", parts: Record<string, string>, newId: string, origin: ItemOrigin, at: string): Draft {
  const joined = Object.keys(parts).map(Number).sort((a, b) => a - b).map((i) => parts[i]).filter((part) => part).join("\n\n");
  const ids = { ...e.ids };
  let id = ids[representation];
  if (!id && ids.placeholder) { id = ids.placeholder; delete ids.placeholder; }
  if (id) draft.patch(id, (item) => item.kind === "thinking" ? { ...item, text: joined, reasoning: representation } : item);
  else {
    id = draft.has(newId) ? `${newId}:${representation}` : newId;
    draft.add({ id, kind: "thinking", text: joined, reasoning: representation, status: "running", outcome: "running", origin, at });
  }
  ids[representation] = id;
  return draft.entry(key, { ...e, ids, parts: { ...e.parts, [representation]: parts } });
}

/** Ends whatever an attempt left open with `outcome`. A plan takes the attempt's own outcome when there is one. */
function settle(state: ConversationState, turn: string, attempt: string, outcome: "interrupted" | "unknown", at: string, attemptOutcome?: SettledOutcome): ConversationState {
  const draft = new Draft(state);
  for (const [key, e] of Object.entries(state.entries)) {
    if (e.done || e.turn !== turn || e.attempt !== attempt) continue;
    for (const id of Object.values(e.ids)) {
      draft.patch(id, (item) => item.kind === "plan" ? { ...item, outcome: attemptOutcome ?? outcome }
        : item.kind === "assistant" ? { ...item, outcome }
        : item.kind === "tool" ? { ...item, status: "done", outcome, ok: okFor(outcome), durationMs: elapsed(item.at, at) }
        : { ...item, status: "done", outcome, durationMs: elapsed(item.at, at) });
    }
    draft.entry(key, { ...e, done: true });
  }
  return draft.done();
}

/** Copy-on-write edits to a state: only what changed gets a new object. */
class Draft {
  private readonly items: ConversationItem[];
  readonly entries: Record<string, Entry>;
  private readonly index = new Map<string, number>();
  constructor(private readonly base: ConversationState) {
    this.items = [...base.items];
    this.entries = { ...base.entries };
    base.items.forEach((item, i) => this.index.set(item.id, i));
  }
  has(id: string): boolean {
    return this.index.has(id);
  }
  add(item: ConversationItem): this {
    this.index.set(item.id, this.items.length);
    this.items.push(item);
    return this;
  }
  patch(id: string, change: (item: ConversationItem) => ConversationItem): this {
    const i = this.index.get(id);
    if (i !== undefined) this.items[i] = change(this.items[i]!);
    return this;
  }
  entry(key: string, value: Entry): this {
    this.entries[key] = value;
    return this;
  }
  done(): ConversationState {
    return { ...this.base, items: this.items, entries: this.entries };
  }
}

function elapsed(from: string, to: string): number {
  return Math.max(0, Date.parse(to) - Date.parse(from)) || 0;
}

function defined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isString(value: unknown): value is string { return typeof value === "string"; }
function text(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
function strings(value: unknown): boolean { return Array.isArray(value) && value.every(isString); }
function optional(value: unknown, check: (v: unknown) => boolean): boolean { return value === undefined || check(value); }
function progress(value: unknown): boolean {
  return isRecord(value) && optional(value.args, isRecord) && optional(value.title, isString) && optional(value.agent, isRecord) && optional(value.output, isString)
    && optional(value.durationMs, (d) => typeof d === "number" && Number.isFinite(d))
    && optional(value.outputBytes, (b) => Number.isSafeInteger(b) && (b as number) >= 0) && optional(value.outputTruncated, (t) => typeof t === "boolean")
    && optional(value.exitCode, (c) => c === null || Number.isSafeInteger(c));
}
