import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ConversationEvent, TurnRef } from "../../shared/conversation-events.js";
import type { ThreadItem } from "../../shared/types.js";
import { contextRefId, type ContextCapture, type ContextRelation, type ContextTarget, type TaskContextEvidence } from "../../shared/task-context-evidence.js";
import type { TaskContextCapture } from "./task-context-capture.js";
import type { PagesReadReceipt } from "./pages-agents.js";

type Tool = Extract<ThreadItem, { kind: "tool" }>;
const sameTurn = (a: TurnRef, b: TurnRef) => a.thread === b.thread && a.turn === b.turn && a.attempt === b.attempt && a.backend === b.backend && a.account === b.account;

/** One real runtime attempt. Async observations may only update its still-authoritative user item. */
export class TaskContextAttempt {
  private readonly abort = new AbortController();
  readonly signal: AbortSignal;
  private readonly native = new Set<string>();
  private readonly notes = new Map<string, string>();
  private readonly pending = new Set<Promise<void>>();
  private readonly errors: unknown[] = [];
  constructor(private readonly o: {
    turn: TurnRef; cwd: string; projectId: string; signal: AbortSignal;
    capture: Pick<TaskContextCapture, "capture">;
    current(): boolean;
    update(change: (context: TaskContextEvidence) => void): void;
  }) { this.signal = AbortSignal.any([o.signal, this.abort.signal]); }

  current(): boolean { return !this.signal.aborted && this.o.current(); }
  close(): void { this.abort.abort(); }
  flush(): Promise<void> | undefined {
    if (!this.pending.size) { if (this.errors.length) throw this.errors[0]; return; }
    return Promise.all(this.pending).then(() => { if (this.errors.length) throw this.errors[0]; });
  }

  private change(change: (context: TaskContextEvidence) => void): void {
    if (!this.current()) return;
    this.o.update(context => { change(context); context.revision++; });
  }
  private ref(context: TaskContextEvidence, target: ContextTarget, relation: ContextRelation) {
    let ref = context.refs.find(ref => contextRefId(ref.target) === contextRefId(target));
    if (!ref) { ref = { id: randomUUID(), target, relations: [], captureIds: [] }; context.refs.push(ref); }
    if (!ref.relations.some(existing => JSON.stringify(existing) === JSON.stringify(relation))) ref.relations.push(relation);
    return ref;
  }
  private operations(item: Tool): { target: ContextTarget; kind: "read" | "changed" | "searched" }[] {
    // Only structured native arguments/actions count. Never parse model prose or shell output.
    const operations: { target: ContextTarget; kind: "read" | "changed" | "searched" }[] = [];
    const add = (value: unknown, kind: "read" | "changed" | "searched", cwd?: string) => {
      if (typeof value !== "string" || !value || /[\u0000-\u001f\u007f\\]/.test(value) || (!path.isAbsolute(value) && !cwd)) return;
      const relative = path.relative(this.o.cwd, path.resolve(cwd ?? this.o.cwd, value));
      if (!relative || relative.length > 4096 || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || /^[A-Za-z]:/.test(relative)) return;
      const target: ContextTarget = { kind: "file", path: relative.split(path.sep).join("/") };
      if (!operations.some(op => op.kind === kind && contextRefId(op.target) === contextRefId(target))) operations.push({ target, kind });
    };
    if (this.o.turn.backend === "claude") {
      if (item.name === "Read") add(item.args.file_path, "read", this.o.cwd);
      else if (["Write", "Edit", "MultiEdit"].includes(item.name)) add(item.args.file_path, "changed", this.o.cwd);
      else if (item.name === "NotebookEdit") add(item.args.notebook_path, "changed", this.o.cwd);
      else if (["Grep", "Glob"].includes(item.name)) add(item.args.path, "searched", this.o.cwd);
    }
    if (this.o.turn.backend === "codex") {
      for (const action of item.exec?.actions ?? []) add(action.path, action.kind === "read" ? "read" : "searched", item.exec?.cwd);
      if (item.name === "apply_patch" && Array.isArray(item.args.files)) {
        for (const file of item.args.files) if (file && typeof file === "object") {
          add(file.path, "changed", this.o.cwd);
          add(file.movePath, "changed", this.o.cwd);
        }
      }
    }
    return operations;
  }
  accepted(event: ConversationEvent, item: Tool): void {
    if (!this.current() || !item.origin || !sameTurn(item.origin, this.o.turn) || (event.type !== "tool.start" && event.type !== "tool.done")) return;
    const key = JSON.stringify([item.id, event.type]);
    if (this.native.has(key)) return;
    const operations = this.operations(item);
    if (!operations.length) return;
    const targets = [...new Map(operations.map(op => [contextRefId(op.target), op.target])).values()];
    const source = { kind: "native" as const, itemId: item.id, origin: item.origin };
    const succeeded = event.type === "tool.done" && event.outcome === "succeeded";
    const placeholders: ContextCapture[] = succeeded ? targets.map(target => ({
      id: randomUUID(), target, source, phase: "after-native-result", startedAt: event.at, finishedAt: event.at,
      repository: { state: "unavailable", reason: "not-captured" }, revision: { state: "unavailable", reason: "not-captured" },
      workspace: { kind: "thread", projectId: this.o.projectId, threadId: this.o.turn.thread },
    })) : [];
    this.change(context => {
      for (const { target, kind } of operations) {
        this.ref(context, target, { kind, provenance: "native-requested", source });
        if (succeeded) {
          this.ref(context, target, { kind, provenance: "observed", source });
        }
      }
      for (const placeholder of placeholders) {
        const ref = context.refs.find(ref => contextRefId(ref.target) === contextRefId(placeholder.target))!;
        ref.captureIds.push(placeholder.id); context.captures.push(placeholder);
      }
    });
    this.native.add(key);
    if (!succeeded) return;
    const pending = this.o.capture.capture(this.o.cwd, targets, source, "after-native-result", this.signal).then(captures => {
      if (!this.current()) return;
      this.change(context => {
        for (const placeholder of placeholders) {
          const replacement = captures.find(c => contextRefId(c.target) === contextRefId(placeholder.target));
          const index = context.captures.findIndex(c => c.id === placeholder.id);
          if (replacement && index >= 0) context.captures[index] = { ...replacement, id: placeholder.id, workspace: placeholder.workspace };
        }
      });
    }).catch(error => { if (this.current()) this.errors.push(error); }).finally(() => { this.pending.delete(pending); });
    this.pending.add(pending);
  }
  observedNotes(receipt: PagesReadReceipt): void {
    if (!this.current()) throw new Error("Task context attempt is no longer current.");
    if (!sameTurn(receipt.source.turn, this.o.turn) || receipt.captures.some(c => c.phase !== "after-notes-read" || JSON.stringify(c.source) !== JSON.stringify(receipt.source)
      || c.workspace?.kind !== "thread" || c.workspace.projectId !== this.o.projectId || c.workspace.threadId !== this.o.turn.thread)) throw new Error("Notes context receipt scope changed.");
    const key = receipt.source.receiptId, signature = JSON.stringify(receipt);
    if (this.notes.has(key)) { if (this.notes.get(key) !== signature) throw new Error("Notes receipt changed."); return; }
    this.change(context => {
      for (const capture of receipt.captures) {
        const ref = this.ref(context, capture.target, { kind: "read", provenance: "observed", source: receipt.source });
        ref.captureIds.push(capture.id); context.captures.push(capture);
      }
    });
    this.notes.set(key, signature);
  }
}
