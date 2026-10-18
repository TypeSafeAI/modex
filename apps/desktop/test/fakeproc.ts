import type { ApprovalRequest, TurnSink } from "../src/main/engine/backends/types.js";
import { okFor, type NativeRef, type Observation } from "../src/shared/conversation-events.js";
import { LocalItems } from "../src/main/engine/backends/local-items.js";
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
  kill(): boolean {
    this.killed = true;
    this.close(null);
    return true;
  }
  close(code: number | null): void {
    if (this.exitCode !== null || this.killed && code !== null) return;
    this.exitCode = code ?? 0;
    this.stdout.end();
    setImmediate(() => this.emit("close", code));
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
