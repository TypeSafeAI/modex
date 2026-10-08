import { AgentTracker } from "./agents.js";
import type { CliExecutable } from "../cli-path.js";
import { generateTitle } from "../titles.js";
import { spawn, type ChildProcess } from "node:child_process";
import type { Backend, ModelInfo, TurnOptions, TurnResult, TurnSink } from "./types.js";
import { LineBuffer, stderrTail } from "./types.js";
import { cliEnvironment, health, installation } from "./health.js";
import type { AgentActivity, BackendHealth } from "../../../shared/types.js";

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
  /** File paths of in-flight file changes, keyed `threadId:itemId`, so an approval can name them without the patch. */
  private readonly changePaths = new Map<string, string[]>();
  /** From the `initialize` reply: which codex build the server is. Kept for failure reports. */
  private userAgent: string | null = null;

  private get bin(): string { return typeof this.executable === "function" ? this.executable() : this.executable; }

  constructor(private readonly executable: CliExecutable = process.env.MODEX_CODEX_BIN ?? "codex", private readonly spawnImpl = spawn,
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
      this.loaded.clear();
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
      this.request<{ userAgent?: string }>("initialize", { clientInfo: { name: "modex", title: "Modex", version: process.env.MODEX_VERSION ?? "0.0.1" }, capabilities: {} }, 5000)
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

  generateTitle(text: string, opts: { model: string }, signal: AbortSignal): Promise<string | null> {
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
    let threadId = opts.resume;
    try {
      if (threadId && !this.loaded.has(threadId)) {
        const r = await duringSetup(this.request<{ thread: { id: string } }>("thread/resume", { threadId, cwd: opts.cwd, approvalPolicy: pol.approvalPolicy, sandbox: pol.sandbox, model: opts.model || null, config: THREAD_CONFIG }), signal);
        threadId = r.thread.id;
      } else if (!threadId) {
        const r = await duringSetup(this.request<{ thread: { id: string } }>("thread/start", { cwd: opts.cwd, approvalPolicy: pol.approvalPolicy, sandbox: pol.sandbox, model: opts.model || null, config: THREAD_CONFIG }), signal);
        threadId = r.thread.id;
      }
    } catch (err) {
      return failed(err, { stage: "open thread", codexThreadId: opts.resume });
    }
    if (signal.aborted) return { status: "interrupted" };
    this.loaded.add(threadId);
    sink.session(threadId);

    const tid = threadId;
    const input = opts.plan
      ? `${PLAN_PREFIX}\n\n${text}`
      : text;
    const agents = new AgentTracker(sink);
    const activities = new Set<string>();
    const tools = new Map<string, { started: number; output: string }>();
    const reasoning = new Set<string>();
    let turnId: string | null = null;
    const streaming = new Map<string, string>();
    // Codex announces a fatal error as an `error` notification before `turn/completed` reports the
    // failure. The notification carries the better message and an error code; it is held here and
    // reported once, with the completion, instead of as a separate red line.
    let lastError: Record<string, unknown> | null = null;
    const retried: string[] = [];

    return new Promise<TurnResult>((resolve) => {
      let done = false;
      let starting = true;
      const queued: RpcMessage[] = [];
      let abortTimer: ReturnType<typeof setTimeout> | undefined;
      let interrupted = false;
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
        signal.removeEventListener("abort", onAbort);
        resolve(r);
      };
      const onAbort = () => {
        // A requested interrupt is not a terminal acknowledgement. Keep the turn active so
        // deletion cannot remove its worktree while Codex may still be executing there.
        abortTimer = setTimeout(() => {
          if (!done) sink.notice("warn", "Codex has not confirmed the stop yet. Press Stop again to force it; that restarts Codex and ends any other Codex turn in progress.");
        }, 1500);
        interrupt();
      };
      const onMsg = (msg: RpcMessage) => {
        if (done) return;
        const p = (msg.params ?? {}) as Record<string, unknown>;
        if (msg.method === "thread/started") {
          const thread = p.thread as { id?: string; agentNickname?: string; source?: { subAgent?: { thread_spawn?: { parent_thread_id?: string; agent_path?: string } } } } | undefined;
          const spawn = thread?.source?.subAgent?.thread_spawn;
          if (thread?.id && (spawn?.parent_thread_id === tid || (spawn?.parent_thread_id && agents.has(spawn.parent_thread_id)))) {
            agents.update(thread.id, { state: "running", ...(thread.agentNickname || spawn.agent_path ? { label: thread.agentNickname ?? spawn.agent_path } : {}) });
          }
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
            void this.handleServerRequest(msg, sink);
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
        // Server → client requests (approvals).
        if (msg.id !== undefined && msg.method) {
          void this.handleServerRequest(msg, sink);
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
              streaming.set(item.id, "");
            } else if (item.type === "reasoning") {
              reasoning.add(item.id);
              sink.thinkingDelta(item.id, "");
            } else if (item.type === "commandExecution") {
              tools.set(item.id, { started: Date.now(), output: "" });
              sink.toolStart({ id: item.id, name: "shell", title: `$ ${stripShell(item.command ?? "")}`, args: { command: item.command, cwd: item.cwd } });
            } else if (item.type === "fileChange") {
              tools.set(item.id, { started: Date.now(), output: "" });
              const files = (item.changes ?? []).map((c) => c.path);
              this.changePaths.set(`${tid}:${item.id}`, files);
              sink.toolStart({ id: item.id, name: "apply_patch", title: `edit ${files.join(", ")}`, args: { patch: (item.changes ?? []).map((c) => c.diff).join("\n") } });
            } else if (item.type === "mcpToolCall" || item.type === "dynamicToolCall" || item.type === "webSearch") {
              tools.set(item.id, { started: Date.now(), output: "" });
              const label = item.type === "webSearch" ? `search ${item.query ?? ""}` : `${item.server ? item.server + "." : ""}${item.tool ?? item.type}`;
              sink.toolStart({ id: item.id, name: item.type, title: label, args: (item.arguments as Record<string, unknown>) ?? {} });
            }
            break;
          }
          case "item/reasoning/summaryTextDelta":
          case "item/reasoning/textDelta": {
            reasoning.add(String(p.itemId));
            sink.thinkingDelta(String(p.itemId), String(p.delta ?? ""));
            break;
          }
          case "item/reasoning/summaryPartAdded": {
            if (Number(p.summaryIndex) > 0) sink.thinkingDelta(String(p.itemId), "\n\n");
            break;
          }
          case "item/agentMessage/delta": {
            const id = String(p.itemId);
            streaming.set(id, (streaming.get(id) ?? "") + String(p.delta ?? ""));
            sink.delta(String(p.delta ?? ""));
            break;
          }
          case "item/commandExecution/outputDelta": {
            const t = tools.get(String(p.itemId));
            if (t) {
              t.output += String(p.delta ?? "");
              sink.toolUpdate(String(p.itemId), { output: t.output });
            }
            break;
          }
          case "item/completed": {
            const item = p.item as CodexItem;
            if (item.type === "fileChange") this.changePaths.delete(`${tid}:${item.id}`);
            if (item.type === "agentMessage") {
              if (item.phase === "commentary" && !streaming.has(item.id)) break;
              sink.assistant(item.text ?? streaming.get(item.id) ?? "");
              streaming.delete(item.id);
            } else if (tools.has(item.id)) {
              const t = tools.get(item.id)!;
              const output = item.type === "commandExecution" ? (item.aggregatedOutput ?? t.output) : item.type === "fileChange" ? (item.changes ?? []).map((c) => `${c.kind?.type ?? "update"} ${c.path}\n${c.diff}`).join("\n") : JSON.stringify(item.result ?? item.error ?? "", null, 2);
              const ok = item.type === "commandExecution" ? item.exitCode === 0 && item.status !== "declined" : item.status ? item.status === "completed" : !item.error;
              sink.toolUpdate(item.id, { output: output || undefined, ok, status: "done", durationMs: item.durationMs ?? Date.now() - t.started });
            } else if (item.type === "reasoning") {
              const text = [...(item.summary ?? []), ...(item.content ?? [])].filter(Boolean).join("\n\n");
              if (reasoning.has(item.id) || text) sink.thinkingDone(item.id, text || undefined);
              reasoning.delete(item.id);
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
              finish(turn.status === "interrupted" ? { status: "interrupted" } : { status: "completed" });
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
      this.request<{ turn: { id: string } }>("turn/start", {
        threadId: tid,
        input: [{ type: "text", text: input, text_elements: [] }],
        cwd: opts.cwd,
        approvalPolicy: pol.approvalPolicy,
        sandboxPolicy: pol.sandboxPolicy,
        model: opts.model || null,
        effort: opts.effort ?? null,
        // "fast" is the Codex fast-mode service tier; only this turn, the thread's tier is untouched.
        serviceTierForTurn: opts.fast ? "fast" : null,
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

  private async handleServerRequest(msg: RpcMessage, sink: TurnSink): Promise<void> {
    const p = (msg.params ?? {}) as Record<string, unknown>;
    if (msg.method === "item/commandExecution/requestApproval") {
      const cmd = stripShell(String(p.command ?? ""));
      const cwd = typeof p.cwd === "string" && p.cwd ? p.cwd : undefined;
      const answer = await sink.approval({
        question: `Allow command: ${cmd}?`,
        detail: [p.reason ? `Reason: ${String(p.reason)}` : "", `cwd: ${String(p.cwd ?? "")}`].filter(Boolean).join("\n"),
        canAlways: true,
        action: { backend: "codex", tool: "command", title: cmd, ...(cwd ? { cwd } : {}), input: { command: cmd } },
      });
      this.respond(msg.id, { decision: answer === "yes" ? "accept" : answer === "always" ? "acceptForSession" : "decline" });
    } else if (msg.method === "item/fileChange/requestApproval") {
      const grantRoot = typeof p.grantRoot === "string" && p.grantRoot ? p.grantRoot : undefined;
      const paths = this.takeChangePaths(p);
      const answer = await sink.approval({
        question: "Allow Codex to apply these file changes?",
        detail: [p.reason ? `Reason: ${String(p.reason)}` : "", p.grantRoot ? `grants write access to ${String(p.grantRoot)}` : ""].filter(Boolean).join("\n") || undefined,
        canAlways: true,
        // Paths only: the patch body stays out of the action, so no gate can forward it.
        action: { backend: "codex", tool: "fileChange", title: "apply file changes", input: { ...(paths.length ? { paths } : {}), ...(grantRoot ? { grantRoot } : {}) }, ...(grantRoot ? { escalation: true } : {}) },
      });
      this.respond(msg.id, { decision: answer === "yes" ? "accept" : answer === "always" ? "acceptForSession" : "decline" });
    } else if (msg.method === "item/permissions/requestApproval") {
      const answer = await sink.approval({ question: "Codex is asking for additional permissions.", detail: JSON.stringify(p, null, 2).slice(0, 1500), canAlways: false, action: { backend: "codex", tool: "permissions", title: "grant additional permissions", escalation: true } });
      this.respond(msg.id, { decision: answer === "no" ? "decline" : "accept" });
    } else {
      sink.notice("warn", `Codex asked for ${msg.method}, which Modex does not support yet; declined.`);
      this.send({ id: msg.id, error: { code: -32601, message: `unsupported by modex: ${msg.method}` } });
    }
  }
}

/** An error with the facts behind it (RPC method and code, exit code, stderr) for the failure report. */
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
interface CodexItem {
  type: string;
  id: string;
  text?: string;
  phase?: string | null;
  command?: string;
  cwd?: string;
  status?: string;
  aggregatedOutput?: string | null;
  exitCode?: number | null;
  durationMs?: number | null;
  changes?: { path: string; kind?: { type: string }; diff: string }[];
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
  if (child.pid) {
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
