import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ConversationEvent, TurnRef } from "../../shared/conversation-events.js";
import type { ThreadItem } from "../../shared/types.js";
import { contextRefId, type ContextCapture, type ContextRelation, type ContextTarget, type TaskContextEvidence } from "../../shared/task-context-evidence.js";
import type { TaskContextCapture } from "./task-context-capture.js";
import type { PagesReadReceipt } from "./pages-agents.js";
import { isTaskContextCapability, type TaskContextCapability, type TaskContextProposal, type TaskContextProposalResult } from "../../shared/task-context-tools.js";
import type { Exec } from "../../shared/evidence.js";
import { checkDirectoryChanges, isCheckCommand, mayWrite } from "../../shared/task-context.js";

type Tool = Extract<ThreadItem, { kind: "tool" }>;
type Operation = { target: ContextTarget; kind: "read" | "changed" | "searched" };
const sameTurn = (a: TurnRef, b: TurnRef) => a.thread === b.thread && a.turn === b.turn && a.attempt === b.attempt && a.backend === b.backend && a.account === b.account;

/** One real runtime attempt. Async observations may only update its still-authoritative user item. */
export class TaskContextAttempt {
  private readonly abort = new AbortController();
  readonly signal: AbortSignal;
  private readonly native = new Set<string>();
  /** Normalized targets only, never retained raw arguments or tool bodies. */
  private readonly requested = new Map<string, Operation[]>();
  private readonly notes = new Map<string, string>();
  private readonly proposals = new Map<string, { signature: string; result: TaskContextProposalResult }>();
  private readonly pending = new Set<Promise<void>>();
  private readonly errors: unknown[] = [];
  private sealed = false;
  private lastCapability?: string;
  constructor(private readonly o: {
    turn: TurnRef; cwd: string; projectId: string; signal: AbortSignal;
    capture: Pick<TaskContextCapture, "capture">;
    privateValue?(value: unknown): boolean;
    current(): boolean;
    update(change: (context: TaskContextEvidence) => void): void;
    read(): TaskContextEvidence;
    planRevision(): number | undefined;
    publicationFailed?(error: unknown): void;
  }) { this.signal = AbortSignal.any([o.signal, this.abort.signal]); }

  current(): boolean { return !this.signal.aborted && this.o.current(); }
  accepting(): boolean { return !this.sealed && this.current(); }
  seal(): void { this.sealed = true; }
  close(): void { this.abort.abort(); }
  capability(value: TaskContextCapability): void {
    if (!this.accepting()) return;
    if (!isTaskContextCapability(value)) throw new Error("Invalid task context capability report.");
    const signature = JSON.stringify(value);
    if (this.lastCapability === signature) return;
    this.change(context => {
      const receipts = context.capabilities ??= [], index = receipts.findIndex(c => c.turn.attempt === this.o.turn.attempt);
      const receipt = { turn: structuredClone(this.o.turn), at: new Date().toISOString(), capability: structuredClone(value) };
      if (index < 0) receipts.push(receipt); else receipts[index] = receipt;
    });
    this.lastCapability = signature;
  }
  flush(): Promise<void> | undefined {
    if (!this.pending.size) { if (this.errors.length) throw this.errors[0]; return; }
    return Promise.all(this.pending).then(() => { if (this.errors.length) throw this.errors[0]; });
  }

  private change(change: (context: TaskContextEvidence) => void): void {
    if (!this.current()) return;
    try { this.o.update(context => { change(context); context.revision++; }); }
    catch (error) { this.o.publicationFailed?.(error); throw error; }
  }
  private ref(context: TaskContextEvidence, target: ContextTarget, relation: ContextRelation) {
    let ref = context.refs.find(ref => contextRefId(ref.target) === contextRefId(target));
    if (!ref) { ref = { id: randomUUID(), target, relations: [], captureIds: [] }; context.refs.push(ref); }
    if (!ref.relations.some(existing => JSON.stringify(existing) === JSON.stringify(relation))) ref.relations.push(relation);
    return ref;
  }
  private operations(item: Tool): Operation[] {
    // Only structured native arguments/actions count. Never parse model prose or shell output.
    const operations: Operation[] = [];
    const add = (value: unknown, kind: "read" | "changed" | "searched", cwd?: string) => {
      if (typeof value !== "string" || !value || /[\u0000-\u001f\u007f\\]/.test(value) || (!path.isAbsolute(value) && !cwd)) return;
      if (this.o.privateValue?.(value)) return;
      const relative = path.relative(this.o.cwd, path.resolve(cwd ?? this.o.cwd, value));
      if (!relative || relative.length > 4096 || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || /^[A-Za-z]:/.test(relative)) return;
      const target: ContextTarget = { kind: "file", path: relative.split(path.sep).join("/") };
      if (!operations.some(op => op.kind === kind && contextRefId(op.target) === contextRefId(target))) operations.push({ target, kind });
    };
    if (this.o.turn.backend === "claude") {
      if (item.name === "Read" && !item.unavailableInputs?.includes("args.file_path")) add(item.args.file_path, "read", this.o.cwd);
      else if (["Write", "Edit", "MultiEdit"].includes(item.name) && !item.unavailableInputs?.includes("args.file_path")) add(item.args.file_path, "changed", this.o.cwd);
      else if (item.name === "NotebookEdit" && !item.unavailableInputs?.includes("args.notebook_path")) add(item.args.notebook_path, "changed", this.o.cwd);
      else if (["Grep", "Glob"].includes(item.name) && !item.unavailableInputs?.includes("args.path")) add(item.args.path, "searched", this.o.cwd);
    }
    if (this.o.turn.backend === "codex") {
      for (const [i, action] of (item.exec?.actions ?? []).entries()) {
        if (!item.unavailableInputs?.includes(`exec.actions.${i}.path`)) add(action.path, action.kind === "read" ? "read" : "searched", item.unavailableInputs?.includes("exec.cwd") ? undefined : item.exec?.cwd);
      }
      if (item.name === "apply_patch" && Array.isArray(item.args.files)) {
        for (const [i, file] of item.args.files.entries()) if (file && typeof file === "object") {
          if (!item.unavailableInputs?.includes(`args.files.${i}.path`)) add(file.path, "changed", this.o.cwd);
          if (!item.unavailableInputs?.includes(`args.files.${i}.movePath`)) add(file.movePath, "changed", this.o.cwd);
        }
      }
    }
    return operations;
  }
  planChanged(): void {
    if (!this.accepting() || !this.o.read().checks.length) return;
    this.change(context => { for (const check of context.checks) check.staleness = "stale"; });
  }
  private checkAccepted(event: ConversationEvent, item: Tool, nativeExec?: Exec): void {
    if (event.type !== "tool.start" && event.type !== "tool.done") return;
    const exec = nativeExec ?? item.exec, command = exec?.command;
    if (!command || !item.origin) return;
    if (item.unavailableInputs?.includes("exec.command") || this.o.privateValue?.(command)) {
      if (event.type === "tool.done" && event.outcome !== "denied") this.planChanged();
      return;
    }
    if (!isCheckCommand(command)) {
      if (event.type === "tool.done" && event.outcome !== "denied" && mayWrite(command) && this.o.read().checks.length) this.planChanged();
      return;
    }
    const source = { kind: "native" as const, itemId: item.id, origin: item.origin };
    const phase = event.type === "tool.start" ? "check-start-observed" : "check-end-observed";
    const placeholders: ContextCapture[] = [];
    this.change(context => {
      let check = context.checks.find(c => c.itemId === item.id);
      if (!check) {
        const changes = checkDirectoryChanges(command);
        const cwd = exec?.cwd && !item.unavailableInputs?.includes("exec.cwd") && changes
          ? changes.reduce((cwd, change) => path.resolve(cwd, change), path.resolve(exec.cwd)) : undefined;
        const relative = cwd === undefined ? undefined : path.relative(this.o.cwd, cwd);
        const scope = relative === undefined ? "unknown" : relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) ? "outside" : "project";
        const planRevision = this.o.planRevision();
        check = { itemId: item.id, origin: item.origin, eventIds: [], command, outcome: "running", scope,
          relevantRefIds: [], relevance: "unestablished", startCaptureIds: [], endCaptureIds: [], staleness: "unknown",
          ...(planRevision === undefined ? {} : { planRevision }) };
        context.checks.push(check);
      }
      check.eventIds.push(event.id);
      if (event.type === "tool.start") check.startedAt = event.at;
      else {
        check.finishedAt = event.at; check.outcome = event.outcome;
        if (item.exitCode !== undefined) check.exitCode = item.exitCode;
        // Millisecond timestamps can tie even when the start read is still queued. Preserve
        // that missed boundary rather than retroactively promoting a late hash on settlement.
        if (check.staleness !== "stale") check.staleness = check.startedAt && check.startCaptureIds.length
          && check.startCaptureIds.every(id => context.captures.some(c => c.id === id && c.revision.state === "available")) ? "current-observation" : "unknown";
      }
      // An unconfirmed model proposal never causes a filesystem or Notes body read.
      const refs = event.type === "tool.start"
        ? context.refs.filter(ref => ref.relations.some(r => r.provenance === "user-confirmed" || r.provenance === "observed"))
        : context.refs.filter(ref => ref.captureIds.some(id => check!.startCaptureIds.includes(id)));
      for (const ref of refs) {
        const capture: ContextCapture = { id: randomUUID(), target: ref.target, source, phase, startedAt: event.at, finishedAt: event.at,
          repository: { state: "unavailable", reason: "not-captured" }, revision: { state: "unavailable", reason: "not-captured" },
          workspace: { kind: "thread", projectId: this.o.projectId, threadId: this.o.turn.thread } };
        placeholders.push(capture); context.captures.push(capture); ref.captureIds.push(capture.id);
        (event.type === "tool.start" ? check.startCaptureIds : check.endCaptureIds).push(capture.id);
      }
    });
    if (!placeholders.length) return;
    const pending = this.o.capture.capture(this.o.cwd, placeholders.map(c => c.target), source, phase, this.signal).then(captures => {
      if (!this.current()) return;
      this.change(context => {
        for (const placeholder of placeholders) {
          const capture = captures.find(c => contextRefId(c.target) === contextRefId(placeholder.target));
          const index = context.captures.findIndex(c => c.id === placeholder.id);
          if (capture && index >= 0) context.captures[index] = { ...capture, id: placeholder.id, workspace: placeholder.workspace };
        }
      });
    }).catch(error => { if (this.current()) this.errors.push(error); }).finally(() => { this.pending.delete(pending); });
    this.pending.add(pending);
  }
  accepted(event: ConversationEvent, item: Tool, nativeArgs?: Record<string, unknown>, nativeExec?: Exec): void {
    if (!this.accepting() || !item.origin || !sameTurn(item.origin, this.o.turn) || (event.type !== "tool.start" && event.type !== "tool.done")) return;
    const key = JSON.stringify([item.id, event.type]);
    if (this.native.has(key)) return;
    this.checkAccepted(event, item, nativeExec);
    this.native.add(key);
    if (event.type === "tool.done" && event.outcome !== "denied" && ["Write", "Edit", "MultiEdit", "NotebookEdit", "apply_patch"].includes(item.name) && this.o.read().checks.length) this.planChanged();
    // Display previews may truncate strings; derive identities from accepted native arguments instead.
    const operations = event.type === "tool.done" && nativeArgs === undefined
      ? this.requested.get(item.id) ?? []
      : this.operations({ ...item, ...(nativeArgs === undefined ? {} : { args: nativeArgs }), ...(nativeExec === undefined ? {} : { exec: nativeExec }) });
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
    if (event.type === "tool.start") this.requested.set(item.id, operations);
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
    if (!this.accepting()) throw new Error("Task context attempt is no longer accepting Notes receipts.");
    if (this.o.privateValue?.(receipt)) throw new Error("Notes context receipt contains a private connection.");
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
  proposed(proposal: TaskContextProposal): TaskContextProposalResult {
    if (!this.accepting()) throw new Error("Task context attempt is no longer accepting proposals.");
    if (this.o.privateValue?.(proposal)) throw new Error("Task context proposal contains a private connection.");
    const signature = JSON.stringify(proposal), prior = this.proposals.get(proposal.receiptId);
    if (prior) { if (prior.signature !== signature) throw new Error("Task context proposal receipt changed."); return structuredClone(prior.result); }
    this.capability({ state: "available" });
    const source = { kind: "model-proposal" as const, turn: structuredClone(this.o.turn), leaseId: proposal.leaseId, receiptId: proposal.receiptId, requestId: proposal.requestId, at: proposal.at };
    let result: TaskContextProposalResult | undefined;
    this.change(context => {
      // Public acceptedRefIds must never expose legacy tuple/path keys. Only this mutable user graph changes.
      const remap = new Map<string, string>();
      for (const ref of context.refs) {
        if (/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(ref.id)) continue;
        const id = randomUUID(); remap.set(ref.id, id); ref.id = id;
      }
      for (const check of context.checks) check.relevantRefIds = check.relevantRefIds.map(id => remap.get(id) ?? id);
      const accepted = new Set<string>();
      for (const { target, role } of proposal.refs) accepted.add(this.ref(context, target, { kind: "relevant", provenance: "model-proposed", role, source }).id);
      result = { receiptId: proposal.receiptId, accepted: accepted.size, refIds: [...accepted] };
    });
    if (!result) throw new Error("Task context attempt is no longer current.");
    this.proposals.set(proposal.receiptId, { signature, result }); return structuredClone(result);
  }
}
