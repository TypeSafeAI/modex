import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaudeBackend } from "../src/main/engine/backends/claude.js";
import type { TurnResult } from "../src/main/engine/backends/types.js";
import { FakeProcess, fakeSpawn, collectSink } from "./fakeproc.js";

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const options = { cwd: "/repo", mode: "agent" as const, plan: false, model: "sonnet" };

/** Starts a turn on a fake `claude` and waits for the prompt to reach its stdin. */
async function start(timing: { backgroundIdleMs?: number; backgroundCapMs?: number } = {}, answers: ("yes" | "no" | "always")[] = ["yes"]) {
  const proc = new FakeProcess();
  const backend = new ClaudeBackend("claude", fakeSpawn(proc).spawn, timing);
  const { sink, events } = collectSink(answers);
  const abort = new AbortController();
  let settled: TurnResult | undefined;
  const run = backend.runTurn("go", options, sink, abort.signal);
  void run.then((r) => (settled = r));
  await proc.waitFor((l) => l.includes('"type":"user"'));
  return { proc, events, abort, run, settled: () => settled };
}

const bashInBackground = (id: string) => ({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "Bash", input: { command: "npm test", run_in_background: true } }] } });
const ok = { type: "result", subtype: "success", is_error: false, session_id: "sess-bg", result: "Started." };

test("ClaudeBackend: background work keeps the turn and stdin open past the first result", async () => {
  const proc = new FakeProcess();
  const { spawn } = fakeSpawn(proc);
  const backend = new ClaudeBackend("claude", spawn);
  const { sink, events } = collectSink(["yes"]);
  let settled = false;
  const run = backend.runTurn("run the suite in the background", { cwd: "/repo", mode: "agent", plan: false, model: "sonnet" }, sink, new AbortController().signal);
  void run.then(() => (settled = true));
  await proc.waitFor((l) => l.includes('"type":"user"'));

  proc.emitLine({ type: "system", subtype: "init", session_id: "sess-bg" });
  proc.emitLine({ type: "assistant", message: { content: [{ type: "tool_use", id: "tu-bg", name: "Bash", input: { command: "npm test", run_in_background: true } }] } });
  proc.emitLine({ type: "system", subtype: "task_started", task_id: "bash-1", tool_use_id: "tu-bg", task_type: "local_bash", is_backgrounded: true, description: "npm test" });
  proc.emitLine({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu-bg", content: "Command running in background with ID: bash-1" }] } });
  proc.emitLine({ type: "assistant", message: { content: [{ type: "text", text: "Started the suite; I'll report back." }] } });
  proc.emitLine({ type: "result", subtype: "success", is_error: false, session_id: "sess-bg", result: "Started." });
  await tick();

  assert.equal(proc.stdin.writableEnded, false, "stdin must stay open while background work is outstanding");
  assert.equal(settled, false, "the turn must not end at a result while background work is outstanding");

  // The background shell finishes; the CLI starts a follow-up turn whose tool needs permission.
  proc.emitLine({ type: "system", subtype: "task_notification", task_id: "bash-1", tool_use_id: "tu-bg", status: "completed", summary: "tests passed" });
  proc.emitLine({ type: "system", subtype: "init", session_id: "sess-bg" });
  proc.emitLine({ type: "assistant", message: { content: [{ type: "tool_use", id: "tu-w", name: "Write", input: { file_path: "/repo/report.md", content: "ok" } }] } });
  proc.emitLine({ type: "control_request", request_id: "r-bg", request: { subtype: "can_use_tool", tool_name: "Write", input: { file_path: "/repo/report.md", content: "ok" } } });
  const resp = JSON.parse(await proc.waitFor((l) => l.includes("control_response"))) as { response: { request_id: string; response: { behavior: string } } };
  assert.equal(resp.response.request_id, "r-bg");
  assert.equal(resp.response.response.behavior, "allow");
  assert.ok(events.some((e) => e.startsWith("approval:Allow Write")), "the follow-up permission prompt reaches the user");
  assert.equal(settled, false);

  proc.emitLine({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu-w", content: "File created" }] } });
  proc.emitLine({ type: "result", subtype: "success", is_error: false, session_id: "sess-bg", result: "Report written." });
  const r = await run;
  assert.equal(r.status, "completed");
  assert.equal(proc.stdin.writableEnded, true, "stdin closes once the final result arrives with no background work left");
  proc.close(0);
});

// The order and fields `claude` 2.1.289 emitted (stream-json, --verbose, --include-partial-messages) for a
// `run_in_background` Bash call, captured live and redacted: ids shortened, stream_event/rate_limit lines,
// paths, usage and session ids dropped.
const CAPTURED: unknown[] = [
  { type: "system", subtype: "init", session_id: "s", claude_code_version: "2.1.289", permissionMode: "default" },
  { type: "system", subtype: "status", status: "requesting" },
  { type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "sleep 3 && echo done", description: "Sleep 3 seconds then print done", run_in_background: true } }] } },
  { type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "b0l6", task_type: "local_bash", description: "Sleep 3 seconds then print done" }] },
  { type: "system", subtype: "task_started", task_id: "b0l6", tool_use_id: "toolu_1", description: "Sleep 3 seconds then print done", is_backgrounded: true, task_type: "local_bash" },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "Command running in background with ID: b0l6. Output is being written to: /tmp/…" }] } },
  { type: "system", subtype: "status", status: "requesting" },
  { type: "assistant", message: { content: [{ type: "text", text: "The command is running in the background as task `b0l6`. I'll tell you when it finishes." }] } },
  { type: "result", subtype: "success", is_error: false, session_id: "s", result: "The command is running in the background…", num_turns: 2, result_index: 0, terminal_reason: "completed" },
  // --- the held result; everything below arrived on its own about 3 s later ---
  { type: "system", subtype: "background_tasks_changed", tasks: [] },
  { type: "system", subtype: "task_updated", task_id: "b0l6", patch: { status: "completed", end_time: 1 } },
  { type: "system", subtype: "task_notification", task_id: "b0l6", tool_use_id: "toolu_1", status: "completed", output_file: "/tmp/…/b0l6.output", summary: "Background command \"Sleep 3 seconds then print done\" completed (exit code 0)" },
  { type: "system", subtype: "init", session_id: "s", claude_code_version: "2.1.289", permissionMode: "default" },
  { type: "system", subtype: "status", status: "requesting" },
  { type: "assistant", message: { content: [{ type: "text", text: "The background command has finished." }] } },
  { type: "result", subtype: "success", is_error: false, session_id: "s", result: "The background command has finished.", num_turns: 1, result_index: 1, origin: { kind: "task-notification", producer: "session-task" } },
];

test("ClaudeBackend: a captured background Bash stream ends the turn only at the follow-up turn's result", async () => {
  // A short idle window: the follow-up turn's `init` must keep the turn open past it.
  const t = await start({ backgroundIdleMs: 20 });
  const firstResult = CAPTURED.findIndex((m) => (m as { type: string }).type === "result");
  for (const m of CAPTURED.slice(0, firstResult + 1)) t.proc.emitLine(m);
  await tick();
  assert.equal(t.settled(), undefined, "held at the first result");
  assert.equal(t.proc.stdin.writableEnded, false);
  assert.ok(t.events.some((e) => e.startsWith("notice:info:Claude is still running a background task")));
  for (const m of CAPTURED.slice(firstResult + 1, -1)) t.proc.emitLine(m);
  await tick(60);
  assert.equal(t.settled(), undefined, "the follow-up turn is under way; its result has not arrived");
  t.proc.emitLine(CAPTURED.at(-1));
  const r = await t.run;
  assert.equal(r.status, "completed");
  assert.equal(t.proc.stdin.writableEnded, true);
  assert.ok(t.events.includes("assistant:The background command has finished."));
  t.proc.close(0);
});

test("ClaudeBackend: an Agent runs in the background by default and holds the turn until it ends", async () => {
  const t = await start({ backgroundIdleMs: 20 });
  t.proc.emitLine({ type: "assistant", message: { content: [{ type: "tool_use", id: "ag", name: "Agent", input: { description: "Review", prompt: "review" } }] } });
  t.proc.emitLine({ type: "system", subtype: "task_started", task_id: "task-ag", tool_use_id: "ag", task_type: "local_agent", description: "Review" });
  t.proc.emitLine({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "ag", content: "Agent launched" }] } });
  t.proc.emitLine(ok);
  await tick(60);
  assert.equal(t.settled(), undefined, "a default-background Agent keeps the turn open");
  assert.equal(t.proc.stdin.writableEnded, false);
  // Keyed by task id only, as the CLI sends it once running.
  t.proc.emitLine({ type: "system", subtype: "task_updated", task_id: "task-ag", patch: { status: "completed" } });
  const r = await t.run;
  assert.equal(r.status, "completed", "with the work drained and the CLI quiet, the held reply stands");
  assert.equal(t.proc.stdin.writableEnded, true);
  t.proc.close(0);
});

test("ClaudeBackend: an Agent started in the foreground does not hold the turn", async () => {
  const t = await start({ backgroundIdleMs: 20 });
  t.proc.emitLine({ type: "assistant", message: { content: [{ type: "tool_use", id: "ag", name: "Agent", input: { description: "Review" } }] } });
  t.proc.emitLine({ type: "system", subtype: "task_started", task_id: "task-ag", tool_use_id: "ag", task_type: "local_agent", is_backgrounded: false });
  t.proc.emitLine({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "ag", content: "Done reviewing" }] } });
  t.proc.emitLine(ok);
  assert.equal((await t.run).status, "completed");
  t.proc.close(0);
});

test("ClaudeBackend: run_in_background on the tool call alone holds the turn", async () => {
  const t = await start({ backgroundIdleMs: 20 });
  t.proc.emitLine(bashInBackground("tu-bg"));
  t.proc.emitLine({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu-bg", content: "Command running in background with ID: x" }] } });
  t.proc.emitLine(ok);
  await tick(60);
  assert.equal(t.settled(), undefined, "no task message was sent, yet the tool call asked for the background");
  assert.equal(t.proc.stdin.writableEnded, false);
  // The end is reported against the tool call, by a task the turn never saw start.
  t.proc.emitLine({ type: "system", subtype: "task_notification", task_id: "x", tool_use_id: "tu-bg", status: "completed" });
  assert.equal((await t.run).status, "completed");
  t.proc.close(0);
});

test("ClaudeBackend: a background launch that fails does not hold the turn", async () => {
  const t = await start();
  t.proc.emitLine(bashInBackground("tu-bg"));
  t.proc.emitLine({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu-bg", content: "The user denied this action", is_error: true }] } });
  t.proc.emitLine(ok);
  assert.equal((await t.run).status, "completed");
  assert.equal(t.proc.stdin.writableEnded, true);
  t.proc.close(0);
});

test("ClaudeBackend: the wait for background work is capped and says why the turn ended", async () => {
  const t = await start({ backgroundIdleMs: 20, backgroundCapMs: 120 });
  t.proc.emitLine(bashInBackground("tu-bg"));
  t.proc.emitLine({ type: "system", subtype: "task_started", task_id: "bash-1", tool_use_id: "tu-bg", task_type: "local_bash", is_backgrounded: true });
  t.proc.emitLine(ok);
  await tick(60);
  assert.equal(t.settled(), undefined);
  // The task never reports an end.
  const r = await t.run;
  assert.equal(r.status, "completed", "the held reply stands");
  assert.equal(t.proc.stdin.writableEnded, true);
  assert.equal(t.proc.killed, true, "the CLI is stopped rather than left running");
  assert.ok(t.events.some((e) => /^notice:warn:Claude still reported a background task running .* after its reply\. Modex ended the turn and stopped Claude\.$/.test(e)), t.events.join("\n"));
});

test("ClaudeBackend: a follow-up turn that never replies is ended by the cap", async () => {
  const t = await start({ backgroundIdleMs: 20, backgroundCapMs: 150 });
  t.proc.emitLine(bashInBackground("tu-bg"));
  t.proc.emitLine(ok);
  t.proc.emitLine({ type: "system", subtype: "task_notification", task_id: "x", tool_use_id: "tu-bg", status: "completed" });
  t.proc.emitLine({ type: "system", subtype: "init", session_id: "s" });
  await tick(80);
  assert.equal(t.settled(), undefined, "a follow-up turn is waited for beyond the idle window");
  assert.equal((await t.run).status, "completed");
  assert.ok(t.events.some((e) => e.startsWith("notice:warn:Claude had not finished the turn its background work started")), t.events.join("\n"));
});

test("ClaudeBackend: system/status after the held result cannot strand the turn", async () => {
  const t = await start({ backgroundIdleMs: 30 });
  t.proc.emitLine(bashInBackground("tu-bg"));
  t.proc.emitLine({ type: "system", subtype: "task_started", task_id: "bash-1", tool_use_id: "tu-bg", task_type: "local_bash", is_backgrounded: true });
  t.proc.emitLine(ok);
  t.proc.emitLine({ type: "system", subtype: "status", status: "requesting" });
  t.proc.emitLine({ type: "system", subtype: "task_notification", task_id: "bash-1", status: "completed" });
  t.proc.emitLine({ type: "system", subtype: "status", status: "requesting" });
  // No init and no result follow: the idle window, re-armed by each message, still ends the turn.
  const r = await t.run;
  assert.equal(r.status, "completed");
  assert.equal(t.proc.stdin.writableEnded, true);
  t.proc.close(0);
});

test("ClaudeBackend: a permission prompt waiting on the user is never cut off by the idle window", async () => {
  const proc = new FakeProcess();
  const backend = new ClaudeBackend("claude", fakeSpawn(proc).spawn, { backgroundIdleMs: 20 });
  const { sink, events } = collectSink();
  let answer: (a: "yes") => void = () => {};
  const slow = { ...sink, approval: (req: Parameters<typeof sink.approval>[0]) => { events.push(`approval:${req.question}`); return new Promise<"yes">((r) => (answer = r)); } };
  let settled = false;
  const run = backend.runTurn("go", options, slow, new AbortController().signal);
  void run.then(() => (settled = true));
  await proc.waitFor((l) => l.includes('"type":"user"'));
  proc.emitLine(bashInBackground("tu-bg"));
  proc.emitLine(ok);
  proc.emitLine({ type: "system", subtype: "task_notification", task_id: "x", tool_use_id: "tu-bg", status: "completed" });
  // No `init` this time: only the open prompt keeps the turn alive.
  proc.emitLine({ type: "control_request", request_id: "r1", request: { subtype: "can_use_tool", tool_name: "Write", input: { file_path: "/repo/a" } } });
  await tick(100);
  assert.equal(settled, false, "the user is still deciding");
  assert.equal(proc.stdin.writableEnded, false);
  answer("yes");
  await proc.waitFor((l) => l.includes('"request_id":"r1"'));
  proc.emitLine({ type: "result", subtype: "success", is_error: false, result: "Written." });
  assert.equal((await run).status, "completed");
  proc.close(0);
});

test("ClaudeBackend: an error result ends the turn at once even with background work outstanding", async () => {
  const t = await start();
  t.proc.emitLine(bashInBackground("tu-bg"));
  t.proc.emitLine({ type: "system", subtype: "task_started", task_id: "bash-1", tool_use_id: "tu-bg", task_type: "local_bash", is_backgrounded: true });
  t.proc.emitLine({ type: "result", subtype: "error_during_execution", is_error: true, result: "boom" });
  const r = await t.run;
  assert.equal(r.status, "failed");
  assert.equal(r.status === "failed" && r.error, "boom");
  assert.equal(t.proc.stdin.writableEnded, true);
  assert.ok(t.events.some((e) => e.startsWith("notice:warn:Claude reported an error while a background task was still running")));
  t.proc.close(1);
});

test("ClaudeBackend: Stop during the background wait kills Claude and reports interrupted", async () => {
  // Default (long) timers: if Stop left one armed, this test file would not exit.
  const t = await start();
  t.proc.emitLine(bashInBackground("tu-bg"));
  t.proc.emitLine({ type: "system", subtype: "task_started", task_id: "bash-1", tool_use_id: "tu-bg", task_type: "local_bash", is_backgrounded: true });
  t.proc.emitLine(ok);
  await tick();
  assert.equal(t.settled(), undefined);
  t.abort.abort();
  const r = await t.run;
  assert.equal(r.status, "interrupted");
  assert.equal(t.proc.killed, true);
});
