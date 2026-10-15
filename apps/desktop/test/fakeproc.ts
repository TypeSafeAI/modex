import type { CanUseTool, Options, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ApprovalRequest } from "../src/main/engine/backends/types.js";
import { LineBuffer } from "../src/main/engine/backends/types.js";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";

/** A scriptable stand-in for a spawned CLI: tests feed stdout lines and inspect what was written to stdin. */
export class FakeProcess extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  killed = false;
  written: string[] = [];
  constructor() {
    super();
    this.stdin.on("data", (d: Buffer) => { for (const line of d.toString().split("\n")) if (line.trim()) this.written.push(line); });
  }
  emitLine(o: unknown): void {
    this.stdout.write((typeof o === "string" ? o : JSON.stringify(o)) + "\n");
  }
  kill(_signal?: NodeJS.Signals | number): boolean {
    this.killed = true;
    this.close(null);
    return true;
  }
  close(code: number | null): void {
    if (this.exitCode !== null || this.killed && code !== null) return;
    this.exitCode = code ?? 0;
    this.stdout.end();
    setImmediate(() => {
      this.emit("close", code);
      this.emit("exit", code, null);
    });
  }
  /** Waits until stdin has received a line matching `pred`. */
  async waitFor(pred: (line: string) => boolean, ms = 2000): Promise<string> {
    const start = Date.now();
    for (;;) {
      const hit = this.written.find(pred);
      if (hit) return hit;
      if (Date.now() - start > ms) throw new Error(`timed out waiting for stdin line; got: ${this.written.join(" | ")}`);
      await new Promise((r) => setTimeout(r, 5));
    }
  }
}

export function fakeSpawn(proc: FakeProcess): { spawn: typeof import("node:child_process").spawn; calls: { file: string; args: string[]; cwd?: string }[] } {
  const calls: { file: string; args: string[]; cwd?: string }[] = [];
  const spawn = ((file: string, args: string[], opts?: { cwd?: string }) => {
    calls.push({ file, args, cwd: opts?.cwd });
    return proc as unknown as ChildProcess;
  }) as unknown as typeof import("node:child_process").spawn;
  return { spawn, calls };
}

/** Yield a macrotask so the scripted query and backend drain queued stdout. */
export function flushClaude(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

export function collectSink(answers: ("yes" | "no" | "always")[] = ["yes"]) {
  const events: string[] = [];
  /** Every approval request as the backend sent it, including its structured `action`. */
  const requests: ApprovalRequest[] = [];
  const queue = [...answers];
  const sink = {
    delta: (t: string) => events.push(`delta:${t}`),
    assistant: (t: string) => events.push(`assistant:${t}`),
    toolStart: (t: { id: string; name: string; title: string }) => events.push(`tool_start:${t.id}:${t.title}`),
    toolUpdate: (id: string, p: { output?: string; ok?: boolean; status?: string }) => events.push(`tool_update:${id}:${p.status ?? ""}:${p.ok ?? ""}:${(p.output ?? "").slice(0, 40)}`),
    approval: async (req: ApprovalRequest) => { events.push(`approval:${req.question}`); requests.push(req); return queue.shift() ?? "no"; },
    notice: (level: string, text: string) => events.push(`notice:${level}:${text}`),
    thinkingDelta: (id: string, delta: string) => events.push(`think:${id}:${delta}`),
    thinkingDone: (id: string, text?: string) => events.push(`think_done:${id}:${text ?? ""}`),
    session: (h: string) => events.push(`session:${h}`),
  };
  return { sink, events, requests };
}

/**
 * Test double for Agent SDK `query()`: spawns the injected fake process, writes the user
 * message to stdin, yields stdout JSON (the same shapes the SDK surfaces), and answers
 * `control_request` lines through `canUseTool` so existing FakeProcess tests still drive
 * approvals, Stop, and background turns.
 */
export function scriptedClaudeQuery(params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }): Query {
  const options = params.options ?? {};
  const pending: SDKMessage[] = [];
  let wake: (() => void) | undefined;
  let done = false;
  let failure: Error | undefined;
  let child: ChildProcess | undefined;
  const lines = new LineBuffer();

  const notify = () => { const w = wake; wake = undefined; w?.(); };
  const finish = (err?: Error) => {
    if (done) return;
    failure = err;
    done = true;
    notify();
  };

  const write = (o: unknown) => {
    try { child?.stdin?.write(JSON.stringify(o) + "\n"); } catch { /* closed */ }
  };

  const handleControl = async (msg: { request_id?: string; request?: { subtype?: string; tool_name?: string; input?: Record<string, unknown>; permission_suggestions?: unknown[] } }) => {
    const req = msg.request;
    if (req?.subtype !== "can_use_tool" || !options.canUseTool) {
      write({ type: "control_response", response: { subtype: "error", request_id: msg.request_id, error: `unsupported control request ${req?.subtype ?? "?"}` } });
      return;
    }
    try {
      const result = await options.canUseTool(req.tool_name ?? "tool", req.input ?? {}, {
        signal: options.abortController?.signal ?? new AbortController().signal,
        suggestions: req.permission_suggestions as Parameters<CanUseTool>[2]["suggestions"],
        toolUseID: "",
        requestId: msg.request_id ?? "",
      });
      if (result == null) return;
      write({ type: "control_response", response: { subtype: "success", request_id: msg.request_id, response: result } });
    } catch (err) {
      write({ type: "control_response", response: { subtype: "error", request_id: msg.request_id, error: (err as Error).message } });
    }
  };

  const start = async () => {
    const command = options.pathToClaudeCodeExecutable ?? "claude";
    try {
      if (!options.spawnClaudeCodeProcess) throw new Error("scriptedClaudeQuery requires spawnClaudeCodeProcess");
      child = options.spawnClaudeCodeProcess({
        command,
        args: [],
        cwd: options.cwd,
        env: options.env ?? process.env,
        signal: options.abortController?.signal ?? new AbortController().signal,
      }) as unknown as ChildProcess;
    } catch (err) {
      finish(err as Error);
      return;
    }
    child.on("error", (err) => finish(err));
    child.on("close", () => finish());
    child.stderr?.on("data", (d: Buffer) => options.stderr?.(d.toString()));
    child.stdout?.on("data", (d: Buffer) => {
      lines.push(d, (line) => {
        let msg: { type?: string; request_id?: string; request?: { subtype?: string; tool_name?: string; input?: Record<string, unknown>; permission_suggestions?: unknown[] } };
        try { msg = JSON.parse(line) as typeof msg; } catch { return; }
        pending.push(msg as SDKMessage);
        notify();
      });
    });
    let content: SDKUserMessage["message"]["content"] = typeof params.prompt === "string" ? params.prompt : "";
    if (typeof params.prompt !== "string") {
      const first = await params.prompt[Symbol.asyncIterator]().next();
      if (!first.done) content = first.value.message.content;
    }
    write({ type: "user", message: { role: "user", content } });
  };
  void start();

  const gen = (async function* () {
    for (;;) {
      if (pending.length) {
        const msg = pending.shift()!;
        if ((msg as { type?: string }).type === "control_request") {
          await handleControl(msg as { request_id?: string; request?: { subtype?: string; tool_name?: string; input?: Record<string, unknown>; permission_suggestions?: unknown[] } });
          continue;
        }
        yield msg;
        continue;
      }
      if (failure) throw failure;
      if (done) return;
      await new Promise<void>((r) => { wake = r; });
    }
  })();

  return Object.assign(gen, {
    interrupt: async () => { child?.kill("SIGTERM"); },
    close: () => { try { child?.stdin?.end(); } catch { /* closed */ } },
    rewindFiles: async () => ({ canRewind: false as const }),
    setPermissionMode: async () => {},
    setModel: async () => {},
    setMaxThinkingTokens: async () => {},
    applyFlagSettings: async () => {},
    updateSettings: async () => {},
    initializationResult: async () => ({ type: "success" as const }),
    reinitialize: async () => ({ type: "success" as const }),
    supportedCommands: async () => [],
    supportedModels: async () => [],
    supportedAgents: async () => [],
    mcpServerStatus: async () => [],
    getContextUsage: async () => ({ categories: [] }),
    readFile: async () => null,
    reloadPlugins: async () => ({}),
    reloadSkills: async () => ({}),
    reloadOutputStyles: async () => ({}),
    accountInfo: async () => ({}),
    reconnectMcpServer: async () => {},
    toggleMcpServer: async () => {},
    setMcpServers: async () => ({ added: [], removed: [], errors: {} }),
    readMcpResource: async () => ({}),
    streamInput: async () => {},
    stopTask: async () => {},
  }) as unknown as Query;
}
