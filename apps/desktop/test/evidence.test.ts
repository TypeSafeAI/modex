import { test } from "node:test";
import assert from "node:assert/strict";
import { OUTPUT_PREVIEW_BYTES, boundOutput, memoryEvidence } from "../src/shared/evidence.js";
import { CodexBackend } from "../src/main/engine/backends/codex.js";
import { ClaudeBackend } from "../src/main/engine/backends/claude.js";
import { Store } from "../src/main/engine/store.js";
import { ThreadRunner } from "../src/main/engine/runner.js";
import type { Backend } from "../src/main/engine/backends/types.js";
import type { ThreadEvent, ThreadItem } from "../src/shared/types.js";
import { FakeProcess, collectSink, fakeSpawn, local } from "./fakeproc.js";
import { gitRepo, tmpdir } from "./helpers.js";

/**
 * Evidence a turn leaves (docs/conversation-evidence.md): what the CLI natively cited, the command
 * that actually ran and how it ended, and output bounded with a visible truncation. Nothing here is
 * presented as more than the CLI reported.
 */

test("tool output is bounded to its last 256 KiB on a UTF-8 boundary, with the total kept", () => {
  assert.deepEqual(boundOutput("short"), { text: "short" });
  const big = "é".repeat(200_000) + "\n" + "tail ✓".repeat(30_000);
  const bytes = Buffer.byteLength(big);
  const bounded = boundOutput(big);
  assert.ok(Buffer.byteLength(bounded.text) <= OUTPUT_PREVIEW_BYTES);
  assert.ok(Buffer.byteLength(bounded.text) > OUTPUT_PREVIEW_BYTES - 4, "it fills the preview");
  assert.ok(big.endsWith(bounded.text), "the end of the log is what stays");
  assert.ok(!bounded.text.includes("�"), "no character is cut in half");
  assert.deepEqual(bounded.truncated, { totalBytes: bytes, shownBytes: Buffer.byteLength(bounded.text) });
});

test("Codex memory citations become native evidence only when they are well formed", () => {
  const good = { path: "notes/build.md", lineStart: 3, lineEnd: 5, note: "Build flags 🛠" };
  assert.deepEqual(memoryEvidence({ entries: [good], threadIds: ["thr-old"] }), [{ kind: "memory", source: "codex", ...good, threadIds: ["thr-old"] }]);
  for (const bad of [null, "x", { entries: "x" }, { entries: [{ ...good, lineStart: 6 }] }, { entries: [{ ...good, lineStart: -1 }] }, { entries: [{ ...good, lineEnd: 2.5 }] }, { entries: [{ ...good, path: "" }] }, { entries: [{ ...good, note: 3 }] }]) {
    assert.deepEqual(memoryEvidence(bad), [], JSON.stringify(bad));
  }
});

/** A Codex app-server that answers setup, then plays `lines` (notifications) after turn/start. */
function codexWith(lines: unknown[]) {
  const proc = new FakeProcess();
  proc.stdin.on("data", (d: Buffer) => {
    for (const line of d.toString().split("\n")) {
      if (!line.trim()) continue;
      const msg = JSON.parse(line) as { id?: number; method?: string };
      if (msg.method === "initialize") proc.emitLine({ id: msg.id, result: { userAgent: "fake" } });
      else if (msg.method === "thread/start") proc.emitLine({ id: msg.id, result: { thread: { id: "thr" } } });
      else if (msg.method === "turn/start") {
        proc.emitLine({ id: msg.id, result: { turn: { id: "tu" } } });
        proc.emitLine({ method: "turn/started", params: { threadId: "thr", turn: { id: "tu" } } });
        for (const l of lines) proc.emitLine(l);
        proc.emitLine({ method: "turn/completed", params: { threadId: "thr", turn: { id: "tu", status: "completed", error: null } } });
      }
    }
  });
  return new CodexBackend("codex", fakeSpawn(proc).spawn);
}
const n = (method: string, params: Record<string, unknown>) => ({ method, params: { threadId: "thr", turnId: "tu", ...params } });

test("Codex: a message's memory citation, a command's real command line, cwd and exit code are kept apart from its title", async () => {
  const backend = codexWith([
    n("item/started", { item: { type: "agentMessage", id: "m1", text: "", phase: "final_answer" } }),
    n("item/completed", { item: { type: "agentMessage", id: "m1", text: "Use the build flags from memory.", phase: "final_answer", memoryCitation: { entries: [{ path: "notes/build.md", lineStart: 3, lineEnd: 5, note: "flags" }], threadIds: [] } } }),
    n("item/started", { item: { type: "commandExecution", id: "c1", command: "/bin/zsh -lc 'npm test -- --grep \"a b\"'", cwd: "/repo/pkg", status: "inProgress" } }),
    n("item/completed", { item: { type: "commandExecution", id: "c1", command: "/bin/zsh -lc 'npm test -- --grep \"a b\"'", cwd: "/repo/pkg", status: "completed", exitCode: 2, aggregatedOutput: "1 failing\n" } }),
    n("item/started", { item: { type: "commandExecution", id: "c2", command: "/bin/zsh -lc 'rm -rf build'", cwd: "/repo", status: "inProgress" } }),
    n("item/completed", { item: { type: "commandExecution", id: "c2", command: "/bin/zsh -lc 'rm -rf build'", cwd: "/repo", status: "declined", exitCode: null } }),
  ]);
  const { sink, observations } = collectSink();
  try {
    assert.equal((await backend.runTurn("go", { cwd: "/repo", mode: "agent", plan: false, model: "" }, sink, new AbortController().signal)).status, "completed");
    const done = observations.find((o) => o.type === "message.done") as { evidence?: unknown[] } | undefined;
    assert.deepEqual(done?.evidence, [{ kind: "memory", source: "codex", path: "notes/build.md", lineStart: 3, lineEnd: 5, note: "flags", threadIds: [] }]);
    const starts = observations.filter((o) => o.type === "tool.start") as { tool: { title: string; exec?: unknown } }[];
    assert.deepEqual(starts.map((s) => [s.tool.title, s.tool.exec]), [
      ['$ npm test -- --grep "a b"', { command: "/bin/zsh -lc 'npm test -- --grep \"a b\"'", cwd: "/repo/pkg" }],
      ["$ rm -rf build", { command: "/bin/zsh -lc 'rm -rf build'", cwd: "/repo" }],
    ]);
    const ends = observations.filter((o) => o.type === "tool.done") as { outcome: string; progress?: { exitCode?: number | null } }[];
    assert.deepEqual(ends.map((e) => [e.outcome, e.progress?.exitCode]), [["failed", 2], ["denied", null]]);
  } finally { await backend.dispose(); }
});

test("Codex: streaming a 3 MiB log never sends more than the preview, and the end keeps its outcome and total", async () => {
  const chunk = "x".repeat(64 * 1024 - 1) + "\n";
  const deltas = Array.from({ length: 48 }, () => n("item/commandExecution/outputDelta", { itemId: "c1", delta: chunk }));
  const backend = codexWith([
    n("item/started", { item: { type: "commandExecution", id: "c1", command: "yes", cwd: "/repo", status: "inProgress" } }),
    ...deltas,
    n("item/completed", { item: { type: "commandExecution", id: "c1", command: "yes", cwd: "/repo", status: "completed", exitCode: 0, aggregatedOutput: chunk.repeat(48) } }),
  ]);
  const { sink, observations } = collectSink();
  try {
    await backend.runTurn("go", { cwd: "/repo", mode: "agent", plan: false, model: "" }, sink, new AbortController().signal);
    const outputs = observations.flatMap((o) => (o.type === "tool.update" || o.type === "tool.done") && o.progress?.output !== undefined ? [o.progress] : []);
    assert.ok(outputs.length > 1);
    assert.ok(outputs.every((p) => Buffer.byteLength(p!.output!) <= OUTPUT_PREVIEW_BYTES), "every update is bounded");
    const last = observations.at(-1) as { type: string; outcome: string; progress: { outputBytes?: number; exitCode?: number } };
    assert.deepEqual([last.type, last.outcome, last.progress.outputBytes, last.progress.exitCode], ["tool.done", "succeeded", 48 * 64 * 1024, 0]);
  } finally { await backend.dispose(); }
});

test("Claude: a Bash result has no exit code to report, so none is invented", async () => {
  const proc = new FakeProcess();
  const backend = new ClaudeBackend("claude", fakeSpawn(proc).spawn);
  const { sink, observations } = collectSink();
  const run = backend.runTurn("go", { cwd: "/repo", mode: "agent", plan: false, model: "" }, sink, new AbortController().signal);
  await proc.waitFor((l) => l.includes('"type":"user"'));
  proc.emitLine({ type: "system", subtype: "init", session_id: "s" });
  proc.emitLine({ type: "assistant", message: { id: "m", content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "npm test", description: "run tests" } }] } });
  proc.emitLine({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: "1 failing", is_error: true }] } });
  proc.emitLine({ type: "assistant", message: { id: "m2", content: [{ type: "text", text: "One test fails." }] } });
  proc.emitLine({ type: "result", subtype: "success", is_error: false, session_id: "s", result: "One test fails.", num_turns: 2 });
  proc.close(0);
  await run;
  const start = observations.find((o) => o.type === "tool.start") as { tool: { exec?: unknown } };
  // Claude Code's Bash keeps its own working directory between calls, so Modex does not claim one.
  assert.deepEqual(start.tool.exec, { command: "npm test" });
  const done = observations.find((o) => o.type === "tool.done") as { outcome: string; progress?: { exitCode?: unknown } };
  assert.equal(done.outcome, "failed");
  assert.equal(done.progress && "exitCode" in done.progress, false, "no exit code was reported");
});

test("the runner bounds any tool's output, keeps its outcome, and saves the total it saw", async () => {
  const home = tmpdir("modex-evidence-");
  const store = new Store(home);
  const events: ThreadEvent[] = [];
  const huge = "line\n".repeat(400_000);
  const backend: Backend = { id: "claude", listModels: async () => [], dispose: async () => {}, async runTurn(_t, _o, sink) {
    local(sink).toolStart({ id: "t1", name: "Bash", title: "$ cat big.log", args: {} });
    local(sink).toolUpdate("t1", { output: huge.slice(0, 100) });
    local(sink).toolUpdate("t1", { output: huge, status: "done", ok: false });
    return { status: "completed" };
  } };
  const runner = new ThreadRunner({ home, store, emit: (e) => events.push(e), backends: { claude: backend } });
  const project = store.addProject(gitRepo());
  const thread = await runner.createThread(project.id, { backend: "claude", auto: false });
  store.updateThread(thread.id, { title: "Fixture", titleSource: "manual" });
  await runner.send(thread.id, "go");
  const tool = new Store(home).items(thread.id).find((i) => i.kind === "tool") as ThreadItem & { output?: string; outputBytes?: number; outputTruncated?: boolean; outcome?: string };
  assert.ok(Buffer.byteLength(tool.output!) <= OUTPUT_PREVIEW_BYTES);
  assert.deepEqual([tool.outputBytes, tool.outputTruncated, tool.outcome], [Buffer.byteLength(huge), true, "failed"]);
  const sent = events.flatMap((e) => (e.type === "item_update" && typeof (e.patch as { output?: string }).output === "string" ? [(e.patch as { output: string }).output] : []));
  assert.ok(sent.every((o) => Buffer.byteLength(o) <= OUTPUT_PREVIEW_BYTES), "no update carries the whole log");
  await runner.dispose();
});
