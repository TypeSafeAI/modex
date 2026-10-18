import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { ClaudeBackend } from "../src/main/engine/backends/claude.js";
import type { ApprovalRequest, TurnResult } from "../src/main/engine/backends/types.js";
import { Store } from "../src/main/engine/store.js";
import { ThreadRunner } from "../src/main/engine/runner.js";
import { MockBackend } from "../src/main/engine/backends/mock.js";
import { Router } from "../src/main/engine/routing/router.js";
import type { ApprovalAnswer, ThreadEvent, ThreadItem } from "../src/shared/types.js";
import { FakeProcess, actLikeClaude, collectSink, fakeSpawn } from "./fakeproc.js";
import { gitRepo, tmpdir, writeScript } from "./helpers.js";

// Stop, draining and cancelled-request cleanup for `claude -p` stream-json (#275). The protocol shapes below
// are what Claude Code 2.1.302 sent live on 2026-10-18 (see docs/reviews/2026-10-18-claude-lifecycle.md):
// an interrupt is acknowledged at once, a pending can_use_tool is withdrawn with control_cancel_request,
// a running Bash tool ends only once stdin ends, and the CLI then exits with code 1.

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const options = { cwd: "/repo", mode: "agent" as const, plan: false, model: "haiku" };
const isUser = (l: string) => l.includes('"type":"user"');
const canUse = (request_id: string, command: string) => ({ type: "control_request", request_id, request: { subtype: "can_use_tool", tool_name: "Bash", input: { command }, tool_use_id: `tu-${request_id}` } });
const interrupts = (proc: FakeProcess) => proc.sent((m) => m.type === "control_request" && m.request?.subtype === "interrupt");
const responses = (proc: FakeProcess, id: string) => proc.sent((m) => m.type === "control_response" && m.response?.request_id === id);
async function until(ok: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!ok()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await tick(5);
  }
}

function turn(proc: FakeProcess | FakeProcess[], timing: ConstructorParameters<typeof ClaudeBackend>[2] = {}, sinkPatch: Partial<ReturnType<typeof collectSink>["sink"]> = {}) {
  const backend = new ClaudeBackend("claude", fakeSpawn(proc).spawn, timing);
  const { sink, events } = collectSink();
  const abort = new AbortController();
  let settled: TurnResult | undefined;
  const run = backend.runTurn("go", options, { ...sink, ...sinkPatch }, abort.signal);
  void run.then((r) => { settled = r; });
  return { backend, events, abort, run, settled: () => settled };
}

test("Stop interrupts Claude natively, drains its last messages, and settles only once it has exited", async () => {
  const proc = new FakeProcess();
  actLikeClaude(proc, { partial: "Once upon a" });
  const t = turn(proc, { interruptGraceMs: 5000, killGraceMs: 5000 });
  await proc.waitFor(isUser);
  proc.emitLine({ type: "system", subtype: "init", session_id: "s", claude_code_version: "2.1.302", capabilities: ["interrupt_receipt_v1"] });
  proc.emitLine({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Once upon" } } });
  await tick();
  t.abort.abort();
  const r = await t.run;
  assert.equal(r.status, "interrupted");
  assert.equal(interrupts(proc).length, 1, "Stop asks the CLI to interrupt its turn");
  assert.equal(proc.stdin.writableEnded, true, "and ends its input, so a running tool stops and the CLI exits");
  assert.deepEqual(proc.signals, [], "no signal: Claude ended the turn and exited by itself");
  assert.deepEqual(r.stop && { outcome: r.stop.outcome, exitCode: r.stop.exitCode }, { outcome: "exited", exitCode: 1 }, "exit code 1 after an interrupt is not a failure");
  assert.ok(t.events.includes("assistant:Once upon a"), "the CLI's final snapshot of the interrupted reply reaches the thread");
});

test("Stop terminates a Claude that does not exit within the interrupt grace", async () => {
  const proc = new FakeProcess(); // ignores the interrupt and the end of its input
  const t = turn(proc, { interruptGraceMs: 60, killGraceMs: 2000 });
  await proc.waitFor(isUser);
  const stopped = Date.now();
  t.abort.abort();
  await until(() => proc.signals.length > 0);
  const waited = Date.now() - stopped;
  assert.ok(waited >= 50, `SIGTERM waits for the grace window (sent after ${waited} ms)`);
  const r = await t.run;
  assert.equal(interrupts(proc).length, 1);
  assert.deepEqual(proc.signals, ["SIGTERM"]);
  assert.equal(r.status, "interrupted");
  assert.deepEqual(r.stop && { outcome: r.stop.outcome, signal: r.stop.signal }, { outcome: "terminated", signal: "SIGTERM" });
});

test("Stop kills a Claude that also ignores SIGTERM", async () => {
  const proc = new FakeProcess();
  proc.ignore.add("SIGTERM");
  const t = turn(proc, { interruptGraceMs: 30, killGraceMs: 30 });
  await proc.waitFor(isUser);
  t.abort.abort();
  const r = await t.run;
  assert.deepEqual(proc.signals, ["SIGTERM", "SIGKILL"]);
  assert.deepEqual(r.stop && { outcome: r.stop.outcome, signal: r.stop.signal }, { outcome: "killed", signal: "SIGKILL" });
});

test("A Claude that never confirms its exit is reported unconfirmed instead of holding Stop forever", { timeout: 4000 }, async () => {
  const proc = new FakeProcess();
  proc.ignore.add("SIGTERM").add("SIGKILL");
  const t = turn(proc, { interruptGraceMs: 30, killGraceMs: 30, exitConfirmMs: 30 });
  await proc.waitFor(isUser);
  t.abort.abort();
  const r = await t.run;
  assert.equal(r.status, "interrupted");
  assert.deepEqual(r.stop && { outcome: r.stop.outcome, pid: r.stop.pid }, { outcome: "unconfirmed", pid: proc.pid });
  // Anything it still prints belongs to a turn that is over.
  proc.emitLine({ type: "assistant", message: { content: [{ type: "text", text: "stale" }] } });
  proc.emitLine({ type: "result", subtype: "success", is_error: false, num_turns: 1, session_id: "late" });
  await tick();
  assert.ok(!t.events.some((e) => e.includes("stale") || e.includes("late")), "late output after the turn settled reaches nobody");
});

test("A permission request Claude cancels is withdrawn, and a late answer to it writes nothing", async () => {
  const proc = new FakeProcess();
  let withdrawn: AbortSignal | undefined;
  let answer: ((a: ApprovalAnswer) => void) | undefined;
  const t = turn(proc, {}, { approval: (_req: ApprovalRequest, signal?: AbortSignal) => { withdrawn = signal; return new Promise<ApprovalAnswer>((r) => { answer = r; }); } });
  await proc.waitFor(isUser);
  proc.emitLine(canUse("r1", "touch a"));
  await until(() => answer !== undefined);
  assert.equal(withdrawn?.aborted, false, "the backend gives the sink a withdrawal signal with each request");
  proc.emitLine({ type: "control_cancel_request", request_id: "r1" });
  await tick();
  assert.equal(withdrawn?.aborted, true, "control_cancel_request withdraws the request");
  answer!("yes");
  await tick();
  assert.deepEqual(responses(proc, "r1"), [], "a cancelled request is never answered");
  proc.emitLine({ type: "result", subtype: "success", is_error: false, num_turns: 1, session_id: "s" });
  assert.equal((await t.run).status, "completed");
});

test("A withdrawn request no longer holds a drained turn open", { timeout: 3000 }, async () => {
  const proc = new FakeProcess();
  const t = turn(proc, { backgroundIdleMs: 40 }, { approval: () => new Promise<ApprovalAnswer>(() => {}) });
  await proc.waitFor(isUser);
  proc.emitLine({ type: "system", subtype: "init", session_id: "s" });
  proc.emitLine({ type: "assistant", message: { content: [{ type: "tool_use", id: "tu-bg", name: "Bash", input: { command: "npm test", run_in_background: true } }] } });
  proc.emitLine({ type: "system", subtype: "task_started", task_id: "b1", tool_use_id: "tu-bg", task_type: "local_bash", is_backgrounded: true });
  proc.emitLine({ type: "assistant", message: { content: [{ type: "text", text: "Running." }] } });
  proc.emitLine({ type: "result", subtype: "success", is_error: false, num_turns: 2, session_id: "s" });
  proc.emitLine(canUse("r1", "touch b"));
  proc.emitLine({ type: "control_cancel_request", request_id: "r1" });
  proc.emitLine({ type: "system", subtype: "task_notification", task_id: "b1", tool_use_id: "tu-bg", status: "completed" });
  const r = await t.run;
  assert.equal(r.status, "completed");
});

test("An answer that arrives after the turn settled is not written to Claude's closed input", async () => {
  const proc = new FakeProcess();
  let answer: ((a: ApprovalAnswer) => void) | undefined;
  const t = turn(proc, { drainMs: 30 }, { approval: () => new Promise<ApprovalAnswer>((r) => { answer = r; }) });
  await proc.waitFor(isUser);
  proc.emitLine(canUse("r1", "touch c"));
  await until(() => answer !== undefined);
  proc.emitLine({ type: "result", subtype: "error_during_execution", is_error: true, result: "boom", errors: ["boom"], num_turns: 1 });
  proc.close(1);
  assert.equal((await t.run).status, "failed");
  answer!("yes");
  await tick();
  assert.deepEqual(responses(proc, "r1"), []);
});

test("keep_alive heartbeats do not keep a finished turn open", { timeout: 3000 }, async () => {
  const proc = new FakeProcess();
  const t = turn(proc, { backgroundIdleMs: 60 });
  await proc.waitFor(isUser);
  proc.emitLine({ type: "assistant", message: { content: [{ type: "tool_use", id: "tu-bg", name: "Bash", input: { command: "npm test", run_in_background: true } }] } });
  proc.emitLine({ type: "system", subtype: "task_started", task_id: "b1", tool_use_id: "tu-bg", task_type: "local_bash", is_backgrounded: true });
  proc.emitLine({ type: "assistant", message: { content: [{ type: "text", text: "Started." }] } });
  proc.emitLine({ type: "result", subtype: "success", is_error: false, num_turns: 2, session_id: "s" });
  proc.emitLine({ type: "system", subtype: "task_notification", task_id: "b1", tool_use_id: "tu-bg", status: "completed" });
  const started = Date.now();
  const beat = setInterval(() => { if (!t.settled()) proc.emitLine({ type: "keep_alive" }); }, 15);
  try {
    await until(() => t.settled() !== undefined, 1000);
  } finally { clearInterval(beat); }
  assert.ok(Date.now() - started < 600, "the idle window ran out despite the heartbeats");
  assert.equal(t.settled()?.status, "completed");
});

test("Split JSON lines, split UTF-8, a final unterminated line and stderr written just before exit all survive", async () => {
  const proc = new FakeProcess();
  const t = turn(proc, { drainMs: 200 });
  await proc.waitFor(isUser);
  const line = Buffer.from(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Café ☕ ready" }] } }) + "\n");
  const cut = line.indexOf(Buffer.from("☕")) + 1;
  proc.emitRaw(line.subarray(0, cut));
  await tick(5);
  proc.emitRaw(line.subarray(cut));
  const err = Buffer.from("Erreur : clé refusée ✗\n");
  const ecut = err.indexOf(Buffer.from("é")) + 1;
  proc.stderr.write(err.subarray(0, ecut));
  await tick(5);
  proc.stderr.write(err.subarray(ecut));
  // The failing result, with no trailing newline, immediately before the process exits.
  proc.emitRaw(JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: "Session ended: clé expirée", errors: ["expired"], num_turns: 1 }));
  proc.close(2);
  const r = await t.run;
  assert.ok(t.events.includes("assistant:Café ☕ ready"), "a character split across chunks is decoded whole");
  assert.equal(r.status, "failed");
  assert.equal(r.error, "Session ended: clé expirée", "the last line, unterminated at exit, is still read");
  assert.equal(r.detail?.stderr, "Erreur : clé refusée ✗", "stderr is decoded across chunks");
  assert.equal(r.detail?.exitCode, 2, "the failure records the exit code");
});

test("A failure result waits briefly for stderr Claude writes after it, and for its exit", async () => {
  const proc = new FakeProcess();
  const t = turn(proc, { drainMs: 500 });
  await proc.waitFor(isUser);
  proc.emitLine({ type: "result", subtype: "error_during_execution", is_error: true, result: "boom", errors: ["boom"], num_turns: 1 });
  await tick(10);
  proc.stderr.write("trace: the session file was locked\n");
  proc.close(1);
  const r = await t.run;
  assert.equal(r.detail?.stderr, "trace: the session file was locked");
  assert.equal(r.detail?.exitCode, 1);
});

test("Output after exit is drained, and a descendant holding Claude's pipes cannot hold the turn open", { timeout: 3000 }, async () => {
  const proc = new FakeProcess();
  proc.holdStdio = true;
  const t = turn(proc, { drainMs: 60 });
  await proc.waitFor(isUser);
  proc.close(3);
  await tick(5);
  proc.stderr.write("late: credentials expired\n");
  const r = await t.run;
  assert.equal(r.status, "failed");
  assert.equal(r.detail?.exitCode, 3);
  assert.equal(r.detail?.stderr, "late: credentials expired");
  assert.match(r.error ?? "", /credentials expired/);
});

test("A process killed by a signal says so in its failure", async () => {
  const proc = new FakeProcess();
  const t = turn(proc);
  await proc.waitFor(isUser);
  proc.close(null, "SIGKILL");
  const r = await t.run;
  assert.equal(r.status, "failed");
  assert.equal(r.error, "claude was terminated by SIGKILL");
  assert.deepEqual([r.detail?.exitCode, r.detail?.signal], [null, "SIGKILL"]);
});

test("Failure details name the MCP routes without their capability tokens", async () => {
  const proc = new FakeProcess();
  const token = "3f0c2a6e-8b1d-4c55-9e0f-7a2b1c3d4e5f";
  const backend = new ClaudeBackend("claude", fakeSpawn(proc).spawn);
  const run = backend.runTurn("go", { ...options, pages: { url: `http://127.0.0.1:4100/mcp/${token}`, instructions: "Notes" } }, collectSink().sink, new AbortController().signal);
  await proc.waitFor(isUser);
  proc.stderr.write("fatal\n");
  proc.close(1);
  const r = await run;
  assert.equal(r.status, "failed");
  const detail = JSON.stringify(r.detail);
  assert.ok(!detail.includes(token), "the route token never reaches the debug report");
  assert.ok(detail.includes("127.0.0.1:4100/mcp/"), "the route itself is still named");
});

test("Stop pressed while a failed result drains keeps the failure and still ends the process", async () => {
  const proc = new FakeProcess(); // ends neither on stdin's end nor by itself, as with background work running
  const t = turn(proc, { drainMs: 30, interruptGraceMs: 60, killGraceMs: 2000 });
  await proc.waitFor(isUser);
  proc.emitLine({ type: "result", subtype: "error_during_execution", is_error: true, result: "API Error: 529 overloaded", errors: ["529"], num_turns: 1 });
  await tick(5);
  t.abort.abort();
  const r = await t.run;
  assert.equal(r.status, "failed", "the turn had already failed when Stop was pressed");
  assert.equal(r.error, "API Error: 529 overloaded");
  await until(() => proc.signals.length > 0);
  assert.deepEqual(proc.signals, ["SIGTERM"], "and Stop still ends the process the turn left running");
});

test("A success result inside a failure's drain window does not turn the failure into a completion", async () => {
  const proc = new FakeProcess();
  const t = turn(proc, { drainMs: 50 });
  await proc.waitFor(isUser);
  proc.emitLine({ type: "result", subtype: "error_during_execution", is_error: true, result: "boom", errors: ["boom"], num_turns: 1 });
  proc.emitLine({ type: "assistant", message: { content: [{ type: "text", text: "late" }] } });
  proc.emitLine({ type: "result", subtype: "success", is_error: false, num_turns: 1, session_id: "s" });
  const r = await t.run;
  assert.equal(r.status, "failed");
  assert.equal(r.error, "boom");
});

test("A launch that throws reports its argv without MCP route tokens", async () => {
  const token = "9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d";
  const backend = new ClaudeBackend("claude", (() => { throw new Error("unsupported launcher"); }) as unknown as typeof import("node:child_process").spawn);
  const r = await backend.runTurn("go", { ...options, knowledge: { url: `http://127.0.0.1:4101/mcp/${token}`, instructions: "Knowledge" } }, collectSink().sink, new AbortController().signal);
  assert.equal(r.status, "failed");
  assert.ok(!JSON.stringify(r.detail).includes(token));
});

// ---- Through the runner: cards, notices, statuses, deletion and the next turn. ----

function harness() {
  const home = tmpdir("modex-home-");
  const store = new Store(home);
  store.updateSettings({ default_backend: "mock", mock_script: writeScript([]) });
  const events: ThreadEvent[] = [];
  return { home, store, events, emit: (e: ThreadEvent) => events.push(e), mock: new MockBackend(() => store.settings.mock_script, home, 0) };
}

async function claudeThread(procs: FakeProcess[], timing: ConstructorParameters<typeof ClaudeBackend>[2] = {}, extra: { isProcessAlive?: (pid: number) => boolean } = {}) {
  const h = harness();
  const router = new Router({ home: h.home, policy: () => h.store.settings.routing, listModels: async () => ({ models: [] }), transport: null });
  const claude = new ClaudeBackend("claude", fakeSpawn(procs).spawn, timing);
  const runner = new ThreadRunner({ home: h.home, store: h.store, emit: h.emit, router, backends: { mock: h.mock, claude }, ...extra });
  const project = h.store.addProject(gitRepo());
  return { h, runner, project };
}
const approvals = (items: ThreadItem[]) => items.filter((i): i is Extract<ThreadItem, { kind: "approval" }> => i.kind === "approval");
const notices = (items: ThreadItem[]) => items.filter((i): i is Extract<ThreadItem, { kind: "notice" }> => i.kind === "notice").map((i) => `${i.level}:${i.text}`);
const statuses = (events: ThreadEvent[], threadId: string) => events.filter((e) => e.threadId === threadId && e.type === "status").map((e) => (e as { status: string }).status);

test("runner: a card Claude cancels becomes inert, the thread stops waiting, and a late answer satisfies nothing", async () => {
  const proc = new FakeProcess();
  const { h, runner, project } = await claudeThread([proc]);
  const thread = await runner.createThread(project.id, { backend: "claude", mode: "agent", auto: false });
  runner.updateThread(thread.id, { title: "Cards" });
  const done = runner.send(thread.id, "go");
  await proc.waitFor(isUser);
  proc.emitLine(canUse("r1", "touch one"));
  await until(() => runner.status(thread.id) === "waiting");
  const card = approvals(runner.items(thread.id))[0]!;
  proc.emitLine({ type: "control_cancel_request", request_id: "r1" });
  await until(() => runner.status(thread.id) === "running");
  const closed = approvals(runner.items(thread.id))[0]!;
  assert.deepEqual([closed.id, closed.answer, closed.withdrawn], [card.id, "no", "native"], "the card is closed as withdrawn, not left actionable");
  proc.emitLine(canUse("r2", "touch two"));
  await until(() => approvals(runner.items(thread.id)).length === 2 && runner.status(thread.id) === "waiting");
  runner.answer(thread.id, card.id, "yes"); // a late click on the obsolete card
  await tick();
  assert.deepEqual(responses(proc, "r1"), [], "the withdrawn request is never answered");
  assert.deepEqual(responses(proc, "r2"), [], "and the late answer does not satisfy the next request");
  assert.equal(runner.status(thread.id), "waiting");
  const second = approvals(runner.items(thread.id))[1]!;
  runner.answer(thread.id, second.id, "no");
  await proc.waitFor((l) => l.includes('"request_id":"r2"'));
  proc.emitLine({ type: "result", subtype: "success", is_error: false, num_turns: 1, session_id: "s" });
  proc.close(0);
  await done;
  assert.deepEqual(approvals(h.store.items(thread.id)).map((a) => [a.answer, a.withdrawn]), [["no", "native"], ["no", undefined]], "persisted the same way");
});

test("runner: a request withdrawn while the approval gate is still deciding never shows a card", async () => {
  const proc = new FakeProcess();
  const { h, runner, project } = await claudeThread([proc]);
  h.store.updateSettings({ approval_gate: { enabled: true, threshold: 0.8, timeout_ms: 1000 }, approval_rules: [{ id: "a", when: "touch files", decision: "ask", match: "Bash: touch*", enabled: true }] });
  const thread = await runner.createThread(project.id, { backend: "claude", mode: "agent", auto: false });
  runner.updateThread(thread.id, { title: "Gate" });
  const done = runner.send(thread.id, "go");
  await proc.waitFor(isUser);
  proc.emitRaw(`${JSON.stringify(canUse("r1", "touch gated"))}\n${JSON.stringify({ type: "control_cancel_request", request_id: "r1" })}\n`);
  await tick(50);
  assert.deepEqual(approvals(runner.items(thread.id)), [], "nothing was asked of the user");
  assert.equal(runner.status(thread.id), "running");
  proc.emitLine({ type: "assistant", message: { content: [{ type: "text", text: "Skipped." }] } });
  proc.emitLine({ type: "result", subtype: "success", is_error: false, num_turns: 1, session_id: "s" });
  proc.close(0);
  await done;
  assert.deepEqual(responses(proc, "r1"), []);
});

test("runner: Stop with a pending card withdraws it, sends one interrupt and reports one stop", async () => {
  const proc = new FakeProcess();
  actLikeClaude(proc, { pending: ["r1"], tools: ["tu-r1"] });
  const { h, runner, project } = await claudeThread([proc]);
  const thread = await runner.createThread(project.id, { backend: "claude", mode: "agent", auto: false });
  runner.updateThread(thread.id, { title: "Stop" });
  const done = runner.send(thread.id, "go");
  await proc.waitFor(isUser);
  proc.emitLine({ type: "assistant", message: { content: [{ type: "tool_use", id: "tu-r1", name: "Bash", input: { command: "touch x" } }] } });
  proc.emitLine(canUse("r1", "touch x"));
  await until(() => runner.status(thread.id) === "waiting");
  runner.stop(thread.id);
  runner.stop(thread.id); // a second press before Claude has exited
  await done;
  runner.stop(thread.id); // and one after
  const items = runner.items(thread.id);
  assert.equal(interrupts(proc).length, 1, "one interrupt, however often Stop is pressed");
  assert.deepEqual(responses(proc, "r1"), [], "Claude withdrew the request itself; Modex does not answer it");
  assert.deepEqual(approvals(items).map((a) => [a.answer, a.withdrawn]), [["no", "stopped"]]);
  assert.deepEqual(notices(items), ["info:Stopped."]);
  assert.equal(items.filter((i) => i.kind === "notice" && i.failure).length, 0, "the CLI's exit code 1 after an interrupt is no failure");
  assert.equal(statuses(h.events, thread.id).at(-1), "idle");
  assert.equal(statuses(h.events, thread.id).filter((s) => s === "idle").length, 1, "one terminal status");
  const tool = items.find((i) => i.kind === "tool");
  assert.equal(tool?.kind === "tool" && tool.status, "done", "the CLI's own tool result closes the row");
  assert.equal(tool?.kind === "tool" && tool.outcome, "interrupted", "a call Stop rejected was interrupted, not a failure");
});

test("runner: a Stop Claude does not acknowledge says how Modex ended it", async () => {
  const proc = new FakeProcess();
  const { runner, project } = await claudeThread([proc], { interruptGraceMs: 30, killGraceMs: 30 });
  const thread = await runner.createThread(project.id, { backend: "claude", mode: "agent", auto: false });
  runner.updateThread(thread.id, { title: "Slow" });
  const done = runner.send(thread.id, "go");
  await proc.waitFor(isUser);
  runner.stop(thread.id);
  await done;
  assert.deepEqual(notices(runner.items(thread.id)), ["info:Stopped. Claude did not end the turn within 30 ms of the interrupt, so Modex terminated it."]);
});

test("runner: an unconfirmed stop keeps the worktree, and the old process cannot touch the next turn", { timeout: 6000 }, async () => {
  const stuck = new FakeProcess();
  stuck.ignore.add("SIGTERM").add("SIGKILL");
  const next = new FakeProcess();
  let stuckAlive = true;
  const { h, runner, project } = await claudeThread([stuck, next], { interruptGraceMs: 20, killGraceMs: 20, exitConfirmMs: 20 }, { isProcessAlive: (pid) => pid === stuck.pid ? stuckAlive : false });
  const thread = await runner.createThread(project.id, { backend: "claude", mode: "agent", auto: false, worktree: true });
  runner.updateThread(thread.id, { title: "Stuck" });
  const first = runner.send(thread.id, "first");
  await stuck.waitFor(isUser);
  runner.stop(thread.id);
  await first;
  assert.equal(runner.status(thread.id), "idle");
  assert.deepEqual(notices(runner.items(thread.id)), [`warn:Stop requested, but Claude (pid ${stuck.pid}) has not confirmed that it exited. Modex keeps this thread and its worktree until it does.`]);
  const worktree = h.store.thread(thread.id)!.worktree!.path;
  await assert.rejects(runner.deleteThread(thread.id, true), new RegExp(`pid ${stuck.pid}`));
  assert.ok(fs.existsSync(worktree), "the worktree a live process may still use is kept");
  assert.ok(h.store.thread(thread.id), "and so is the thread");

  const second = runner.send(thread.id, "second");
  await next.waitFor(isUser);
  stuck.emitLine({ type: "assistant", message: { content: [{ type: "text", text: "stale reply" }] } });
  stuck.emitLine({ type: "result", subtype: "success", is_error: false, num_turns: 1, session_id: "stale" });
  await tick();
  assert.equal(runner.status(thread.id), "running", "the old process's success does not complete the new turn");
  next.emitLine({ type: "assistant", message: { content: [{ type: "text", text: "fresh reply" }] } });
  next.emitLine({ type: "result", subtype: "success", is_error: false, num_turns: 1, session_id: "fresh" });
  next.close(0);
  await second;
  const texts = runner.items(thread.id).filter((i) => i.kind === "assistant").map((i) => (i as { text: string }).text);
  assert.deepEqual(texts, ["fresh reply"]);
  assert.equal(h.store.thread(thread.id)?.sessionHandle, "fresh");

  stuckAlive = false;
  await runner.deleteThread(thread.id, true);
  assert.ok(!fs.existsSync(worktree), "once the process is gone the worktree can go");
});

test("runner: deleting a thread stops only its own Claude and waits for it to exit; another thread keeps running", async () => {
  const doomed = new FakeProcess();
  actLikeClaude(doomed, { exitOnEnd: false }); // acknowledges the interrupt, then takes a while to exit
  const other = new FakeProcess();
  const { runner, project } = await claudeThread([doomed, other]);
  const a = await runner.createThread(project.id, { backend: "claude", mode: "agent", auto: false });
  const b = await runner.createThread(project.id, { backend: "claude", mode: "agent", auto: false });
  runner.updateThread(a.id, { title: "A" });
  runner.updateThread(b.id, { title: "B" });
  const runA = runner.send(a.id, "a");
  await doomed.waitFor(isUser);
  const runB = runner.send(b.id, "b");
  await other.waitFor(isUser);
  let deleted = false;
  const deletion = runner.deleteThread(a.id).then(() => { deleted = true; });
  await until(() => interrupts(doomed).length === 1);
  await tick(50);
  assert.equal(deleted, false, "deletion waits for the stopped process");
  assert.deepEqual(interrupts(other), [], "the other thread's Claude is not stopped");
  assert.equal(runner.status(b.id), "running");
  doomed.close(1);
  await deletion;
  await runA;
  other.emitLine({ type: "assistant", message: { content: [{ type: "text", text: "B done" }] } });
  other.emitLine({ type: "result", subtype: "success", is_error: false, num_turns: 1, session_id: "b" });
  other.close(0);
  await runB;
  assert.equal(runner.status(b.id), "idle");
  assert.ok(runner.items(b.id).some((i) => i.kind === "assistant"));
});

test("runner: a resumed session's replayed background result does not finish the new turn; a silent one still fails visibly", async () => {
  const procs = [new FakeProcess(), new FakeProcess()];
  const { runner, project } = await claudeThread(procs, { backgroundIdleMs: 300 });
  const thread = await runner.createThread(project.id, { backend: "claude", mode: "agent", auto: false });
  runner.updateThread(thread.id, { title: "Resume" });
  const replay = [
    { type: "system", subtype: "task_notification", task_id: "b-old", tool_use_id: "tu-old", status: "stopped" },
    { type: "system", subtype: "init", session_id: "s" },
    { type: "result", subtype: "success", is_error: false, session_id: "s", result: "", num_turns: 0 },
  ];
  const first = runner.send(thread.id, "go on");
  await procs[0]!.waitFor(isUser);
  for (const line of replay) procs[0]!.emitLine(line);
  await tick(60);
  assert.equal(runner.status(thread.id), "running", "the replayed result is held, not taken as this turn's answer");
  procs[0]!.emitLine({ type: "system", subtype: "init", session_id: "s" });
  procs[0]!.emitLine({ type: "assistant", message: { content: [{ type: "text", text: "Continuing." }] } });
  procs[0]!.emitLine({ type: "result", subtype: "success", is_error: false, session_id: "s", num_turns: 1 });
  await first;
  assert.ok(runner.items(thread.id).some((i) => i.kind === "assistant" && i.text === "Continuing."));
  const second = runner.send(thread.id, "again");
  await procs[1]!.waitFor(isUser);
  for (const line of replay) procs[1]!.emitLine(line);
  await second;
  assert.match(notices(runner.items(thread.id)).at(-1) ?? "", /ended the turn without replying/);
  assert.equal(runner.status(thread.id), "error");
});

test("a failure before Stop retains an unconfirmed process report and the original error", async () => {
  const proc = new FakeProcess();
  proc.ignore.add("SIGTERM").add("SIGKILL");
  const t = turn(proc, { drainMs: 5, interruptGraceMs: 20, killGraceMs: 20, exitConfirmMs: 20 });
  await proc.waitFor(isUser);
  proc.emitLine({ type: "result", subtype: "error_during_execution", is_error: true, result: "boom", errors: ["boom"], num_turns: 1 });
  t.abort.abort();
  const result = await t.run;
  assert.equal(result.status, "failed");
  assert.equal(result.error, "boom");
  assert.deepEqual(result.stop && { outcome: result.stop.outcome, pid: result.stop.pid }, { outcome: "unconfirmed", pid: proc.pid });
  assert.deepEqual(proc.signals, ["SIGTERM", "SIGKILL"]);
});

test("runner: a failure before Stop keeps its live process's worktree until exit is confirmed", async () => {
  const proc = new FakeProcess();
  proc.ignore.add("SIGTERM").add("SIGKILL");
  let alive = true;
  const { h, runner, project } = await claudeThread([proc], { drainMs: 5, interruptGraceMs: 20, killGraceMs: 20, exitConfirmMs: 20 }, { isProcessAlive: (pid) => pid === proc.pid && alive });
  const thread = await runner.createThread(project.id, { backend: "claude", mode: "agent", auto: false, worktree: true });
  runner.updateThread(thread.id, { title: "Failed then stopped" });
  const run = runner.send(thread.id, "go");
  await proc.waitFor(isUser);
  proc.emitLine({ type: "result", subtype: "error_during_execution", is_error: true, result: "boom", errors: ["boom"], num_turns: 1 });
  runner.stop(thread.id);
  await run;
  const worktree = h.store.thread(thread.id)!.worktree!.path;
  assert.ok(runner.items(thread.id).some((i) => i.kind === "notice" && i.failure && i.text.includes("boom")), "the original failure remains visible");
  await assert.rejects(runner.deleteThread(thread.id, true), /has not confirmed/);
  assert.ok(fs.existsSync(worktree));
  assert.ok(h.store.thread(thread.id));
  alive = false;
  await runner.deleteThread(thread.id, true);
  assert.ok(!fs.existsSync(worktree));
});
