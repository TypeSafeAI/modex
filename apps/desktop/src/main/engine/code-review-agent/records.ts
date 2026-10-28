import path from "node:path";
import { sameKey, validateRequest } from "../../../shared/code-review.js";
import { AGENT_LIMITS, SEVERITIES, type AgentFinding, type AgentInstructions, type AgentRun } from "../../../shared/code-review-agent.js";
import { AttachmentRecoveryFile, recoveryJSON, type RecoveryFileSnapshot } from "../attachment-recovery-file.js";

/**
 * CR-6 (#325): the person's review instructions and the runs' records, in one bounded main-owned file with the
 * recovery-file adapter's compare-and-replace, symlink checks and durability. A run is recorded before its CLI
 * starts, so a crash leaves a record that the next start reads as `unknown`: nothing is ever re-run from here.
 */
/**
 * A run as stored: the recovery serializer admits at most 16 keys per object, so the record's flat fields are
 * grouped. `toRun`/`toStored` convert at the boundary; nothing else sees this shape.
 */
interface StoredRun {
  id: string; kind: AgentRun["kind"]; key: AgentRun["key"]; revision: AgentRun["revision"]; question: string | null; instructionsVersion: number; backend: AgentRun["backend"];
  time: { startedAt: string; endedAt: string | null };
  outcome: { state: AgentRun["state"]; reason: AgentRun["reason"]; detail: string | null; promptsRefused: number };
  coverage: AgentRun["coverage"];
  output: { reply: string; replyTruncated: boolean; findings: AgentFinding[]; findingsMalformed: boolean; trail: AgentRun["trail"]; toolCalls: number };
}
interface Document { schema: 1; instructions: AgentInstructions; runs: StoredRun[] }

function toStored(run: AgentRun): StoredRun {
  const { id, kind, key, revision, question, instructionsVersion, backend, startedAt, endedAt, state, reason, detail, promptsRefused, coverage, reply, replyTruncated, findings, findingsMalformed, trail, toolCalls } = run;
  return { id, kind, key, revision, question, instructionsVersion, backend, time: { startedAt, endedAt }, outcome: { state, reason, detail, promptsRefused }, coverage, output: { reply, replyTruncated, findings, findingsMalformed, trail, toolCalls } };
}
function toRun(v: unknown): AgentRun | null {
  if (!isObject(v) || !isObject(v.time) || !isObject(v.outcome) || !isObject(v.output)) return null;
  const { id, kind, key, revision, question, instructionsVersion, backend, coverage } = v;
  const run = { id, kind, key, revision, question, instructionsVersion, backend, ...v.time, ...v.outcome, coverage, ...v.output };
  return validRun(run) ? run : null;
}

const BYTES = 4 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STATES = new Set(["running", "completed", "failed", "stopped", "unknown"]);
const REASONS = new Set(["stopped", "restart", "backend-failed", "could-not-start", "no-reply"]);
const OMISSIONS = new Set(["binary", "too-large", "provider", "budget", "file-cap"]);
const REFERENCES = new Set(["anchored", "unverified", "none"]);
const failure = () => new Error("Review agent data is invalid; existing records were preserved.");
const copy = <T>(value: T): T => structuredClone(value);
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isText = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;
const isCount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const isTime = (v: unknown): v is string => typeof v === "string" && !Number.isNaN(Date.parse(v));

function validInstructions(v: unknown): v is AgentInstructions {
  return isObject(v) && isCount(v.version) && isText(v.text, AGENT_LIMITS.instructions) && (v.updatedAt === null || isTime(v.updatedAt));
}
function validFinding(v: unknown): v is AgentFinding {
  if (!isObject(v) || !UUID.test(String(v.id)) || !isText(v.title, AGENT_LIMITS.findingTitle) || !isText(v.detail, AGENT_LIMITS.findingDetail)) return false;
  if (!SEVERITIES.includes(v.severity as never) || !(v.path === null || isText(v.path, 1024)) || !REFERENCES.has(String(v.reference))) return false;
  if (!(v.line === null || isCount(v.line)) || !(v.endLine === null || isCount(v.endLine))) return false;
  if (v.anchor === null) return v.reference !== "anchored";
  return v.reference === "anchored" && isObject(v.anchor) && validateRequest({ op: "context", requestId: "record", key: v.anchor.key, revision: v.anchor.revision, side: v.anchor.side, path: v.anchor.path, start: v.anchor.start, end: v.anchor.end }) !== null
    && typeof v.anchor.commitSha === "string";
}
function validRun(v: unknown): v is AgentRun {
  if (!isObject(v) || !UUID.test(String(v.id)) || (v.kind !== "review" && v.kind !== "ask")) return false;
  if (validateRequest({ op: "checks", requestId: "record", key: v.key, revision: v.revision }) === null) return false;
  if (!(v.question === null || isText(v.question, AGENT_LIMITS.question)) || !isCount(v.instructionsVersion)) return false;
  const backend = v.backend;
  if (!isObject(backend) || backend.id !== "claude" || !(backend.version === null || isText(backend.version, 64)) || !isText(backend.model, AGENT_LIMITS.model)) return false;
  if (!isTime(v.startedAt) || !(v.endedAt === null || isTime(v.endedAt)) || !STATES.has(String(v.state)) || !(v.reason === null || REASONS.has(String(v.reason)))) return false;
  if (!(v.detail === null || isText(v.detail, 1024)) || !isText(v.reply, AGENT_LIMITS.reply) || typeof v.replyTruncated !== "boolean" || typeof v.findingsMalformed !== "boolean") return false;
  const coverage = v.coverage;
  if (!isObject(coverage) || !Array.isArray(coverage.included) || !Array.isArray(coverage.omitted) || !isCount(coverage.bytes) || !(coverage.filesTotal === null || isCount(coverage.filesTotal)) || typeof coverage.listComplete !== "boolean") return false;
  if (!coverage.included.every((i) => isObject(i) && isText(i.path, 1024) && isCount(i.bytes))) return false;
  if (!coverage.omitted.every((o) => isObject(o) && isText(o.path, 1024) && OMISSIONS.has(String(o.reason)))) return false;
  if (!Array.isArray(v.findings) || v.findings.length > AGENT_LIMITS.findings || !v.findings.every(validFinding)) return false;
  if (!Array.isArray(v.trail) || v.trail.length > AGENT_LIMITS.trail || !v.trail.every((t) => isObject(t) && isText(t.name, 128) && isText(t.title, 2048) && isText(t.outcome, 16))) return false;
  return isCount(v.toolCalls) && isCount(v.promptsRefused);
}
function validate(value: unknown): void {
  if (!isObject(value) || value.schema !== 1 || !validInstructions(value.instructions) || !Array.isArray(value.runs) || !value.runs.every((r) => toRun(r) !== null)) throw failure();
}

const settled = (run: StoredRun) => run.outcome.state !== "running";
const runs = (data: Document): AgentRun[] => data.runs.map((r) => toRun(r)!);

export class AgentRecords {
  private readonly file: AttachmentRecoveryFile<Document>;
  private snapshot: RecoveryFileSnapshot<Document>;
  private blocked = false;

  constructor(home: string) {
    this.file = new AttachmentRecoveryFile(path.join(home, "review-agent"), "state.json", BYTES, validate);
    this.snapshot = this.file.read();
    const data = this.data();
    let changed = false;
    // A run that was running when main last stopped is unknown: its CLI is gone and nothing restarts it.
    for (const run of data.runs) if (run.outcome.state === "running") { run.outcome.state = "unknown"; run.outcome.reason = "restart"; run.time.endedAt ??= new Date().toISOString(); changed = true; }
    if (changed) this.commit(data);
  }

  private data(): Document {
    return this.snapshot.value ? copy(this.snapshot.value) as Document : { schema: 1, instructions: { version: 0, text: "", updatedAt: null }, runs: [] };
  }

  private commit(data: Document): void {
    if (this.blocked) throw new Error("Review agent storage requires recovery.");
    try {
      this.snapshot = this.file.write(this.snapshot, data);
    } catch (cause) {
      this.blocked = true;
      throw new Error("Review agent storage requires recovery; nothing was started.", { cause });
    }
  }

  instructions(): AgentInstructions {
    return this.data().instructions;
  }

  /** Versioned, so a stale editor can't overwrite a newer text. Returns null on a version mismatch. */
  saveInstructions(text: string, expectedVersion: number, now: string): AgentInstructions | null {
    const data = this.data();
    if (data.instructions.version !== expectedVersion) return null;
    const next: AgentInstructions = { version: expectedVersion + 1, text, updatedAt: now };
    if (!validInstructions(next)) return null;
    data.instructions = next;
    this.commit(data);
    return copy(next);
  }

  get(id: string): AgentRun | null {
    return runs(this.data()).find((r) => r.id === id) ?? null;
  }

  /** This PR's runs, newest first. */
  list(key: AgentRun["key"]): AgentRun[] {
    return runs(this.data()).filter((r) => sameKey(r.key, key)).sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
  }

  /** Inserts or replaces a run by id, then prunes settled runs beyond the bounds; a running run is never dropped. */
  put(input: AgentRun): AgentRun {
    let stored: StoredRun;
    try { stored = JSON.parse(recoveryJSON(toStored(input), BYTES)); } catch { throw failure(); }
    const run = toRun(stored);
    if (!run) throw failure();
    const data = this.data();
    const index = data.runs.findIndex((r) => r.id === stored.id);
    if (index < 0) data.runs.push(stored); else data.runs[index] = stored;
    prune(data);
    this.commit(data);
    return run;
  }
}

/** Oldest settled runs go first: over the per-PR count, over the total, then until the file fits the serializer's bounds. */
function prune(data: Document): void {
  const drop = (test: (run: StoredRun) => boolean) => {
    const victim = data.runs.map((run, i) => ({ run, i })).filter(({ run }) => settled(run) && test(run)).sort((a, b) => (a.run.time.startedAt < b.run.time.startedAt ? -1 : 1))[0];
    if (!victim) return false;
    data.runs.splice(victim.i, 1);
    return true;
  };
  const pr = (run: StoredRun) => `${run.key.account}/${run.key.host}/${run.key.repoId}/${run.key.number}`;
  const perPr = () => {
    const counts = new Map<string, number>();
    for (const run of data.runs) counts.set(pr(run), (counts.get(pr(run)) ?? 0) + 1);
    return [...counts.entries()].find(([, n]) => n > AGENT_LIMITS.runsPerPr)?.[0] ?? null;
  };
  for (let over = perPr(); over; over = perPr()) if (!drop((run) => pr(run) === over)) break;
  while (data.runs.length > AGENT_LIMITS.runs && drop(() => true));
  const fits = () => { try { recoveryJSON(data, BYTES - 64 * 1024); return true; } catch { return false; } };
  while (data.runs.length && !fits() && drop(() => true));
}
