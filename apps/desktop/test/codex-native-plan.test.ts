import { test } from "node:test";
import assert from "node:assert/strict";
import { CodexBackend } from "../src/main/engine/backends/codex.js";
import { FakeProcess, fakeSpawn, collectSink } from "./fakeproc.js";

/**
 * Plan mode on Codex runs in Codex's native plan collaboration mode (codex-cli 0.163.0, experimental):
 * Codex's own planning instructions, its question tool offered by default, and the plan returned as a
 * `plan` item that Modex shows as the turn's answer. Shapes follow the 2026-10-22 live capture in
 * docs/reviews/2026-10-22-cf3-plan-mode-decision.md.
 */

/** The plan item text Codex sent in the live capture. */
const CAPTURED_PLAN = "### Add a new-user greeting\n\nCreate `greeting.txt` in the workspace root with the selected English greeting:\n\n```text\nWelcome! We're glad you're here.\n```\n\n- End the file with a newline.\n- Verify the filename and exact content; no automated tests are needed.\n";

/** A scripted app-server that reports the thread's model, as 0.163.0 does, and can refuse `collaborationMode`. */
function server(proc: FakeProcess, opts: { model?: string; refuseCollaboration?: boolean } = {}) {
  const seen: { method: string; params: Record<string, unknown> }[] = [];
  proc.stdin.on("data", (d: Buffer) => {
    for (const line of d.toString().split("\n")) {
      if (!line.trim()) continue;
      const msg = JSON.parse(line) as { id?: number; method?: string; params?: Record<string, unknown> };
      if (msg.method) seen.push({ method: msg.method, params: msg.params ?? {} });
      if (msg.method === "initialize") proc.emitLine({ id: msg.id, result: { userAgent: "fake" } });
      else if (msg.method === "thread/start" || msg.method === "thread/resume") proc.emitLine({ id: msg.id, result: { thread: { id: "thr" }, model: opts.model ?? "gpt-6-astra" } });
      else if (msg.method === "turn/start") {
        if (opts.refuseCollaboration && msg.params?.collaborationMode) {
          proc.emitLine({ id: msg.id, error: { code: -32602, message: "Invalid request: unknown field `collaborationMode`" } });
          continue;
        }
        proc.emitLine({ id: msg.id, result: { turn: { id: "tu" } } });
        proc.emitLine({ method: "turn/started", params: { threadId: "thr", turn: { id: "tu" } } });
      }
    }
  });
  return seen;
}

const turnStarts = (seen: { method: string; params: Record<string, unknown> }[]) => seen.filter((s) => s.method === "turn/start").map((s) => s.params);
const text = (params: Record<string, unknown>) => (params.input as { text?: string }[])[0]!.text!;
const complete = (proc: FakeProcess) => proc.emitLine({ method: "turn/completed", params: { threadId: "thr", turn: { id: "tu", status: "completed", error: null } } });

test("a Plan turn on Codex starts in native plan mode with the thread's model, no prompt prefix, and stays read-only", async () => {
  const proc = new FakeProcess();
  const seen = server(proc);
  const backend = new CodexBackend("codex", fakeSpawn(proc).spawn);
  try {
    const run = backend.runTurn("Add a greeting.txt", { cwd: "/repo", mode: "agent", plan: true, model: "" }, collectSink().sink, new AbortController().signal);
    await proc.waitFor((l) => l.includes('"turn/start"'));
    const [start] = turnStarts(seen);
    assert.deepEqual(start!.collaborationMode, { mode: "plan", settings: { model: "gpt-6-astra", reasoning_effort: null, developer_instructions: null } },
      "the model Codex chose for the thread, Codex's own effort default and Codex's own plan instructions");
    assert.equal(text(start!), "Add a greeting.txt", "no PLAN MODE prefix: Codex's plan instructions replace it");
    assert.equal((start!.sandboxPolicy as { type: string }).type, "readOnly");
    assert.equal(start!.approvalPolicy, "untrusted");
    complete(proc);
    assert.equal((await run).status, "completed");
  } finally { await backend.dispose(); }
});

test("a Plan turn keeps the model and effort picked in Modex, since the collaboration mode overrides the turn's own", async () => {
  const proc = new FakeProcess();
  const seen = server(proc);
  const backend = new CodexBackend("codex", fakeSpawn(proc).spawn);
  try {
    const run = backend.runTurn("plan it", { cwd: "/repo", mode: "agent", plan: true, model: "gpt-5.5", effort: "high" }, collectSink().sink, new AbortController().signal);
    await proc.waitFor((l) => l.includes('"turn/start"'));
    const [start] = turnStarts(seen);
    assert.deepEqual(start!.collaborationMode, { mode: "plan", settings: { model: "gpt-5.5", reasoning_effort: "high", developer_instructions: null } });
    complete(proc);
    await run;
  } finally { await backend.dispose(); }
});

test("a resumed thread's Plan turn uses the model thread/resume reported", async () => {
  const proc = new FakeProcess();
  const seen = server(proc, { model: "gpt-6-sol" });
  const backend = new CodexBackend("codex", fakeSpawn(proc).spawn);
  try {
    const run = backend.runTurn("plan it", { cwd: "/repo", mode: "agent", plan: true, model: "", resume: "thr" }, collectSink().sink, new AbortController().signal);
    await proc.waitFor((l) => l.includes('"turn/start"'));
    assert.equal((turnStarts(seen)[0]!.collaborationMode as { settings: { model: string } }).settings.model, "gpt-6-sol");
    complete(proc);
    await run;
    // The thread stays loaded: the next Plan turn sends no thread/resume and still knows the model.
    const again = backend.runTurn("and again", { cwd: "/repo", mode: "agent", plan: true, model: "", resume: "thr" }, collectSink().sink, new AbortController().signal);
    await proc.waitFor(() => turnStarts(seen).length === 2);
    assert.equal(seen.filter((s) => s.method === "thread/resume").length, 1);
    assert.equal((turnStarts(seen)[1]!.collaborationMode as { settings: { model: string } }).settings.model, "gpt-6-sol");
    complete(proc);
    await again;
  } finally { await backend.dispose(); }
});

test("an ordinary turn sends no collaboration mode", async () => {
  const proc = new FakeProcess();
  const seen = server(proc);
  const backend = new CodexBackend("codex", fakeSpawn(proc).spawn);
  try {
    const run = backend.runTurn("go", { cwd: "/repo", mode: "agent", plan: false, model: "" }, collectSink().sink, new AbortController().signal);
    await proc.waitFor((l) => l.includes('"turn/start"'));
    assert.equal(turnStarts(seen)[0]!.collaborationMode, undefined);
    complete(proc);
    await run;
  } finally { await backend.dispose(); }
});

test("Codex's plan item is the turn's answer: streamed from its deltas, final text from item/completed", async () => {
  const proc = new FakeProcess();
  server(proc);
  const backend = new CodexBackend("codex", fakeSpawn(proc).spawn);
  const { sink, events, observations } = collectSink();
  try {
    const run = backend.runTurn("Add a greeting.txt", { cwd: "/repo", mode: "agent", plan: true, model: "" }, sink, new AbortController().signal);
    await proc.waitFor((l) => l.includes('"turn/start"'));
    proc.emitLine({ method: "item/started", params: { threadId: "thr", turnId: "tu", item: { type: "plan", id: "plan-1", text: "" } } });
    proc.emitLine({ method: "item/plan/delta", params: { threadId: "thr", turnId: "tu", itemId: "plan-1", delta: "### Add a new-user " } });
    proc.emitLine({ method: "item/plan/delta", params: { threadId: "thr", turnId: "tu", itemId: "plan-1", delta: "greeting" } });
    // The completed item is authoritative and may differ from the deltas joined.
    proc.emitLine({ method: "item/completed", params: { threadId: "thr", turnId: "tu", item: { type: "plan", id: "plan-1", text: CAPTURED_PLAN } } });
    complete(proc);
    assert.equal((await run).status, "completed");
    assert.deepEqual(events.filter((e) => e.startsWith("delta:") || e.startsWith("assistant:")), ["delta:### Add a new-user ", "delta:greeting", `assistant:${CAPTURED_PLAN}`]);
    const start = observations.find((o) => o.type === "message.start");
    const done = observations.find((o) => o.type === "message.done");
    assert.deepEqual([start?.type === "message.start" && start.phase, start?.type === "message.start" && start.nativePhase], ["final", "plan"]);
    assert.deepEqual([done?.type === "message.done" && done.phase, done?.type === "message.done" && done.nativePhase], ["final", "plan"], "the proposed plan is the turn's final answer, marked as Codex's plan");
  } finally { await backend.dispose(); }
});

test("a Codex that refuses the collaboration mode runs the Plan turn with the prompt prefix instead, and says so", async () => {
  const proc = new FakeProcess();
  const seen = server(proc, { refuseCollaboration: true });
  const backend = new CodexBackend("codex", fakeSpawn(proc).spawn);
  const { sink, events } = collectSink();
  try {
    const run = backend.runTurn("Add a greeting.txt", { cwd: "/repo", mode: "agent", plan: true, model: "" }, sink, new AbortController().signal);
    await proc.waitFor(() => turnStarts(seen).length === 2);
    const [native, fallback] = turnStarts(seen);
    assert.ok(native!.collaborationMode);
    assert.equal(fallback!.collaborationMode, undefined);
    assert.match(text(fallback!), /^PLAN MODE: /);
    assert.match(text(fallback!), /Add a greeting\.txt$/);
    assert.ok(events.some((e) => /^notice:info:.*plan mode/i.test(e)), "the person is told Codex's plan mode was unavailable");
    complete(proc);
    assert.equal((await run).status, "completed");
  } finally { await backend.dispose(); }
});
