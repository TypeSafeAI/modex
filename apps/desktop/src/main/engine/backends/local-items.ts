import { randomUUID } from "node:crypto";
import type { NativeRef } from "../../../shared/conversation-events.js";
import type { ToolStart, ToolUpdate, TurnSink } from "./types.js";

/**
 * Observations for an engine that reports text without item ids: the offline engine and scripted
 * test backends. One message streams at a time, and its id is assigned here, at ingress, in order.
 * A tool or reasoning block ends the message streaming before it, as it always has. Reasoning from
 * such an engine is its own text (`provider-text`), never a summary. Tool and reasoning ids are the
 * engine's own; `runtime` scopes all of them.
 */
export class LocalItems {
  private open: string | null = null;
  private seq = 0;
  private readonly reasoning = new Set<string>();

  constructor(private readonly sink: TurnSink, readonly runtime: string = randomUUID()) {}

  private ref(item: string): NativeRef {
    return { runtime: this.runtime, item };
  }

  /** Streams text into the open message, opening one when none is. */
  delta(text: string): void {
    if (!this.open) {
      this.open = `message-${++this.seq}`;
      this.sink.observe({ type: "message.start", native: this.ref(this.open), phase: "unspecified" });
    }
    this.sink.observe({ type: "message.delta", native: this.ref(this.open), text });
  }

  /** A whole reply: the final text of the open message, or a message of its own. */
  assistant(text: string): void {
    const item = this.open ?? `message-${++this.seq}`;
    this.open = null;
    this.sink.observe({ type: "message.done", native: this.ref(item), text });
  }

  thinkingDelta(id: string, delta: string): void {
    this.close();
    if (!this.reasoning.has(id)) {
      this.reasoning.add(id);
      this.sink.observe({ type: "reasoning.start", native: this.ref(id) });
    }
    if (delta) this.sink.observe({ type: "reasoning.delta", native: this.ref(id), representation: "provider-text", index: 0, text: delta });
  }

  /** Ends a reasoning block; `text`, when given, is its final version. */
  thinkingDone(id: string, text?: string): void {
    this.sink.observe({ type: "reasoning.done", native: this.ref(id), ...(text !== undefined ? { text: [text] } : {}) });
  }

  toolStart(tool: ToolStart): void {
    this.close();
    this.sink.observe({ type: "tool.start", native: this.ref(tool.id), tool: { name: tool.name, title: tool.title, args: tool.args, ...(tool.agent ? { agent: tool.agent } : {}) } });
  }

  /** `status: "done"` settles the tool: `ok` true succeeded, false failed, absent unknown. */
  toolUpdate(id: string, patch: ToolUpdate): void {
    const { ok, status, ...progress } = patch;
    if (status === "done") this.sink.observe({ type: "tool.done", native: this.ref(id), outcome: ok === true ? "succeeded" : ok === false ? "failed" : "unknown", progress });
    else this.sink.observe({ type: "tool.update", native: this.ref(id), progress });
  }

  /** A tool or reasoning block began: the message streaming before it is complete as it stands. */
  private close(): void {
    if (!this.open) return;
    this.sink.observe({ type: "message.done", native: this.ref(this.open) });
    this.open = null;
  }
}
