import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { prKeyId, sameKey, sameRevision, type PrFile, type PrKey, type PrRevision } from "../../../shared/code-review.js";
import {
  AGENT_LIMITS, AGENT_REFUSALS, validateAgent,
  type AgentAvailability, type AgentInstructions, type AgentRefusal, type AgentReply, type AgentRequest, type AgentResult, type AgentRun, type AgentStatus, type AgentTrailEntry,
} from "../../../shared/code-review-agent.js";
import { CONVERSATION_SCHEMA, applyConversationEvent, initialConversation, type ConversationEvent, type ConversationState, type Observation, type TurnRef } from "../../../shared/conversation-events.js";
import type { Backend, TurnResult, TurnSink } from "../backends/types.js";
import { ClaudeBackend } from "../backends/claude.js";
import type { CliExecutable } from "../cli-path.js";
import { ghHostsStamp, ghTransport, type GhAnswer, type GhTransport } from "../code-review/gh.js";
import { changedFile, json, pull, repository, type Pull } from "../code-review/github.js";
import { planSnapshot, SNAPSHOT_LIMITS, systemPrompt, userPrompt, writeSnapshot, type SnapshotLimits, type SnapshotPlan } from "./context.js";
import { bindFindings, extractFindings } from "./findings.js";
import { AgentRecords } from "./records.js";

/**
 * CR-6 (#325): main's `code-review:agent` service. A review or a question runs the installed Claude Code CLI,
 * confined to a snapshot main builds from its own fresh GitHub reads (the person's `gh` login, GET only, through
 * the read path's transport), under the person's own account. It starts only on an explicit `start` from this
 * Mac's window, one run per pull request at a time, after main has confirmed the account, the pull request's
 * head and target and the CLI's availability. Its reply and findings are recorded against the revision they
 * were made about; nothing here posts, approves or merges, and no run is retried on its own.
 */
export interface CodeReviewAgentOptions {
  /** Where review-agent/state.json and each run's snapshot live (MODEX_HOME). */
  home: string;
  /** Off in demos, E2E and browser development, like the read and write services. */
  enabled?: boolean;
  transport?: GhTransport;
  identityStamp?: () => string | null;
  now?: () => number;
  identityTtlMs?: number;
  /** The confined backend. Tests pass a fake; the app passes the Claude Code executable it resolved. */
  backend?: Backend;
  executable?: CliExecutable;
  limits?: SnapshotLimits;
  /** Model calls the CLI may make in one run. */
  maxTurns?: number;
  /** Runs at once, across pull requests. */
  concurrent?: number;
}

type Account = { id: string; login: string };
interface Fresh { key: PrKey; account: Account; stamp: string | null; owner: string; name: string; pr: Pull }
interface Live {
  run: AgentRun;
  abort: AbortController;
  conversation: ConversationState;
  seq: number;
  dir: string;
  done: Promise<AgentRun>;
}

const KB = 1024, MB = 1024 * KB;
const READ_TIMEOUT_MS = 15_000, FILES_TIMEOUT_MS = 30_000;
const FILE_PAGES = 30, PAGE = 100;
const DETAIL = 600;

class Refused extends Error {
  constructor(readonly reason: AgentRefusal, readonly detail?: string) { super(reason); }
}

export class CodeReviewAgent {
  private readonly home: string;
  private readonly enabled: boolean;
  private readonly transport: GhTransport;
  private readonly stamp: () => string | null;
  private readonly now: () => number;
  private readonly ttl: number;
  private readonly backend: Backend;
  private readonly limits: SnapshotLimits;
  private readonly maxTurns: number;
  private readonly concurrent: number;
  private records: AgentRecords | null = null;
  private identity: (Account & { stamp: string | null; at: number }) | null = null;
  private availabilityCache: { at: number; value: AgentAvailability } | null = null;
  private readonly live = new Map<string, Live>();
  /** Runs that ended but whose record could not be written: shown settled from here; the file says running until a restart. */
  private readonly unrecorded = new Map<string, AgentRun>();
  /** PRs whose start is between its checks and its record: a second click waits, then finds it busy. */
  private readonly starting = new Set<string>();
  private disposed = false;
  private readonly uncertain = new Map<string, AgentRun>();

  constructor(options: CodeReviewAgentOptions) {
    this.home = options.home;
    this.enabled = options.enabled ?? true;
    this.transport = options.transport ?? ghTransport();
    this.stamp = options.identityStamp ?? ghHostsStamp;
    this.now = options.now ?? Date.now;
    this.ttl = options.identityTtlMs ?? 30_000;
    this.backend = options.backend ?? new ClaudeBackend(options.executable);
    this.limits = options.limits ?? SNAPSHOT_LIMITS;
    this.maxTurns = options.maxTurns ?? 60;
    this.concurrent = options.concurrent ?? 2;
  }

  /** The `code-review:agent` handler. `session` is main's name for the window that asked, never the renderer's. */
  async handle(input: unknown, session: string): Promise<AgentReply> {
    const request = validateAgent(input);
    if (!request) throw new Error("Invalid Code Review agent request.");
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(session)) throw new Error("Invalid Code Review session.");
    const reply = (result: AgentResult<unknown>) => ({ requestId: request.requestId, op: request.op, key: request.key, result }) as AgentReply;
    if (!this.enabled) return reply(refuse("disabled"));
    try {
      return reply({ state: "ok", value: await this.run(request) });
    } catch (error) {
      // Anything that is not one of this file's refusals reads as `failed`: no exception text leaves main.
      return reply(error instanceof Refused ? refuse(error.reason, error.detail) : refuse("failed"));
    }
  }

  private run(request: AgentRequest): Promise<unknown> {
    switch (request.op) {
      case "status": return this.status(request.key);
      case "instructions": return this.instructions(request.key, request.text, request.expectedVersion);
      case "start": return this.start(request);
      case "stop": return this.stop(request.key, request.runId);
    }
  }

  /** Ends every run; their records are left `running` for the next start to read as unknown, which is what they are. */
  async dispose(): Promise<void> {
    this.disposed = true;
    const pending = [...this.live.values()];
    for (const live of pending) live.abort.abort();
    await Promise.race([Promise.allSettled(pending.map((l) => l.done)), new Promise((resolve) => setTimeout(resolve, 8_000).unref())]);
    this.refreshUnconfirmed();
    if (this.live.size || this.uncertain.size) throw new Error("A review process has not confirmed its exit; its snapshot is preserved.");
  }

  // --- Local state ------------------------------------------------------------------------------

  private store(): AgentRecords {
    try {
      if (!this.records) {
        this.records = new AgentRecords(this.home);
        for (const run of this.records.unconfirmedStops()) this.uncertain.set(run.id, run);
      }
      return this.records;
    } catch {
      throw new Refused("storage");
    }
  }

  private local<T>(work: (records: AgentRecords) => T): T {
    const records = this.store();
    try {
      return work(records);
    } catch (error) {
      throw error instanceof Refused ? error : new Refused("storage");
    }
  }

  /** Signal zero observes only; a reused PID conservatively retains ownership. */
  private refreshUnconfirmed(): void {
    const records = this.store();
    for (const [id, run] of this.uncertain) {
      if (!run.stop?.pid) continue;
      try { process.kill(run.stop.pid, 0); continue; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") continue; }
      const confirmed: AgentRun = { ...run, state: "unknown", reason: "exit-observed", endedAt: new Date(this.now()).toISOString() };
      // Keep the original receipt, and release ownership only after the new observation is durable.
      records.put(confirmed);
      this.uncertain.delete(id);
      this.unrecorded.delete(id);
      try { fs.rmSync(path.join(this.home, "review-agent", "runs", id), { recursive: true, force: true }); } catch { /* retained for cleanup */ }
    }
  }

  // --- Operations -------------------------------------------------------------------------------

  private async status(key: PrKey): Promise<AgentStatus> {
    this.refreshUnconfirmed();
    const account = await this.account(key, false);
    const backend = await this.availability();
    const runs = this.local((records) => records.list(key)).map((run) => this.live.get(run.id)?.run ?? this.unrecorded.get(run.id) ?? run);
    const active = runs.find((run) => run.state === "running" || this.uncertain.has(run.id)) ?? null;
    return { account, instructions: this.local((records) => records.instructions()), backend, runs, active: active?.id ?? null };
  }

  private async instructions(key: PrKey, text: string, expectedVersion: number): Promise<AgentInstructions> {
    await this.account(key, false);
    const saved = this.local((records) => records.saveInstructions(text, expectedVersion, new Date(this.now()).toISOString()));
    if (!saved) throw new Refused("instructions-conflict");
    return saved;
  }

  private async start(request: Extract<AgentRequest, { op: "start" }>): Promise<AgentRun> {
    const id = prKeyId(request.key);
    if (this.disposed) throw new Refused("disabled");
    this.refreshUnconfirmed();
    if ([...this.uncertain.values()].some((run) => sameKey(run.key, request.key))) throw new Refused("busy", "The previous review process has not confirmed its exit.");
    if (this.starting.has(id) || [...this.live.values()].some((l) => sameKey(l.run.key, request.key))) throw new Refused("busy");
    if (this.live.size + this.starting.size + this.uncertain.size >= this.concurrent) throw new Refused("busy", "Another review run is going. Wait for it to finish.");
    this.starting.add(id);
    try {
      const backend = await this.availability(true);
      if (!backend.available) throw new Refused("backend-unavailable", backend.reason ?? undefined);
      if (!backend.models.some((m) => m.id === request.model)) throw new Refused("backend-unavailable", "That model isn't offered by Claude Code here.");
      const fresh = await this.fresh(request.key);
      this.current(fresh, request.revision);
      const files = await this.files(fresh);
      const plan = planSnapshot(files.rows, files.complete, fresh.pr.totals.files, this.limits);
      if (request.kind === "review" && !plan.included.length) throw new Refused("nothing-to-review");
      const instructions = this.local((records) => records.instructions());
      const run: AgentRun = {
        id: randomUUID(), kind: request.kind, key: request.key, revision: request.revision, question: request.question,
        instructionsVersion: instructions.version, backend: { id: "claude", version: backend.version, model: request.model },
        startedAt: new Date(this.now()).toISOString(), endedAt: null, state: "running", reason: null, detail: null,
        coverage: plan.coverage, reply: "", replyTruncated: false, findings: [], findingsMalformed: false, trail: [], toolCalls: 0, promptsRefused: 0,
      };
      const dir = path.join(this.home, "review-agent", "runs", run.id);
      try {
        writeSnapshot(path.join(dir, "snapshot"), { owner: fresh.owner, repo: fresh.name, number: request.key.number, title: fresh.pr.title, body: fresh.pr.body, authorLogin: fresh.pr.author.login, headRef: fresh.pr.headRef, revision: fresh.pr.revision, filesTotal: fresh.pr.totals.files }, plan);
      } catch {
        fs.rmSync(dir, { recursive: true, force: true });
        throw new Refused("storage");
      }
      // Durable before the CLI starts: a crash from here on leaves a record, never a second run.
      try {
        this.local((records) => records.put(run));
      } catch (error) {
        fs.rmSync(dir, { recursive: true, force: true });
        throw error;
      }
      if (this.disposed) {
        fs.rmSync(dir, { recursive: true, force: true });
        throw new Refused("disabled");
      }
      this.launch(run, dir, plan, instructions);
      return structuredClone(run);
    } finally {
      this.starting.delete(id);
    }
  }

  /** Ends a local child; GitHub is not consulted, so a stop works offline and signed out. */
  private async stop(key: PrKey, runId: string): Promise<AgentRun> {
    const live = this.live.get(runId);
    if (live && sameKey(live.run.key, key)) {
      live.abort.abort();
      return live.done;
    }
    const run = this.unrecorded.get(runId) ?? this.local((records) => records.get(runId));
    if (!run || !sameKey(run.key, key)) throw new Refused("no-run");
    return run;
  }

  // --- The run ----------------------------------------------------------------------------------

  private launch(run: AgentRun, dir: string, plan: SnapshotPlan, instructions: AgentInstructions): void {
    const snapshot = path.join(dir, "snapshot");
    // Findings bind only to what the run could read: the included patches, never a file the snapshot left out.
    const files: PrFile[] = plan.included.map((i) => i.file);
    const abort = new AbortController();
    const turn: TurnRef = { thread: `code-review:${prKeyId(run.key)}`, turn: run.id, attempt: run.id, backend: "claude" };
    // The projector takes events only inside an attempt it has seen start.
    const opened = applyConversationEvent(initialConversation(), { type: "attempt.start", schema: CONVERSATION_SCHEMA, id: `${run.id}:0`, seq: 1, at: new Date().toISOString(), turn });
    const live: Live = { run, abort, conversation: opened, seq: 1, dir, done: Promise.resolve(run) };
    const seen = new Set<string>();
    const sink: TurnSink = {
      observe: (observation: Observation) => {
        if (observation.source) {
          if (seen.has(observation.source)) return;
          seen.add(observation.source);
        }
        live.seq++;
        const id = observation.source ? `${observation.native.runtime}:${observation.source}` : `${run.id}:${live.seq}`;
        const event = { ...observation, schema: CONVERSATION_SCHEMA, id, seq: live.seq, at: new Date().toISOString(), turn } as ConversationEvent;
        live.conversation = applyConversationEvent(live.conversation, event);
        live.run = { ...live.run, ...this.project(live.conversation, snapshot) };
      },
      // The confinement asks for no prompt; one that arrives anyway is refused, and counted.
      approval: async () => { live.run = { ...live.run, promptsRefused: live.run.promptsRefused + 1 }; return "no"; },
      question: async () => ({ withdrawn: "ended" }),
      notice: () => {},
      session: () => {},
    };
    this.live.set(run.id, live);
    live.done = (async () => {
      let result: TurnResult;
      try {
        result = await this.backend.runTurn(userPrompt(run.kind, run.question), {
          cwd: snapshot, mode: "chat", plan: false, model: run.backend.model,
          confinement: { kind: "review-snapshot", systemPrompt: systemPrompt(run.kind, instructions), maxTurns: this.maxTurns },
        }, sink, abort.signal);
      } catch (error) {
        result = { status: "failed", error: `could not start: ${(error as Error).message}` };
      }
      const projected = this.project(live.conversation, snapshot);
      const settled = this.settle({ ...live.run, ...projected, ...(result.stop ? { stop: result.stop } : {}) }, result, files);
      if (result.stop?.outcome === "unconfirmed") this.uncertain.set(run.id, settled);
      live.run = settled;
      try {
        this.local((records) => records.put(settled));
      } catch {
        // The file keeps saying running until a restart reads it as unknown; until then this is the run's truth.
        this.unrecorded.set(run.id, settled);
      } finally {
        this.live.delete(run.id);
        if (!this.uncertain.has(run.id)) {
          try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* retained for cleanup */ }
        }
      }
      return settled;
    })();
  }

  /** The run as the conversation shows it now: the last reply's text, and every tool call as a trail entry, with the snapshot's path cut out. */
  private project(conversation: ConversationState, snapshot: string): Pick<AgentRun, "reply" | "replyTruncated" | "trail" | "toolCalls"> {
    const assistant = conversation.items.filter((item) => item.kind === "assistant");
    const text = assistant.length ? assistant[assistant.length - 1]!.text : "";
    const tools = conversation.items.filter((item): item is Extract<typeof item, { kind: "tool" }> => item.kind === "tool");
    const trail: AgentTrailEntry[] = tools.slice(0, AGENT_LIMITS.trail).map((item) => ({ name: item.name.slice(0, 128), title: withoutPaths(item.title, snapshot).slice(0, 2048), outcome: item.outcome ?? (item.status === "done" ? "unknown" : "running") }));
    return { reply: text.slice(0, AGENT_LIMITS.reply), replyTruncated: text.length > AGENT_LIMITS.reply, trail, toolCalls: tools.length };
  }

  private settle(run: AgentRun, result: TurnResult, files: PrFile[]): AgentRun {
    const endedAt = new Date(this.now()).toISOString();
    if (result.stop?.outcome === "unconfirmed") return { ...run, state: "unknown", reason: "stop-unconfirmed", endedAt: null };
    if (result.status === "interrupted") return { ...run, state: "stopped", reason: "stopped", endedAt };
    if (result.status === "failed") {
      const couldNotStart = typeof result.error === "string" && result.error.startsWith("could not start");
      // What the CLI said, without any local path it may name (its own executable, a config file, the home directory).
      return { ...run, state: "failed", reason: couldNotStart ? "could-not-start" : "backend-failed", detail: result.error ? withoutPaths(result.error, null).slice(0, DETAIL) : null, endedAt };
    }
    if (!run.reply.trim()) return { ...run, state: "failed", reason: "no-reply", endedAt };
    const extracted = extractFindings(run.reply);
    const findings = bindFindings(extracted.findings, files, run.key, run.revision);
    return { ...run, state: "completed", endedAt, reply: extracted.text, findings, findingsMalformed: extracted.malformed };
  }

  // --- The backend ------------------------------------------------------------------------------

  /**
   * Whether Claude Code can run a review here. A status never probes the CLI (opening a pull request starts no
   * process); it reports the last probe, or that nothing has been checked yet. A start probes, every time, and a
   * failed probe is reported for a while so the person sees why before it is offered again.
   */
  private async availability(force = false): Promise<AgentAvailability> {
    const cached = this.availabilityCache;
    if (!force) {
      if (cached && (cached.value.available || this.now() - cached.at < 30_000)) return cached.value;
      return { available: true, reason: null, version: cached?.value.version ?? null, models: await this.models() };
    }
    let value: AgentAvailability;
    try {
      const health = this.backend.health ? await this.backend.health() : null;
      const models = await this.models();
      const version = health?.version ?? null;
      if (health && health.executable !== "available") value = { available: false, reason: "Claude Code isn't installed, or Modex can't find it.", version, models };
      else if (health?.authentication === "signed-out") value = { available: false, reason: "Claude Code is signed out. Run `claude auth login`, then retry.", version, models };
      else if (!models.length) value = { available: false, reason: "Claude Code offers no model here.", version, models };
      else value = { available: true, reason: null, version, models };
    } catch {
      value = { available: false, reason: "Claude Code couldn't be checked.", version: null, models: [] };
    }
    this.availabilityCache = { at: this.now(), value };
    return value;
  }

  private async models(): Promise<AgentAvailability["models"]> {
    try {
      return (await this.backend.listModels()).map((m) => ({ id: m.id, label: m.label, isDefault: m.isDefault === true }));
    } catch {
      return [];
    }
  }

  // --- GitHub -----------------------------------------------------------------------------------

  /** The signed-in account, which must be the key's. A remembered answer that disagrees is checked again, never trusted. */
  private async account(key: PrKey, force: boolean): Promise<Account> {
    let account = await this.who(force);
    if (account.id !== key.account && !force) account = await this.who(true);
    if (account.id !== key.account) throw new Refused("account-changed");
    return account;
  }

  private async who(force: boolean): Promise<Account> {
    const stamp = this.stamp();
    const known = this.identity;
    if (!force && known && this.now() - known.at < this.ttl && stamp !== null && stamp === known.stamp) return { id: known.id, login: known.login };
    const answer = await this.get("user", 256 * KB, READ_TIMEOUT_MS, (kind) => { if (kind === "signed-out" || kind === "no-cli") this.identity = null; });
    const user = json(answer.body) as { id?: unknown; login?: unknown } | undefined;
    const id = typeof user?.id === "number" && Number.isSafeInteger(user.id) && user.id > 0 ? String(user.id) : null;
    const login = typeof user?.login === "string" && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(user.login) ? user.login : null;
    if (!id || !login) throw new Refused("failed");
    this.identity = { id, login, stamp, at: this.now() };
    return { id, login };
  }

  /** The account, the repository by its stable id and the pull request, read now. */
  private async fresh(key: PrKey): Promise<Fresh> {
    const stamp = this.stamp();
    const account = await this.account(key, true);
    const repo = repository(json((await this.get(`repositories/${key.repoId}`, MB, READ_TIMEOUT_MS)).body));
    if (!repo || repo.id !== key.repoId) throw new Refused("not-found");
    const pr = pull(json((await this.get(`repos/${enc(repo.owner)}/${enc(repo.name)}/pulls/${key.number}`, 4 * MB, READ_TIMEOUT_MS)).body));
    if (!pr || pr.base.id !== key.repoId || pr.number !== key.number) throw new Refused("not-found");
    return { key, account, stamp, owner: repo.owner, name: repo.name, pr };
  }

  /** The revision the person is looking at must still be the PR's. */
  private current(fresh: Fresh, revision: PrRevision): void {
    if (fresh.pr.revision.headSha !== revision.headSha) throw new Refused("head-changed");
    if (!sameRevision(fresh.pr.revision, revision)) throw new Refused("target-changed");
  }

  /** The changed files, every page main can read, bracketed by a head check so the patches are the revision's. */
  private async files(fresh: Fresh): Promise<{ rows: PrFile[]; complete: boolean }> {
    const root = `repos/${enc(fresh.owner)}/${enc(fresh.name)}/pulls/${fresh.key.number}/files`;
    const rows: PrFile[] = [];
    let complete = false;
    for (let page = 1; page <= FILE_PAGES; page++) {
      const list = json((await this.get(`${root}?per_page=${PAGE}&page=${page}`, 24 * MB, FILES_TIMEOUT_MS)).body);
      if (!Array.isArray(list) || list.length > PAGE) throw new Refused("failed");
      for (const row of list) {
        const file = changedFile(row);
        if (!file) throw new Refused("failed");
        rows.push(file);
      }
      if (list.length < PAGE) { complete = true; break; }
    }
    const after = await this.fresh(fresh.key);
    this.current(after, fresh.pr.revision);
    if (this.stamp() !== fresh.stamp) throw new Refused("account-changed");
    return { rows, complete: complete && rows.length === fresh.pr.totals.files };
  }

  private async get(endpoint: string, maxBytes: number, timeoutMs: number, onFailure?: (kind: Exclude<GhAnswer["kind"], "http">) => void): Promise<{ body: Buffer }> {
    const answer = await this.transport({ endpoint, accept: "application/vnd.github+json", etag: null, maxBytes, timeoutMs, signal: new AbortController().signal });
    if (answer.kind !== "http") { onFailure?.(answer.kind); throw new Refused(transportRefusal(answer.kind)); }
    if (answer.status < 200 || answer.status >= 300) {
      if (answer.status === 401) this.identity = null;
      throw new Refused(httpRefusal(answer));
    }
    return answer;
  }
}

const enc = (segment: string) => encodeURIComponent(segment);

/** Text with the snapshot directory made relative and every other absolute path replaced: no local path crosses the bridge. */
function withoutPaths(text: string, snapshot: string | null): string {
  const relative = snapshot ? text.split(`${snapshot}/`).join("").split(snapshot).join(".") : text;
  return relative.replace(/(?:^|(?<=[\s"'`(:=]))(?:[A-Za-z]:)?(?:\/|\\)(?:[^\s"'`()<>|]+(?:\/|\\))+[^\s"'`()<>|:,;]*/g, "<path>");
}

function refuse(reason: AgentRefusal, detail?: string): AgentResult<never> {
  return { state: "refused", reason, detail: detail ?? AGENT_REFUSALS[reason] };
}

function transportRefusal(kind: Exclude<GhAnswer["kind"], "http">): AgentRefusal {
  return kind === "no-cli" ? "no-cli" : kind === "signed-out" ? "signed-out" : kind === "offline" ? "offline" : kind === "timeout" ? "timeout" : "failed";
}

function httpRefusal(answer: Extract<GhAnswer, { kind: "http" }>): AgentRefusal {
  if (answer.status === 401) return "signed-out";
  if (answer.status === 429 || (answer.status === 403 && answer.headers["x-ratelimit-remaining"] === "0")) return "rate-limited";
  if (answer.status === 403) return "denied";
  if (answer.status === 404 || answer.status === 410) return "not-found";
  return "failed";
}
