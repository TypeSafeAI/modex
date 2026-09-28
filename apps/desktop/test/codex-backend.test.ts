import { test } from "node:test";
import assert from "node:assert/strict";
import { CodexBackend } from "../src/main/engine/backends/codex.js";
import { FakeProcess, fakeSpawn, collectSink } from "./fakeproc.js";

/** Minimal scripted app-server: answers initialize, thread/start|resume, turn/start, model/list. */
function fakeServer(proc: FakeProcess, opts: { threadId?: string; turnId?: string } = {}) {
  const threadId = opts.threadId ?? "thr-1";
  const turnId = opts.turnId ?? "turn-1";
  const seen: { method: string; params: Record<string, unknown> }[] = [];
  proc.stdin.on("data", (d: Buffer) => {
    for (const line of d.toString().split("\n")) {
      if (!line.trim()) continue;
      const msg = JSON.parse(line) as { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown };
      if (msg.method) seen.push({ method: msg.method, params: msg.params ?? {} });
      if (msg.method === "initialize") proc.emitLine({ id: msg.id, result: { userAgent: "fake" } });
      else if (msg.method === "model/list") proc.emitLine({ id: msg.id, result: { data: [{ id: "gpt-6-astra", displayName: "GPT-6-Astra", hidden: false, isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }], defaultReasoningEffort: "medium" }, { id: "secret", displayName: "hidden", hidden: true, isDefault: false }], nextCursor: null } });
      else if (msg.method === "thread/start" || msg.method === "thread/resume") proc.emitLine({ id: msg.id, result: { thread: { id: threadId } } });
      else if (msg.method === "turn/start") {
        proc.emitLine({ id: msg.id, result: { turn: { id: turnId } } });
        proc.emitLine({ method: "turn/started", params: { threadId, turn: { id: turnId } } });
      } else if (msg.method === "turn/interrupt") {
        proc.emitLine({ id: msg.id, result: {} });
        proc.emitLine({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "interrupted", error: null } } });
      }
    }
  });
  return { seen, threadId, turnId };
}

test("CodexBackend.policy maps modes to approval + sandbox policies", () => {
  const base = { cwd: "/w", model: "", plan: false } as const;
  assert.deepEqual(CodexBackend.policy({ ...base, mode: "chat" }).approvalPolicy, "untrusted");
  assert.deepEqual(CodexBackend.policy({ ...base, mode: "chat" }).sandboxPolicy, { type: "readOnly", networkAccess: false });
  assert.equal(CodexBackend.policy({ ...base, mode: "agent" }).sandboxPolicy.type, "workspaceWrite");
  assert.equal(CodexBackend.policy({ ...base, mode: "full-access" }).approvalPolicy, "never");
  assert.equal(CodexBackend.policy({ ...base, mode: "full-access", plan: true }).sandboxPolicy.type, "readOnly", "plan forces read-only");
});

test("CodexBackend: lists visible models with efforts", async () => {
  const proc = new FakeProcess();
  fakeServer(proc);
  const backend = new CodexBackend("codex", fakeSpawn(proc).spawn);
  const models = await backend.listModels();
  assert.deepEqual(models.map((m) => m.id), ["gpt-6-astra"]);
  assert.deepEqual(models[0]!.efforts, ["low", "high"]);
  assert.equal(models[0]!.defaultEffort, "medium");
  await backend.dispose();
});

test("CodexBackend: a turn streams deltas, command + file-change items, approvals, and completes", async () => {
  const proc = new FakeProcess();
  const { seen, threadId, turnId } = fakeServer(proc);
  const backend = new CodexBackend("codex", fakeSpawn(proc).spawn);
  const { sink, events } = collectSink(["yes", "always"]);
  const run = backend.runTurn("add a note", { cwd: "/repo", mode: "chat", plan: false, model: "gpt-6-astra", effort: "high" }, sink, new AbortController().signal);
  await proc.waitFor((l) => l.includes('"turn/start"'));
  const turnStart = seen.find((s) => s.method === "turn/start")!;
  assert.equal(turnStart.params.threadId, threadId);
  assert.equal(turnStart.params.approvalPolicy, "untrusted");
  assert.equal(turnStart.params.effort, "high");
  assert.deepEqual((turnStart.params.input as { text: string }[])[0]!.text, "add a note");
  assert.equal(seen.find((s) => s.method === "thread/start")!.params.cwd, "/repo");
  assert.deepEqual(seen.find((s) => s.method === "thread/start")!.params.config, { model_reasoning_summary: "detailed" });

  const n = (method: string, params: Record<string, unknown>) => proc.emitLine({ method, params: { threadId, turnId, ...params } });
  n("item/started", { item: { type: "reasoning", id: "r1", summary: [], content: [] } });
  n("item/reasoning/summaryTextDelta", { itemId: "r1", delta: "Need to ", summaryIndex: 0 });
  n("item/reasoning/summaryTextDelta", { itemId: "r1", delta: "look first.", summaryIndex: 0 });
  n("item/reasoning/summaryPartAdded", { itemId: "r1", summaryIndex: 1 });
  n("item/reasoning/summaryTextDelta", { itemId: "r1", delta: "Then edit.", summaryIndex: 1 });
  n("item/completed", { item: { type: "reasoning", id: "r1", summary: ["Need to look first.", "Then edit."], content: [] } });
  n("item/started", { item: { type: "agentMessage", id: "m1", text: "" } });
  n("item/agentMessage/delta", { itemId: "m1", delta: "Look" });
  n("item/agentMessage/delta", { itemId: "m1", delta: "ing." });
  n("item/completed", { item: { type: "agentMessage", id: "m1", text: "Looking." } });
  n("item/started", { item: { type: "commandExecution", id: "c1", command: "/bin/zsh -lc 'ls -la'", cwd: "/repo", status: "inProgress" } });
  proc.emitLine({ id: 0, method: "item/commandExecution/requestApproval", params: { threadId, turnId, itemId: "c1", command: "/bin/zsh -lc 'ls -la'", cwd: "/repo" } });
  const a1 = JSON.parse(await proc.waitFor((l) => l.startsWith('{"id":0,"result"'))) as { result: { decision: string } };
  assert.equal(a1.result?.decision, "accept", JSON.stringify(a1));
  n("item/commandExecution/outputDelta", { itemId: "c1", delta: "README.md\n" });
  n("item/completed", { item: { type: "commandExecution", id: "c1", command: "/bin/zsh -lc 'ls -la'", status: "completed", aggregatedOutput: "README.md\n", exitCode: 0, durationMs: 12 } });
  n("item/started", { item: { type: "fileChange", id: "f1", changes: [{ path: "NOTE.md", kind: { type: "add" }, diff: "+hello" }], status: "inProgress" } });
  proc.emitLine({ id: 1, method: "item/fileChange/requestApproval", params: { threadId, turnId, itemId: "f1", reason: "outside sandbox" } });
  const a2 = JSON.parse(await proc.waitFor((l) => l.startsWith('{"id":1,"result"'))) as { result: { decision: string } };
  assert.equal(a2.result?.decision, "acceptForSession", JSON.stringify(a2));
  n("item/completed", { item: { type: "fileChange", id: "f1", changes: [{ path: "NOTE.md", kind: { type: "add" }, diff: "+hello" }], status: "completed" } });
  n("item/started", { item: { type: "agentMessage", id: "m2", text: "" } });
  n("item/completed", { item: { type: "agentMessage", id: "m2", text: "Added NOTE.md." } });
  proc.emitLine({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", error: null } } });
  const r = await run;
  assert.equal(r.status, "completed");
  assert.deepEqual(events, [
    `session:${threadId}`,
    "think:r1:",
    "think:r1:Need to ",
    "think:r1:look first.",
    "think:r1:\n\n",
    "think:r1:Then edit.",
    "think_done:r1:Need to look first.\n\nThen edit.",
    "delta:Look",
    "delta:ing.",
    "assistant:Looking.",
    "tool_start:c1:$ ls -la",
    "approval:Allow command: ls -la?",
    "tool_update:c1:::README.md\n",
    "tool_update:c1:done:true:README.md\n",
    "tool_start:f1:edit NOTE.md",
    "approval:Allow Codex to apply these file changes?",
    "tool_update:f1:done:true:add NOTE.md\n+hello",
    "assistant:Added NOTE.md.",
  ]);

  // Second turn on the same thread reuses the loaded thread (no thread/resume), and events for other threads are ignored.
  const { sink: sink2, events: events2 } = collectSink();
  const run2 = backend.runTurn("again", { cwd: "/repo", mode: "agent", plan: false, model: "", resume: threadId }, sink2, new AbortController().signal);
  await proc.waitFor((l) => l.includes('"turn/start"') && l.includes("again"));
  assert.equal(seen.filter((s) => s.method === "thread/resume").length, 0);
  proc.emitLine({ method: "item/agentMessage/delta", params: { threadId: "other", turnId, itemId: "x", delta: "IGNORED" } });
  proc.emitLine({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "failed", error: { message: "quota" } } } });
  const r2 = await run2;
  assert.equal(r2.status, "failed");
  assert.equal(r2.error, "quota");
  assert.ok(!events2.some((e) => e.includes("IGNORED")));
  await backend.dispose();
});

test("CodexBackend: resume on a fresh server calls thread/resume; abort interrupts", async () => {
  const proc = new FakeProcess();
  const { seen } = fakeServer(proc, { threadId: "thr-9" });
  const backend = new CodexBackend("codex", fakeSpawn(proc).spawn);
  const ac = new AbortController();
  const run = backend.runTurn("go", { cwd: "/repo", mode: "agent", plan: false, model: "", resume: "thr-9" }, collectSink().sink, ac.signal);
  await proc.waitFor((l) => l.includes('"turn/start"'));
  assert.equal(seen.find((s) => s.method === "thread/resume")!.params.threadId, "thr-9");
  ac.abort();
  const r = await run;
  assert.equal(r.status, "interrupted");
  assert.ok(seen.some((s) => s.method === "turn/interrupt"));
  await backend.dispose();
});

test("CodexBackend: service tiers come through model/list; a fast turn sets serviceTierForTurn", async () => {
  const proc = new FakeProcess();
  const seen: { method: string; params: Record<string, unknown> }[] = [];
  proc.stdin.on("data", (d: Buffer) => {
    for (const line of d.toString().split("\n")) {
      if (!line.trim()) continue;
      const msg = JSON.parse(line) as { id?: number; method?: string; params?: Record<string, unknown> };
      if (msg.method) seen.push({ method: msg.method, params: msg.params ?? {} });
      if (msg.method === "initialize") proc.emitLine({ id: msg.id, result: {} });
      else if (msg.method === "model/list") proc.emitLine({ id: msg.id, result: { data: [{ id: "gpt-5.5", displayName: "GPT-5.5", hidden: false, isDefault: false, supportedReasoningEfforts: [{ reasoningEffort: "low" }], defaultReasoningEffort: "low", serviceTiers: [{ id: "default", name: "Standard" }, { id: "fast", name: "Fast" }], defaultServiceTier: "default" }] } });
      else if (msg.method === "thread/start") proc.emitLine({ id: msg.id, result: { thread: { id: "thr-f" } } });
      else if (msg.method === "turn/start") { proc.emitLine({ id: msg.id, result: { turn: { id: "turn-f" } } }); proc.emitLine({ method: "turn/completed", params: { threadId: "thr-f", turn: { id: "turn-f", status: "completed", error: null } } }); }
    }
  });
  const backend = new CodexBackend("codex", fakeSpawn(proc).spawn);
  const models = await backend.listModels();
  assert.deepEqual(models[0]!.serviceTiers, ["default", "fast"]);
  assert.equal(models[0]!.defaultServiceTier, "default");
  const r = await backend.runTurn("go", { cwd: "/repo", mode: "agent", plan: false, model: "gpt-5.5", effort: "low", fast: true }, collectSink().sink, new AbortController().signal);
  assert.equal(r.status, "completed");
  const turn = seen.find((s) => s.method === "turn/start")!;
  assert.equal(turn.params.serviceTierForTurn, "fast");
  assert.equal(turn.params.effort, "low");
  const r2 = await backend.runTurn("again", { cwd: "/repo", mode: "agent", plan: false, model: "gpt-5.5", resume: "thr-f" }, collectSink().sink, new AbortController().signal);
  assert.equal(r2.status, "completed");
  assert.equal(seen.filter((s) => s.method === "turn/start")[1]!.params.serviceTierForTurn, null, "a normal turn inherits the thread's tier");
  await backend.dispose();
});

test("a server crash settles an active turn and a new server can recover", async () => {
  const proc = new FakeProcess();
  fakeServer(proc);
  const replacement = new FakeProcess();
  const recovered = fakeServer(replacement);
  let spawns = 0;
  const spawn = (() => spawns++ === 0 ? proc : replacement) as unknown as typeof import("node:child_process").spawn;
  const backend = new CodexBackend("codex", spawn);
  const { sink } = collectSink();
  const opts = { cwd: "/repo", mode: "chat" as const, plan: false, model: "" };
  const run = backend.runTurn("go", opts, sink, new AbortController().signal);
  await proc.waitFor((l) => l.includes('"turn/start"'));
  proc.close(7);
  const result = await Promise.race([run, new Promise<null>((resolve) => setTimeout(() => resolve(null), 100))]);
  assert.equal(result?.status, "failed");
  assert.match(result?.error ?? "", /exited \(7\)/);
  const next = backend.runTurn("try again", { ...opts, resume: recovered.threadId }, sink, new AbortController().signal);
  await replacement.waitFor((line) => line.includes('"turn/start"'));
  assert.equal(spawns, 2);
  assert.ok(recovered.seen.some((request) => request.method === "thread/resume"));
  replacement.emitLine({ method: "turn/completed", params: { threadId: recovered.threadId, turn: { id: recovered.turnId, status: "completed" } } });
  assert.deepEqual(await next, { status: "completed" });
  await backend.dispose();
});

test("cancellation during setup never starts a coding turn", async () => {
  const proc = new FakeProcess();
  const backend = new CodexBackend("codex", fakeSpawn(proc).spawn);
  const abort = new AbortController();
  const run = backend.runTurn("go", { cwd: "/repo", mode: "chat", plan: false, model: "" }, collectSink().sink, abort.signal);
  const init = JSON.parse(await proc.waitFor((l) => l.includes('"initialize"')));
  abort.abort();
  fakeServer(proc);
  proc.emitLine({ id: init.id, result: {} });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(proc.written.some((l) => l.includes('"turn/start"')), false);
  assert.deepEqual(await run, { status: "interrupted" });
});

test("a previous turn's completion cannot finish the next turn", async () => {
  const proc = new FakeProcess();
  const { threadId, turnId } = fakeServer(proc, { turnId: "current" });
  const backend = new CodexBackend("codex", fakeSpawn(proc).spawn);
  const { sink, events } = collectSink();
  const run = backend.runTurn("go", { cwd: "/repo", mode: "chat", plan: false, model: "" }, sink, new AbortController().signal);
  await proc.waitFor((l) => l.includes('"turn/start"'));
  proc.emitLine({ method: "item/agentMessage/delta", params: { threadId, turnId: "previous", itemId: "old", delta: "stale" } });
  proc.emitLine({ method: "turn/completed", params: { threadId, turn: { id: "previous", status: "interrupted" } } });
  proc.emitLine({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } });
  assert.deepEqual(await run, { status: "completed" });
  assert.equal(events.some((e) => e.includes("stale")), false);
});

test("Stop interrupts a known started turn before turn/start replies and waits for acknowledgement", async () => {
  const proc = new FakeProcess();
  let startId: number | undefined;
  proc.stdin.on("data", (chunk: Buffer) => {
    const message = JSON.parse(chunk.toString());
    if (message.method === "initialize") proc.emitLine({ id: message.id, result: {} });
    if (message.method === "thread/start") proc.emitLine({ id: message.id, result: { thread: { id: "thread" } } });
    if (message.method === "turn/start") {
      startId = message.id;
      proc.emitLine({ method: "turn/started", params: { threadId: "thread", turn: { id: "turn" } } });
    }
    if (message.method === "turn/interrupt") proc.emitLine({ id: message.id, result: {} });
  });
  const backend = new CodexBackend("codex", fakeSpawn(proc).spawn);
  const abort = new AbortController();
  const run = backend.runTurn("go", { cwd: "/repo", mode: "chat", plan: false, model: "" }, collectSink().sink, abort.signal);
  let settled = false;
  void run.then(() => { settled = true; });
  await proc.waitFor((line) => line.includes('"turn/start"'));
  abort.abort();
  const interrupt = JSON.parse(await proc.waitFor((line) => line.includes('"turn/interrupt"'), 200));
  assert.equal(interrupt.params.turnId, "turn");
  await new Promise((resolve) => setTimeout(resolve, 1550));
  assert.equal(settled, false, "an interrupt request is not proof that execution stopped");
  proc.emitLine({ id: startId, result: { turn: { id: "turn" } } });
  proc.emitLine({ method: "turn/completed", params: { threadId: "thread", turn: { id: "turn", status: "interrupted" } } });
  assert.deepEqual(await run, { status: "interrupted" });
  assert.equal(proc.written.filter((line) => line.includes('"turn/interrupt"')).length, 1);
});

test("force-stop ends an unacknowledged turn, fails other turns, and a fresh server takes the next one", async () => {
  const proc = new FakeProcess();
  const turns = new Map<string, number>();
  let thread = 0;
  proc.stdin.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n")) {
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (message.method === "initialize") proc.emitLine({ id: message.id, result: {} });
      if (message.method === "thread/start") proc.emitLine({ id: message.id, result: { thread: { id: `thread-${++thread}` } } });
      if (message.method === "turn/start") {
        const id = `turn-${message.params.threadId}`;
        turns.set(id, message.id);
        proc.emitLine({ id: message.id, result: { turn: { id } } });
      }
      // Acknowledges the interrupt request but never completes the turn.
      if (message.method === "turn/interrupt") proc.emitLine({ id: message.id, result: {} });
    }
  });
  const replacement = new FakeProcess();
  const recovered = fakeServer(replacement);
  let spawns = 0;
  const spawn = (() => spawns++ === 0 ? proc : replacement) as unknown as typeof import("node:child_process").spawn;
  const backend = new CodexBackend("codex", spawn);
  const opts = { cwd: "/repo", mode: "chat" as const, plan: false, model: "" };
  const stopped = new AbortController();
  const stuck = backend.runTurn("stuck", opts, collectSink().sink, stopped.signal);
  await proc.waitFor((line) => line.includes('"turn/start"'));
  const other = backend.runTurn("bystander", opts, collectSink().sink, new AbortController().signal);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(turns.size, 2);
  stopped.abort();
  await proc.waitFor((line) => line.includes('"turn/interrupt"'));
  await backend.forceStop();
  assert.equal(proc.killed, true);
  assert.deepEqual(await stuck, { status: "interrupted" });
  const bystander = await other;
  assert.equal(bystander.status, "failed");
  assert.match(bystander.error ?? "", /force-stopped/);
  const next = backend.runTurn("again", opts, collectSink().sink, new AbortController().signal);
  await replacement.waitFor((line) => line.includes('"turn/start"'));
  assert.equal(spawns, 2);
  replacement.emitLine({ method: "turn/completed", params: { threadId: recovered.threadId, turn: { id: recovered.turnId, status: "completed" } } });
  assert.deepEqual(await next, { status: "completed" });
  await backend.forceStop();
  await backend.dispose();
});

test("force-stop with no server running is a no-op", async () => {
  const backend = new CodexBackend("codex", fakeSpawn(new FakeProcess()).spawn);
  await backend.forceStop();
});
