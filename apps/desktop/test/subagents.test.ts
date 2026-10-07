import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaudeBackend } from "../src/main/engine/backends/claude.js";
import { CodexBackend } from "../src/main/engine/backends/codex.js";
import { FakeProcess, fakeSpawn, collectSink } from "./fakeproc.js";
import type { ToolStart, ToolUpdate } from "../src/main/engine/backends/types.js";

function recording() {
  const { sink, events } = collectSink();
  const tools = new Map<string, Partial<ToolStart & ToolUpdate>>();
  return { tools, events, sink: { ...sink,
    toolStart: (tool: ToolStart) => tools.set(tool.id, { ...tool, status: "running" }),
    toolUpdate: (id: string, patch: ToolUpdate) => tools.set(id, { ...tools.get(id), ...patch }),
  } };
}
const options = { cwd: "/repo", mode: "agent" as const, plan: false, model: "" };

test("Claude tracks concurrent background agents without treating the launch receipt as completion", async () => {
  const proc = new FakeProcess();
  const backend = new ClaudeBackend("claude", fakeSpawn(proc).spawn);
  const { sink, tools, events } = recording();
  const run = backend.runTurn("go", options, sink, new AbortController().signal);
  await proc.waitFor((line) => line.includes('"user"'));
  try {
    for (const id of ["a", "b"]) {
      proc.emitLine({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "Agent", input: { description: `Review ${id}` } }] } });
      proc.emitLine({ type: "system", subtype: "task_started", task_id: `task-${id}`, tool_use_id: id, task_type: "local_agent", description: `Review ${id}`, is_backgrounded: true });
      proc.emitLine({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: "Agent launched" }] } });
    }
    proc.emitLine({ type: "system", subtype: "task_started", task_id: "shell", task_type: "local_bash", description: "Watch logs" });
    proc.emitLine({ type: "system", subtype: "task_started", task_id: "ambient", task_type: "local_agent", description: "Internal", ambient: true });
    proc.emitLine({ type: "assistant", parent_tool_use_id: "a", message: { content: [{ type: "text", text: "child response" }, { type: "tool_use", id: "read", name: "Read", input: { file_path: "src/a.ts" } }] } });
    assert.equal(tools.size, 2);
    assert.equal(tools.get("agent:a")?.args?.description, "Review a");
    assert.equal(tools.get("agent:a")?.agent?.state, "running");
    assert.match(tools.get("agent:a")?.agent?.detail ?? "", /read src\/a.ts/);
    assert.equal(events.some((e) => e.includes("child response")), false, "child text must not complete the parent's streamed answer");
    proc.emitLine({ type: "system", subtype: "task_notification", task_id: "task-a", status: "completed", summary: "Looks good" });
    assert.equal(tools.get("agent:a")?.agent?.state, "completed");
    assert.equal(tools.get("agent:b")?.agent?.state, "running");
    proc.emitLine({ type: "system", subtype: "task_progress", task_id: "task-b", description: "Review b", summary: "Checking retry handling" });
    assert.equal(tools.get("agent:b")?.agent?.detail, "Checking retry handling");
    proc.emitLine({ type: "system", subtype: "task_updated", task_id: "task-b", patch: { status: "failed", error: "No capacity" } });
    assert.equal(tools.get("agent:b")?.agent?.state, "failed");
    assert.equal(tools.get("agent:b")?.ok, false);
  } finally { proc.emitLine({ type: "result", is_error: false }); await run; }
});

test("Claude foreground Task completes with its result; missing final agent state remains unknown", async () => {
  const proc = new FakeProcess();
  const backend = new ClaudeBackend("claude", fakeSpawn(proc).spawn);
  const { sink, tools } = recording();
  const run = backend.runTurn("go", options, sink, new AbortController().signal);
  await proc.waitFor((line) => line.includes('"user"'));
  for (const id of ["a", "b"]) proc.emitLine({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "Task", input: { description: id, run_in_background: false } }] } });
  proc.emitLine({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "a", content: "finished" }] } });
  proc.emitLine({ type: "result", is_error: false });
  await run;
  assert.equal(tools.get("agent:a")?.agent?.state, "completed");
  assert.equal(tools.get("agent:b")?.agent?.state, "unknown");
  assert.equal(tools.get("agent:b")?.ok, undefined);
});

test("Codex child lifecycle is visible immediately, isolated from the parent turn and unrelated threads", async () => {
  const proc = new FakeProcess();
  proc.stdin.on("data", (d: Buffer) => {
    const m = JSON.parse(d.toString());
    if (m.method === "initialize") proc.emitLine({ id: m.id, result: {} });
    if (m.method === "thread/start") proc.emitLine({ id: m.id, result: { thread: { id: "parent" } } });
    if (m.method === "turn/start") proc.emitLine({ id: m.id, result: { turn: { id: "turn" } } });
  });
  const backend = new CodexBackend("codex", fakeSpawn(proc).spawn);
  const { sink, tools, events } = recording();
  const run = backend.runTurn("go", options, sink, new AbortController().signal);
  await proc.waitFor((line) => line.includes('"turn/start"'));
  await new Promise((r) => setImmediate(r));
  const emit = (method: string, params: Record<string, unknown>) => proc.emitLine({ method, params });
  try {
    emit("item/started", { threadId: "parent", turnId: "turn", item: { id: "call", type: "collabAgentToolCall", tool: "spawnAgent", receiverThreadIds: ["child"], agentsStates: { child: { status: "running" } }, prompt: "Review the changes" } });
    assert.equal(tools.get("agent:child")?.agent?.state, "running");
    emit("item/completed", { threadId: "parent", turnId: "turn", item: { id: "call", type: "collabAgentToolCall", tool: "spawnAgent", status: "completed", receiverThreadIds: ["child"], agentsStates: { child: { status: "running" } } } });
    assert.equal(tools.get("agent:child")?.status, "running", "spawn completed is not agent completed");
    emit("item/started", { threadId: "parent", turnId: "turn", item: { id: "waiting", type: "collabAgentToolCall", tool: "wait", receiverThreadIds: ["child"], agentsStates: {} } });
    assert.equal(tools.get("agent:child")?.agent?.state, "running", "an absent snapshot must not erase observed state");
    emit("item/started", { threadId: "parent", turnId: "turn", item: { id: "activity", type: "subAgentActivity", agentThreadId: "child", agentPath: "/root/reviewer", kind: "started" } });
    assert.equal(tools.get("agent:child")?.agent?.label, "/root/reviewer");
    emit("thread/status/changed", { threadId: "child", status: { type: "active", activeFlags: ["waitingOnApproval"] } });
    assert.equal(tools.get("agent:child")?.agent?.state, "waiting");
    proc.emitLine({ id: 88, method: "item/commandExecution/requestApproval", params: { threadId: "child", turnId: "child-turn", itemId: "command", command: "npm test", cwd: "/repo" } });
    const response = JSON.parse(await proc.waitFor(line => line.includes('"id":88')));
    assert.equal(response.result.decision, "accept", "a child approval still reaches the parent's human approval sink");
    emit("item/agentMessage/delta", { threadId: "child", turnId: "child-turn", itemId: "msg", delta: "private child reasoning" });
    emit("thread/status/changed", { threadId: "unrelated", status: { type: "idle" } });
    assert.equal(events.some((e) => e.includes("private child reasoning")), false);
    emit("item/completed", { threadId: "parent", turnId: "turn", item: { id: "wait", type: "collabAgentToolCall", tool: "wait", receiverThreadIds: ["child"], agentsStates: { child: { status: "errored", message: "Usage limit" } } } });
    assert.equal(tools.get("agent:child")?.agent?.state, "failed");
    assert.equal(tools.get("agent:child")?.output, "Usage limit");
    emit("thread/status/changed", { threadId: "child", status: { type: "idle" } });
    assert.equal(tools.get("agent:child")?.agent?.state, "failed", "idle is not proof of successful completion");
  } finally {
    emit("turn/completed", { threadId: "parent", turn: { id: "turn", status: "completed" } });
    assert.equal((await run).status, "completed", "a child failure must not finish its parent turn"); await backend.dispose();
  }
});
