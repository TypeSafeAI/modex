/**
 * Human requests (docs/human-requests.md): approvals and native questions a CLI asks a person, as one
 * versioned contract with a pure broker. A request is bound to the identity and the exact action it
 * was asked for; it accepts one local resolution, and stale, duplicate, withdrawn, wrong-identity or
 * changed-action answers authorise nothing. A local decision is not proof the CLI received it: a
 * request withdrawn while its answer was being sent is `uncertain`, never resolved.
 *
 * Pure and serializable, shared by main (which owns the authoritative state) and clients.
 */
import type { AnswerDelivery, BackendId } from "./types.js";

export const HUMAN_REQUEST_SCHEMA = 1 as const;

/** Who asked: the Modex thread, turn and attempt, the runtime that issued it, and its native request id. */
export interface RequestBinding {
  thread: string;
  turn: string;
  attempt: string;
  backend: BackendId;
  /** Opaque account binding; never a credential. */
  account?: string;
  /** The runtime generation (shared/conversation-events.ts) whose native ids these are. */
  runtime: string;
  nativeRequestId: string;
  /** The native item the request is about, when the CLI names one. */
  item?: string;
}

export interface QuestionOption { label: string; description: string }

/** One question as the CLI asked it. `options` null: free text. `allowOther`: free text besides the options. */
export interface Question {
  id: string;
  header: string;
  text: string;
  options: QuestionOption[] | null;
  allowOther: boolean;
  /** The answer is sensitive: it is sent to the CLI and never shown, saved or exported. */
  secret: boolean;
}

export type HumanRequest =
  | { kind: "approval"; id: string; binding: RequestBinding; action: unknown; digest: string; canAlways: boolean }
  | { kind: "question"; id: string; binding: RequestBinding; questions: Question[]; blocking: boolean; digest: string };

export type Resolution =
  | { kind: "approval"; answer: "yes" | "no" | "always" }
  | { kind: "question"; answers: Record<string, string[]> };

/**
 * `pending`: waiting for a person. `resolving`: one answer accepted, being sent to the CLI.
 * `resolved`: sent. `withdrawn`: the request went away before any answer. `uncertain`: it went away,
 * or the send failed, after an answer was accepted, so whether the CLI received it is unknown.
 */
export type RequestState = "pending" | "resolving" | "resolved" | "withdrawn" | "uncertain";

export interface RequestRecord {
  request: HumanRequest;
  state: RequestState;
  resolution?: Resolution;
  /** Which client's answer was accepted. */
  by?: string;
}

export interface RequestsState {
  schema: typeof HUMAN_REQUEST_SCHEMA;
  requests: Record<string, RequestRecord>;
}

export type Refusal = "unknown" | "already-resolved" | "withdrawn" | "wrong-identity" | "changed-action" | "invalid";

export function emptyRequests(): RequestsState {
  return { schema: HUMAN_REQUEST_SCHEMA, requests: {} };
}

export function register(state: RequestsState, request: HumanRequest): RequestsState {
  if (state.requests[request.id]) return state;
  return { ...state, requests: { ...state.requests, [request.id]: { request: structuredClone(request), state: "pending" } } };
}

/**
 * Accepts one answer for a pending request, from a client that names the identity and action digest
 * it was shown. On success the request is `resolving` until `settle` reports the send.
 */
export function resolve(state: RequestsState, id: string, resolution: Resolution, claim: { binding: RequestBinding; digest: string; by: string }): { ok: true; state: RequestsState } | { ok: false; reason: Refusal; state: RequestsState } {
  const record = state.requests[id];
  const refuse = (reason: Refusal) => ({ ok: false as const, reason, state });
  if (!record) return refuse("unknown");
  if (record.state === "withdrawn") return refuse("withdrawn");
  if (record.state !== "pending") return refuse("already-resolved");
  if (!sameBinding(record.request.binding, claim.binding)) return refuse("wrong-identity");
  if (claim.digest !== record.request.digest) return refuse("changed-action");
  if (resolution.kind !== record.request.kind) return refuse("invalid");
  if (resolution.kind === "approval" && record.request.kind === "approval" &&
      (!["yes", "no", "always"].includes(resolution.answer) || (resolution.answer === "always" && !record.request.canAlways))) return refuse("invalid");
  if (resolution.kind === "question" && record.request.kind === "question" && !validateAnswers(record.request.questions, resolution.answers).ok) return refuse("invalid");
  return { ok: true, state: { ...state, requests: { ...state.requests, [id]: { ...record, state: "resolving", resolution: structuredClone(resolution), by: claim.by } } } };
}

/** Records the outcome of sending an accepted answer. Only a `resolving` request changes. */
export function settle(state: RequestsState, id: string, sent: "sent" | "uncertain"): RequestsState {
  const record = state.requests[id];
  if (!record || record.state !== "resolving") return state;
  return { ...state, requests: { ...state.requests, [id]: { ...record, state: sent === "sent" ? "resolved" : "uncertain" } } };
}

/** Withdraws open requests (Stop, a native withdrawal, an ended attempt): pending ones are withdrawn, ones being sent become uncertain. */
export function withdraw(state: RequestsState, match: { id: string } | { thread: string; turn?: string; attempt?: string }): RequestsState {
  let changed = false;
  const requests = { ...state.requests };
  for (const [id, record] of Object.entries(state.requests)) {
    const hit = "id" in match ? id === match.id
      : record.request.binding.thread === match.thread && (match.turn === undefined || record.request.binding.turn === match.turn) && (match.attempt === undefined || record.request.binding.attempt === match.attempt);
    if (!hit || (record.state !== "pending" && record.state !== "resolving")) continue;
    requests[id] = { ...record, state: record.state === "pending" ? "withdrawn" : "uncertain" };
    changed = true;
  }
  return changed ? { ...state, requests } : state;
}

/** A stable digest of the exact action a request asks about. A changed action is a new request. */
export function actionDigest(action: unknown): string {
  return stable(action);
}

/** Checks answers against the questions: each question answered, choices from its options unless other text is allowed. */
export function validateAnswers(questions: readonly Question[], answers: unknown): { ok: true; answers: Record<string, string[]> } | { ok: false; error: string } {
  if (!isRecord(answers)) return { ok: false, error: "Answer every question." };
  const ids = new Set(questions.map((q) => q.id));
  for (const id of Object.keys(answers)) if (!ids.has(id)) return { ok: false, error: `Unknown question ${id}.` };
  for (const q of questions) {
    const given = answers[q.id];
    if (!Array.isArray(given) || given.length === 0) return { ok: false, error: `${q.header || q.text} needs an answer.` };
    if (!given.every((a) => typeof a === "string" && a.trim())) return { ok: false, error: `${q.header || q.text} needs a text answer.` };
    if (q.options && !q.allowOther && !given.every((a) => q.options!.some((o) => o.label === a))) return { ok: false, error: `${q.header || q.text}: choose one of the options.` };
  }
  return { ok: true, answers: answers as Record<string, string[]> };
}

/**
 * What a closed card adds under its answer: that the phone gave it, and that nobody can tell whether the CLI
 * received it. An answer given in this window and sent, or saved before these fields existed, adds nothing.
 */
export function answerNote(card: { answeredBy?: string; delivery?: AnswerDelivery }): string | null {
  const notes = [
    card.answeredBy === "phone" ? "Answered on your phone." : "",
    card.delivery === "uncertain" ? "Modex stopped before it could confirm the agent received this answer." : "",
  ].filter(Boolean);
  return notes.length ? notes.join(" ") : null;
}

/** Answers as they may be shown, saved or exported: a secret answer is "(hidden)". */
export function publicAnswers(questions: readonly Question[], answers: Record<string, string[]>): Record<string, string[]> {
  const secret = new Set(questions.filter((q) => q.secret).map((q) => q.id));
  return Object.fromEntries(Object.entries(answers).map(([id, values]) => [id, secret.has(id) ? ["(hidden)"] : values]));
}

/**
 * Codex's `item/tool/requestUserInput` params (codex-cli 0.163.0, marked experimental) as questions,
 * or null when they are not well formed; a malformed request is never half-answered.
 */
export function codexQuestions(params: unknown): { questions: Question[]; blocking: boolean } | null {
  if (!isRecord(params) || !Array.isArray(params.questions) || !params.questions.length) return null;
  const questions: Question[] = [];
  const ids = new Set<string>();
  for (const q of params.questions) {
    if (!isRecord(q) || typeof q.id !== "string" || !q.id || typeof q.question !== "string") return null;
    if (ids.has(q.id) || (q.header !== undefined && typeof q.header !== "string") ||
        (q.isOther !== undefined && typeof q.isOther !== "boolean") || (q.isSecret !== undefined && typeof q.isSecret !== "boolean")) return null;
    ids.add(q.id);
    let options: QuestionOption[] | null = null;
    if (q.options !== null && q.options !== undefined) {
      if (!Array.isArray(q.options) || !q.options.every((o) => isRecord(o) && typeof o.label === "string" && (o.description === undefined || typeof o.description === "string"))) return null;
      if (new Set(q.options.map(o => (o as Record<string, unknown>).label)).size !== q.options.length) return null;
      options = (q.options as { label: string; description?: string }[]).map((o) => ({ label: o.label, description: o.description ?? "" }));
    }
    questions.push({ id: q.id, header: typeof q.header === "string" ? q.header : "", text: q.question, options, allowOther: q.isOther === true || options === null, secret: q.isSecret === true });
  }
  return { questions, blocking: params.isBlocking !== false };
}

/** Answers in the shape Codex's `ToolRequestUserInputResponse` takes. */
export function codexAnswerResponse(answers: Record<string, string[]>): { answers: Record<string, { answers: string[] }> } {
  return { answers: Object.fromEntries(Object.entries(answers).map(([id, values]) => [id, { answers: values }])) };
}

function sameBinding(a: RequestBinding, b: RequestBinding): boolean {
  return a.thread === b.thread && a.turn === b.turn && a.attempt === b.attempt && a.backend === b.backend && (a.account ?? null) === (b.account ?? null)
    && a.runtime === b.runtime && a.nativeRequestId === b.nativeRequestId && (a.item ?? null) === (b.item ?? null);
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
