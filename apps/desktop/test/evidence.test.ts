import { test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { OUTPUT_PREVIEW_BYTES, boundOutput, codexWebSearch, memoryEvidence } from "../src/shared/evidence.js";
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

test("the runner keeps a long tool's raw output for its item, reads it back in pages, and deletes it with the thread", async () => {
  const home = tmpdir("modex-evidence-");
  const store = new Store(home);
  const events: ThreadEvent[] = [];
  const big = "row of output\n".repeat(60_000); // about 840 KB, past the 256 KiB preview
  const backend: Backend = { id: "claude", listModels: async () => [], dispose: async () => {}, async runTurn(_t, _o, sink) {
    const native = { runtime: "claude", thread: "nt", turn: "nu", item: "c1" };
    sink.observe({ type: "tool.start", native, tool: { name: "Bash", title: "$ cat big.log", args: {} } });
    for (let i = 0; i < big.length; i += 65_536) sink.output?.(native, big.slice(i, i + 65_536));
    sink.observe({ type: "tool.done", native, outcome: "succeeded", progress: { output: big, outputBytes: Buffer.byteLength(big), outputTruncated: true } });
    return { status: "completed" };
  } };
  const runner = new ThreadRunner({ home, store, emit: (e) => events.push(e), backends: { claude: backend } });
  const project = store.addProject(gitRepo());
  const thread = await runner.createThread(project.id, { backend: "claude", auto: false });
  store.updateThread(thread.id, { title: "Fixture", titleSource: "manual" });
  await runner.send(thread.id, "go");
  const tool = store.items(thread.id).find((i) => i.kind === "tool")!;
  let text = "";
  let offset: number | null = 0;
  while (offset !== null) {
    const page = runner.toolLog(thread.id, tool.id, offset);
    assert.ok(page);
    assert.equal(page.kept, Buffer.byteLength(big));
    text += page.text;
    offset = page.next;
  }
  assert.equal(text, big, "the whole log, from its first line");
  assert.ok(JSON.stringify(events).length < Buffer.byteLength(big), "no event carried the raw log");
  const user = store.items(thread.id).find((i) => i.kind === "user")!;
  assert.throws(() => runner.toolLog(thread.id, user.id, 0), /not a tool/);
  assert.throws(() => runner.toolLog(thread.id, "missing", 0), /no longer in this thread/);
  await runner.deleteThread(thread.id);
  assert.equal(fs.existsSync(path.join(home, "app", "tool-logs", thread.id)), false);
  await runner.dispose();
});


/** A live codex-cli 0.163.0 web search (test/fixtures/codex-websearch-0.163.0.json): the item as it started and completed. */
const nativeSearch = JSON.parse(fs.readFileSync(fileURLToPath(new URL("../../test/fixtures/codex-websearch-0.163.0.json", import.meta.url)), "utf8")) as { started: Record<string, unknown>; completed: Record<string, unknown> };

test("a live Codex web search becomes its query, its action and the results Codex reported, as safe links", () => {
  assert.equal(codexWebSearch(nativeSearch.started), null, "at item/started 0.163.0 sends an empty query, no action and no results");
  const search = codexWebSearch(nativeSearch.completed)!;
  assert.equal(search.source, "codex");
  assert.equal(search.query, "site:github.com/openai/codex changelog codex cli");
  assert.deepEqual(search.action, { kind: "search", queries: ["site:github.com/openai/codex changelog codex cli"] });
  assert.equal(search.results.length, 3);
  assert.deepEqual(search.results[0], {
    title: "codex/CHANGELOG.md at main · openai/codex · GitHub",
    url: "https://github.com/openai/codex/blob/main/CHANGELOG.md",
    domain: "github.com",
    snippet: "The changelog can be found on the releases page.",
  });
  assert.equal(search.dropped, undefined);
});

test("search results without a safe http(s) link are dropped and counted, and each field is bounded", () => {
  const search = codexWebSearch({ type: "webSearch", query: "q", action: { type: "search", query: null, queries: ["a", 7, "b"] }, results: [
    { type: "text_result", title: "Fine", url: "https://example.com/a" },
    { type: "text_result", title: "Script", url: "javascript:alert(1)" },
    { type: "text_result", title: "No link" },
    "not an object",
    { type: "image_result", url: "http://example.org/x.png", snippet: "s".repeat(5000) },
  ] })!;
  assert.deepEqual(search.action, { kind: "search", queries: ["a", "b"] });
  assert.deepEqual(search.results.map((r) => [r.title, r.url, r.domain]), [["Fine", "https://example.com/a", "example.com"], ["example.org", "http://example.org/x.png", "example.org"]]);
  assert.ok(search.results[1]!.snippet!.length <= 501, "snippets are cut to 500 characters and an ellipsis");
  assert.equal(search.dropped, 3);
  assert.equal(codexWebSearch({ query: "q".repeat(5000) })!.query.length <= 501, true);
});

test("open-page and find-in-page actions keep only a safe URL and the pattern", () => {
  assert.deepEqual(codexWebSearch({ query: "", action: { type: "openPage", url: "https://example.com/p" } })!.action, { kind: "openPage", url: "https://example.com/p" });
  assert.deepEqual(codexWebSearch({ query: "", action: { type: "findInPage", url: "https://example.com/p", pattern: "needle" } })!.action, { kind: "findInPage", url: "https://example.com/p", pattern: "needle" });
  assert.equal(codexWebSearch({ query: "", action: { type: "openPage", url: "file:///etc/passwd" } }), null, "an unsafe page is not a link, and nothing else was reported");
  assert.equal(codexWebSearch({ query: "", action: { type: "other" } }), null);
});
