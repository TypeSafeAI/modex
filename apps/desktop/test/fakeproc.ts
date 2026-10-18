import type { ApprovalRequest, TurnSink } from "../src/main/engine/backends/types.js";
import { okFor, type NativeRef, type Observation } from "../src/shared/conversation-events.js";
import { LocalItems } from "../src/main/engine/backends/local-items.js";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";

let nextPid = 40_000;

/** A scriptable stand-in for a spawned CLI: tests feed stdout lines and inspect what was written to stdin. */
export class FakeProcess extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  readonly pid = nextPid++;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  written: string[] = [];
  /** Every signal `kill` was asked to deliver, in order. */
  signals: NodeJS.Signals[] = [];
  /** Signals this process survives, like a CLI that traps SIGTERM, or one stuck in the kernel. */
  ignore = new Set<NodeJS.Signals>();
  /** A descendant still holds stdout/stderr: `exit` fires, `close` waits for `releaseStdio()`. */
  holdStdio = false;
  private exited = false;
  private closed = false;
  constructor() {
    super();
    this.stdin.on("data", (d: Buffer) => { for (const line of d.toString().split("\n")) if (line.trim()) this.written.push(line); });
  }
  emitLine(o: unknown): void {
    this.stdout.write((typeof o === "string" ? o : JSON.stringify(o)) + "\n");
  }
  /** Writes raw bytes to stdout, for lines and characters split across chunks. */
  emitRaw(chunk: Buffer | string): void {
    this.stdout.write(chunk);
  }
  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(signal);
    this.killed = true;
    if (!this.ignore.has(signal)) this.close(null, signal);
    return true;
  }
  /** Ends the process: `exit` at once, then `close` when its stdio has ended. */
  close(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.exited || (this.killed && code !== null)) return;
    this.exited = true;
    this.exitCode = signal ? null : code ?? 0;
    this.signalCode = signal;
    setImmediate(() => {
      this.emit("exit", this.exitCode, signal);
      if (!this.holdStdio) this.releaseStdio();
    });
  }
  /** The descendant holding stdio let go: stdout and stderr end, then `close`. */
  releaseStdio(): void {
    if (this.closed) return;
    this.closed = true;
    this.stdout.end();
    this.stderr.end();
    setImmediate(() => this.emit("close", this.exitCode, this.signalCode));
  }
  /** Lines written to stdin that parse as JSON and match `pred`. */
  sent(pred: (msg: Record<string, any>) => boolean = () => true): Record<string, any>[] {
    return this.written.flatMap((line) => { try { const msg = JSON.parse(line) as Record<string, any>; return pred(msg) ? [msg] : []; } catch { return []; } });
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

/** Live Claude Code 2.1.302 shapes for an interrupted turn (stream-json, captured 2026-10-18; ids shortened). */
export const INTERRUPTED = {
  ack: (request_id: string) => ({ type: "control_response", response: { subtype: "success", request_id, response: { still_queued: [] } } }),
  streaming: { type: "user", message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] } },
  tools: { type: "user", message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user for tool use]" }] } },
  result: (terminal_reason: "aborted_streaming" | "aborted_tools") => ({
    type: "result", subtype: "error_during_execution", is_error: true, num_turns: 2, session_id: "s",
    stop_reason: terminal_reason === "aborted_tools" ? "tool_use" : null, terminal_reason,
    errors: [`[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=${terminal_reason === "aborted_tools" ? "tool_use" : "null"}`],
  }),
};

/**
 * Answers Modex's interrupt the way Claude Code 2.1.302 did live: cancel each pending `can_use_tool`,
 * acknowledge, close the turn, and exit with code 1 once stdin ends. Returns the request ids it cancelled.
 */
export function actLikeClaude(proc: FakeProcess, opts: { pending?: string[]; tools?: string[]; partial?: string; exitCode?: number; exitOnEnd?: boolean } = {}): { cancelled: string[] } {
  const cancelled: string[] = [];
  let input = "";
  proc.stdin.on("data", (d: Buffer) => {
    input += d.toString();
    let nl: number;
    while ((nl = input.indexOf("\n")) >= 0) {
      const line = input.slice(0, nl);
      input = input.slice(nl + 1);
      let msg: Record<string, any>;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.type !== "control_request" || msg.request?.subtype !== "interrupt") continue;
      for (const id of opts.pending ?? []) { cancelled.push(id); proc.emitLine({ type: "control_cancel_request", request_id: id }); }
      proc.emitLine(INTERRUPTED.ack(msg.request_id));
      if (opts.partial !== undefined) proc.emitLine({ type: "assistant", message: { id: "m-partial", content: [{ type: "text", text: opts.partial }] } });
      // Each tool call the interrupt stopped is closed with a rejection (its text's first sentence, as captured).
      for (const id of opts.tools ?? []) proc.emitLine({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "The user doesn't want to proceed with this tool use.", is_error: true }] } });
      proc.emitLine(opts.pending?.length ? INTERRUPTED.tools : INTERRUPTED.streaming);
      proc.emitLine(INTERRUPTED.result(opts.pending?.length ? "aborted_tools" : "aborted_streaming"));
    }
  });
  if (opts.exitOnEnd !== false) proc.stdin.on("end", () => proc.close(opts.exitCode ?? 1));
  return { cancelled };
}

export function fakeSpawn(proc: FakeProcess | FakeProcess[]): { spawn: typeof import("node:child_process").spawn; calls: { file: string; args: string[]; cwd?: string }[] } {
  const calls: { file: string; args: string[]; cwd?: string }[] = [];
  const queue = Array.isArray(proc) ? [...proc] : undefined;
  const spawn = ((file: string, args: string[], opts?: { cwd?: string }) => {
    calls.push({ file, args, cwd: opts?.cwd });
    const next = queue ? queue.shift() : proc;
    if (!next) throw new Error("no more fake processes");
    return next as unknown as ChildProcess;
  }) as unknown as typeof import("node:child_process").spawn;
  return { spawn, calls };
}

export function collectSink(answers: ("yes" | "no" | "always")[] = ["yes"]) {
  const events: string[] = [];
  /** Every observation as the backend made it. */
  const observations: Observation[] = [];
  /** Every approval request as the backend sent it, including its structured `action`. */
  const requests: ApprovalRequest[] = [];
  const queue = [...answers];
  // Observations read back as the short lines these tests have always compared.
  const id = (n: NativeRef) => (n.part !== undefined ? `${n.item}#${n.part}` : n.item);
  const describe = (o: Observation): string | null => {
    switch (o.type) {
      case "message.start": return null;
      case "message.delta": return `delta:${o.text}`;
      case "message.done": return o.text !== undefined ? `assistant:${o.text}` : null;
      case "reasoning.start": return `think:${id(o.native)}:`;
      case "reasoning.delta": return `think:${id(o.native)}:${o.representation === "summary" ? `summary[${o.index}]:` : ""}${o.text}`;
      case "reasoning.done": return `think_done:${id(o.native)}:${(o.summary ?? []).join("|")}${o.text?.length ? `/text:${o.text.join("|")}` : ""}`;
      case "tool.start": return `tool_start:${id(o.native)}:${o.tool.title}`;
      case "tool.update": return `tool_update:${id(o.native)}:::${(o.progress.output ?? "").slice(0, 40)}`;
      case "tool.done": return `tool_update:${id(o.native)}:done:${okFor(o.outcome) ?? ""}:${(o.progress?.output ?? "").slice(0, 40)}`;
    }
  };
  const sink: TurnSink = {
    observe: (o) => { observations.push(o); const line = describe(o); if (line !== null) events.push(line); },
    approval: async (req: ApprovalRequest) => { events.push(`approval:${req.question}`); requests.push(req); return queue.shift() ?? "no"; },
    notice: (level: string, text: string) => { events.push(`notice:${level}:${text}`); },
    session: (h: string) => { events.push(`session:${h}`); },
  };
  return { sink, events, requests, observations };
}

const locals = new WeakMap<TurnSink, LocalItems>();
/** One LocalItems per sink, so a scripted backend's calls stream like one engine's (ids assigned at ingress). */
export function local(sink: TurnSink): LocalItems {
  let items = locals.get(sink);
  if (!items) { items = new LocalItems(sink); locals.set(sink, items); }
  return items;
}
