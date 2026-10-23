import { actionDigest } from "../../../shared/human-requests.js";
import { AgentTracker } from "./agents.js";
import type { CliExecutable } from "../cli-path.js";
import { generateTitle } from "../titles.js";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { PAGES_TOOLS } from "../../../shared/pages.js";
import { KNOWLEDGE_TOOLS } from "../../../shared/knowledge.js";
import type { ApprovalRequest, Backend, ModelInfo, StopReport, TitleOptions, TurnAttachment, TurnOptions, TurnResult, TurnSink } from "./types.js";
import { LineBuffer, shortJson, stderrTail, writeJsonResponse } from "./types.js";
import { claudeCall, UsageMeter, withUsage } from "./usage.js";
import { cliEnvironment, cliSpawn, health, installation, probe } from "./health.js";
import type { ApprovalAnswer, BackendHealth } from "../../../shared/types.js";
import type { NativeRef, Observation, PlanStepStatus } from "../../../shared/conversation-events.js";
import { isModelOutOfCredits } from "../../../shared/failures.js";

/**
 * The stream-json user message content: plain text, or text plus base64 image blocks when images
 * are attached. Other files are already named by path in the text. Exported for tests.
 */
export function userContent(text: string, attachments: TurnAttachment[] = []): string | Record<string, unknown>[] {
  const images = attachments.filter((a) => a.kind === "image");
  if (!images.length) return text;
  return [
    ...(text.trim() ? [{ type: "text", text }] : []),
    ...images.map((a) => ({ type: "image", source: { type: "base64", media_type: a.mime, data: fs.readFileSync(a.path).toString("base64") } })),
  ];
}

/**
 * Drives the Claude Code CLI (`claude -p`) over its stream-json protocol:
 * newline-delimited JSON in both directions, token deltas via --include-partial-messages,
 * and permission prompts delivered as `control_request` messages that we answer on stdin.
 * No HTTP API is used — the user's `claude` login is the credential.
 */
export class ClaudeBackend implements Backend {
  readonly id = "claude" as const;
  private get bin(): string { return typeof this.executable === "function" ? this.executable() : this.executable; }

  constructor(
    private readonly executable: CliExecutable = process.env.MODEX_CLAUDE_BIN ?? "claude",
    private readonly spawnImpl = cliSpawn,
    /** How long a turn waits on background work; tests shorten these. */
    private readonly timing: { backgroundIdleMs?: number; backgroundCapMs?: number; interruptGraceMs?: number; killGraceMs?: number; exitConfirmMs?: number; drainMs?: number } = {},
  ) {}

  /** `claude --effort` levels (from `claude --help`); no default so the CLI's own setting applies. */
  static readonly EFFORTS = ["low", "medium", "high", "xhigh", "max"];

  static readonly MODELS: ModelInfo[] = [
    // Aliases always point at the newest model of each family (resolved by the CLI on every run);
    // a full model id such as "claude-fable-5-1" can be typed as well.
    { id: "fable", label: "Fable (latest)", description: "Newest Fable — currently claude-fable-5-1", isDefault: true, efforts: ClaudeBackend.EFFORTS },
    // Fast mode runs only on Opus 4.8 and newer Opus models (Claude Code's own check, and its docs), so only Opus offers it.
    { id: "opus", label: "Opus (latest)", description: "Newest Opus — currently claude-opus-5-5", efforts: ClaudeBackend.EFFORTS, serviceTiers: ["fast"] },
    { id: "sonnet", label: "Sonnet (latest)", description: "Newest Sonnet — currently claude-sonnet-5-5", efforts: ClaudeBackend.EFFORTS },
    { id: "haiku", label: "Haiku (latest)", description: "Newest Haiku — currently claude-haiku-5-5", efforts: ClaudeBackend.EFFORTS },
  ];

  async listModels(): Promise<ModelInfo[]> {
    return ClaudeBackend.MODELS;
  }

  async health() {
    const installed = await installation(this.bin, this.spawnImpl);
    if (installed.unavailable) return installed.unavailable;
    const report = (authentication: BackendHealth["authentication"], detail: string) => health(authentication, detail, "available", installed.version);
    const result = await probe(this.bin, ["auth", "status"], this.spawnImpl);
    if (result.failure) return report("failed", result.failure === "timeout" ? "Account check timed out" : "Account check failed");
    try {
      const account = JSON.parse(result.output) as { loggedIn?: unknown; authMethod?: unknown };
      const source = account.authMethod === "claude.ai" ? "Claude subscription" : ["api_key", "api_key_helper"].includes(String(account.authMethod)) ? "API credentials" : account.authMethod === "third_party" ? "Third-party provider" : "CLI account";
      // Retain main's exit-code checks and CLI version reporting.
      if (account.loggedIn === true && result.code === 0) return report("authenticated", `Signed in · ${source} · model access unverified`);
      if (account.loggedIn === false && result.code === 1) return report("signed-out", "Signed out · run claude auth login");
    } catch { /* Older CLIs do not provide structured account status. */ }
    return report("unknown", "Account status unavailable · check in Claude CLI");
  }

  async dispose(): Promise<void> {}

  /** CLI argv for a turn. Exported for tests. */
  static args(opts: TurnOptions): string[] {
    const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--permission-prompt-tool", "stdio"];
    if (opts.plan) args.push("--permission-mode", "plan");
    else if (opts.mode === "chat") args.push("--permission-mode", "manual", "--disallowedTools", "Edit", "Write", "NotebookEdit");
    else if (opts.mode === "agent") args.push("--permission-mode", "acceptEdits");
    else args.push("--permission-mode", "bypassPermissions");
    if (opts.model) args.push("--model", opts.model);
    if (opts.effort) args.push("--effort", opts.effort);
    // Fast mode is a settings key in Claude Code; `--settings` accepts inline JSON for this session only.
    if (opts.fast) args.push("--settings", JSON.stringify({ fastMode: true }));
    if (opts.resume) args.push("--resume", opts.resume);
    for (const d of opts.addDirs ?? []) args.push("--add-dir", d);
    if (opts.knowledge || opts.pages || opts.images) args.push("--mcp-config", JSON.stringify({ mcpServers: {
      ...(opts.images ? { modex_images: { type: "http", url: opts.images.url } } : {}),
      ...(opts.knowledge ? { modex_knowledge: { type: "http", url: opts.knowledge.url } } : {}),
      ...(opts.pages ? { modex_pages: { type: "http", url: opts.pages.url } } : {}),
    } }), "--append-system-prompt", [opts.knowledge?.instructions, opts.pages?.instructions, opts.images?.instructions].filter(Boolean).join("\n\n"),
    "--allowedTools", ...(opts.images ? ["mcp__modex_images__register"] : []), ...(opts.knowledge ? KNOWLEDGE_TOOLS.map(name => `mcp__modex_knowledge__${name}`) : []),
    ...(opts.pages ? PAGES_TOOLS.map(name => `mcp__modex_pages__${name}`) : []));
    return args;
  }

  generateTitle(text: string, opts: TitleOptions, signal: AbortSignal): Promise<string | null> {
    return generateTitle(this, opts, text, signal);
  }

  runTurn(text: string, opts: TurnOptions, sink: TurnSink, signal: AbortSignal): Promise<TurnResult> {
    if (signal.aborted) return Promise.resolve({ status: "interrupted" });
    return new Promise((resolve) => {
      let child: ChildProcess;
      let bin = "claude";
      const argv = ClaudeBackend.args(opts);
      try {
        bin = this.bin;
        child = this.spawnImpl(bin, argv, { cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"], env: cliEnvironment(bin) });
      } catch (err) {
        return resolve({ status: "failed", error: `could not start ${bin}: ${(err as Error).message}`, detail: { bin, argv: reportArgv(argv), spawnError: (err as Error).message } });
      }
      const lines = new LineBuffer();
      const started = new Map<string, number>();
      // One opaque id for this CLI process: its session, message and tool ids are scoped by it.
      const runtime = randomUUID();
      const blocks: Blocks = { message: null, types: new Map(), local: 0, seen: new Map(), streamed: new Set() };
      const denied = new Set<string>();
      const session = { id: undefined as string | undefined };
      const agents = new AgentTracker(sink, runtime);
      const tasks = new Map<string, string>();
      // The one record of background work still running (keyed by tool_use id, else task id). The
      // agent display reads it, and the turn may end only while it is empty; see `onResult`.
      const background = new Set<string>();
      // Task ids the CLI's own `background_tasks_changed` list has named, so leaving that list ends them.
      const listed = new Set<string>();
      const taskList = new TaskList();
      let finished = false;
      // Whether the model has spoken since the last `system/init`: a `result` without that is not a reply to this turn.
      let sawAssistant = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      let stderr = "";
      // A multi-byte character can straddle two stderr chunks, as on stdout.
      const stderrText = new StringDecoder("utf8");
      // What the CLI said about itself at startup (build, model, where its key came from), for failure reports.
      const init: Record<string, unknown> = {};
      const meter = new UsageMeter();
      // Whether fast mode serves this session, from the latest `system/init` or `result` that says.
      let fast: { state?: string; reason?: string } = {};
      // Background work (Bash or Agent with run_in_background) outlives the `result` that ends the model's
      // reply. When it finishes, the CLI starts a follow-up turn by itself, and that turn's permission
      // prompts are answered on stdin. Closing stdin at the first `result` failed every later prompt with
      // "Tool permission request failed: AbortError: Stream closed". So a successful `result` that arrives
      // while work is outstanding is held, and the turn ends at the first `result` with nothing outstanding.
      let held: TurnResult | null = null;
      // The CLI has begun a follow-up turn since `held` (it announces each turn with `system/init`); its own `result` will come.
      let followUp = false;
      let approvals = 0;
      let announced = false;
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      let capTimer: ReturnType<typeof setTimeout> | undefined;
      const idleMs = this.timing.backgroundIdleMs ?? BACKGROUND_IDLE_MS;
      const capMs = this.timing.backgroundCapMs ?? BACKGROUND_CAP_MS;
      const graceMs = this.timing.interruptGraceMs ?? INTERRUPT_GRACE_MS;
      const killMs = this.timing.killGraceMs ?? KILL_GRACE_MS;
      const confirmMs = this.timing.exitConfirmMs ?? EXIT_CONFIRM_MS;
      const drainMs = this.timing.drainMs ?? DRAIN_MS;
      // `can_use_tool` requests waiting on an answer, by request id. The CLI's `control_cancel_request` aborts one.
      const requests = new Map<string, AbortController>();
      const seenRequests = new Map<string, string>();
      // The process's own end: `exit` may precede `close` by however long a descendant holds its pipes.
      let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
      // A failed `result` ends the turn once the process has exited (or `drainMs` passed), so the stderr it
      // writes on its way out and its exit code reach the failure report.
      let failure: TurnResult | null = null;
      let drainTimer: ReturnType<typeof setTimeout> | undefined;
      // Stop: when it was asked for, and how far Modex had to go to end the process.
      let stopAt: number | undefined;
      let escalation: "terminated" | "killed" | undefined;
      let graceTimer: ReturnType<typeof setTimeout> | undefined;
      let confirmTimer: ReturnType<typeof setTimeout> | undefined;
      // Writing to a pipe the CLI has closed fails asynchronously (EPIPE); there is nothing left to tell it.
      child.stdin?.on("error", () => {});
      const endInput = () => {
        if (child.stdin && !child.stdin.writableEnded) child.stdin.end();
      };
      const settle = (r: TurnResult) => {
        endInput();
        finish(r);
      };
      // Once the work has drained, the CLI normally starts its follow-up turn at once. If it stays quiet
      // for `idleMs` (and no prompt is waiting on the user), the held reply stands. Every message re-arms
      // this, so no message, `system/status` included, can leave a drained turn waiting for nothing.
      const armIdle = () => {
        clearTimeout(idleTimer);
        idleTimer = undefined;
        if (finished || stopAt !== undefined || failure || !held || followUp || approvals > 0 || background.size > 0) return;
        const done = held;
        idleTimer = setTimeout(() => settle(done), idleMs);
      };
      const onResult = (msg: ClaudeMessage) => {
        meter.addOutput(msg.usage?.output_tokens);
        if (msg.session_id) sink.session(msg.session_id);
        // After Stop, this is the interrupted turn closing (`error_during_execution`, terminal_reason `aborted_*`).
        // It is no failure, and it does not end the turn: the process's exit does.
        if (stopAt !== undefined) return endInput();
        // The turn has failed already; nothing the CLI reports while it winds down changes that.
        if (failure) return;
        const r = resultOf(msg);
        // An error ends the turn at once, as on a turn without background work; holding it would hide it.
        if (r.status === "failed") {
          if (background.size > 0) sink.notice("warn", `Claude reported an error while ${work(background.size)} ${background.size === 1 ? "was" : "were"} still running. The turn ends now, so that work may stop.`);
          return fail(r);
        }
        // `--resume` first replays the previous turn's stopped background task as a turn of its own: `task_notification`,
        // `init`, then a success `result` with `num_turns` 0 and no text, and only then the `init` of the turn that answers
        // this message. Ending on that result ended the turn with no reply while the CLI did the real work unheard
        // (2026-10-09, thread 52868298; claude 2.1.296). A result from a turn that never called the model is held instead:
        // the real turn's `init` marks it as a follow-up and its own result ends the turn; silence ends it on the idle window.
        if (msg.num_turns === 0 || (msg.num_turns === undefined && !sawAssistant)) {
          held = r;
          followUp = false;
          armIdle();
          return;
        }
        if (background.size === 0) return settle(r);
        held = r;
        followUp = false;
        armIdle();
        if (!announced) {
          announced = true;
          const one = background.size === 1;
          sink.notice("info", `Claude is still running ${work(background.size)}; this turn continues when ${one ? "it finishes" : "they finish"}. Stop ends ${one ? "it" : "them"}.`);
        }
        // The wait is bounded: a task that never reports an end must not hold the turn (and the CLI) open forever.
        capTimer ??= setTimeout(() => {
          const still = background.size > 0 ? `still reported ${work(background.size)} running` : "had not finished the turn its background work started";
          sink.notice("warn", `Claude ${still} ${duration(capMs)} after its reply. Modex ended the turn and stopped Claude.`);
          settle(held ?? { status: "completed" });
          terminate();
        }, capMs);
      };
      const fail = (r: TurnResult) => {
        failure = r;
        clearTimeout(idleTimer);
        clearTimeout(capTimer);
        endInput();
        drainTimer ??= setTimeout(ended, drainMs);
      };
      const stopReport = (outcome: StopReport["outcome"]): StopReport => ({
        outcome, exitCode: exit?.code ?? null, signal: exit?.signal ?? null, pid: child.pid, ms: Date.now() - (stopAt ?? Date.now()), graceMs,
      });
      const finish = (r: TurnResult) => {
        if (finished) return;
        finished = true;
        agents.finish(signal.aborted || r.status === "interrupted");
        // Stop's escalation outlives the turn: one that failed before Stop still has a process to end.
        for (const t of [idleTimer, capTimer, drainTimer, confirmTimer]) clearTimeout(t);
        signal.removeEventListener("abort", onAbort);
        // A turn that failed before Stop was pressed reports its failure, not the stop.
        const out: TurnResult = signal.aborted && !failure ? { status: "interrupted", ...(r.stop ? { stop: r.stop } : {}) }
          : r.status === "failed" ? { ...r, detail: { bin, argv: reportArgv(argv), pid: child.pid, ...init, ...r.detail, stderr: stderrTail(stderr) || undefined } } : r;
        const fastMode = fastModeOf(fast.state, fast.reason);
        resolve(withUsage(fastMode ? { ...out, fastMode } : out, meter));
      };
      // The process is done (closed, or exited and `drainMs` passed): whatever it printed last has been read.
      const ended = () => {
        if (finished) return;
        // A failed result's drain deadline is not proof that Stop ended the process.
        // Keep ownership until exit or the bounded unconfirmed-stop deadline.
        if (stopAt !== undefined && !exit) {
          clearTimeout(drainTimer);
          drainTimer = undefined;
          return;
        }
        lines.flush(onLine);
        stderr = (stderr + stderrText.end()).slice(-16_384);
        if (finished) return;
        const exited = exit && (exit.code !== null ? { exitCode: exit.code } : {}), signalled = exit?.signal ? { signal: exit.signal } : {};
        if (failure) return finish({ ...failure, detail: { ...failure.detail, ...exited, ...signalled }, ...(stopAt !== undefined ? { stop: stopReport(escalation ?? "exited") } : {}) });
        if (signal.aborted) return finish({ status: "interrupted", stop: stopReport(escalation ?? "exited") });
        const err = stderr.trim().split("\n").filter((l) => !/^\s*$/.test(l)).slice(-3).join("\n");
        const how = exit?.signal ? `was terminated by ${exit.signal}` : `exited with code ${exit?.code}`;
        finish(exit?.code === 0 ? held ?? { status: "completed" } : { status: "failed", error: err || `${bin} ${how}`, detail: { exitCode: exit?.code ?? null, signal: exit?.signal ?? undefined } });
      };
      // Only while this turn lasts, and only into an input that is still open.
      const write = (o: unknown) => {
        const stdin = child.stdin;
        if (finished || !stdin || stdin.writableEnded || stdin.destroyed) return;
        try {
          stdin.write(JSON.stringify(o) + "\n");
        } catch {
          /* closed */
        }
      };
      const writeResponse = (o: unknown) => finished
        ? Promise.reject(new Error("request transport unavailable")) : writeJsonResponse(child.stdin, o);
      // Turn settlement must not cancel escalation while the child is still alive.
      const terminate = () => {
        if (exit || child.exitCode !== null || child.signalCode != null) return;
        killTimer ??= setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
        child.kill("SIGTERM");
      };
      // Stop asks Claude Code to interrupt its turn, as its own Esc does: it withdraws its pending prompts, closes
      // the turn and acknowledges at once. Ending its input too lets a running tool stop and the CLI exit once the
      // turn is closed (2.1.302 kept a running Bash call going under the interrupt alone until stdin ended). Its
      // last messages are still read. The turn ends when the process has exited; one that has not within
      // `graceMs` is terminated, then killed, and one that never reports an exit is given up on, said so.
      const onAbort = () => {
        if (finished || stopAt !== undefined) return;
        stopAt = Date.now();
        clearTimeout(idleTimer);
        clearTimeout(capTimer);
        write({ type: "control_request", request_id: `modex-stop-${randomUUID()}`, request: { subtype: "interrupt" } });
        endInput();
        graceTimer = setTimeout(() => {
          if (exit) return;
          escalation = "terminated";
          child.kill("SIGTERM");
          killTimer = setTimeout(() => {
            if (exit) return;
            escalation = "killed";
            child.kill("SIGKILL");
            confirmTimer = setTimeout(() => finish({ ...(failure ?? { status: "interrupted" }), stop: stopReport("unconfirmed") }), confirmMs);
          }, killMs);
        }, graceMs);
      };
      signal.addEventListener("abort", onAbort, { once: true });

      const onLine = (line: string) => {
        if (finished) return;
        let msg: ClaudeMessage;
        try {
          msg = JSON.parse(line) as ClaudeMessage;
        } catch {
          return;
        }
        // A heartbeat (the CLI sends one while a control request runs long) is no sign of the turn going on.
        if (msg.type === "keep_alive") return;
        // The CLI no longer needs an answer to one of its prompts (Stop, or it settled the prompt itself).
        if (msg.type === "control_cancel_request") return void (msg.request_id && requests.get(msg.request_id)?.abort());
        // Our interrupt's acknowledgement. What ends a stopped turn is the process's exit.
        if (msg.type === "control_response") return;
        // The thread's own calls only: sub-agents run on their own context. One call can span several messages with one id.
        if (msg.type === "assistant" && !msg.parent_tool_use_id && msg.message?.usage) meter.call(claudeCall(msg.message.usage), msg.message.id);
        if ((msg.type === "result" || (msg.type === "system" && msg.subtype === "init")) && msg.fast_mode_state !== undefined) fast = { state: msg.fast_mode_state, reason: msg.fast_mode_disabled_reason };
        if (msg.type === "system" && msg.subtype === "init") sawAssistant = false;
        if (msg.type === "assistant" && !msg.parent_tool_use_id) sawAssistant = true;
        if (msg.type === "result") return onResult(msg);
        // An API refusal arrives as a synthetic assistant reply, then again as the failed result. The
        // failure card shows it once; as a reply bubble it would also outlive a model fallback.
        if (isApiErrorReply(msg)) return;
        // `handle` updates `background` before it first awaits, so the checks below see this message's effect.
        if (msg.session_id) session.id = msg.session_id;
        // Every line has its own uuid; the observations a line makes are numbered after it.
        let part = 0;
        const observe = (o: Observation) => sink.observe({ ...o, ...(msg.uuid ? { source: `${msg.uuid}#${part++}` } : {}) });
        const native = (item: string, block?: number): NativeRef => ({ runtime, ...(session.id ? { thread: session.id } : {}), item, ...(block !== undefined ? { part: String(block) } : {}) });
        const handled = this.handle(msg, sink, { cwd: opts.cwd, started, write, writeResponse, requests, seenRequests, stopping: () => stopAt !== undefined, init, agents, tasks, taskList, background, listed, blocks, denied, observe, native });
        if (msg.type === "control_request") {
          approvals++;
          void handled.finally(() => {
            approvals--;
            armIdle();
          });
        }
        if (msg.type === "system" && msg.subtype === "init" && held) followUp = true;
        armIdle();
      };
      child.on("error", (err) => finish({ status: "failed", error: `${bin}: ${err.message}. Is Claude Code installed and on PATH?`, detail: { spawnError: err.message, errno: (err as NodeJS.ErrnoException).code } }));
      child.stderr?.on("data", (d: Buffer) => (stderr = (stderr + stderrText.write(d)).slice(-16_384)));
      child.stdout?.on("data", (d: Buffer) => lines.push(d, onLine));
      // The last line may lack its newline when the CLI exits.
      child.stdout?.on("end", () => lines.flush(onLine));
      child.on("exit", (code, sig) => {
        exit = { code, signal: sig };
        for (const t of [killTimer, graceTimer, confirmTimer]) clearTimeout(t);
        // A descendant (a background shell, say) can hold the pipes open long after Claude itself is gone.
        drainTimer ??= setTimeout(ended, drainMs);
      });
      child.on("close", (code, sig) => {
        exit ??= { code, signal: sig };
        for (const t of [killTimer, graceTimer, confirmTimer]) clearTimeout(t);
        ended();
      });

      write({ type: "user", message: { role: "user", content: userContent(text, opts.attachments) } });
    });
  }

  /** Everything but `result`, which `runTurn` handles itself because it decides when the turn ends. */
  private async handle(msg: ClaudeMessage, sink: TurnSink, ctx: { agents: AgentTracker; tasks: Map<string, string>; taskList: TaskList; background: Set<string>; listed: Set<string>; cwd?: string; started: Map<string, number>; write: (o: unknown) => void; writeResponse: (o: unknown) => Promise<void>; requests: Map<string, AbortController>; seenRequests: Map<string, string>; stopping: () => boolean; init: Record<string, unknown>; blocks: Blocks; denied: Set<string>; observe: (o: Observation) => void; native: (item: string, block?: number) => NativeRef }): Promise<void> {
    // Subagent text/thinking belongs to that agent, never to the parent's streaming buffer.
    if (msg.parent_tool_use_id && ["assistant", "user", "stream_event"].includes(msg.type)) {
      const tool = msg.message?.content?.find((b) => b.type === "tool_use");
      if (tool) ctx.agents.update(msg.parent_tool_use_id, { state: "running", detail: toolTitle(tool.name ?? "tool", tool.input ?? {}) });
      return;
    }
    switch (msg.type) {
      case "system":
        if (msg.subtype === "init") {
          if (msg.session_id) sink.session(msg.session_id);
          Object.assign(ctx.init, { claudeVersion: msg.claude_code_version, claudeModel: msg.model, permissionMode: msg.permissionMode, apiKeySource: msg.apiKeySource });
        }
        if (msg.subtype === "background_tasks_changed" && Array.isArray(msg.tasks)) {
          // The CLI's full list of running background tasks: whatever has left it has ended.
          const now = new Set(msg.tasks.map((t) => t?.task_id).filter((t): t is string => typeof t === "string"));
          for (const t of ctx.listed) if (!now.has(t)) ctx.background.delete(ctx.tasks.get(t) ?? t);
          ctx.listed.clear();
          for (const t of now) {
            ctx.listed.add(t);
            ctx.background.add(ctx.tasks.get(t) ?? t);
          }
        }
        if (msg.task_id && !msg.ambient) {
          const id = msg.tool_use_id ?? ctx.tasks.get(msg.task_id) ?? msg.task_id;
          if (msg.tool_use_id && ctx.tasks.get(msg.task_id) !== id) {
            ctx.tasks.set(msg.task_id, id);
            // Work first named by task id (from `background_tasks_changed`) is now known by its tool_use id.
            if (ctx.background.delete(msg.task_id)) ctx.background.add(id);
          }
          if (msg.subtype === "task_started") {
            if (msg.is_backgrounded === false) ctx.background.delete(id);
            else ctx.background.add(id);
          }
          if (msg.subtype === "task_updated" && msg.patch?.is_backgrounded !== undefined) {
            if (msg.patch.is_backgrounded) ctx.background.add(id);
            else ctx.background.delete(id);
          }
          if ((msg.subtype === "task_notification" && msg.status !== "running") || (msg.subtype === "task_updated" && TERMINAL_TASK_STATUSES.has(msg.patch?.status ?? ""))) {
            ctx.background.delete(id);
            ctx.listed.delete(msg.task_id);
          }
          if (msg.subtype === "task_started" && (msg.task_type === "local_agent" || msg.task_type === "remote_agent")) {
            ctx.tasks.set(msg.task_id, id);
            ctx.agents.update(id, { state: "running", ...(msg.description ? { label: msg.description } : {}) });
          } else if (ctx.agents.has(id)) {
            if (msg.subtype === "task_progress") ctx.agents.update(id, { state: "running", detail: msg.summary ?? msg.last_tool_name ?? msg.description });
            if (msg.subtype === "task_notification") ctx.agents.update(id, { state: msg.status === "completed" ? "completed" : msg.status === "failed" ? "failed" : "stopped", detail: msg.summary }, msg.summary);
            if (msg.subtype === "task_updated") {
              const status = msg.patch?.status;
              ctx.agents.update(id, {
                ...(status ? { state: status === "completed" ? "completed" : status === "failed" ? "failed" : status === "killed" ? "stopped" : "running" } : {}),
                ...(msg.patch?.description ? { label: msg.patch.description } : {}),
                ...(msg.patch?.error ? { detail: msg.patch.error } : {}),
              }, msg.patch?.error);
            }
          }
        }
        return;
      case "stream_event": {
        // A content block is named by its message id and stream index. Thinking text is a summary when
        // the CLI says the display is `summarized`, otherwise the provider's own text; a block with no
        // text (signature only) or a redacted one stays unavailable. Signatures and redacted data are
        // opaque and are never read.
        const ev = msg.event;
        const b = ctx.blocks;
        if (!ev) return;
        if (msg.thinking_display) b.display = msg.thinking_display;
        if (ev.type === "message_start") {
          // A message the CLI gave no id (older builds) gets one here, at ingress.
          b.message = ev.message?.id ?? `local-${++b.local}`;
          b.types.clear();
          b.last = undefined;
          b.display = msg.thinking_display;
          return;
        }
        if (!ev.type.startsWith("content_block_")) return;
        b.message ??= `local-${++b.local}`;
        // A delta with no index continues the block before it; one with no start says its type in the delta.
        const index = ev.index ?? b.last ?? 0;
        b.last = index;
        const native = ctx.native(b.message, index);
        const deltaType = ev.delta?.type === "text_delta" ? "text" : ev.delta?.type === "thinking_delta" || ev.delta?.type === "signature_delta" ? "thinking" : undefined;
        const type = ev.type === "content_block_start" ? ev.content_block?.type : b.types.get(index) ?? deltaType;
        if (type && !b.types.has(index)) b.types.set(index, type);
        if (type === "thinking" || type === "redacted_thinking") {
          b.streamed.add(`${b.message}:${index}`);
          if (ev.type === "content_block_start") ctx.observe({ type: "reasoning.start", native });
          const text = ev.type === "content_block_start" ? ev.content_block?.thinking : ev.delta?.type === "thinking_delta" ? ev.delta.thinking : undefined;
          if (type === "thinking" && text) ctx.observe({ type: "reasoning.delta", native, representation: thinkingRepresentation(b.display), index: 0, text });
          if (ev.type === "content_block_stop") ctx.observe({ type: "reasoning.done", native });
        } else if (type === "text") {
          if (ev.type === "content_block_start") ctx.observe({ type: "message.start", native, phase: "unspecified" });
          else if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) ctx.observe({ type: "message.delta", native, text: ev.delta.text });
          else if (ev.type === "content_block_stop") ctx.observe({ type: "message.done", native });
        }
        return;
      }
      case "assistant": {
        // The CLI sends one `assistant` message per content block, in stream order, so the k-th block
        // seen for a message id is stream block k. Its text is the block's final snapshot.
        // Without an id it is the message streaming now, or one of its own.
        const message = msg.message?.id ?? ctx.blocks.message ?? `local-${++ctx.blocks.local}`;
        for (const block of msg.message?.content ?? []) {
          const k = ctx.blocks.seen.get(message) ?? 0;
          ctx.blocks.seen.set(message, k + 1);
          const native = ctx.native(message, k);
          if ((block.type === "thinking" || block.type === "redacted_thinking") && !ctx.blocks.streamed.has(`${message}:${k}`)) {
            // Without partial messages the whole block arrives at once.
            ctx.observe({ type: "reasoning.start", native });
            if (block.type === "thinking" && block.thinking) ctx.observe({ type: "reasoning.delta", native, representation: thinkingRepresentation(msg.thinking_display ?? ctx.blocks.display), index: 0, text: block.thinking });
            ctx.observe({ type: "reasoning.done", native });
          } else if (block.type === "text" && block.text) {
            ctx.observe({ type: "message.done", native, text: block.text });
          } else if (block.type === "tool_use" && block.id) {
            // Agent runs in the background unless told otherwise; any tool may be asked to.
            if (block.input?.run_in_background === true || (block.name === "Agent" && block.input?.run_in_background !== false)) ctx.background.add(block.id);
            if (block.name === "Agent" || block.name === "Task") {
              ctx.agents.update(block.id, { state: "running", label: String(block.input?.description ?? block.input?.subagent_type ?? "Subagent") }, undefined, block.input);
              continue;
            }
            ctx.started.set(block.id, Date.now());
            // TodoWrite carries the whole todo list: Claude's plan, revised by each call.
            if (block.name === "TodoWrite" && Array.isArray(block.input?.todos)) {
              const steps = (block.input.todos as { content?: unknown; status?: unknown }[]).map((t) => ({ text: String(t.content ?? ""), status: claudeStepStatus(t.status) }));
              ctx.observe({ type: "plan.update", native: ctx.native("todos"), from: "claude-todo", steps });
            }
            if (block.name === "TaskCreate" || block.name === "TaskUpdate") ctx.taskList.called(block.id, block.name, block.input ?? {});
            // Bash's command is what ran; its working directory is the CLI's own and persists between calls, so none is claimed.
            const command = block.name === "Bash" && typeof block.input?.command === "string" ? block.input.command : undefined;
            ctx.observe({ type: "tool.start", native: ctx.native(block.id), tool: { name: block.name ?? "tool", title: toolTitle(block.name ?? "tool", block.input ?? {}), args: block.input ?? {}, ...(command ? { exec: { command } } : {}) } });
          }
        }
        return;
      }
      case "user": {
        for (const block of msg.message?.content ?? []) {
          if (block.type === "tool_result" && block.tool_use_id) {
            const content = typeof block.content === "string" ? block.content : (block.content ?? []).map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
            // A background launch that failed (or was denied) leaves nothing running.
            if (block.is_error) ctx.background.delete(block.tool_use_id);
            else {
              const steps = ctx.taskList.confirmed(block.tool_use_id, content);
              if (steps) ctx.observe({ type: "plan.update", native: ctx.native("tasks"), from: "claude-tasks", steps });
            }
            if (ctx.agents.has(block.tool_use_id)) {
              if (block.is_error || !ctx.background.has(block.tool_use_id)) ctx.agents.update(block.tool_use_id, { state: block.is_error ? "failed" : "completed" }, content);
              continue;
            }
            const t0 = ctx.started.get(block.tool_use_id);
            // An error result is a denial only when Modex itself refused this tool_use. After Stop it is the CLI
            // rejecting the call it was interrupted in; otherwise it failed.
            const outcome = !block.is_error ? "succeeded" : ctx.denied.has(block.tool_use_id) ? "denied" : ctx.stopping() ? "interrupted" : "failed";
            ctx.observe({ type: "tool.done", native: ctx.native(block.tool_use_id), outcome, progress: { output: content, ...(t0 ? { durationMs: Date.now() - t0 } : {}) } });
          }
        }
        return;
      }
      case "control_request": {
        const req = msg.request;
        if (req?.subtype !== "can_use_tool") {
          ctx.write({ type: "control_response", response: { subtype: "error", request_id: msg.request_id, error: `unsupported control request ${req?.subtype ?? "?"}` } });
          return;
        }
        if (msg.request_id) {
          const digest = actionDigest(req);
          if (ctx.seenRequests.has(msg.request_id)) {
            if (ctx.seenRequests.get(msg.request_id) !== digest) {
              ctx.requests.get(msg.request_id)?.abort();
              sink.notice("warn", "Claude reused a request id for a changed action; the original request was withdrawn. A new request id is required.");
            }
            return;
          }
          ctx.seenRequests.set(msg.request_id, digest);
        }
        const tool = req.tool_name ?? "tool";
        const title = toolTitle(tool, req.input ?? {});
        const request: ApprovalRequest = {
          question: `Allow ${req.tool_name}: ${title}?`,
          detail: shortJson(req.input ?? {}),
          canAlways: Boolean(req.permission_suggestions?.length),
          action: { backend: "claude", tool, title, cwd: ctx.cwd, input: req.input ?? {} },
          ...(msg.request_id ? { native: { runtime: ctx.native("").runtime, request: msg.request_id, ...(req.tool_use_id ? { item: req.tool_use_id } : {}) } } : {}),
        };
        // The CLI may withdraw the prompt (`control_cancel_request`) while it waits: the sink closes its card,
        // this request is done, and no answer is sent, since the CLI ignores one for a request it cancelled.
        const withdrawn = new AbortController();
        const id = msg.request_id;
        if (id) ctx.requests.set(id, withdrawn);
        let answer: ApprovalAnswer | undefined;
        try {
          answer = await Promise.race([
            sink.approval(request, withdrawn.signal),
            new Promise<undefined>((resolve) => withdrawn.signal.addEventListener("abort", () => resolve(undefined), { once: true })),
          ]);
          if (answer === undefined || withdrawn.signal.aborted) return;
          const allow = answer !== "no";
          if (!allow && req.tool_use_id) ctx.denied.add(req.tool_use_id);
          const response = {
            type: "control_response",
            response: {
              subtype: "success",
              request_id: msg.request_id,
              response: allow
                ? { behavior: "allow", updatedInput: req.input ?? {}, ...(answer === "always" && req.permission_suggestions?.length ? { updatedPermissions: req.permission_suggestions } : {}) }
                : { behavior: "deny", message: denyMessage(sink.refusedByRule?.(request)) },
            },
          };
          const write = () => ctx.writeResponse(response);
          if (request.native && sink.deliverRequest) await sink.deliverRequest(request.native, write);
          else ctx.write(response);
        } finally {
          if (id && ctx.requests.get(id) === withdrawn) ctx.requests.delete(id);
        }
        return;
      }
      default:
        return;
    }
  }
}

/**
 * Content blocks of the parent's messages: the message streaming now, its block types by stream
 * index, the last index seen, blocks seen per message, thinking blocks already streamed, and a
 * counter for messages that came without an id.
 */
interface Blocks {
  message: string | null;
  /** The message's `thinking_display`, which the CLI sends from `message_start` on. */
  display?: string;
  types: Map<number, string>;
  last?: number;
  local: number;
  seen: Map<string, number>;
  streamed: Set<string>;
}

interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | { type: string; text?: string }[];
  is_error?: boolean;
}
interface ClaudeUsage {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
}
interface ClaudeMessage {
  type: string;
  subtype?: string;
  parent_tool_use_id?: string | null;
  task_id?: string;
  tool_use_id?: string;
  task_type?: string;
  is_backgrounded?: boolean;
  ambient?: boolean;
  description?: string;
  summary?: string;
  last_tool_name?: string;
  status?: string;
  patch?: { status?: string; description?: string; error?: string; is_backgrounded?: boolean };
  /** `system/background_tasks_changed`: every background task still running. */
  tasks?: { task_id?: string }[];
  session_id?: string;
  message?: { id?: string; model?: string; content?: ContentBlock[]; usage?: ClaudeUsage };
  /** A synthetic assistant reply's API error class ("rate_limit", "billing_error", …). */
  error?: unknown;
  /** `result`: the turn's token totals. */
  usage?: ClaudeUsage;
  event?: { type: string; index?: number; message?: { id?: string }; content_block?: { type: string; thinking?: string }; delta?: { type: string; text?: string; thinking?: string } };
  request_id?: string;
  request?: { subtype?: string; tool_name?: string; tool_use_id?: string; input?: Record<string, unknown>; permission_suggestions?: unknown[] };
  /** Every line's own id. */
  uuid?: string;
  /** How the CLI displays thinking for this message: `summarized`, `omitted`, `highlights` (2.1.302's settings), `updates` (seen live). */
  thinking_display?: string;
  is_error?: boolean;
  result?: unknown;
  /** `result` extras and `system/init` facts, kept for failure reports. */
  errors?: unknown;
  num_turns?: number;
  duration_ms?: number;
  claude_code_version?: string;
  model?: string;
  permissionMode?: string;
  apiKeySource?: string;
  /** `system/init` and `result`: "on", "off" or "cooldown" (paused after a rate limit), and why it is not on. */
  fast_mode_state?: string;
  fast_mode_disabled_reason?: string;
}

/** Claude Code's `fast_mode_disabled_reason` values (2.1.296), in words. Its own messages read the same. */
const FAST_MODE_OFF: Record<string, string> = {
  extra_usage_disabled: "fast mode requires usage credits",
  free: "fast mode requires a paid subscription",
  preference: "fast mode is disabled by your organization",
  model_not_allowed: "Opus is not in your organization's allowed models",
  not_first_party: "fast mode needs the Anthropic API directly, not a cloud provider",
  disabled_by_env: "CLAUDE_CODE_DISABLE_FAST_MODE is set",
  network_error: "Claude Code could not check fast-mode availability (network error)",
  pending: "Claude Code was still checking fast-mode availability",
  sdk_opt_in_required: "fast mode is not available in the Agent SDK",
  unknown: "fast mode is currently unavailable",
};

/** Fast mode as the CLI reported it, or undefined when it did not say. Exported for tests. */
export function fastModeOf(state: string | undefined, reason: string | undefined): TurnResult["fastMode"] {
  if (state === undefined) return undefined;
  if (state === "on") return { on: true };
  if (state === "cooldown") return { on: false, why: "fast mode is cooling down after a rate limit" };
  if (!reason) return { on: false, why: "Claude Code reported fast mode off" };
  return { on: false, why: FAST_MODE_OFF[reason] ? `${FAST_MODE_OFF[reason]} (${reason})` : `Claude Code reported ${reason}` };
}

/** Claude Code's stand-in reply for a refused API call: model `<synthetic>`, plus an error class or a credit refusal. Exported for tests. */
export function isApiErrorReply(msg: { type: string; parent_tool_use_id?: string | null; message?: { model?: string; content?: ContentBlock[] }; error?: unknown }): boolean {
  if (msg.type !== "assistant" || msg.parent_tool_use_id || msg.message?.model !== "<synthetic>") return false;
  if (typeof msg.error === "string" && msg.error) return true;
  return (msg.message.content ?? []).some((block) => block.type === "text" && typeof block.text === "string" && isModelOutOfCredits(block.text));
}

/**
 * Claude thinking text as a reasoning representation: a summary only when the CLI says the display
 * is `summarized`; any other text is the provider's own. Exported for tests.
 */
export function thinkingRepresentation(display: string | undefined): "summary" | "provider-text" {
  return display === "summarized" ? "summary" : "provider-text";
}

/**
 * Claude's task list from `TaskCreate`/`TaskUpdate` (Claude Code 2.1.309 with
 * `CLAUDE_CODE_ENABLE_TODO_TOOLS`): each call changes one task, and counts only once the CLI's result
 * confirms it. A created task's id is the number in "Task #N created"; an update to a task this turn
 * did not create is not guessed at.
 */
export class TaskList {
  private readonly steps: { id: string; text: string; status: PlanStepStatus }[] = [];
  private readonly calls = new Map<string, { name: "TaskCreate" | "TaskUpdate"; input: Record<string, unknown> }>();

  called(toolUseId: string, name: "TaskCreate" | "TaskUpdate", input: Record<string, unknown>): void {
    this.calls.set(toolUseId, { name, input });
  }

  /** The whole list after a confirmed call, or undefined when the result changed nothing Modex can show. */
  confirmed(toolUseId: string, result: string): { text: string; status: PlanStepStatus }[] | undefined {
    const call = this.calls.get(toolUseId);
    if (!call) return undefined;
    this.calls.delete(toolUseId);
    if (call.name === "TaskCreate") {
      const id = /^Task #(\S+) created/.exec(result.trim())?.[1];
      if (!id || typeof call.input.subject !== "string" || !call.input.subject.trim()) return undefined;
      this.steps.push({ id, text: call.input.subject.trim(), status: "pending" });
    } else {
      const i = this.steps.findIndex((step) => step.id === String(call.input.taskId));
      if (i < 0) return undefined;
      if (call.input.status === "deleted") this.steps.splice(i, 1);
      else this.steps[i] = {
        ...this.steps[i]!,
        ...(call.input.status !== undefined ? { status: claudeStepStatus(call.input.status) } : {}),
        ...(typeof call.input.subject === "string" && call.input.subject.trim() ? { text: call.input.subject.trim() } : {}),
      };
    }
    return this.steps.map(({ text, status }) => ({ text, status }));
  }
}

function claudeStepStatus(status: unknown): PlanStepStatus {
  return status === "pending" ? "pending" : status === "in_progress" ? "in-progress" : status === "completed" ? "completed" : "unknown";
}

/** A `result` message as a turn outcome. */
function resultOf(msg: ClaudeMessage): TurnResult {
  if (msg.is_error) return { status: "failed", error: typeof msg.result === "string" ? msg.result : msg.subtype ?? "error", detail: { resultSubtype: msg.subtype, errors: msg.errors, sessionId: msg.session_id, numTurns: msg.num_turns, durationMs: msg.duration_ms } };
  return { status: "completed" };
}

/**
 * After Stop, how long Claude has to close its turn and exit before Modex sends SIGTERM. Measured live on Claude
 * Code 2.1.302 (2026-10-18), interrupt plus end of input: acknowledged within 10 ms; exited 0.6 s after Stop while
 * streaming; with a Bash call running, the turn closed after 2.7 s and the CLI exited at 3.2 s, so there this grace
 * ends in SIGTERM as Stop always did, 1.5 s later than before.
 */
export const INTERRUPT_GRACE_MS = 1500;
/** After SIGTERM, how long before SIGKILL (the budget Stop has always had). */
export const KILL_GRACE_MS = 1500;
/** After SIGKILL, how long to wait for the exit before reporting the stop unconfirmed rather than waiting forever. */
export const EXIT_CONFIRM_MS = 2000;
/** After the exit (or a failed result), how long to keep reading output that is still on its way. */
export const DRAIN_MS = 1000;

/** The argv for a debug report: MCP routes keep their address, not the capability token in their path. Exported for tests. */
export function reportArgv(argv: string[]): string[] {
  return argv.map((arg) => arg.replace(/(\/mcp\/)[A-Za-z0-9._~-]{8,}/g, "$1[redacted]"));
}

/** After background work drains, how long to wait for the CLI to begin its follow-up turn before the held reply stands. */
export const BACKGROUND_IDLE_MS = 15_000;
/** The longest a turn stays open after Claude's reply while background work is still reported running (or its follow-up turn has not replied). */
export const BACKGROUND_CAP_MS = 30 * 60_000;
/** Task statuses after which a background task is no longer running. */
const TERMINAL_TASK_STATUSES = new Set(["completed", "failed", "killed", "stopped", "cancelled", "canceled"]);

const work = (n: number) => (n === 1 ? "a background task" : `${n} background tasks`);
const duration = (ms: number) => (ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`);

/** What Claude is told when an approval is denied; a refusal by one of the user's approval rules names the rule. */
export function denyMessage(rule?: string): string {
  const when = rule?.replace(/\s+/g, " ").trim();
  return when ? `The user denied this action in Modex (rule: ${when.length > 200 ? `${when.slice(0, 199)}…` : when}).` : "The user denied this action in Modex.";
}

/** Human title for a Claude Code tool call. */
export function toolTitle(name: string, input: Record<string, unknown>): string {
  const s = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : "");
  switch (name) {
    case "Bash": return `$ ${s("command")}`;
    case "Read": return `read ${s("file_path")}`;
    case "Edit": case "MultiEdit": case "NotebookEdit": return `edit ${s("file_path") || s("notebook_path")}`;
    case "Write": return `write ${s("file_path")}`;
    case "Glob": return `glob ${s("pattern")}`;
    case "Grep": return `grep ${s("pattern")}`;
    case "WebFetch": return `fetch ${s("url")}`;
    case "WebSearch": return `search ${s("query")}`;
    case "Agent": case "Task": return `agent: ${s("description")}`;
    default: return name;
  }
}
