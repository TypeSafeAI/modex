import { AbortError, query } from "@anthropic-ai/claude-agent-sdk";
import type { CanUseTool, EffortLevel, McpHttpServerConfig, Options, PermissionMode, Query, SDKUserMessage, SettingSource } from "@anthropic-ai/claude-agent-sdk";
import { AgentTracker } from "./agents.js";
import type { CliExecutable } from "../cli-path.js";
import { generateTitle } from "../titles.js";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import { PAGES_TOOLS } from "../../../shared/pages.js";
import { KNOWLEDGE_TOOLS } from "../../../shared/knowledge.js";
import type { ApprovalRequest, Backend, ModelInfo, TitleOptions, TurnAttachment, TurnOptions, TurnResult, TurnSink } from "./types.js";
import { shortJson, stderrTail } from "./types.js";
import { claudeCall, UsageMeter, withUsage } from "./usage.js";
import { cliEnvironment, cliSpawn, health, installation, probe } from "./health.js";
import type { BackendHealth } from "../../../shared/types.js";
import { isModelOutOfCredits } from "../../../shared/failures.js";

/** Filesystem sources whose CLAUDE.md, hooks, MCP servers and skills should load, matching Claude Code CLI defaults. */
export const CLAUDE_SETTING_SOURCES: SettingSource[] = ["user", "project", "local"];

/**
 * The user message content: plain text, or text plus base64 image blocks when images
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

/** Injectable `query()` so tests can drive a scripted fake process instead of the real SDK subprocess. */
export type ClaudeQuery = typeof query;

/**
 * Drives Claude Code through the official Agent SDK (`query()`), pointing at the
 * user's installed `claude` executable so the existing CLI login is the credential.
 * Permission prompts arrive as `canUseTool` callbacks (the SDK's replacement for
 * stdio `control_request` / `control_response`). No HTTP inference API is used.
 */
export class ClaudeBackend implements Backend {
  readonly id = "claude" as const;
  private get bin(): string { return typeof this.executable === "function" ? this.executable() : this.executable; }

  constructor(
    private readonly executable: CliExecutable = process.env.MODEX_CLAUDE_BIN ?? "claude",
    private readonly spawnImpl = cliSpawn,
    /** How long a turn waits on background work, and Stop on a clean interrupt; tests shorten these. */
    private readonly timing: { backgroundIdleMs?: number; backgroundCapMs?: number; interruptGraceMs?: number } = {},
    private readonly queryImpl: ClaudeQuery = query,
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
    } catch { /* Older CLIs do not provide structured account status. */
    }
    return report("unknown", "Account status unavailable · check in Claude CLI");
  }

  async dispose(): Promise<void> {}

  /** Agent SDK `query()` options for a turn. Exported for tests. */
  static sessionOptions(opts: TurnOptions): Options {
    const permissionMode = permissionModeOf(opts);
    const mcp = mcpServersOf(opts);
    const allowed = allowedToolsOf(opts);
    const append = [opts.knowledge?.instructions, opts.pages?.instructions, opts.images?.instructions].filter(Boolean).join("\n\n");
    const effort = opts.effort && (ClaudeBackend.EFFORTS as string[]).includes(opts.effort) ? opts.effort as EffortLevel : undefined;
    return {
      permissionMode,
      ...(permissionMode === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}),
      ...(opts.mode === "chat" && !opts.plan ? { disallowedTools: ["Edit", "Write", "NotebookEdit"] } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      ...(effort ? { effort } : {}),
      ...(opts.fast ? { settings: { fastMode: true } } : {}),
      ...(opts.resume ? { resume: opts.resume } : {}),
      ...(opts.addDirs?.length ? { additionalDirectories: opts.addDirs } : {}),
      ...(mcp ? { mcpServers: mcp } : {}),
      ...(allowed.length ? { allowedTools: allowed } : {}),
      settingSources: [...CLAUDE_SETTING_SOURCES],
      includePartialMessages: true,
      forwardSubagentText: true,
      persistSession: true,
      tools: { type: "preset", preset: "claude_code" },
      systemPrompt: { type: "preset", preset: "claude_code", ...(append ? { append } : {}) },
    };
  }

  generateTitle(text: string, opts: TitleOptions, signal: AbortSignal): Promise<string | null> {
    return generateTitle(this, opts, text, signal);
  }

  runTurn(text: string, opts: TurnOptions, sink: TurnSink, signal: AbortSignal): Promise<TurnResult> {
    if (signal.aborted) return Promise.resolve({ status: "interrupted" });
    return new Promise((resolve) => {
      let child: ChildProcess | undefined;
      let session: Query | undefined;
      let bin = "claude";
      const sdk = ClaudeBackend.sessionOptions(opts);
      const started = new Map<string, number>();
      // Extended-thinking blocks are keyed by content-block index within the current assistant message.
      const thinking = new Map<number, string>();
      let thinkingSeq = 0;
      let streaming = "";
      const agents = new AgentTracker(sink);
      const tasks = new Map<string, string>();
      // The one record of background work still running (keyed by tool_use id, else task id). The
      // agent display reads it, and the turn may end only while it is empty; see `onResult`.
      const background = new Set<string>();
      // Task ids the CLI's own `background_tasks_changed` list has named, so leaving that list ends them.
      const listed = new Set<string>();
      let finished = false;
      // Whether the model has spoken since the last `system/init`: a `result` without that is not a reply to this turn.
      let sawAssistant = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      let stderr = "";
      // What the CLI said about itself at startup (build, model, where its key came from), for failure reports.
      const init: Record<string, unknown> = {};
      const meter = new UsageMeter();
      // Whether fast mode serves this session, from the latest `system/init` or `result` that says.
      let fast: { state?: string; reason?: string } = {};
      // Background work (Bash or Agent with run_in_background) outlives the `result` that ends the model's
      // reply. When it finishes, Claude starts a follow-up turn by itself. Closing the query at the first
      // `result` would drop later permission prompts, so a successful `result` that arrives while work is
      // outstanding is held, and the turn ends at the first `result` with nothing outstanding.
      let held: TurnResult | null = null;
      // Claude has begun a follow-up turn since `held` (it announces each turn with `system/init`); its own `result` will come.
      let followUp = false;
      let approvals = 0;
      let announced = false;
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      let capTimer: ReturnType<typeof setTimeout> | undefined;
      let interruptTimer: ReturnType<typeof setTimeout> | undefined;
      // Recorded on `exit`, which fires before the SDK reports the exit, so its error can be replaced with ours.
      let exit: { code: number | null; signal?: NodeJS.Signals } = { code: null };
      let markClosed: () => void = () => {};
      const closed = new Promise<void>((r) => { markClosed = r; });
      let releasePrompt: (() => void) | undefined;
      // Aborted only when Stop's grace runs out before Claude was launched; Stop itself interrupts first.
      const sdkAbort = new AbortController();
      // The SDK answers permission requests as they arrive, ahead of messages this loop has not reached yet,
      // so a card waits (briefly) for its tool's row. Tool ids this loop has seen, and approvals waiting on one.
      const seenTools = new Set<string>();
      const toolWaiters = new Map<string, () => void>();
      const idleMs = this.timing.backgroundIdleMs ?? BACKGROUND_IDLE_MS;
      const capMs = this.timing.backgroundCapMs ?? BACKGROUND_CAP_MS;
      const interruptMs = this.timing.interruptGraceMs ?? INTERRUPT_GRACE_MS;
      const settle = (r: TurnResult) => {
        releasePrompt?.();
        try { session?.close(); } catch { /* already closed */ }
        try { child?.stdin?.end(); } catch { /* closed */ }
        finish(r);
      };
      // Once the work has drained, Claude normally starts its follow-up turn at once. If it stays quiet
      // for `idleMs` (and no prompt is waiting on the user), the held reply stands. Every message re-arms
      // this, so no message, `system/status` included, can leave a drained turn waiting for nothing.
      const armIdle = () => {
        clearTimeout(idleTimer);
        idleTimer = undefined;
        if (finished || signal.aborted || !held || followUp || approvals > 0 || background.size > 0) return;
        const done = held;
        idleTimer = setTimeout(() => settle(done), idleMs);
      };
      const onResult = (msg: ClaudeMessage) => {
        meter.addOutput(msg.usage?.output_tokens);
        if (msg.session_id) sink.session(msg.session_id);
        const r = resultOf(msg);
        // An error ends the turn at once, as on a turn without background work; holding it would hide it.
        if (r.status === "failed") {
          if (background.size > 0) sink.notice("warn", `Claude reported an error while ${work(background.size)} ${background.size === 1 ? "was" : "were"} still running. The turn ends now, so that work may stop.`);
          return settle(r);
        }
        // `--resume` first replays the previous turn's stopped background task as a turn of its own: `task_notification`,
        // `init`, then a success `result` with `num_turns` 0 and no text, and only then the `init` of the turn that answers
        // this message. Ending on that result ended the turn with no reply while Claude did the real work unheard
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
        // The wait is bounded: a task that never reports an end must not hold the turn (and Claude) open forever.
        capTimer ??= setTimeout(() => {
          const still = background.size > 0 ? `still reported ${work(background.size)} running` : "had not finished the turn its background work started";
          sink.notice("warn", `Claude ${still} ${duration(capMs)} after its reply. Modex ended the turn and stopped Claude.`);
          settle(held ?? { status: "completed" });
          terminate();
        }, capMs);
      };
      const finish = (r: TurnResult) => {
        if (finished) return;
        finished = true;
        releasePrompt?.();
        agents.finish(signal.aborted || r.status === "interrupted");
        clearTimeout(idleTimer);
        clearTimeout(capTimer);
        // Every way here has Claude gone or closing: `settle` closes the session, which escalates to a kill itself.
        clearTimeout(interruptTimer);
        signal.removeEventListener("abort", onAbort);
        const out: TurnResult = signal.aborted ? { status: "interrupted" } : r.status === "failed" ? { ...r, detail: { bin, sdk, pid: child?.pid, ...init, ...r.detail, stderr: stderrTail(stderr) || undefined } } : r;
        const fastMode = fastModeOf(fast.state, fast.reason);
        resolve(withUsage(fastMode ? { ...out, fastMode } : out, meter));
      };
      // Turn settlement must not cancel escalation while the child is still alive.
      const terminate = () => {
        clearTimeout(interruptTimer);
        // Not launched yet: nothing to wait for, so the SDK gives up and the turn ends. Otherwise the turn ends when
        // Claude has really exited (its stream ends), so a resumed turn never races a CLI still writing the session.
        if (!child) return sdkAbort.abort();
        if (child.exitCode !== null || child.signalCode != null) return;
        killTimer ??= setTimeout(() => child?.kill("SIGKILL"), 1500);
        child.kill("SIGTERM");
      };
      // Stop asks Claude to end the turn, so the session records the interruption and `--resume` picks up cleanly.
      // Its `result` then settles the turn; a Claude that has not stopped within the grace window is killed.
      const onAbort = () => {
        clearTimeout(idleTimer);
        clearTimeout(capTimer);
        void session?.interrupt().catch(() => { /* closed or not started */ });
        interruptTimer ??= setTimeout(terminate, interruptMs);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      // A non-zero exit or a kill, reported as the CLI's own last stderr lines like any CLI failure.
      const exitFailure = (sdkError?: string): TurnResult | undefined => {
        if (exit.code === 0 || (exit.code === null && !exit.signal)) return undefined;
        const err = stderr.trim().split("\n").filter((l) => !/^\s*$/.test(l)).slice(-3).join("\n");
        const how = exit.code !== null ? `exited with code ${exit.code}` : `was terminated by ${exit.signal}`;
        return { status: "failed", error: err || `${bin} ${how}`, detail: { exitCode: exit.code ?? undefined, signal: exit.signal, ...(sdkError ? { sdkError } : {}) } };
      };
      const toolSeen = (id: string, cancelled: AbortSignal) => new Promise<void>((r) => {
        if (!id || seenTools.has(id) || cancelled.aborted) return r();
        const done = () => {
          clearTimeout(timer);
          toolWaiters.delete(id);
          cancelled.removeEventListener("abort", done);
          r();
        };
        const timer = setTimeout(done, TOOL_ROW_WAIT_MS);
        toolWaiters.set(id, done);
        cancelled.addEventListener("abort", done, { once: true });
      });

      const canUseTool: CanUseTool = async (toolName, input, toolOpts) => {
        const title = toolTitle(toolName, input);
        const request: ApprovalRequest = {
          question: `Allow ${toolName}: ${title}?`,
          detail: shortJson(input),
          canAlways: Boolean(toolOpts.suggestions?.length) && toolOpts.suppressAlwaysAllowRule !== true,
          action: { backend: "claude", tool: toolName, title, cwd: opts.cwd, input },
        };
        approvals++;
        // Cancel a held-result idle window so a prompt cannot be cut off while the user is deciding.
        armIdle();
        try {
          await toolSeen(toolOpts.toolUseID, toolOpts.signal);
          // null tells the SDK to leave a withdrawn request unanswered.
          if (toolOpts.signal.aborted) return null;
          const answer = await sink.approval(request, toolOpts.signal);
          if (toolOpts.signal.aborted) return null;
          const allow = answer !== "no";
          if (!allow) return { behavior: "deny", message: denyMessage(sink.refusedByRule?.(request)) };
          return {
            behavior: "allow",
            updatedInput: input,
            ...(answer === "always" && toolOpts.suggestions?.length ? { updatedPermissions: toolOpts.suggestions } : {}),
          };
        } finally {
          approvals--;
          armIdle();
        }
      };

      async function* prompt(): AsyncIterable<SDKUserMessage> {
        yield {
          type: "user",
          message: { role: "user", content: userContent(text, opts.attachments) as SDKUserMessage["message"]["content"] },
          parent_tool_use_id: null,
        };
        await new Promise<void>((r) => { releasePrompt = r; });
      }

      try {
        bin = this.bin;
        const env = { ...cliEnvironment(bin), CLAUDE_AGENT_SDK_CLIENT_APP: "modex" };
        session = this.queryImpl({
          prompt: prompt(),
          options: {
            ...sdk,
            cwd: opts.cwd,
            pathToClaudeCodeExecutable: bin,
            abortController: sdkAbort,
            env,
            canUseTool,
            spawnClaudeCodeProcess: (spawnOpts) => {
              // `spawnOpts.env` is `env` above with the SDK's own additions; PATH already leads with the CLI's folder.
              const launched = this.spawnImpl(spawnOpts.command, spawnOpts.args, {
                cwd: spawnOpts.cwd ?? opts.cwd,
                stdio: ["pipe", "pipe", "pipe"],
                env: spawnOpts.env,
                signal: spawnOpts.signal,
              });
              if (!launched.stdin || !launched.stdout) throw new Error(`could not start ${bin}: stdio pipes were not created`);
              child = launched;
              launched.stderr?.on("data", (d: Buffer) => { stderr = (stderr + d.toString()).slice(-16_384); });
              launched.on("error", (err: NodeJS.ErrnoException) => settle({ status: "failed", error: `${bin}: ${err.message}. Is Claude Code installed and on PATH?`, detail: { spawnError: err.message, errno: err.code } }));
              launched.on("exit", (code, sig) => { exit = { code, signal: sig ?? undefined }; });
              launched.on("close", () => {
                clearTimeout(killTimer);
                markClosed();
              });
              return launched as typeof launched & { stdin: NonNullable<ChildProcess["stdin"]>; stdout: NonNullable<ChildProcess["stdout"]> };
            },
          },
        });
      } catch (err) {
        return finish({ status: "failed", error: `could not start ${bin}: ${(err as Error).message}`, detail: { bin, sdk, spawnError: (err as Error).message } });
      }

      void (async () => {
        try {
          for await (const raw of session!) {
            if (finished) return;
            const msg = raw as unknown as ClaudeMessage;
            // After Stop nothing more reaches the thread. The interrupted turn's `result` ends the prompt, so Claude
            // exits on end of input; its stream then ends (or the grace window kills it) and the code after this loop
            // settles the turn once the process is gone.
            if (signal.aborted) {
              if (msg.type === "result") releasePrompt?.();
              continue;
            }
            // The thread's own calls only: sub-agents run on their own context. One call can span several messages with one id.
            if (msg.type === "assistant" && !msg.parent_tool_use_id && msg.message?.usage) meter.call(claudeCall(msg.message.usage), msg.message.id);
            if ((msg.type === "result" || (msg.type === "system" && msg.subtype === "init")) && msg.fast_mode_state !== undefined) fast = { state: msg.fast_mode_state, reason: msg.fast_mode_disabled_reason };
            if (msg.type === "system" && msg.subtype === "init") {
              sawAssistant = false;
              void captureAccount(session, init);
            }
            if (msg.type === "assistant" && !msg.parent_tool_use_id) sawAssistant = true;
            if (msg.type === "result") {
              onResult(msg);
              continue;
            }
            // An API refusal arrives as a synthetic assistant reply, then again as the failed result. The
            // failure card shows it once; as a reply bubble it would also outlive a model fallback.
            if (isApiErrorReply(msg)) continue;
            // Await so `background` and agent rows are current before idle/follow-up checks (and before the next message).
            await this.handle(msg, sink, { cwd: opts.cwd, started, thinking, init, agents, tasks, background, listed, nextThinkingId: () => `think-${++thinkingSeq}`, get streaming() { return streaming; }, set streaming(v: string) { streaming = v; } });
            // Sub-agent tool calls count too: their approval cards wait the same way.
            if (msg.type === "assistant") {
              for (const block of msg.message?.content ?? []) {
                if (block.type !== "tool_use" || !block.id) continue;
                seenTools.add(block.id);
                toolWaiters.get(block.id)?.();
              }
            }
            if (msg.type === "system" && msg.subtype === "init" && held) followUp = true;
            armIdle();
          }
        } catch (err) {
          if (finished) return;
          if (signal.aborted || err instanceof AbortError) {
            if (child) await closed;
            return finish({ status: "interrupted" });
          }
          // The SDK reports a failed exit in its own words; the CLI's stderr says what went wrong. Its last lines may trail `exit`.
          await Promise.race([closed, new Promise((r) => setTimeout(r, 500))]);
          if (finished) return;
          const message = (err as Error).message || String(err);
          return finish(exitFailure(message) ?? { status: "failed", error: message, detail: { sdkError: message } });
        }
        if (finished) return;
        if (signal.aborted) {
          if (child) await closed;
          return finish({ status: "interrupted" });
        }
        finish(exitFailure() ?? held ?? { status: "completed" });
      })();
    });
  }

  /** Everything but `result`, which `runTurn` handles itself because it decides when the turn ends. */
  private async handle(msg: ClaudeMessage, sink: TurnSink, ctx: { agents: AgentTracker; tasks: Map<string, string>; background: Set<string>; listed: Set<string>; cwd?: string; started: Map<string, number>; streaming: string; thinking: Map<number, string>; init: Record<string, unknown>; nextThinkingId: () => string }): Promise<void> {
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
        const ev = msg.event;
        if (ev?.type === "message_start") ctx.thinking.clear();
        else if (ev?.type === "content_block_start" && ev.content_block?.type === "thinking" && ev.index !== undefined) {
          const id = ctx.nextThinkingId();
          ctx.thinking.set(ev.index, id);
          sink.thinkingDelta(id, ev.content_block.thinking ?? "");
        } else if (ev?.type === "content_block_delta" && ev.delta?.type === "thinking_delta" && ev.index !== undefined) {
          const id = ctx.thinking.get(ev.index);
          if (id && ev.delta.thinking) sink.thinkingDelta(id, ev.delta.thinking);
        } else if (ev?.type === "content_block_stop" && ev.index !== undefined && ctx.thinking.has(ev.index)) {
          // Keep the index mapped so the full `assistant` message does not re-emit this block.
          sink.thinkingDone(ctx.thinking.get(ev.index)!);
        } else if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
          ctx.streaming += ev.delta.text;
          sink.delta(ev.delta.text);
        }
        return;
      }
      case "assistant": {
        for (const [i, block] of (msg.message?.content ?? []).entries()) {
          if (block.type === "thinking" && block.thinking && !ctx.thinking.has(i)) {
            // Without partial messages the whole block arrives at once.
            const id = ctx.nextThinkingId();
            sink.thinkingDelta(id, block.thinking);
            sink.thinkingDone(id, block.thinking);
          } else if (block.type === "text" && block.text) {
            sink.assistant(block.text);
            ctx.streaming = "";
          } else if (block.type === "tool_use" && block.id) {
            // Agent runs in the background unless told otherwise; any tool may be asked to.
            if (block.input?.run_in_background === true || (block.name === "Agent" && block.input?.run_in_background !== false)) ctx.background.add(block.id);
            if (block.name === "Agent" || block.name === "Task") {
              ctx.agents.update(block.id, { state: "running", label: String(block.input?.description ?? block.input?.subagent_type ?? "Subagent") }, undefined, block.input);
              continue;
            }
            ctx.started.set(block.id, Date.now());
            sink.toolStart({ id: block.id, name: block.name ?? "tool", title: toolTitle(block.name ?? "tool", block.input ?? {}), args: block.input ?? {} });
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
            if (ctx.agents.has(block.tool_use_id)) {
              if (block.is_error || !ctx.background.has(block.tool_use_id)) ctx.agents.update(block.tool_use_id, { state: block.is_error ? "failed" : "completed" }, content);
              continue;
            }
            const t0 = ctx.started.get(block.tool_use_id);
            sink.toolUpdate(block.tool_use_id, { output: content, ok: !block.is_error, status: "done", durationMs: t0 ? Date.now() - t0 : undefined });
          }
        }
        return;
      }
      default:
        return;
    }
  }
}

function permissionModeOf(opts: TurnOptions): PermissionMode {
  if (opts.plan) return "plan";
  if (opts.mode === "chat") return "default";
  if (opts.mode === "agent") return "acceptEdits";
  return "bypassPermissions";
}

function mcpServersOf(opts: TurnOptions): Record<string, McpHttpServerConfig> | undefined {
  if (!opts.knowledge && !opts.pages && !opts.images) return undefined;
  return {
    ...(opts.images ? { modex_images: { type: "http" as const, url: opts.images.url } } : {}),
    ...(opts.knowledge ? { modex_knowledge: { type: "http" as const, url: opts.knowledge.url } } : {}),
    ...(opts.pages ? { modex_pages: { type: "http" as const, url: opts.pages.url } } : {}),
  };
}

function allowedToolsOf(opts: TurnOptions): string[] {
  return [
    ...(opts.images ? ["mcp__modex_images__register"] : []),
    ...(opts.knowledge ? KNOWLEDGE_TOOLS.map((name) => `mcp__modex_knowledge__${name}`) : []),
    ...(opts.pages ? PAGES_TOOLS.map((name) => `mcp__modex_pages__${name}`) : []),
  ];
}

async function captureAccount(session: Query | undefined, init: Record<string, unknown>): Promise<void> {
  if (!session) return;
  try {
    const info = await session.accountInfo();
    if (info && typeof info === "object") {
      Object.assign(init, {
        ...(info.apiKeySource ? { apiKeySource: info.apiKeySource } : {}),
        ...(info.subscriptionType ? { subscriptionType: info.subscriptionType } : {}),
        ...(info.tokenSource ? { tokenSource: info.tokenSource } : {}),
        ...(info.apiProvider ? { apiProvider: info.apiProvider } : {}),
      });
    }
  } catch { /* Scripted tests and older CLIs have no accountInfo(). */ }
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
  event?: { type: string; index?: number; content_block?: { type: string; thinking?: string }; delta?: { type: string; text?: string; thinking?: string } };
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

/** A `result` message as a turn outcome. */
function resultOf(msg: ClaudeMessage): TurnResult {
  if (msg.is_error) return { status: "failed", error: typeof msg.result === "string" ? msg.result : msg.subtype ?? "error", detail: { resultSubtype: msg.subtype, errors: msg.errors, sessionId: msg.session_id, numTurns: msg.num_turns, durationMs: msg.duration_ms } };
  return { status: "completed" };
}

/** After background work drains, how long to wait for the CLI to begin its follow-up turn before the held reply stands. */
export const BACKGROUND_IDLE_MS = 15_000;
/** The longest a turn stays open after Claude's reply while background work is still reported running (or its follow-up turn has not replied). */
export const BACKGROUND_CAP_MS = 30 * 60_000;
/** How long Stop waits for Claude to end an interrupted turn before it is killed. */
export const INTERRUPT_GRACE_MS = 1_500;
/** The longest a permission card waits for its tool's row to reach the thread. */
export const TOOL_ROW_WAIT_MS = 1_000;
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
