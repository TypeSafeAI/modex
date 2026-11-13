import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/main/engine/store.js";
import { ThreadRunner } from "../src/main/engine/runner.js";
import { TaskContextCapture } from "../src/main/engine/task-context-capture.js";
import type { Backend } from "../src/main/engine/backends/types.js";
import type { TaskContextEvidence } from "../src/shared/task-context-evidence.js";
import { taskRecord } from "../src/shared/task-context.js";
import { gitRepo, tmpdir } from "./helpers.js";
import { registerCommands, type RegisterCommand } from "../src/main/commands.js";
import { TerminalManager } from "../src/main/engine/terminal.js";

for (const boundary of ["both", "missing-start", "late-start", "outside", "unknown-cwd", "instant-completion", "cd-outside", "cwd-flag", "protected-command", "large-confirmation"] as const) test(`accepted check receipts preserve native identity and ${boundary} boundaries`, async t => {
  const store = new Store(tmpdir("modex-check-receipt-")), project = store.addProject(gitRepo());
  let captureCalls = 0, finishStart: (() => void) | undefined;
  const capture = new TaskContextCapture();
  capture.capture = async (_cwd, targets, source, phase) => {
    captureCalls++;
    if (boundary === "late-start" && phase === "check-start-observed") await new Promise<void>(resolve => { finishStart = resolve; });
    const at = new Date().toISOString();
    return targets.map((target, i) => ({ id: `capture-${captureCalls}-${i}`, target, source, phase, startedAt: at, finishedAt: at, repository: { state: "available", head: "a".repeat(40) }, revision: { state: "available", algorithm: "sha256", digest: "b".repeat(64), bytes: 3 } }));
  };
  const backend: Backend = { id: "codex", identity: () => "synthetic", listModels: async () => [], dispose: async () => {}, runTurn: async (text, _opts, sink) => {
    if (!text.startsWith("Check")) return { status: "completed" };
    const native = { runtime: "fixture", thread: "native-thread", turn: "native-turn", item: "check" };
    const exec = { command: boundary === "cd-outside" ? "cd /outside && pnpm test" : boundary === "cwd-flag" ? "pnpm --dir /outside test" : "pnpm test", ...(boundary === "unknown-cwd" ? {} : { cwd: boundary === "outside" ? "/outside" : project.path }) };
    if (boundary !== "missing-start") sink.observe({ type: "tool.start", source: "start", native, tool: { name: "exec_command", title: "test", args: {}, exec, ...(boundary === "protected-command" ? { unavailableInputs: ["exec.command"] } : {}) } });
    if (boundary !== "instant-completion") await new Promise<void>(resolve => setImmediate(resolve));
    // A completion without a start uses only its reported command; it cannot invent a start capture.
    sink.observe({ type: "tool.done", source: "end", native, outcome: "succeeded", progress: { exitCode: 0, args: {}, ...(boundary === "missing-start" ? { title: "test" } : {}) } });
    finishStart?.(); return { status: "completed" };
  } };
  const runner = new ThreadRunner({ home: store.dir, store, emit: () => {}, contextCapture: capture, backends: { codex: backend } });
  const terminals = new TerminalManager(id => store.thread(id)!.cwd, () => {}), handlers = new Map<string, (req: any) => any>();
  registerCommands(((channel, handler) => handlers.set(channel, handler)) as RegisterCommand, { store, runner, terminals, emit: () => {}, pickDirectory: async () => null, openPath: async () => {}, openTerminal: async () => {} });
  t.after(async () => { await runner.dispose(); await terminals.dispose(); });
  const thread = await runner.createThread(project.id, { backend: "codex", auto: false });
  const opened = runner.openContextDraft({ kind: "thread", threadId: thread.id });
  const selected = await runner.selectTaskContext(opened, boundary === "large-confirmation" ? Array.from({ length: 1001 }, (_, i) => ({ kind: "file" as const, path: `selected-${i}.ts` })) : [{ kind: "file", path: "README.md" }]);
  await runner.send(thread.id, "Check", [], "desktop", selected.binding);
  const items = runner.items(thread.id), user = items.find(item => item.kind === "user")!;
  assert.ok(user.kind === "user" && user.contextEvidence);
  if (boundary === "missing-start" || boundary === "protected-command") {
    assert.equal(user.contextEvidence.checks.length, 0, "an unavailable command is not a native check identity");
    assert.notEqual(taskRecord(items, { threadId: thread.id, title: "Task", cwd: thread.cwd }).verification!.state, "verified");
    return;
  }
  const evidence = user.contextEvidence, check = evidence.checks[0]!;
  assert.ok(check, "accepted native command must produce a durable check receipt");
  const item = items.find(item => item.id === check.itemId)!;
  assert.ok(item.kind === "tool"); assert.deepEqual(check.origin, item.origin);
  assert.equal(check.eventIds.length, 2); assert.equal(new Set(check.eventIds).size, 2);
  assert.equal(check.exitCode, 0); assert.equal(check.relevance, "unestablished");
  assert.equal(check.scope, boundary === "outside" || boundary === "cd-outside" ? "outside" : boundary === "unknown-cwd" || boundary === "cwd-flag" ? "unknown" : "project");
  assert.ok(handlers.has("task:context"), "existing task context needs a scoped read command");
  assert.ok(handlers.has("task:check-confirm"), "check relevance requires an explicit main-owned confirmation command");
  const confirm = (_thread: string, _turn: string, revision: number, item: string, refs: string[]) => handlers.get("task:check-confirm")!({ threadId: _thread, turnId: _turn, expectedRevision: revision, itemId: item, refIds: refs }) as TaskContextEvidence;
  const before = structuredClone(evidence), calls = captureCalls;
  assert.throws(() => confirm!.call(runner, thread.id, user.id, evidence.revision, "foreign-item", [evidence.refs[0]!.id]));
  assert.throws(() => confirm!.call(runner, thread.id, user.id, evidence.revision - 1, check.itemId, [evidence.refs[0]!.id]));
  assert.throws(() => confirm!.call(runner, thread.id, "foreign-turn", evidence.revision, check.itemId, [evidence.refs[0]!.id]));
  assert.throws(() => confirm!.call(runner, thread.id, user.id, evidence.revision, check.itemId, ["foreign-ref"]));
  if (boundary === "both") {
    const save = store.saveItems.bind(store);
    store.saveItems = () => { throw new Error("synthetic check confirmation write failure"); };
    try { assert.throws(() => confirm!.call(runner, thread.id, user.id, evidence.revision, check.itemId, [evidence.refs[0]!.id]), /synthetic check confirmation write failure/); }
    finally { store.saveItems = save; }
    assert.deepEqual(runner.taskContext(thread.id, user.id), before, "failed persistence cannot publish confirmation");
  }
  assert.deepEqual(runner.items(thread.id).find(i => i.id === user.id), user);
  const frozen = runner.saveTaskNote(thread.id, user.id), snapshot = structuredClone(store.space.taskSnapshot(frozen.pageId));
  const confirmed = confirm!.call(runner, thread.id, user.id, evidence.revision, check.itemId, evidence.refs.map(ref => ref.id));
  assert.equal(confirmed.checks[0]!.relevance, "user-confirmed");
  assert.equal(captureCalls, calls, "confirmation must never execute a check or refresh its captures");
  assert.deepEqual(before, evidence, "confirmation replaces metadata without mutating old snapshots");
  assert.deepEqual(store.space.taskSnapshot(frozen.pageId), snapshot, "an explicit Save remains frozen");
  const record = taskRecord(runner.items(thread.id), { threadId: thread.id, title: "Task", cwd: thread.cwd });
  assert.equal(record.verification!.state === "verified", boundary === "both" || boundary === "large-confirmation");
});
