import { AgentTracker } from "./agents.js";
import type { CliExecutable } from "../cli-path.js";
import { generateTitle } from "../titles.js";
import { spawn, type ChildProcess } from "node:child_process";
import type { ApprovalRequest, Backend, ModelInfo, TurnOptions, TurnResult, TurnSink } from "./types.js";
import { LineBuffer, shortJson, stderrTail } from "./types.js";
import { cliEnvironment, health, installation, probe } from "./health.js";
import type { BackendHealth } from "../../../shared/types.js";

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
    private readonly spawnImpl = spawn,
    /** How long a turn waits on background work; tests shorten these. */
    private readonly timing: { backgroundIdleMs?: number; backgroundCapMs?: number } = {},
  ) {}

  /** `claude --effort` levels (from `claude --help`); no default so the CLI's own setting applies. */
  static readonly EFFORTS = ["low", "medium", "high", "xhigh", "max"];

  static readonly MODELS: ModelInfo[] = [
    // Aliases always point at the newest model of each family (resolved by the CLI on every run);
    // a full model id such as "claude-fable-5-1" can be typed as well.
    { id: "fable", label: "Fable (latest)", description: "Newest Fable — currently claude-fable-5-1", isDefault: true, efforts: ClaudeBackend.EFFORTS },
    { id: "opus", label: "Opus (latest)", description: "Newest Opus — currently claude-opus-5-5", efforts: ClaudeBackend.EFFORTS },
    { id: "sonnet", label: "Sonnet (latest)", description: "Newest Sonnet — currently claude-sonnet-5", efforts: ClaudeBackend.EFFORTS },
    { id: "haiku", label: "Haiku (latest)", description: "Newest Haiku — currently claude-haiku-4-5", efforts: ClaudeBackend.EFFORTS },
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
    return args;
  }

  generateTitle(text: string, opts: { model: string }, signal: AbortSignal): Promise<string | null> {
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
        return resolve({ status: "failed", error: `could not start ${bin}: ${(err as Error).message}`, detail: { bin, argv, spawnError: (err as Error).message } });
      }
      const lines = new LineBuffer();
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
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      let stderr = "";
      // What the CLI said about itself at startup (build, model, where its key came from), for failure reports.
      const init: Record<string, unknown> = {};
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
      const settle = (r: TurnResult) => {
        child.stdin?.end();
        finish(r);
      };
      // Once the work has drained, the CLI normally starts its follow-up turn at once. If it stays quiet
      // for `idleMs` (and no prompt is waiting on the user), the held reply stands. Every message re-arms
      // this, so no message, `system/status` included, can leave a drained turn waiting for nothing.
      const armIdle = () => {
        clearTimeout(idleTimer);
        idleTimer = undefined;
        if (finished || !held || followUp || approvals > 0 || background.size > 0) return;
        const done = held;
        idleTimer = setTimeout(() => settle(done), idleMs);
      };
      const onResult = (msg: ClaudeMessage) => {
        if (msg.session_id) sink.session(msg.session_id);
        const r = resultOf(msg);
        // An error ends the turn at once, as on a turn without background work; holding it would hide it.
        if (r.status === "failed") {
          if (background.size > 0) sink.notice("warn", `Claude reported an error while ${work(background.size)} ${background.size === 1 ? "was" : "were"} still running. The turn ends now, so that work may stop.`);
          return settle(r);
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
          child.kill("SIGTERM");
        }, capMs);
      };
      const finish = (r: TurnResult) => {
        if (finished) return;
        finished = true;
        agents.finish(signal.aborted || r.status === "interrupted");
        clearTimeout(killTimer);
        clearTimeout(idleTimer);
        clearTimeout(capTimer);
        signal.removeEventListener("abort", onAbort);
        resolve(signal.aborted ? { status: "interrupted" } : r.status === "failed" ? { ...r, detail: { bin, argv, pid: child.pid, ...init, ...r.detail, stderr: stderrTail(stderr) || undefined } } : r);
      };
      const write = (o: unknown) => {
        try {
          child.stdin?.write(JSON.stringify(o) + "\n");
        } catch {
          /* closed */
        }
      };
      const onAbort = () => {
        killTimer = setTimeout(() => child.kill("SIGKILL"), 1500);
        child.kill("SIGTERM");
      };
      signal.addEventListener("abort", onAbort, { once: true });

      child.on("error", (err) => finish({ status: "failed", error: `${bin}: ${err.message}. Is Claude Code installed and on PATH?`, detail: { spawnError: err.message, errno: (err as NodeJS.ErrnoException).code } }));
      child.stderr?.on("data", (d: Buffer) => (stderr = (stderr + d.toString()).slice(-16_384)));
      child.stdout?.on("data", (d: Buffer) =>
        lines.push(d, (line) => {
          if (finished || signal.aborted) return;
          let msg: ClaudeMessage;
          try {
            msg = JSON.parse(line) as ClaudeMessage;
          } catch {
            return;
          }
          if (msg.type === "result") return onResult(msg);
          // `handle` updates `background` before it first awaits, so the checks below see this message's effect.
          const handled = this.handle(msg, sink, { cwd: opts.cwd, started, write, thinking, init, agents, tasks, background, listed, nextThinkingId: () => `think-${++thinkingSeq}`, get streaming() { return streaming; }, set streaming(v: string) { streaming = v; } });
          if (msg.type === "control_request") {
            approvals++;
            void handled.finally(() => {
              approvals--;
              armIdle();
            });
          }
          if (msg.type === "system" && msg.subtype === "init" && held) followUp = true;
          armIdle();
        }),
      );
      child.on("close", (code, sig) => {
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) return finish({ status: "interrupted" });
        const err = stderr.trim().split("\n").filter((l) => !/^\s*$/.test(l)).slice(-3).join("\n");
        finish(code === 0 ? held ?? { status: "completed" } : { status: "failed", error: err || `${bin} exited with code ${code}`, detail: { exitCode: code, signal: sig ?? undefined } });
      });

      write({ type: "user", message: { role: "user", content: text } });
    });
  }

  /** Everything but `result`, which `runTurn` handles itself because it decides when the turn ends. */
  private async handle(msg: ClaudeMessage, sink: TurnSink, ctx: { agents: AgentTracker; tasks: Map<string, string>; background: Set<string>; listed: Set<string>; cwd?: string; started: Map<string, number>; write: (o: unknown) => void; streaming: string; thinking: Map<number, string>; init: Record<string, unknown>; nextThinkingId: () => string }): Promise<void> {
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
      case "control_request": {
        const req = msg.request;
        if (req?.subtype !== "can_use_tool") {
          ctx.write({ type: "control_response", response: { subtype: "error", request_id: msg.request_id, error: `unsupported control request ${req?.subtype ?? "?"}` } });
          return;
        }
        const tool = req.tool_name ?? "tool";
        const title = toolTitle(tool, req.input ?? {});
        const request: ApprovalRequest = {
          question: `Allow ${req.tool_name}: ${title}?`,
          detail: shortJson(req.input ?? {}),
          canAlways: Boolean(req.permission_suggestions?.length),
          action: { backend: "claude", tool, title, cwd: ctx.cwd, input: req.input ?? {} },
        };
        const answer = await sink.approval(request);
        const allow = answer !== "no";
        ctx.write({
          type: "control_response",
          response: {
            subtype: "success",
            request_id: msg.request_id,
            response: allow
              ? { behavior: "allow", updatedInput: req.input ?? {}, ...(answer === "always" && req.permission_suggestions?.length ? { updatedPermissions: req.permission_suggestions } : {}) }
              : { behavior: "deny", message: denyMessage(sink.refusedByRule?.(request)) },
          },
        });
        return;
      }
      default:
        return;
    }
  }
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
  message?: { content?: ContentBlock[] };
  event?: { type: string; index?: number; content_block?: { type: string; thinking?: string }; delta?: { type: string; text?: string; thinking?: string } };
  request_id?: string;
  request?: { subtype?: string; tool_name?: string; input?: Record<string, unknown>; permission_suggestions?: unknown[] };
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
