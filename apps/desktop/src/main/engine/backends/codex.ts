import { requestedPermissions } from "./codex-permissions.js";
import { AgentTracker } from "./agents.js";
import { PAGES_TOOLS } from "../../../shared/pages.js";
import { KNOWLEDGE_TOOLS } from "../../../shared/knowledge.js";
import type { CliExecutable } from "../cli-path.js";
import { generateTitle } from "../titles.js";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Backend, ModelInfo, NativeRequest, TitleOptions, TurnOptions, TurnResult, TurnSink } from "./types.js";
import { LineBuffer, stderrTail, writeJsonResponse } from "./types.js";
import { codexCall, UsageMeter, withUsage } from "./usage.js";
import { cliEnvironment, cliSpawn, health, installation } from "./health.js";
import type { AgentActivity, BackendHealth } from "../../../shared/types.js";
import type { MessageAsk, MessagePhase, NativeRef, PlanStepStatus, SettledOutcome } from "../../../shared/conversation-events.js";
import { boundOutput, byteLength, codexWebSearch, memoryEvidence, type ExecAction } from "../../../shared/evidence.js";
import { actionDigest, codexAnswerResponse, codexQuestions } from "../../../shared/human-requests.js";

/**
 * Codex's own wording when the sign-in it loaded at startup no longer matches ~/.codex/auth.json
 * (the user ran `codex login` again, or as someone else, while the app-server was running). The
 * server refuses to refresh the old token; a fresh server reads the file again and works.
 */
const STALE_AUTH = /(?:access token|authentication session) could not be refreshed/i;

/**
 * Drives the Codex CLI through `codex app-server`, the JSON-RPC-over-stdio protocol the
 * official Codex App uses. One server process is shared by all Codex threads; each Modex
 * thread maps to a Codex thread id, which is the resume handle. Approvals arrive as server
 * requests (`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`).
 */
export class CodexBackend implements Backend {
  readonly id = "codex" as const;
  private child: ChildProcess | null = null;
  private ready: Promise<void> | null = null;
  private nextId = 1;
  /** Includes turns still awaiting initialize/thread creation, before they subscribe to events. */
  private activeTurns = 0;
  private readonly pending = new Map<number, { method: string; resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly subscribers = new Set<(msg: RpcMessage) => void>();
  private readonly disconnects = new Set<(error: Error) => void>();
  private readonly loaded = new Set<string>();
  /** The model Codex chose for each loaded thread, from thread/start or thread/resume: a Plan turn's collaboration mode needs one. */
  private readonly threadModels = new Map<string, string>();
  /** File paths of in-flight file changes, keyed `threadId:itemId`, so an approval can name them without the patch. */
  private readonly changePaths = new Map<string, string[]>();
  /** From the `initialize` reply: which codex build the server is. Kept for failure reports. */
  private userAgent: string | null = null;
  /** Opaque id of the running app-server process; native thread, turn and item ids are unique only within it. */
  private generation = "";
  /**
   * Server requests waiting on a person, keyed `generation:id`. Codex's `serverRequest/resolved` for one still
   * here means Codex settled it itself (codex-cli 0.163.0): the card is withdrawn and no answer is sent.
   */
  private readonly openRequests = new Map<string, { controller: AbortController; thread: unknown }>();

  /**
   * How long a turn stays open after Codex's final answer with nothing else in progress, when Codex
   * never sends `turn/completed` (seen live on codex-cli 0.163.0, docs/task-context.md#live-codex-captures).
   */
  quietAfterFinalMs = 5 * 60_000;

  private get bin(): string { return typeof this.executable === "function" ? this.executable() : this.executable; }

  constructor(private readonly executable: CliExecutable = process.env.MODEX_CODEX_BIN ?? "codex", private readonly spawnImpl = cliSpawn,
    private readonly configuration?: { args: string[]; env: NodeJS.ProcessEnv; redact: (text: string) => string }) {}

  private ensure(): Promise<void> {
    if (this.ready && this.child && this.child.exitCode === null) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      let child: ChildProcess;
      let bin = "codex";
      try {
        bin = this.bin;
        child = this.spawnImpl(bin, ["app-server", "-c", 'model_reasoning_summary="detailed"', ...(this.configuration?.args ?? [])], { stdio: ["pipe", "pipe", "pipe"], env: cliEnvironment(bin, this.configuration?.env), detached: true });
      } catch (err) {
        return reject(new CodexError(`could not start ${bin} app-server: ${(err as Error).message}`, { bin, spawnError: (err as Error).message }));
      }
      this.child = child;
      this.generation = randomUUID();
      this.loaded.clear();
      this.threadModels.clear();
      const lines = new LineBuffer();
      let stderr = "";
      child.stderr?.on("data", (d: Buffer) => (stderr = (stderr + d.toString()).slice(-16_384)));
      child.stdout?.on("data", (d: Buffer) => { if (this.child === child) lines.push(d, (line) => this.dispatch(line)); });
      child.on("error", (err) => {
        const error = new CodexError(`${bin}: ${err.message}. Is the Codex CLI installed and on PATH?`, { bin, spawnError: err.message, errno: (err as NodeJS.ErrnoException).code, pid: child.pid });
        if (this.child === child) this.disconnect(error);
        reject(error);
      });
      child.on("close", (code, signal) => {
        const output = this.configuration?.redact(stderr) ?? stderr;
        if (this.child === child) this.disconnect(new CodexError(`codex app-server exited (${code}) ${output.trim().split("\n").slice(-2).join(" ")}`, { exitCode: code, signal, stderr: stderrTail(output), pid: child.pid, userAgent: this.userAgent }));
      });
      this.request<{ userAgent?: string }>("initialize", { clientInfo: { name: "modex", title: "Modex", version: process.env.MODEX_VERSION ?? "0.0.1" }, capabilities: { experimentalApi: true } }, 5000)
        .then((r) => {
          this.userAgent = typeof r?.userAgent === "string" ? r.userAgent : null;
          this.notify("initialized", {});
          resolve();
        })
        .catch(reject);
    });
    return this.ready;
  }

  private disconnect(error: Error): void {
    this.child = null;
    this.ready = null;
    this.loaded.clear();
    this.threadModels.clear();
    for (const request of this.openRequests.values()) request.controller.abort();
    this.openRequests.clear();
    for (const p of this.pending.values()) p.reject(error);
    this.pending.clear();
    for (const finish of this.disconnects) finish(error);
  }

  private dispatch(line: string): void {
    let msg: RpcMessage;
    try {
      msg = JSON.parse(line, (_key, value: unknown) => typeof value === "string" ? this.configuration?.redact(value) ?? value : value) as RpcMessage;
    } catch {
      return;
    }
    if (typeof msg.id === "number" && !msg.method) {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new CodexError(msg.error.message ?? "codex error", { method: p.method, rpcCode: msg.error.code, rpcData: msg.error.data }));
        else p.resolve(msg.result);
      }
      return;
    }
    for (const s of this.subscribers) s(msg);
  }

  private send(o: unknown): void {
    this.child?.stdin?.write(JSON.stringify(o) + "\n");
  }

  private request<T = unknown>(method: string, params: unknown, timeoutMs?: number): Promise<T> {
    if (!this.child || this.child.exitCode !== null || !this.child.stdin?.writable) {
      return Promise.reject(new CodexError("codex app-server is not running", { method }));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("timeout"));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: (value) => { clearTimeout(timer); resolve(value as T); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.send({ id, method, params });
    });
  }

  private notify(method: string, params: unknown): void {
    this.send({ method, params });
  }

  private respond(id: unknown, result: unknown): void {
    this.send({ id, result });
  }

  async listModels(): Promise<ModelInfo[]> {
    await this.ensure();
    const res = await this.request<{ data: CodexModel[] }>("model/list", {});
    return res.data
      .filter((m) => !m.hidden)
      .map((m) => ({
        id: m.id, label: m.displayName || m.id, description: m.description, isDefault: m.isDefault,
        efforts: m.supportedReasoningEfforts?.map((e) => e.reasoningEffort), defaultEffort: m.defaultReasoningEffort,
        serviceTiers: m.serviceTiers?.map((t) => t.id), defaultServiceTier: m.defaultServiceTier ?? undefined,
      }));
  }

  async health() {
    const installed = await installation(this.bin, this.spawnImpl);
    if (installed.unavailable) return installed.unavailable;
    const report = (authentication: BackendHealth["authentication"], detail: string) => health(authentication, detail, "available", installed.version);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        this.ensure().then(() => this.request<{ account: { type?: unknown } | null; requiresOpenaiAuth?: boolean }>("account/read", { refreshToken: false }, 5000)),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), 5000); }),
      ]);
      if (result.account?.type === "chatgpt") return report("authenticated", "ChatGPT signed in · model access unverified");
      if (result.account?.type === "apiKey") return report("authenticated", "API key configured · model access unverified");
      if (result.account !== null) return report("unknown", "Account status unavailable · check in Codex CLI");
      if (result.requiresOpenaiAuth === false) return report("unknown", "Custom provider · account status unknown");
      return report("signed-out", "Signed out · run codex login");
    } catch (error) {
      if (error instanceof CodexError && error.detail.rpcCode === -32601) return report("unsupported", "CLI does not support account status · update Codex");
      return report("unknown", (error as Error).message === "timeout" ? "Account check timed out" : "Account status unavailable · check in Codex CLI");
    } finally { clearTimeout(timer); }
  }

  /**
   * Kills the shared app-server and every command it started. Every running Codex turn ends:
   * the stopped ones as interrupted, any others as failed. The next turn starts a fresh server.
   */
  async forceStop(): Promise<void> {
    this.restart("Codex was force-stopped from another thread. Send again to continue.");
  }

  /**
   * Interrupting a turn does not end a command Codex moved to a background terminal (codex-cli
   * 0.163.0, `unified_exec`): on 2026-10-20 a stopped `sleep 30` wrote its file half a minute later.
   * Ends this turn's own terminals, never an earlier turn's, and calls a command interrupted only
   * once Codex no longer lists it. Anything Codex cannot confirm stays unknown, with a notice.
   */
  private async endTerminals(threadId: string, commands: ReadonlySet<string>, settle: (item: string, outcome: "interrupted" | "unknown") => void, sink: TurnSink): Promise<void> {
    type Terminal = { itemId?: string; processId?: string };
    const list = async () => (await this.request<{ data?: Terminal[] }>("thread/backgroundTerminals/list", { threadId }, 3000))?.data ?? [];
    let running: Set<string>;
    try {
      for (const terminal of (await list()).filter((t) => t.itemId && commands.has(t.itemId) && t.processId)) {
        await this.request("thread/backgroundTerminals/terminate", { threadId, processId: terminal.processId }, 3000).catch(() => undefined);
      }
      running = new Set((await list()).map((t) => t.itemId ?? "").filter((id) => commands.has(id)));
    } catch {
      running = new Set(commands);
    }
    for (const id of commands) settle(id, running.has(id) ? "unknown" : "interrupted");
    if (running.size) sink.notice("warn", `Codex stopped the turn but did not confirm that ${running.size === 1 ? "its command" : `${running.size} commands`} ended. ${running.size === 1 ? "It" : "They"} may still be running in a Codex background terminal.`);
  }

  /** Ends the current server (and its commands); the next request starts a fresh one. */
  private restart(reason: string): void {
    const child = this.child;
    if (!child) return;
    this.disconnect(new CodexError(reason, { pid: child.pid }));
    killGroup(child);
  }

  async dispose(): Promise<void> {
    const child = this.child;
    this.disconnect(new CodexError("codex app-server disposed", {}));
    if (child) await new Promise<void>((resolve) => {
      child.once("close", () => resolve());
      killGroup(child);
    });
  }

  /** Mode → Codex approval policy + sandbox policy. Exported for tests. */
  static policy(opts: TurnOptions): { approvalPolicy: string; sandbox: string; sandboxPolicy: Record<string, unknown> } {
    const roots = opts.addDirs ?? [];
    if (opts.plan || opts.mode === "chat") return { approvalPolicy: "untrusted", sandbox: "read-only", sandboxPolicy: { type: "readOnly", networkAccess: false } };
    if (opts.mode === "agent") return { approvalPolicy: "on-request", sandbox: "workspace-write", sandboxPolicy: { type: "workspaceWrite", writableRoots: roots, networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false } };
    return { approvalPolicy: "never", sandbox: "danger-full-access", sandboxPolicy: { type: "dangerFullAccess" } };
  }

  generateTitle(text: string, opts: TitleOptions, signal: AbortSignal): Promise<string | null> {
    return generateTitle(this, opts, text, signal);
  }

  /**
   * One turn, with one silent recovery: when Codex reports that its sign-in went stale, the turn
   * is run again on a server that has read the current sign-in. Other failures return as they are.
   */
  async runTurn(text: string, opts: TurnOptions, sink: TurnSink, signal: AbortSignal): Promise<TurnResult> {
    this.activeTurns++;
    try {
      const first = await this.attempt(text, opts, sink, signal);
      if (first.status !== "failed" || signal.aborted || !STALE_AUTH.test(first.error ?? "")) return first;
      // A fresh server reads ~/.codex/auth.json again. While other threads are mid-turn on this one,
      // keep it and retry in place instead; never interrupt another thread to refresh auth.
      const shared = this.activeTurns > 1 || this.pending.size > 0;
      const step = shared
        ? "retried once on the running codex app-server (other Codex turns were active)"
        : "restarted codex app-server so it reads the current sign-in, then retried once";
      sink.notice("info", "Codex's sign-in changed since it started. Reconnecting and retrying…");
      if (!shared) this.restart("Codex was restarted to pick up a new sign-in.");
      const opened = first.detail?.codexThreadId;
      const resume = typeof opened === "string" ? opened : opts.resume;
      const second = await this.attempt(text, { ...opts, resume }, sink, signal);
      if (second.status !== "failed") return second;
      return { ...second, detail: { ...second.detail, firstAttempt: { error: first.error, ...first.detail } }, recovery: [`${step}: failed again`] };
    } finally {
      this.activeTurns--;
    }
  }

  private async attempt(text: string, opts: TurnOptions, sink: TurnSink, signal: AbortSignal): Promise<TurnResult> {
    if (signal.aborted) return { status: "interrupted" };
    const failed = (err: unknown, extra: Record<string, unknown>): TurnResult =>
      signal.aborted ? { status: "interrupted" } : { status: "failed", error: (err as Error).message, detail: { ...extra, ...detailOf(err), userAgent: this.userAgent, pid: this.child?.pid } };
    try {
      await duringSetup(this.ensure(), signal);
    } catch (err) {
      return failed(err, { stage: "start app-server" });
    }
    const pol = CodexBackend.policy(opts);
    // Only these scoped adapter tools are preapproved. Main enforces project/turn permissions.
    const config = { ...THREAD_CONFIG, ...(opts.images ? { "mcp_servers.modex_images": { url: opts.images.url, enabled_tools: ["register"], tools: { register: { approval_mode: "approve" } } } } : {}), ...(opts.knowledge ? { "mcp_servers.modex_knowledge": {
      url: opts.knowledge.url, enabled_tools: [...KNOWLEDGE_TOOLS],
      tools: Object.fromEntries(KNOWLEDGE_TOOLS.map(name => [name, { approval_mode: "approve" }])),
    } } : {}), ...(opts.pages ? { "mcp_servers.modex_pages": {
      url: opts.pages.url, enabled_tools: [...PAGES_TOOLS],
      tools: Object.fromEntries(PAGES_TOOLS.map(name => [name, { approval_mode: "approve" }])),
    } } : {}) };
    let threadId = opts.resume;
    try {
      if (threadId && !this.loaded.has(threadId)) {
        const r = await duringSetup(this.request<{ thread: { id: string }; model?: unknown }>("thread/resume", { threadId, cwd: opts.cwd, approvalPolicy: pol.approvalPolicy, sandbox: pol.sandbox, model: opts.model || null, config }), signal);
        threadId = r.thread.id;
        if (typeof r.model === "string" && r.model) this.threadModels.set(threadId, r.model);
      } else if (!threadId) {
        const r = await duringSetup(this.request<{ thread: { id: string }; model?: unknown }>("thread/start", { cwd: opts.cwd, approvalPolicy: pol.approvalPolicy, sandbox: pol.sandbox, model: opts.model || null, config }), signal);
        threadId = r.thread.id;
        if (typeof r.model === "string" && r.model) this.threadModels.set(threadId, r.model);
      }
    } catch (err) {
      return failed(err, { stage: "open thread", codexThreadId: opts.resume });
    }
    if (signal.aborted) return { status: "interrupted" };
    this.loaded.add(threadId);
    sink.session(threadId);

    const tid = threadId;
    const context = [opts.knowledge?.instructions, opts.pages?.instructions, opts.images?.instructions, text].filter(value => value !== undefined).join("\n\n");
    // Plan mode runs in Codex's native plan collaboration mode (codex-cli 0.163.0, experimental): Codex's own plan
    // instructions, its question tool offered by default, and the plan as a `plan` item. The mode overrides the
    // turn's model and effort, so it carries Modex's. Without a model to name, or when Codex refuses the mode,
    // the turn falls back to the prompt prefix (docs/reviews/2026-10-22-cf3-plan-mode-decision.md).
    const planModel = opts.plan ? opts.model || this.threadModels.get(threadId) : undefined;
    const collaborationMode = planModel ? { mode: "plan", settings: { model: planModel, reasoning_effort: opts.effort ?? null, developer_instructions: null } } : undefined;
    const prefixed = opts.plan ? `${PLAN_PREFIX}\n\n${context}` : context;
    const input = collaborationMode ? context : prefixed;
    const runtime = this.generation;
    const seenRequests = new Map<string, string>();
    const agents = new AgentTracker(sink, runtime);
    const activities = new Set<string>();
    // Output is kept bounded as it streams (its last 256 KiB), with the total seen.
    const tools = new Map<string, { started: number; output: string; bytes: number }>();
    // Commands Codex started and has not completed. With `unified_exec` one can outlive its turn.
    const commands = new Set<string>();
    let turnId: string | null = null;
    // Codex announces a fatal error as an `error` notification before `turn/completed` reports the
    // failure. The notification carries the better message and an error code; it is held here and
    // reported once, with the completion, instead of as a separate red line.
    let lastError: Record<string, unknown> | null = null;
    const retried: string[] = [];
    const meter = new UsageMeter();
    // Output comes from the thread's running total: the total before this turn's first response, then the latest.
    let outputBase: number | undefined;
    let outputNow: number | undefined;

    return new Promise<TurnResult>((resolve) => {
      let done = false;
      let starting = true;
      const queued: RpcMessage[] = [];
      let abortTimer: ReturnType<typeof setTimeout> | undefined;
      // Set by Codex's final answer, or by the plan it proposes in plan mode, and cleared by any later item;
      // arms `quiet` while nothing else is open.
      let answered: "answer" | "plan" | false = false;
      let quiet: ReturnType<typeof setTimeout> | undefined;
      let interrupted = false;
      // Set once Codex reports the turn interrupted while ending its background terminals.
      let stopping = false;
      const child = this.child;
      const detail = (extra: Record<string, unknown>): Record<string, unknown> => ({
        codexThreadId: tid, turnId, userAgent: this.userAgent, pid: child?.pid, ...(retried.length ? { retriedErrors: retried } : {}), ...(lastError ? { errorNotification: lastError } : {}), ...extra,
      });
      const interrupt = () => {
        if (interrupted || !turnId || this.child !== child) return;
        interrupted = true;
        void this.request("turn/interrupt", { threadId: tid, turnId }).catch(() => {});
      };
      const onDisconnect = (error: Error) => finish(signal.aborted ? { status: "interrupted" } : { status: "failed", error: error.message, detail: detail(detailOf(error)) });
      const finish = (r: TurnResult) => {
        if (done) return;
        done = true;
        agents.finish(signal.aborted || r.status === "interrupted");
        this.subscribers.delete(onMsg);
        this.disconnects.delete(onDisconnect);
        clearTimeout(abortTimer);
        clearTimeout(quiet);
        signal.removeEventListener("abort", onAbort);
        if (outputBase !== undefined && outputNow !== undefined) meter.addOutput(outputNow - outputBase);
        resolve(withUsage(r, meter));
      };
      const onAbort = () => {
        // A requested interrupt is not a terminal acknowledgement. Keep the turn active so
        // deletion cannot remove its worktree while Codex may still be executing there. Nor may the quiet
        // end below call a stopped turn completed: only Codex's answer to the interrupt ends it.
        clearTimeout(quiet);
        abortTimer = setTimeout(() => {
          if (!done) sink.notice("warn", "Codex has not confirmed the stop yet. Press Stop again to force it; that restarts Codex and ends any other Codex turn in progress.");
        }, 1500);
        interrupt();
      };
      const onMsg = (msg: RpcMessage) => {
        if (done || stopping) return;
        const p = (msg.params ?? {}) as Record<string, unknown>;
        const native = (item: unknown): NativeRef => ({ runtime, thread: tid, ...(p.turnId || turnId ? { turn: String(p.turnId ?? turnId) } : {}), item: String(item) });
        if (msg.method === "thread/started") {
          const thread = p.thread as { id?: string; agentNickname?: string; source?: { subAgent?: { thread_spawn?: { parent_thread_id?: string; agent_path?: string } } } } | undefined;
          const spawn = thread?.source?.subAgent?.thread_spawn;
          if (thread?.id && (spawn?.parent_thread_id === tid || (spawn?.parent_thread_id && agents.has(spawn.parent_thread_id)))) {
            agents.update(thread.id, { state: "running", ...(thread.agentNickname || spawn.agent_path ? { label: thread.agentNickname ?? spawn.agent_path } : {}) });
          }
          return;
        }
        if (msg.method === "serverRequest/resolved") {
          const request = this.openRequests.get(`${runtime}:${JSON.stringify(p.requestId)}`);
          if (request && (!p.threadId || p.threadId === request.thread)) request.controller.abort();
          return;
        }
        if (p.threadId && p.threadId !== tid) {
          const id = String(p.threadId);
          if (!agents.has(id)) return;
          if (msg.method === "thread/status/changed") {
            const status = p.status as { type?: string; activeFlags?: string[] } | undefined;
            // Idle/unloaded describe the connection, not the result of the last turn.
            // Completion comes from the turn or collaboration lifecycle event.
            if (status?.type !== "active" && status?.type !== "systemError") return;
            const state = status.type === "active" ? (status.activeFlags?.length ? "waiting" : "running") : "failed";
            agents.update(id, { state, detail: state === "waiting" ? "Waiting for approval or input" : undefined });
          } else if (msg.id !== undefined && msg.method) {
            void this.handleServerRequest(msg, sink, seenRequests);
          } else if (msg.method === "turn/completed") {
            const turn = p.turn as { status?: string; error?: { message?: string } } | undefined;
            agents.update(id, { state: turn?.status === "completed" ? "completed" : turn?.status === "interrupted" ? "stopped" : "failed", detail: turn?.error?.message }, turn?.error?.message);
          }
          return;
        }
        if (starting) {
          if (msg.method === "turn/started") {
            turnId = (p.turn as { id: string }).id;
            if (signal.aborted) interrupt();
          }
          queued.push(msg);
          return;
        }
        const messageTurn = p.turnId ?? (p.turn as { id?: string } | undefined)?.id;
        if (messageTurn && messageTurn !== turnId) return;
        clearTimeout(quiet);
        if (msg.method === "item/started") answered = false;
        else if (msg.method === "item/completed") {
          const item = p.item as CodexItem;
          if (item.type === "agentMessage") answered = item.phase === "final_answer" && "answer";
          else if (item.type === "plan") answered = "plan";
        }
        if (answered && !signal.aborted && msg.method !== "turn/completed") {
          quiet = setTimeout(() => {
            // Codex can go quiet after its final answer or proposed plan without ending the turn (live in
            // codex-cli 0.163.0, default and plan mode). Nothing else is open, so
            // Modex ends it and says so; the interrupt lets Codex close its side.
            if (done || signal.aborted || commands.size || [...this.openRequests.values()].some((r) => r.thread === tid)) return;
            sink.notice("warn", `Codex ${answered === "plan" ? "proposed its plan" : "gave its final answer"} but did not report the turn finished. Modex ended the turn after ${Math.round(this.quietAfterFinalMs / 60_000) || 1} minute${this.quietAfterFinalMs > 60_000 ? "s" : ""} without activity.`);
            interrupt();
            finish({ status: "completed", detail: detail({ endedBy: "modex", quietAfterFinalMs: this.quietAfterFinalMs }) });
          }, this.quietAfterFinalMs);
        }
        // Server → client requests (approvals).
        if (msg.id !== undefined && msg.method) {
          void this.handleServerRequest(msg, sink, seenRequests);
          return;
        }
        if (msg.method === "item/started" || msg.method === "item/completed") {
          const item = p.item as CodexItem;
          if (item.type === "subAgentActivity" && item.agentThreadId && !activities.has(item.id)) {
            activities.add(item.id);
            const state = item.kind === "completed" ? "completed" : item.kind === "interrupted" ? "stopped" : "running";
            agents.update(item.agentThreadId, { state, ...(item.agentPath ? { label: item.agentPath } : {}) });
            return;
          }
          if (item.type === "collabAgentToolCall") {
            const ids = new Set([...(item.receiverThreadIds ?? []), ...Object.keys(item.agentsStates ?? {})]);
            for (const id of ids) {
              const snapshot = item.agentsStates?.[id];
              const state = snapshot ? agentState(snapshot.status) : undefined;
              agents.update(id, { ...(state ? { state } : {}), ...(!agents.has(id) && item.prompt ? { label: item.prompt } : {}), ...(snapshot?.message ? { detail: snapshot.message } : {}) }, snapshot?.message ?? undefined, item.prompt ? { prompt: item.prompt } : undefined);
            }
            return;
          }
        }
        switch (msg.method) {
          case "item/started": {
            const item = p.item as CodexItem;
            if (item.type === "agentMessage") {
              sink.observe({ type: "message.start", native: native(item.id), phase: codexPhase(item.phase), ...(item.phase ? { nativePhase: item.phase } : {}) });
            } else if (item.type === "plan") {
              // Codex's proposed plan in plan collaboration mode: the turn's answer; no agent message follows it.
              sink.observe({ type: "message.start", native: native(item.id), phase: "final", nativePhase: "plan" });
            } else if (item.type === "reasoning") {
              sink.observe({ type: "reasoning.start", native: native(item.id) });
            } else if (item.type === "commandExecution") {
              tools.set(item.id, { started: Date.now(), output: "", bytes: 0 });
              commands.add(item.id);
              sink.observe({ type: "tool.start", native: native(item.id), tool: { name: "shell", title: `$ ${stripShell(item.command ?? "")}`, args: { command: item.command, cwd: item.cwd },
                ...(item.command ? { exec: { command: item.command, ...(item.cwd ? { cwd: item.cwd } : {}), ...(codexActions(item.commandActions) ? { actions: codexActions(item.commandActions)! } : {}) } } : {}) } });
            } else if (item.type === "fileChange") {
              tools.set(item.id, { started: Date.now(), output: "", bytes: 0 });
              const files = (item.changes ?? []).map((c) => c.path);
              this.changePaths.set(`${tid}:${item.id}`, files);
              sink.observe({ type: "tool.start", native: native(item.id), tool: { name: "apply_patch", title: `edit ${files.join(", ")}`, args: { patch: (item.changes ?? []).map((c) => c.diff).join("\n"), files: (item.changes ?? []).map(patchFile) } } });
            } else if (item.type === "mcpToolCall" || item.type === "dynamicToolCall" || item.type === "webSearch") {
              tools.set(item.id, { started: Date.now(), output: "", bytes: 0 });
              // 0.163.0 starts a web search with an empty query; the completed item carries it.
              const label = item.type === "webSearch" ? (item.query ? `search ${item.query}` : "search the web") : `${item.server ? item.server + "." : ""}${item.tool ?? item.type}`;
              sink.observe({ type: "tool.start", native: native(item.id), tool: { name: item.type, title: label, args: (item.arguments as Record<string, unknown>) ?? {} } });
            }
            break;
          }
          // A summary part and a reasoning-text part are different representations; they never share an item.
          case "item/reasoning/summaryTextDelta":
            sink.observe({ type: "reasoning.delta", native: native(p.itemId), representation: "summary", index: partIndex(p.summaryIndex), text: String(p.delta ?? "") });
            break;
          case "item/reasoning/textDelta":
            sink.observe({ type: "reasoning.delta", native: native(p.itemId), representation: "provider-text", index: partIndex(p.contentIndex), text: String(p.delta ?? "") });
            break;
          // The plan Codex reports for the turn (codex-cli 0.163.0: pending, inProgress, completed), whole each time.
          case "turn/plan/updated": {
            const steps = Array.isArray(p.plan) ? (p.plan as { step?: unknown; status?: unknown }[]).map((s) => ({ text: String(s.step ?? ""), status: codexStepStatus(s.status) })) : [];
            sink.observe({ type: "plan.update", native: native("plan"), from: "codex-plan", steps, ...(typeof p.explanation === "string" && p.explanation ? { explanation: p.explanation } : {}) });
            break;
          }
          case "item/agentMessage/delta":
          case "item/plan/delta":
            sink.observe({ type: "message.delta", native: native(p.itemId), text: String(p.delta ?? "") });
            break;
          case "item/commandExecution/outputDelta": {
            const t = tools.get(String(p.itemId));
            if (t) {
              const delta = String(p.delta ?? "");
              sink.output?.(native(p.itemId), delta);
              t.bytes += byteLength(delta);
              t.output = boundOutput(t.output + delta).text;
              sink.observe({ type: "tool.update", native: native(p.itemId), progress: { output: t.output, ...(t.bytes > byteLength(t.output) ? { outputBytes: t.bytes, outputTruncated: true } : {}) } });
            }
            break;
          }
          case "item/completed": {
            const item = p.item as CodexItem;
            commands.delete(item.id);
            if (item.type === "fileChange") this.changePaths.delete(`${tid}:${item.id}`);
            if (item.type === "agentMessage") {
              // A message that completes without streaming is kept, commentary included: its phase says what it is.
              const evidence = memoryEvidence(item.memoryCitation);
              const asks = codexAsks(item.questions);
              sink.observe({ type: "message.done", native: native(item.id), ...(typeof item.text === "string" ? { text: item.text } : {}), phase: codexPhase(item.phase), ...(item.phase ? { nativePhase: item.phase } : {}), ...(evidence.length ? { evidence } : {}), ...(asks.length ? { asks } : {}) });
            } else if (item.type === "plan") {
              // The completed plan item is authoritative; its deltas joined may differ.
              sink.observe({ type: "message.done", native: native(item.id), ...(typeof item.text === "string" ? { text: item.text } : {}), phase: "final", nativePhase: "plan" });
            } else if (tools.has(item.id)) {
              const t = tools.get(item.id)!;
              // A web search's results arrive structured; they are shown as links, not as a JSON string.
              const search = item.type === "webSearch" ? codexWebSearch(item as unknown as Record<string, unknown>) : null;
              const output = item.type === "commandExecution" ? (item.aggregatedOutput ?? t.output) : item.type === "fileChange" ? (item.changes ?? []).map((c) => `${c.kind?.type ?? "update"} ${c.path}\n${c.diff}`).join("\n") : item.type === "webSearch" ? "" : JSON.stringify(item.result ?? item.error ?? "", null, 2);
              const total = Math.max(t.bytes, byteLength(output));
              const shown = boundOutput(output).text;
              sink.observe({ type: "tool.done", native: native(item.id), outcome: codexOutcome(item), progress: {
                ...(search ? { search, ...(search.query ? { title: `search ${search.query}` } : {}) } : {}),
                ...(shown ? { output: shown } : {}), ...(total > byteLength(shown) ? { outputBytes: total, outputTruncated: true } : {}),
                ...(item.type === "commandExecution" && "exitCode" in item ? { exitCode: item.exitCode ?? null } : {}),
                durationMs: item.durationMs ?? Date.now() - t.started,
              } });
            } else if (item.type === "reasoning") {
              sink.observe({ type: "reasoning.done", native: native(item.id), summary: item.summary ?? [], text: item.content ?? [] });
            }
            break;
          }
          case "thread/tokenUsage/updated": {
            const u = p.tokenUsage as { last?: Record<string, unknown>; total?: Record<string, unknown> } | undefined;
            if (!u?.last) break;
            meter.call(codexCall(u.last));
            const total = Number(u.total?.outputTokens);
            const last = Number(u.last.outputTokens);
            if (Number.isFinite(total)) {
              if (outputBase === undefined && Number.isFinite(last)) outputBase = total - last;
              outputNow = total;
            }
            break;
          }
          case "turn/started":
            turnId = (p.turn as { id: string }).id;
            break;
          case "error": {
            const e = p.error as Record<string, unknown> | undefined;
            const message = typeof e?.message === "string" ? e.message : null;
            if (!message) break;
            if (p.willRetry) retried.push(message);
            else lastError = { ...(e ?? {}), at: new Date().toISOString() };
            break;
          }
          case "turn/completed": {
            const turn = p.turn as { status: string; error?: { message?: string } | null };
            if (turn.status === "failed") finish({ status: "failed", error: turn.error?.message ?? (lastError?.message as string | undefined) ?? "turn failed", detail: detail({ turnError: turn.error ?? undefined }) });
            else {
              // An error the server reported but did not fail the turn on still deserves a line.
              if (lastError) sink.notice("error", String(lastError.message));
              if (turn.status === "interrupted" && commands.size) {
                stopping = true;
                clearTimeout(abortTimer);
                const settle = (id: string, outcome: "interrupted" | "unknown") => {
                  const t = tools.get(id);
                  sink.observe({ type: "tool.done", native: native(id), outcome, progress: { ...(t?.output ? { output: t.output } : {}), ...(t ? { durationMs: Date.now() - t.started } : {}) } });
                };
                void this.endTerminals(tid, commands, settle, sink).then(() => finish({ status: "interrupted" }));
              } else finish(turn.status === "interrupted" ? { status: "interrupted" } : { status: "completed" });
            }
            break;
          }
          default:
            break;
        }
      };
      this.subscribers.add(onMsg);
      this.disconnects.add(onDisconnect);
      signal.addEventListener("abort", onAbort, { once: true });
      const turnStart = (text: string, mode: typeof collaborationMode) => this.request<{ turn: { id: string } }>("turn/start", {
        threadId: tid,
        // Images go by path (the app-server reads them); other attached files are named in the text.
        input: [{ type: "text", text, text_elements: [] }, ...(opts.attachments ?? []).filter((a) => a.kind === "image").map((a) => ({ type: "localImage", path: a.path }))],
        cwd: opts.cwd,
        approvalPolicy: pol.approvalPolicy,
        sandboxPolicy: pol.sandboxPolicy,
        model: opts.model || null,
        effort: opts.effort ?? null,
        // "fast" is the Codex fast-mode service tier; only this turn, the thread's tier is untouched.
        serviceTierForTurn: opts.fast ? "fast" : null,
        ...(mode ? { collaborationMode: mode } : {}),
      });
      turnStart(input, collaborationMode)
        .catch((err: unknown) => {
          // A Codex that does not take the collaboration mode refuses the request before starting a turn.
          if (!collaborationMode || signal.aborted || !refusedCollaborationMode(err)) throw err;
          sink.notice("info", "This Codex does not offer its plan mode, so this Plan turn runs with Modex's plan instructions.");
          return turnStart(prefixed, undefined);
        })
        .then((r) => {
          turnId = r.turn.id;
          starting = false;
          if (signal.aborted) interrupt();
          if (!done) for (const msg of queued) onMsg(msg);
          queued.length = 0;
        })
        .catch((err: Error) => finish({ status: "failed", error: err.message, detail: detail(detailOf(err)) }));
    });
  }

  /** Paths of a file change the approval refers to (from its item/started), consumed once. */
  private takeChangePaths(p: Record<string, unknown>): string[] {
    const key = `${String(p.threadId ?? "")}:${String(p.itemId ?? "")}`;
    const paths = this.changePaths.get(key) ?? [];
    this.changePaths.delete(key);
    return paths;
  }

  private async handleServerRequest(msg: RpcMessage, sink: TurnSink, seen: Map<string, string>): Promise<void> {
    const key = `${this.generation}:${JSON.stringify(msg.id)}`;
    const digest = actionDigest({ method: msg.method, params: msg.params });
    if (seen.has(key)) {
      if (seen.get(key) !== digest) {
        this.openRequests.get(key)?.controller.abort();
        sink.notice("warn", "Codex reused a request id for a changed action; the original request was withdrawn. A new request id is required.");
      }
      return;
    }
    seen.set(key, digest);
    const withdrawn = new AbortController();
    this.openRequests.set(key, { controller: withdrawn, thread: (msg.params as Record<string, unknown> | undefined)?.threadId });
    try {
      await this.answerServerRequest(msg, sink, withdrawn.signal);
    } finally {
      if (this.openRequests.get(key)?.controller === withdrawn) this.openRequests.delete(key);
    }
  }

  private async answerServerRequest(msg: RpcMessage, sink: TurnSink, withdrawn: AbortSignal): Promise<void> {
    const p = (msg.params ?? {}) as Record<string, unknown>;
    const native: NativeRequest = { runtime: this.generation, request: JSON.stringify(msg.id), ...(typeof p.itemId === "string" && p.itemId ? { item: p.itemId } : {}) };
    const deliver = async (result: unknown) => {
      const child = this.child;
      const write = () => {
        if (withdrawn.aborted || this.generation !== native.runtime || !child || child !== this.child || child.exitCode !== null) return Promise.reject(new Error("request transport unavailable"));
        return writeJsonResponse(child.stdin, { id: msg.id, result });
      };
      if (sink.deliverRequest) await sink.deliverRequest(native, write);
      else await write();
    };
    if (msg.method === "item/commandExecution/requestApproval") {
      const cmd = stripShell(String(p.command ?? ""));
      const cwd = typeof p.cwd === "string" && p.cwd ? p.cwd : undefined;
      const answer = await sink.approval({
        question: `Allow command: ${cmd}?`,
        detail: [p.reason ? `Reason: ${String(p.reason)}` : "", `cwd: ${String(p.cwd ?? "")}`].filter(Boolean).join("\n"),
        canAlways: true,
        action: { backend: "codex", tool: "command", title: cmd, ...(cwd ? { cwd } : {}), input: { command: cmd } },
        native,
      }, withdrawn);
      if (withdrawn.aborted) return;
      await deliver({ decision: answer === "yes" ? "accept" : answer === "always" ? "acceptForSession" : "decline" });
    } else if (msg.method === "item/fileChange/requestApproval") {
      const grantRoot = typeof p.grantRoot === "string" && p.grantRoot ? p.grantRoot : undefined;
      const paths = this.takeChangePaths(p);
      const answer = await sink.approval({
        question: "Allow Codex to apply these file changes?",
        detail: [p.reason ? `Reason: ${String(p.reason)}` : "", p.grantRoot ? `grants write access to ${String(p.grantRoot)}` : ""].filter(Boolean).join("\n") || undefined,
        canAlways: true,
        // Paths only: the patch body stays out of the action, so no gate can forward it.
        action: { backend: "codex", tool: "fileChange", title: "apply file changes", input: { ...(paths.length ? { paths } : {}), ...(grantRoot ? { grantRoot } : {}) }, ...(grantRoot ? { escalation: true } : {}) },
        native,
      }, withdrawn);
      if (withdrawn.aborted) return;
      await deliver({ decision: answer === "yes" ? "accept" : answer === "always" ? "acceptForSession" : "decline" });
    } else if (msg.method === "item/permissions/requestApproval") {
      const permissions = requestedPermissions(p.permissions);
      if (!permissions) {
        sink.notice("warn", "Codex requested malformed or unsupported permissions; no permissions were granted.");
        this.respond(msg.id, { permissions: {}, scope: "turn" });
        return;
      }
      const answer = await sink.approval({ question: "Allow these additional permissions for this turn?", detail: JSON.stringify({ ...p, permissions }, null, 2), canAlways: false, action: { backend: "codex", tool: "permissions", title: "grant additional permissions", escalation: true }, native }, withdrawn);
      if (withdrawn.aborted) return;
      await deliver({ permissions: answer === "yes" ? permissions : {}, scope: "turn" });
    } else if (msg.method === "item/tool/requestUserInput" && sink.question) {
      // Experimental in codex-cli 0.163.0. A request Modex cannot read is declined whole, never half-answered.
      const asked = codexQuestions(p);
      if (!asked) {
        sink.notice("warn", "Codex asked a question Modex could not read; it was declined.");
        this.send({ id: msg.id, error: { code: -32602, message: "modex could not read this requestUserInput" } });
        return;
      }
      const reply = await sink.question({ ...asked, native }, withdrawn);
      if (withdrawn.aborted) return;
      // A withdrawn question is an error reply, never an empty answer the model could take as the user's.
      if ("answers" in reply) await deliver(codexAnswerResponse(reply.answers));
      else this.send({ id: msg.id, error: { code: -32000, message: reply.withdrawn === "stopped" ? "withdrawn by modex: the turn was stopped" : "withdrawn by modex: the turn ended before anyone answered" } });
    } else {
      sink.notice("warn", `Codex asked for ${msg.method}, which Modex does not support yet; declined.`);
      this.send({ id: msg.id, error: { code: -32601, message: `unsupported by modex: ${msg.method}` } });
    }
  }
}

/** An error with the facts behind it (RPC method and code, exit code, stderr) for the failure report. */
/** Whether a turn/start error is Codex refusing the experimental `collaborationMode` field, not the turn itself. */
function refusedCollaborationMode(err: unknown): boolean {
  if (!(err instanceof CodexError)) return false;
  const code = err.detail.rpcCode;
  return (code === -32602 || code === -32600 || code === -32601) && /collaboration/i.test(err.message);
}

class CodexError extends Error {
  constructor(message: string, readonly detail: Record<string, unknown>) {
    super(message);
  }
}

function detailOf(err: unknown): Record<string, unknown> {
  return err instanceof CodexError ? err.detail : {};
}

/** Per-thread Codex config overrides: surface reasoning summaries so the Thinking item has something to show. */
const THREAD_CONFIG = { model_reasoning_summary: "detailed" };

const PLAN_PREFIX = "PLAN MODE: Investigate the codebase read-only and reply with a concrete, numbered implementation plan (files to change, order, risks, how to verify). Do not edit files or run commands that modify anything.";

function stripShell(cmd: string): string {
  const m = /^\/bin\/(?:zsh|bash|sh) -lc '(.*)'$/s.exec(cmd) ?? /^\/bin\/(?:zsh|bash|sh) -lc "(.*)"$/s.exec(cmd);
  return m ? m[1]!.replace(/'\\''/g, "'") : cmd;
}

interface RpcMessage {
  id?: unknown;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}
interface CodexModel {
  id: string;
  displayName: string;
  description?: string;
  hidden: boolean;
  isDefault: boolean;
  supportedReasoningEfforts?: { reasoningEffort: string }[];
  defaultReasoningEffort?: string;
  serviceTiers?: { id: string; name?: string; description?: string }[];
  defaultServiceTier?: string | null;
}

/** One file of a fileChange, beside the joined patch: `lines` is how much of it is this file's diff (shared/evidence.ts). */
function patchFile(c: NonNullable<CodexItem["changes"]>[number]): import("../../../shared/evidence.js").CodexPatchFile {
  return { path: c.path, kind: c.kind?.type ?? "update", ...(c.kind?.move_path ? { movePath: c.kind.move_path } : {}), lines: (c.diff ?? "").split("\n").length };
}

interface CodexItem {
  type: string;
  id: string;
  /** Codex's own parse of a command (0.163.0): `read`, `search`, `listFiles` or `unknown`. */
  commandActions?: unknown;
  /** An agent message's own questions (0.163.0 `AsyncUserInputQuestion`): `{ title, options }`, answered by the next message. */
  questions?: unknown;
  text?: string;
  phase?: string | null;
  command?: string;
  cwd?: string;
  status?: string;
  aggregatedOutput?: string | null;
  exitCode?: number | null;
  durationMs?: number | null;
  changes?: { path: string; kind?: { type: string; move_path?: string | null }; diff: string }[];
  summary?: string[];
  content?: string[];
  server?: string;
  tool?: string;
  arguments?: unknown;
  result?: unknown;
  error?: unknown;
  query?: string;
  receiverThreadIds?: string[];
  agentsStates?: Record<string, { status: string; message?: string | null }>;
  prompt?: string | null;
  agentThreadId?: string;
  agentPath?: string;
  kind?: string;
  memoryCitation?: unknown;
}

/** Cancel setup locally without killing the shared server used by other threads. */
function duringSetup<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error("Stopped during Codex setup"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/**
 * The app-server leads its own process group (spawned detached), so a group kill also takes
 * the shell commands it is running. Fall back to the server alone if the group is gone.
 */
function killGroup(child: ChildProcess): void {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // Already exited, or not a group leader.
    }
  }
  child.kill("SIGKILL");
}

/** Codex reports the agent state separately from the status of its spawn/wait call. */
function agentState(status: string): AgentActivity["state"] {
  switch (status) {
    case "pendingInit": case "running": return "running";
    case "completed": return "completed";
    case "errored": return "failed";
    case "interrupted": case "shutdown": return "stopped";
    default: return "unknown";
  }
}

/**
 * Codex `MessagePhase` (codex-cli 0.163.0: commentary, partial_answer, final_answer, or null) as a
 * Modex phase. `partial_answer` is neither commentary nor the final answer, and null means the
 * model did not say: both stay unspecified, and the native value is kept beside it. Exported for tests.
 */
export function codexPhase(phase: string | null | undefined): MessagePhase {
  return phase === "commentary" ? "commentary" : phase === "final_answer" ? "final" : "unspecified";
}

/**
 * How a completed Codex tool item ended, from its own status (codex-cli 0.163.0): `declined` is a
 * denial, `failed` a failure, `completed` a success, except a command that completed with a non-zero
 * exit code (failed) or none at all (unknown). A command with no status is judged by its exit code.
 * A web search has neither a status nor an error field, so its `item/completed` is the only report it
 * makes: it finished. Any other item without a status is unknown unless it reports an error, and so
 * is a tool still `inProgress` when it completes. Exported for tests.
 */
export function codexOutcome(item: { type: string; status?: string; exitCode?: number | null; error?: unknown }): SettledOutcome {
  if (item.status === "declined") return "denied";
  if (item.status === "failed") return "failed";
  const exit = item.exitCode === 0 ? "succeeded" : typeof item.exitCode === "number" ? "failed" : "unknown";
  if (item.status === "completed") return item.type === "commandExecution" ? exit : "succeeded";
  if (item.status === undefined && item.type === "commandExecution" && exit !== "unknown") return exit;
  if (item.error) return "failed";
  return item.status === undefined && item.type === "webSearch" ? "succeeded" : "unknown";
}

function codexStepStatus(status: unknown): PlanStepStatus {
  return status === "pending" ? "pending" : status === "inProgress" ? "in-progress" : status === "completed" ? "completed" : "unknown";
}

function partIndex(value: unknown): number {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

/**
 * Codex's parse of a command as `ExecAction`s: what it read, searched or listed. An `unknown` action,
 * or a read without a path, says nothing about files and is left out.
 */
export function codexActions(value: unknown): ExecAction[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const actions = value.flatMap((entry): ExecAction[] => {
    if (!entry || typeof entry !== "object") return [];
    const { type, path, query } = entry as Record<string, unknown>;
    const at = typeof path === "string" && path ? path : undefined;
    const q = typeof query === "string" && query ? query : undefined;
    if (type === "read") return at ? [{ kind: "read", path: at }] : [];
    if (type === "search") return [{ kind: "search", ...(at ? { path: at } : {}), ...(q ? { query: q } : {}) }];
    if (type === "listFiles") return [{ kind: "list", ...(at ? { path: at } : {}) }];
    return [];
  });
  return actions.length ? actions : undefined;
}

/** Codex `agentMessage.questions`, as reported: titled questions with plain-text options. Anything else is dropped. */
export function codexAsks(value: unknown): MessageAsk[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((q) => {
    const { title, options } = (q ?? {}) as { title?: unknown; options?: unknown };
    if (typeof title !== "string" || !title.trim()) return [];
    const opts = Array.isArray(options) ? options.filter((o): o is string => typeof o === "string" && o.trim() !== "") : null;
    return [{ title, options: opts?.length ? opts : null }];
  });
}
