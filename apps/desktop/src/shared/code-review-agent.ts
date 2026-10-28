import { validateRequest, type LineAnchor, type PrKey, type PrRevision } from "./code-review.js";
import type { SettledOutcome } from "./conversation-events.js";

/**
 * CR-6 (#325): what the renderer may ask main's `code-review:agent` channel: a read-only review of a pull
 * request, or a question about it, run by the installed Claude Code CLI on a snapshot main builds from its own
 * GitHub reads; and the person's review instructions, which apply to every repository and are versioned.
 *
 * Nothing here is authority. Main confirms the signed-in account, the pull request's head and target, and the
 * CLI's confinement itself before it starts anything, and only an explicit `start` starts a run. A finding is
 * the model's claim about the snapshot: it is bound to the revision it was made about and never becomes a
 * GitHub comment, an approval or a merge by itself.
 *
 * Pure and serializable. No credential, endpoint, URL, shell text or local path crosses the bridge.
 */

export type AgentKind = "review" | "ask";

/** The person's own instructions, applied to every review run. `version` names which text a run used. */
export interface AgentInstructions { version: number; text: string; updatedAt: string | null }

export type AgentRunState = "running" | "completed" | "failed" | "stopped" | "unknown";
/** Why a run is not `completed`: fixed reasons, each shown with its own text (`RUN_REASONS`). */
export type AgentRunReason = "stopped" | "restart" | "backend-failed" | "could-not-start" | "no-reply";

/** Why a changed file's patch is not in the snapshot. `binary` and `provider` come from GitHub; the rest are main's bounds. */
export type OmissionReason = "binary" | "too-large" | "provider" | "budget" | "file-cap";
/** What the run could see. Omissions are listed by path so the person knows what was not reviewed. */
export interface AgentCoverage {
  included: { path: string; bytes: number }[];
  omitted: { path: string; reason: OmissionReason }[];
  bytes: number;
  /** The PR's own changed-file count, when GitHub said. */
  filesTotal: number | null;
  /** Whether the file list main read reached that count. */
  listComplete: boolean;
}

export type FindingSeverity = "blocker" | "major" | "minor" | "nit" | "note";
/** `anchored`: the path and lines are in the snapshot's head-side diff. `unverified`: the model named a place main could not find. `none`: no place named. */
export type FindingReference = "anchored" | "unverified" | "none";
export interface AgentFinding {
  id: string;
  title: string;
  detail: string;
  severity: FindingSeverity;
  path: string | null;
  line: number | null;
  endLine: number | null;
  /** CR-5's anchor, present only when `reference` is `anchored`, so a finding can become a review draft's line comment. */
  anchor: LineAnchor | null;
  reference: FindingReference;
}

/** One tool call the CLI made, as it reported it. Review runs have only Read. */
export interface AgentTrailEntry { name: string; title: string; outcome: SettledOutcome | "running" }

export interface AgentBackend { id: "claude"; version: string | null; model: string }

export interface AgentRun {
  id: string;
  kind: AgentKind;
  key: PrKey;
  revision: PrRevision;
  question: string | null;
  instructionsVersion: number;
  backend: AgentBackend;
  startedAt: string;
  endedAt: string | null;
  state: AgentRunState;
  reason: AgentRunReason | null;
  /** A bounded detail for `backend-failed` or `could-not-start`: what the CLI said about its own failure. */
  detail: string | null;
  coverage: AgentCoverage;
  /** The CLI's final reply, with its findings block removed. */
  reply: string;
  replyTruncated: boolean;
  findings: AgentFinding[];
  /** Whether the reply carried a findings block main could not read. */
  findingsMalformed: boolean;
  trail: AgentTrailEntry[];
  toolCalls: number;
  /** Permission prompts the CLI raised and main refused. The confinement asks for none; a count above zero is worth reporting. */
  promptsRefused: number;
}

export interface AgentAvailability {
  available: boolean;
  /** Why not, in the person's terms. */
  reason: string | null;
  version: string | null;
  models: { id: string; label: string; isDefault: boolean }[];
}

/** Main's answer for one PR under the signed-in account. `runs` are this PR's, newest first. */
export interface AgentStatus {
  account: { id: string; login: string };
  instructions: AgentInstructions;
  backend: AgentAvailability;
  runs: AgentRun[];
  /** The id of this PR's running run, if any. */
  active: string | null;
}

export type AgentRefusal =
  | "disabled" | "no-cli" | "signed-out" | "account-changed" | "offline" | "timeout" | "rate-limited" | "not-found" | "denied" | "failed"
  | "head-changed" | "target-changed" | "not-open"
  | "backend-unavailable" | "busy" | "nothing-to-review" | "instructions-conflict" | "no-run" | "storage";

export type AgentResult<T> = { state: "ok"; value: T } | { state: "refused"; reason: AgentRefusal; detail: string };

export interface AgentReads {
  status: AgentStatus;
  instructions: AgentInstructions;
  start: AgentRun;
  stop: AgentRun;
}

export type AgentRequest =
  | { op: "status"; requestId: string; key: PrKey }
  | { op: "instructions"; requestId: string; key: PrKey; text: string; expectedVersion: number }
  | { op: "start"; requestId: string; key: PrKey; revision: PrRevision; kind: AgentKind; question: string | null; model: string }
  | { op: "stop"; requestId: string; key: PrKey; runId: string };

export type AgentOp = AgentRequest["op"];
export interface AgentReply<K extends AgentOp = AgentOp> { requestId: string; op: K; key: PrKey; result: AgentResult<AgentReads[K]> }

export const AGENT_LIMITS = {
  question: 4_000, instructions: 8_000, reply: 65_536, findings: 50, findingTitle: 200, findingDetail: 4_000, trail: 200,
  runsPerPr: 10, runs: 100, model: 64,
  /** The snapshot: patches only, within these bounds. */
  snapshotBytes: 1024 * 1024, snapshotFileBytes: 192 * 1024, snapshotFiles: 200,
} as const;

/** Fixed texts for every refusal: nothing GitHub, gh or the CLI printed. */
export const AGENT_REFUSALS: Record<AgentRefusal, string> = {
  disabled: "Agent review is off in this build.",
  "no-cli": "GitHub CLI (gh) isn't installed, so Modex can't read this pull request.",
  "signed-out": "GitHub CLI isn't signed in to this account. Run `gh auth login`, then retry.",
  "account-changed": "GitHub CLI's login changed. Open the pull request again.",
  offline: "GitHub couldn't be reached.",
  timeout: "GitHub took too long to answer.",
  "rate-limited": "GitHub's rate limit was reached. Try again later.",
  "not-found": "The pull request wasn't found, or this account can't see it.",
  denied: "This account can't read this pull request.",
  failed: "Modex couldn't read the pull request.",
  "head-changed": "The pull request's head moved. Reload it, then start again.",
  "target-changed": "The pull request's target branch changed. Reload it, then start again.",
  "not-open": "This pull request is closed.",
  "backend-unavailable": "Claude Code isn't available for review runs.",
  busy: "A run is already going for this pull request.",
  "nothing-to-review": "No text changes are in this pull request's diff.",
  "instructions-conflict": "The instructions changed elsewhere. They were reloaded; edit them again.",
  "no-run": "That run isn't known.",
  storage: "Modex couldn't record the run, so it didn't start.",
};

export const RUN_REASONS: Record<AgentRunReason, string> = {
  stopped: "Stopped before it finished.",
  restart: "Modex restarted while it was running; its outcome is unknown.",
  "backend-failed": "Claude Code ended with an error.",
  "could-not-start": "Claude Code couldn't be started.",
  "no-reply": "Claude Code finished without a reply.",
};

export const SEVERITIES: readonly FindingSeverity[] = ["blocker", "major", "minor", "nit", "note"];
export const SEVERITY_LABELS: Record<FindingSeverity, string> = { blocker: "Blocker", major: "Major", minor: "Minor", nit: "Nit", note: "Note" };

const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MODEL = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** Markdown may hold tabs and newlines; other C0 controls and DEL are refused. */
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

type Plain = Record<string, unknown>;
function plain(value: unknown): value is Plain {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
function exactly(value: Plain, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((k) => Object.hasOwn(value, k));
}
/** Bounded text with no control characters or lone surrogates; `allowEmpty` admits blank text. */
export function agentText(value: unknown, limit: number, allowEmpty: boolean): string | null {
  if (typeof value !== "string" || value.length > limit || CONTROL.test(value) || LONE_SURROGATE.test(value)) return null;
  return allowEmpty || value.trim() ? value : null;
}

const FIELDS: Record<AgentOp, readonly string[]> = {
  status: ["key"],
  instructions: ["key", "text", "expectedVersion"],
  start: ["key", "revision", "kind", "question", "model"],
  stop: ["key", "runId"],
};

/**
 * Main's check on everything the renderer sends: a known operation, exactly its fields, each bounded and well
 * formed. Returns a fresh copy built from the validated fields, or null. Passing it grants nothing.
 */
export function validateAgent(input: unknown): AgentRequest | null {
  if (!plain(input) || typeof input.op !== "string" || !Object.hasOwn(FIELDS, input.op)) return null;
  const op = input.op as AgentOp;
  if (!exactly(input, ["op", "requestId", ...FIELDS[op]]) || typeof input.requestId !== "string" || !REQUEST_ID.test(input.requestId)) return null;
  const requestId = input.requestId;
  const scoped = validateRequest({ op: "overview", requestId: "agent", key: input.key });
  if (!scoped || scoped.op !== "overview") return null;
  const key = scoped.key;
  if (op === "status") return { op, requestId, key };
  if (op === "instructions") {
    const text = agentText(input.text, AGENT_LIMITS.instructions, true);
    if (text === null || !Number.isSafeInteger(input.expectedVersion) || (input.expectedVersion as number) < 0) return null;
    return { op, requestId, key, text, expectedVersion: input.expectedVersion as number };
  }
  if (op === "stop") {
    if (typeof input.runId !== "string" || !UUID.test(input.runId)) return null;
    return { op, requestId, key, runId: input.runId };
  }
  const target = validateRequest({ op: "checks", requestId: "agent", key: input.key, revision: input.revision });
  if (!target || target.op !== "checks") return null;
  if (input.kind !== "review" && input.kind !== "ask") return null;
  if (typeof input.model !== "string" || !MODEL.test(input.model)) return null;
  const question = input.question === null ? null : agentText(input.question, AGENT_LIMITS.question, false);
  if ((input.kind === "ask") !== (question !== null)) return null;
  return { op, requestId, key, revision: target.revision, kind: input.kind, question, model: input.model };
}
