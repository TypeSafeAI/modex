import fs from "node:fs";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { CliExecutable } from "../cli-path.js";
import { generateTitle } from "../titles.js";
import type { Backend, ModelInfo, NativeRequest, TitleOptions, TurnOptions, TurnResult, TurnSink } from "./types.js";
import { LineBuffer, stderrTail, writeJsonResponse } from "./types.js";
import { UsageMeter, withUsage } from "./usage.js";
import { cliEnvironment, cliSpawn, health, installation, probe } from "./health.js";
import type { ApprovalAnswer, BackendHealth, Mode } from "../../../shared/types.js";
import type { NativeRef, PlanStepStatus, SettledOutcome } from "../../../shared/conversation-events.js";
import { boundOutput, byteLength } from "../../../shared/evidence.js";
import { actionDigest } from "../../../shared/human-requests.js";

/** The two CLIs this backend drives: OpenCode, and Xiaomi's MiMo Code, a fork that keeps OpenCode's protocol and config. */
export type AcpFamily = "opencode" | "mimo";

interface Family {
  label: string;
  bin: string;
  /** Inline config the CLI merges on top of the user's own (OpenCode 1.19.5 `config.ts`, MiMo Code 0.1.16 likewise). */
  configEnv: string;
  envBin: string;
  login: string;
}

const FAMILIES: Record<AcpFamily, Family> = {
  opencode: { label: "OpenCode", bin: "opencode", configEnv: "OPENCODE_CONFIG_CONTENT", envBin: "MODEX_OPENCODE_BIN", login: "opencode auth login" },
  mimo: { label: "MiMo Code", bin: "mimo", configEnv: "MIMOCODE_CONFIG_CONTENT", envBin: "MODEX_MIMO_BIN", login: "mimo auth login" },
};

/**
 * Modex's modes as agents the CLI runs (docs/opencode.md). The built-in `plan` agent blocks edits but reads
 * the global permission table for everything else, so it is pinned too. Nothing else about the user's
 * config is touched: their providers, models, MCP servers and other agents stay.
 */
const AGENT_PERMISSIONS: Record<Mode | "plan", Record<string, string>> = {
  chat: { edit: "deny", bash: "ask", task: "deny", external_directory: "ask", webfetch: "allow" },
  plan: { edit: "deny", bash: "ask", task: "deny", external_directory: "ask", webfetch: "allow" },
  agent: { edit: "allow", bash: "ask", task: "allow", external_directory: "ask", webfetch: "allow" },
  "full-access": { "*": "allow" },
};

/** The agent (ACP "session mode") a Modex turn runs as. Exported for tests. */
export function acpMode(opts: Pick<TurnOptions, "mode" | "plan">): string {
  if (opts.plan) return "plan";
  return opts.mode === "chat" ? "modex-chat" : opts.mode === "agent" ? "modex-agent" : "modex-full";
}

/** The config Modex hands the CLI for every server it starts. Exported for tests. */
export function acpConfig(): Record<string, unknown> {
  return {
    autoupdate: false,
    share: "disabled",
    permission: { edit: "ask", bash: "ask", task: "ask", external_directory: "ask", webfetch: "allow" },
    agent: {
      "modex-chat": { mode: "primary", description: "Modex Chat: read-only; commands ask first; never edits.", permission: AGENT_PERMISSIONS.chat },
      plan: { permission: AGENT_PERMISSIONS.plan },
      "modex-agent": { mode: "primary", description: "Modex Agent: edits inside the project; commands and other directories ask first.", permission: AGENT_PERMISSIONS.agent },
      "modex-full": { mode: "primary", description: "Modex Full access: nothing asks.", permission: AGENT_PERMISSIONS["full-access"] },
    },
  };
}

/**
 * Drives OpenCode or MiMo Code through `<cli> acp`, the Agent Client Protocol server (newline-delimited
 * JSON-RPC over stdio) that Zed and other editors use. One server is shared by every thread on the backend;
 * each Modex thread maps to an ACP session id, which is the resume handle. Permission prompts arrive as
 * `session/request_permission` requests and are answered through Modex's approval path.
 */
export class AcpBackend implements Backend {
  readonly id: AcpFamily;
  private readonly family: Family;
  private child: ChildProcess | null = null;
  private ready: Promise<Capabilities> | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { method: string; resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly subscribers = new Set<(msg: RpcMessage) => void>();
  private readonly disconnects = new Set<(error: Error) => void>();
  /** Sessions this server already holds, so a resumed thread is loaded once per server. */
  private readonly loaded = new Set<string>();
  /** Sessions being replayed by `session/load`: their updates are history, not this turn's. */
  private readonly replaying = new Set<string>();
  private agentInfo: { name?: string; version?: string } | null = null;
  /** Opaque id of the running server; session and tool-call ids are unique only within it. */
  private generation = "";
  private readonly openRequests = new Map<string, { controller: AbortController; session: unknown }>();

  private get bin(): string { return typeof this.executable === "function" ? this.executable() : this.executable; }

  constructor(family: AcpFamily, private readonly executable: CliExecutable = process.env[FAMILIES[family].envBin] ?? FAMILIES[family].bin, private readonly spawnImpl = cliSpawn) {
    this.id = family;
    this.family = FAMILIES[family];
  }

  private ensure(): Promise<Capabilities> {
    if (this.ready && this.child && this.child.exitCode === null) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      let child: ChildProcess;
      let bin = this.family.bin;
      try {
        bin = this.bin;
        // `--pure` keeps the CLI's own plugins and hooks out of the server. Settings are injected inline, never written to disk.
        const env = { ...cliEnvironment(bin), [this.family.configEnv]: JSON.stringify(acpConfig()) };
        child = this.spawnImpl(bin, ["acp", "--pure"], { stdio: ["pipe", "pipe", "pipe"], env, detached: true });
      } catch (err) {
        return reject(new AcpError(`could not start ${bin} acp: ${(err as Error).message}`, { bin, spawnError: (err as Error).message }));
      }
      this.child = child;
      this.generation = randomUUID();
      this.loaded.clear();
      this.replaying.clear();
      const lines = new LineBuffer();
      let stderr = "";
      child.stderr?.on("data", (d: Buffer) => (stderr = (stderr + d.toString()).slice(-16_384)));
      child.stdout?.on("data", (d: Buffer) => { if (this.child === child) lines.push(d, (line) => this.dispatch(line)); });
      child.on("error", (err) => {
        const error = new AcpError(`${bin}: ${err.message}. Is the ${this.family.label} CLI installed and on PATH?`, { bin, spawnError: err.message, errno: (err as NodeJS.ErrnoException).code, pid: child.pid });
        if (this.child === child) this.disconnect(error);
        reject(error);
      });
      child.on("close", (code, signal) => {
        if (this.child === child) this.disconnect(new AcpError(`${this.family.bin} acp exited (${code}) ${stderr.trim().split("\n").slice(-2).join(" ")}`, { exitCode: code, signal, stderr: stderrTail(stderr), pid: child.pid, agent: this.agentInfo }));
      });
      // No fs or terminal capabilities are offered: the CLI reads and runs through its own tools, and Modex only answers permission requests.
      this.request<InitializeResult>("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "modex", title: "Modex", version: process.env.MODEX_VERSION ?? "0.0.1" } }, 10_000)
        .then((r) => {
          this.agentInfo = r?.agentInfo ?? null;
          const session = r?.agentCapabilities?.sessionCapabilities ?? {};
          resolve({ loadSession: r?.agentCapabilities?.loadSession === true, resume: typeof session.resume === "object" && session.resume !== null, image: r?.agentCapabilities?.promptCapabilities?.image === true });
        })
        .catch(reject);
    });
    return this.ready;
  }

  private disconnect(error: Error): void {
    this.child = null;
    this.ready = null;
    this.loaded.clear();
    this.replaying.clear();
    for (const request of this.openRequests.values()) request.controller.abort();
    this.openRequests.clear();
    for (const p of this.pending.values()) p.reject(error);
    this.pending.clear();
    for (const finish of this.disconnects) finish(error);
  }

  private dispatch(line: string): void {
    let msg: RpcMessage;
    try { msg = JSON.parse(line) as RpcMessage; } catch { return; }
    if (msg.id !== undefined && !msg.method) {
      const p = typeof msg.id === "number" ? this.pending.get(msg.id) : undefined;
      if (p) {
        this.pending.delete(msg.id as number);
        if (msg.error) p.reject(new AcpError(msg.error.message ?? `${this.family.label} error`, { method: p.method, rpcCode: msg.error.code, rpcData: msg.error.data }));
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
      return Promise.reject(new AcpError(`${this.family.bin} acp is not running`, { method }));
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
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  private notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  /**
   * The CLI's own model list (`<cli> models`): one `provider/model` id per line, the providers the user
   * configured plus the CLI's built-in ones. No session is opened and no model is called.
   */
  async listModels(): Promise<ModelInfo[]> {
    const result = await probe(this.bin, ["models"], this.spawnImpl, 15_000);
    if (result.failure || result.code !== 0) throw new Error(`${this.family.label} could not list models${result.failure ? ` (${result.failure})` : ""}.`);
    return parseModelList(result.output);
  }

  async health(): Promise<BackendHealth> {
    const installed = await installation(this.bin, this.spawnImpl);
    if (installed.unavailable) return installed.unavailable;
    const report = (authentication: BackendHealth["authentication"], detail: string) => health(authentication, detail, "available", installed.version);
    const result = await probe(this.bin, ["auth", "list"], this.spawnImpl, 5000);
    if (result.failure === "timeout") return report("unknown", "Credential check timed out");
    if (result.failure || result.code !== 0) return report("unknown", `Credential status unavailable · check in ${this.family.label}`);
    const count = credentialCount(result.output);
    if (count === null) return report("unknown", `Credential status unavailable · check in ${this.family.label}`);
    if (count > 0) return report("authenticated", `${count} credential${count === 1 ? "" : "s"} configured · model access unverified`);
    return report("signed-out", this.id === "opencode" ? `No credentials · run ${this.family.login} (OpenCode's free models may still answer)` : `No credentials · run ${this.family.login}`);
  }

  /** Kills the shared server and every command it started. Every running turn on this backend ends. */
  async forceStop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.disconnect(new AcpError(`${this.family.label} was force-stopped from another thread. Send again to continue.`, { pid: child.pid }));
    killGroup(child);
  }

  async dispose(): Promise<void> {
    const child = this.child;
    this.disconnect(new AcpError(`${this.family.bin} acp disposed`, {}));
    if (child) await new Promise<void>((resolve) => {
      child.once("close", () => resolve());
      killGroup(child);
    });
  }

  generateTitle(text: string, opts: TitleOptions, signal: AbortSignal): Promise<string | null> {
    return generateTitle(this, opts, text, signal);
  }

  async runTurn(text: string, opts: TurnOptions, sink: TurnSink, signal: AbortSignal): Promise<TurnResult> {
    if (signal.aborted) return { status: "interrupted" };
    // CR-6 review snapshots need a read-only, hook-free, prompt-free mode. The ACP server has no such mode: refuse rather than run loosely.
    if (opts.confinement) return { status: "failed", error: `${this.family.label} has no confined review mode; Code Review runs on Claude.`, detail: { stage: "confinement" } };
    const failed = (err: unknown, extra: Record<string, unknown>): TurnResult =>
      signal.aborted ? { status: "interrupted" } : { status: "failed", error: (err as Error).message, detail: { ...extra, ...detailOf(err), agent: this.agentInfo, pid: this.child?.pid } };
    let capabilities: Capabilities;
    try {
      capabilities = await duringSetup(this.ensure(), signal, this.family.label);
    } catch (err) {
      return failed(err, { stage: "start acp server" });
    }
    // Open or reopen the session. A resume handle the server no longer knows starts a fresh session, with a notice.
    let sessionId = opts.resume;
    const open = () => this.request<{ sessionId: string }>("session/new", { cwd: opts.cwd, mcpServers: [] }, 60_000).then((r) => r.sessionId);
    try {
      if (sessionId && !this.loaded.has(sessionId)) {
        const id = sessionId;
        try {
          if (capabilities.resume) await duringSetup(this.request("session/resume", { sessionId: id, cwd: opts.cwd, mcpServers: [] }, 60_000), signal, this.family.label);
          else if (capabilities.loadSession) {
            // `session/load` replays the whole history as updates before it answers; none of it is this turn's.
            this.replaying.add(id);
            try { await duringSetup(this.request("session/load", { sessionId: id, cwd: opts.cwd, mcpServers: [] }, 120_000), signal, this.family.label); }
            finally { this.replaying.delete(id); }
          } else throw new AcpError("the server cannot resume sessions", { rpcCode: -32601 });
        } catch (err) {
          if (signal.aborted) return { status: "interrupted" };
          sink.notice("warn", `${this.family.label} could not reopen this thread's session (${(err as Error).message}). Starting a fresh session; earlier turns are not in its context.`);
          sessionId = await duringSetup(open(), signal, this.family.label);
        }
      } else if (!sessionId) {
        sessionId = await duringSetup(open(), signal, this.family.label);
      }
    } catch (err) {
      return failed(err, { stage: "open session", sessionId: opts.resume });
    }
    if (signal.aborted) return { status: "interrupted" };
    this.loaded.add(sessionId);
    sink.session(sessionId);
    const sid = sessionId;

    // The mode decides what may run without asking: a turn that cannot be put in its mode must not run.
    const modeId = acpMode(opts);
    try {
      await duringSetup(this.request("session/set_mode", { sessionId: sid, modeId }, 30_000), signal, this.family.label);
    } catch (err) {
      return failed(err, { stage: "set mode", sessionId: sid, modeId });
    }
    if (opts.model) {
      try {
        await duringSetup(this.request("session/set_config_option", { sessionId: sid, configId: "model", value: opts.model }, 30_000), signal, this.family.label);
      } catch (err) {
        if (signal.aborted) return { status: "interrupted" };
        sink.notice("warn", `${this.family.label} did not accept the model ${opts.model} (${(err as Error).message}); the turn runs on the session's current model.`);
      }
    }
    if (opts.effort) {
      // Effort is a config option only for models that have one; a refusal is informational.
      await this.request("session/set_config_option", { sessionId: sid, configId: "effort", value: opts.effort }, 30_000)
        .catch((err: Error) => { if (!signal.aborted) sink.notice("info", `${this.family.label} has no effort setting for this model (${err.message}).`); });
    }
    if (signal.aborted) return { status: "interrupted" };

    const runtime = this.generation;
    const child = this.child;
    const meter = new UsageMeter();
    const seenRequests = new Map<string, string>();
    const context = [opts.knowledge?.instructions, opts.pages?.instructions, opts.images?.instructions, text].filter((value) => value !== undefined).join("\n\n");
    if (opts.knowledge || opts.pages || opts.images) sink.notice("info", `${this.family.label} does not connect to Modex's knowledge, Space or image tools; their instructions were sent as text only.`);
    const prompt: unknown[] = [{ type: "text", text: context }];
    for (const a of opts.attachments ?? []) {
      if (a.kind !== "image") continue;
      if (!capabilities.image) { sink.notice("warn", `${this.family.label} does not take images; ${a.name} was not sent.`); continue; }
      try { prompt.push({ type: "image", mimeType: a.mime, data: fs.readFileSync(a.path).toString("base64") }); }
      catch (err) { sink.notice("warn", `Could not read ${a.name}: ${(err as Error).message}`); }
    }

    return new Promise<TurnResult>((resolve) => {
      let done = false;
      let cancelled = false;
      let abortTimer: ReturnType<typeof setTimeout> | undefined;
      const native = (item: string): NativeRef => ({ runtime, thread: sid, item });
      // Open items, closed when the prompt answers: ACP streams chunks and never says a message ended.
      const messages = new Map<string, string>();
      const thoughts = new Map<string, string>();
      const tools = new Map<string, { started: number; output: string; bytes: number; title: string }>();
      const denied = new Set<string>();
      const detail = (extra: Record<string, unknown>): Record<string, unknown> => ({ sessionId: sid, agent: this.agentInfo, pid: child?.pid, ...extra });
      const settleOpen = (outcome: SettledOutcome) => {
        for (const [id, text] of messages) sink.observe({ type: "message.done", native: native(id), text, phase: "final" });
        messages.clear();
        for (const [id, text] of thoughts) sink.observe({ type: "reasoning.done", native: native(id), text: [text] });
        thoughts.clear();
        for (const [id, t] of tools) sink.observe({ type: "tool.done", native: native(id), outcome, progress: { ...(t.output ? { output: t.output } : {}), durationMs: Date.now() - t.started } });
        tools.clear();
      };
      const finish = (r: TurnResult) => {
        if (done) return;
        done = true;
        this.subscribers.delete(onMsg);
        this.disconnects.delete(onDisconnect);
        clearTimeout(abortTimer);
        signal.removeEventListener("abort", onAbort);
        settleOpen(r.status === "interrupted" ? "interrupted" : r.status === "failed" ? "unknown" : "succeeded");
        resolve(withUsage(r, meter));
      };
      const cancel = () => {
        if (cancelled || this.child !== child) return;
        cancelled = true;
        this.notify("session/cancel", { sessionId: sid });
      };
      const onAbort = () => {
        abortTimer = setTimeout(() => {
          if (!done) sink.notice("warn", `${this.family.label} has not confirmed the stop yet. Press Stop again to force it; that restarts ${this.family.label} and ends any other ${this.family.label} turn in progress.`);
        }, 1500);
        cancel();
      };
      const onDisconnect = (error: Error) => finish(signal.aborted ? { status: "interrupted" } : { status: "failed", error: error.message, detail: detail(detailOf(error)) });
      const onMsg = (msg: RpcMessage) => {
        if (done) return;
        const p = (msg.params ?? {}) as Record<string, unknown>;
        if (p.sessionId !== sid) return;
        if (msg.id !== undefined && msg.method) { void this.handleClientRequest(msg, sink, seenRequests, denied); return; }
        if (msg.method !== "session/update" || this.replaying.has(sid)) return;
        const u = (p.update ?? {}) as Record<string, unknown>;
        switch (u.sessionUpdate) {
          case "agent_message_chunk": {
            const text = chunkText(u.content);
            if (text === undefined) break;
            const id = String(u.messageId ?? "message");
            if (!messages.has(id)) { messages.set(id, ""); sink.observe({ type: "message.start", native: native(id), phase: "final" }); }
            messages.set(id, messages.get(id)! + text);
            sink.observe({ type: "message.delta", native: native(id), text });
            break;
          }
          case "agent_thought_chunk": {
            const text = chunkText(u.content);
            if (text === undefined) break;
            const id = String(u.messageId ?? "thought");
            if (!thoughts.has(id)) { thoughts.set(id, ""); sink.observe({ type: "reasoning.start", native: native(id) }); }
            thoughts.set(id, thoughts.get(id)! + text);
            sink.observe({ type: "reasoning.delta", native: native(id), representation: "provider-text", index: 0, text });
            break;
          }
          case "tool_call": {
            const id = String(u.toolCallId ?? "");
            if (!id || tools.has(id)) break;
            const call = toolCall(u);
            tools.set(id, { started: Date.now(), output: "", bytes: 0, title: call.title });
            sink.observe({ type: "tool.start", native: native(id), tool: call });
            break;
          }
          case "tool_call_update": {
            const id = String(u.toolCallId ?? "");
            if (!id) break;
            if (!tools.has(id)) {
              // An update for a call Modex never saw start (a permission prompt's call, named only now).
              const call = toolCall(u);
              tools.set(id, { started: Date.now(), output: "", bytes: 0, title: call.title });
              sink.observe({ type: "tool.start", native: native(id), tool: call });
            }
            const t = tools.get(id)!;
            const output = toolOutput(u);
            if (output !== undefined) {
              const chunk = output.slice(byteLength(t.output) > 0 && output.startsWith(t.output) ? t.output.length : 0);
              if (chunk) sink.output?.(native(id), chunk);
              t.bytes = Math.max(t.bytes, byteLength(output));
              t.output = boundOutput(output).text;
            }
            // A pending call is titled by its tool name; the update that carries the input names the command or file.
            const named = toolCall(u).title;
            const title = named !== t.title && !(u.rawInput === undefined && typeof u.title !== "string") ? (t.title = named) : undefined;
            const status = u.status;
            if (status === "completed" || status === "failed") {
              tools.delete(id);
              const rejected = denied.has(id) || /rejected permission/i.test(String((u.rawOutput as Record<string, unknown> | undefined)?.error ?? ""));
              sink.observe({ type: "tool.done", native: native(id), outcome: status === "completed" ? "succeeded" : rejected ? "denied" : "failed", progress: {
                ...(title ? { title } : {}), ...(t.output ? { output: t.output } : {}), ...(t.bytes > byteLength(t.output) ? { outputBytes: t.bytes, outputTruncated: true } : {}), durationMs: Date.now() - t.started,
              } });
            } else {
              sink.observe({ type: "tool.update", native: native(id), progress: { ...(title ? { title } : {}), ...(u.rawInput && typeof u.rawInput === "object" ? { args: u.rawInput as Record<string, unknown> } : {}), ...(t.output ? { output: t.output } : {}), ...(t.bytes > byteLength(t.output) ? { outputBytes: t.bytes, outputTruncated: true } : {}) } });
            }
            break;
          }
          case "plan": {
            const entries = Array.isArray(u.entries) ? (u.entries as { content?: unknown; status?: unknown }[]) : [];
            sink.observe({ type: "plan.update", native: native("plan"), from: "acp-plan", steps: entries.map((e) => ({ text: String(e.content ?? ""), status: planStatus(e.status) })) });
            break;
          }
          default:
            // available_commands_update, config_option_update, user_message_chunk, usage_update (a running context size, not a call), session_info_update.
            break;
        }
      };
      this.subscribers.add(onMsg);
      this.disconnects.add(onDisconnect);
      signal.addEventListener("abort", onAbort, { once: true });
      this.request<PromptResult>("session/prompt", { sessionId: sid, prompt })
        .then((r) => {
          const usage = r?.usage;
          if (usage && typeof usage === "object") {
            const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);
            // OpenCode 1.19.5 reports `inputTokens` without the cached share (docs/reviews/2026-10-28-opencode-acp.json).
            if (n(usage.inputTokens) || n(usage.cachedReadTokens) || n(usage.outputTokens)) meter.call({ cacheRead: n(usage.cachedReadTokens), cacheWrite: n(usage.cachedWriteTokens), uncached: n(usage.inputTokens) });
            meter.addOutput(n(usage.outputTokens) + n(usage.thoughtTokens));
          }
          const stop = r?.stopReason;
          if (stop === "cancelled" || signal.aborted) return finish({ status: "interrupted" });
          if (stop === "refusal") return finish({ status: "failed", error: `${this.family.label}'s model refused the request.`, detail: detail({ stopReason: stop }) });
          if (stop === "max_tokens") sink.notice("warn", `${this.family.label} stopped at the model's output limit.`);
          finish({ status: "completed", detail: detail({ stopReason: stop }) });
        })
        .catch((err: Error) => finish(signal.aborted ? { status: "interrupted" } : { status: "failed", error: err.message, detail: detail(detailOf(err)) }));
    });
  }

  private async handleClientRequest(msg: RpcMessage, sink: TurnSink, seen: Map<string, string>, denied: Set<string>): Promise<void> {
    const key = `${this.generation}:${JSON.stringify(msg.id)}`;
    const digest = actionDigest({ method: msg.method, params: msg.params });
    if (seen.has(key)) {
      if (seen.get(key) !== digest) {
        this.openRequests.get(key)?.controller.abort();
        sink.notice("warn", `${this.family.label} reused a request id for a changed action; the original request was withdrawn. A new request id is required.`);
      }
      return;
    }
    seen.set(key, digest);
    const withdrawn = new AbortController();
    this.openRequests.set(key, { controller: withdrawn, session: (msg.params as Record<string, unknown> | undefined)?.sessionId });
    try {
      await this.answerClientRequest(msg, sink, withdrawn.signal, denied);
    } finally {
      if (this.openRequests.get(key)?.controller === withdrawn) this.openRequests.delete(key);
    }
  }

  private async answerClientRequest(msg: RpcMessage, sink: TurnSink, withdrawn: AbortSignal, denied: Set<string>): Promise<void> {
    const p = (msg.params ?? {}) as Record<string, unknown>;
    if (msg.method !== "session/request_permission") {
      // fs/* and terminal/* were never offered (initialize), so any such request is declined, never served.
      sink.notice("warn", `${this.family.label} asked for ${msg.method}, which Modex does not support; declined.`);
      this.send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `unsupported by modex: ${msg.method}` } });
      return;
    }
    const call = (p.toolCall ?? {}) as Record<string, unknown>;
    const toolCallId = typeof call.toolCallId === "string" ? call.toolCallId : undefined;
    const options = Array.isArray(p.options) ? (p.options as { optionId?: unknown; kind?: unknown }[]).filter((o) => typeof o.optionId === "string" && typeof o.kind === "string") as { optionId: string; kind: string }[] : [];
    const option = (kind: string) => options.find((o) => o.kind === kind)?.optionId;
    const native: NativeRequest = { runtime: this.generation, request: JSON.stringify(msg.id), ...(toolCallId ? { item: toolCallId } : {}) };
    const deliver = async (result: unknown) => {
      const child = this.child;
      const write = () => {
        if (withdrawn.aborted || this.generation !== native.runtime || !child || child !== this.child || child.exitCode !== null) return Promise.reject(new Error("request transport unavailable"));
        return writeJsonResponse(child.stdin, { jsonrpc: "2.0", id: msg.id, result });
      };
      if (sink.deliverRequest) await sink.deliverRequest(native, write);
      else await write();
    };
    const allowOnce = option("allow_once");
    const allowAlways = option("allow_always");
    const reject = option("reject_once") ?? option("reject_always");
    if (!allowOnce || !reject) {
      sink.notice("warn", `${this.family.label} asked a permission question Modex could not answer; it was cancelled.`);
      await deliver({ outcome: { outcome: "cancelled" } }).catch(() => undefined);
      return;
    }
    const action = toolCall(call);
    const answer: ApprovalAnswer = await sink.approval({
      question: `Allow ${this.family.label} to ${action.name === "shell" ? "run" : "use"} ${action.name === "shell" ? action.title.replace(/^\$ /, "") : `${action.name}: ${action.title}`}?`,
      detail: action.args.command ? `cwd: ${String(action.args.cwd ?? "")}`.trim() : undefined,
      canAlways: Boolean(allowAlways),
      action: { backend: this.id, tool: action.name, title: action.title, ...(typeof action.args.cwd === "string" ? { cwd: action.args.cwd } : {}), input: approvalInput(action.name, action.args) },
      native,
    }, withdrawn);
    if (withdrawn.aborted) return;
    if (answer === "no" && toolCallId) denied.add(toolCallId);
    await deliver({ outcome: { outcome: "selected", optionId: answer === "yes" ? allowOnce : answer === "always" ? allowAlways ?? allowOnce : reject } });
  }
}

interface Capabilities { loadSession: boolean; resume: boolean; image: boolean }
interface InitializeResult { agentInfo?: { name?: string; version?: string }; agentCapabilities?: { loadSession?: boolean; promptCapabilities?: { image?: boolean }; sessionCapabilities?: Record<string, unknown> } }
interface PromptResult { stopReason?: string; usage?: Record<string, unknown> }

interface RpcMessage {
  id?: unknown;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

class AcpError extends Error {
  constructor(message: string, readonly detail: Record<string, unknown>) {
    super(message);
  }
}

function detailOf(err: unknown): Record<string, unknown> {
  return err instanceof AcpError ? err.detail : {};
}

/** Cancel setup locally without killing the shared server used by other threads. */
function duringSetup<T>(work: Promise<T>, signal: AbortSignal, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error(`Stopped during ${label} setup`));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** The server leads its own process group (spawned detached), so a group kill also takes the commands it is running. */
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

function chunkText(content: unknown): string | undefined {
  const c = content as { type?: unknown; text?: unknown } | undefined;
  return c?.type === "text" && typeof c.text === "string" ? c.text : undefined;
}

/** `provider/model` ids, one per line, as `opencode models` prints them (1.19.5). Exported for tests. */
export function parseModelList(output: string): ModelInfo[] {
  const seen = new Set<string>();
  const models: ModelInfo[] = [];
  for (const raw of output.split("\n")) {
    const line = raw.replace(/\u001b\[[0-9;]*m/g, "").trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\/[^\s]+$/.test(line) || seen.has(line)) continue;
    seen.add(line);
    models.push({ id: line, label: line, isDefault: false });
  }
  return models;
}

/** The credential count from `<cli> auth list` ("0 credentials", "1 credential"), or null when it says nothing. Exported for tests. */
export function credentialCount(output: string): number | null {
  const m = /(\d+)\s+credentials?\b/i.exec(output.replace(/\u001b\[[0-9;]*m/g, ""));
  return m ? Number(m[1]) : null;
}

/**
 * An ACP tool call as Modex's tool: the kind says what it does (`execute`, `edit`, `read`, `search`, `fetch`,
 * `think`, `other`); the name, when given, is the CLI's own. Commands become `shell` with a `$ ` title so the
 * approval gate reads them as command lines; edits keep their paths and never their content.
 */
export function toolCall(u: Record<string, unknown>): { name: string; title: string; args: Record<string, unknown> } {
  const kind = typeof u.kind === "string" ? u.kind : "other";
  const raw = u.rawInput && typeof u.rawInput === "object" ? { ...(u.rawInput as Record<string, unknown>) } : {};
  const name = typeof u.name === "string" && u.name ? u.name : kind === "execute" ? "shell" : kind;
  const locations = Array.isArray(u.locations) ? (u.locations as { path?: unknown }[]).map((l) => l.path).filter((p): p is string => typeof p === "string" && p !== "") : [];
  const given = typeof u.title === "string" && u.title ? u.title : "";
  if (kind === "execute") {
    // A pending call's title is the tool's name (OpenCode 1.19.5 `bash`); the command line arrives with its input.
    const command = typeof raw.command === "string" && raw.command ? raw.command : "";
    return { name: "shell", title: `$ ${command || given || name}`, args: { ...(command ? { command } : {}), ...(typeof raw.cwd === "string" ? { cwd: raw.cwd } : {}) } };
  }
  // Tool input names the file `filePath`; a permission request for the same edit names it `filepath` (OpenCode 1.19.5).
  const path = typeof raw.filePath === "string" ? raw.filePath : typeof raw.filepath === "string" ? raw.filepath : typeof raw.path === "string" ? raw.path : locations[0];
  if (kind === "edit") {
    const { content: _content, newString: _n, oldString: _o, patchText: _p, diff: _d, ...rest } = raw;
    return { name: name === "shell" ? "edit" : name, title: `edit ${path ?? given}`.trim(), args: { ...rest, ...(path ? { path } : {}), ...(locations.length ? { paths: locations } : {}) } };
  }
  return { name, title: toolTitle(u, given || name), args: { ...raw, ...(locations.length && !raw.path ? { paths: locations } : {}) } };
}

function toolTitle(u: Record<string, unknown>, fallback: string): string {
  return u.kind === "execute" && !fallback.startsWith("$ ") ? `$ ${fallback}` : fallback;
}

/** What the approval gate may digest: command lines and paths only, never file contents. */
function approvalInput(name: string, args: Record<string, unknown>): Record<string, unknown> {
  if (name === "shell") return { ...(typeof args.command === "string" ? { command: args.command } : {}), ...(typeof args.cwd === "string" ? { cwd: args.cwd } : {}) };
  const out: Record<string, unknown> = {};
  if (typeof args.path === "string") out.file_path = args.path;
  if (Array.isArray(args.paths)) out.paths = args.paths;
  if (typeof args.url === "string") out.url = args.url;
  if (typeof args.pattern === "string") out.pattern = args.pattern;
  return out;
}

/** The text of a tool's content parts, joined, or its rawOutput as JSON; undefined when the update carries neither. */
function toolOutput(u: Record<string, unknown>): string | undefined {
  if (Array.isArray(u.content)) {
    const texts = (u.content as { type?: unknown; content?: { type?: unknown; text?: unknown } }[]).flatMap((c) => c.type === "content" && c.content?.type === "text" && typeof c.content.text === "string" ? [c.content.text] : []);
    if (texts.length) return texts.join("\n");
  }
  if (u.rawOutput && typeof u.rawOutput === "object") {
    const raw = u.rawOutput as Record<string, unknown>;
    if (typeof raw.output === "string") return raw.output;
    if (typeof raw.error === "string") return raw.error;
    const keys = Object.keys(raw).filter((k) => k !== "metadata");
    if (keys.length) return JSON.stringify(Object.fromEntries(keys.map((k) => [k, raw[k]])), null, 2);
  }
  return undefined;
}

function planStatus(status: unknown): PlanStepStatus {
  return status === "pending" ? "pending" : status === "in_progress" ? "in-progress" : status === "completed" ? "completed" : "unknown";
}
