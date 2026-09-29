import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Store } from "../src/main/engine/store.js";
import { ThreadRunner } from "../src/main/engine/runner.js";
import { MockBackend } from "../src/main/engine/backends/mock.js";
import { CodexBackend } from "../src/main/engine/backends/codex.js";
import { FakeProcess, fakeSpawn } from "./fakeproc.js";
import { Router } from "../src/main/engine/routing/router.js";
import type { Backend, TurnOptions, TurnResult, TurnSink } from "../src/main/engine/backends/types.js";
import type { Thread, ThreadEvent, ThreadItem } from "../src/shared/types.js";
import { MockProvider, type MockStep } from "@modex/core";
import { gitRepo, tmpdir, writeScript } from "./helpers.js";

function harness(steps: MockStep[] = []) {
  const home = tmpdir("modex-home-");
  const store = new Store(home);
  store.updateSettings({ default_backend: "mock", mock_script: writeScript(steps) });
  const events: ThreadEvent[] = [];
  const backends = { mock: new MockBackend(() => store.settings.mock_script, home, 0) };
  return { home, store, events, emit: (e: ThreadEvent) => events.push(e), backends };
}

const PATCH = "*** Begin Patch\n*** Add File: NOTE.md\n+hello from modex\n*** End Patch";

test("thread deletion fences access and waits for terminal cleanup before removing a worktree", async () => {
  const h = harness();
  let finish!: () => void;
  let cleaning = false;
  const options = { ...h, beforeDeleteThread: async () => {
    cleaning = true;
    await new Promise<void>((resolve) => { finish = resolve; });
  } };
  const runner = new ThreadRunner(options);
  const thread = await runner.createThread(h.store.addProject(gitRepo()).id, { worktree: true });
  const deleting = runner.deleteThread(thread.id, true);
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(cleaning, true, "deletion skipped terminal cleanup");
    assert.ok(fs.existsSync(thread.cwd), "worktree was removed while its terminal was closing");
    assert.ok(h.store.thread(thread.id));
    assert.throws(() => runner.assertThreadAvailable(thread.id), /being deleted/);
    await assert.rejects(runner.send(thread.id, "late work"), /being deleted/);
  } finally {
    finish?.();
    await deleting;
    await runner.dispose();
  }
  assert.equal(fs.existsSync(thread.cwd), false);
});

test("failed terminal cleanup preserves the thread and worktree for a deletion retry", async () => {
  const h = harness();
  let fail = true;
  const options = { ...h, beforeDeleteThread: async () => {
    if (fail) throw new Error("terminal still running");
  } };
  const runner = new ThreadRunner(options);
  const thread = await runner.createThread(h.store.addProject(gitRepo()).id, { worktree: true });
  try {
    await assert.rejects(runner.deleteThread(thread.id, true), /terminal still running/);
    assert.ok(h.store.thread(thread.id));
    assert.ok(fs.existsSync(thread.cwd));
  } finally {
    fail = false;
    await runner.deleteThread(thread.id, true);
    await runner.dispose();
  }
});

test("dispose waits for interrupted turns to finalize and persist", async () => {
  const h = harness();
  let finish!: (value: TurnResult) => void;
  let started = false;
  const backend: Backend = { id: "mock", listModels: async () => [], dispose: async () => {}, runTurn(_text, _opts, sink) {
    sink.delta("last live text");
    started = true;
    return new Promise((resolve) => { finish = resolve; });
  } };
  const runner = new ThreadRunner({ ...h, backends: { mock: backend } });
  const project = h.store.addProject(gitRepo());
  const thread = await runner.createThread(project.id);
  const run = runner.send(thread.id, "work");
  await waitFor(() => started);
  let disposed = false;
  const disposal = runner.dispose().then(() => { disposed = true; });
  try {
    await new Promise((r) => setImmediate(r));
    assert.equal(disposed, false, "shutdown returned before the backend stopped");
  } finally {
    finish({ status: "interrupted" });
    await Promise.all([run, disposal]);
  }
  assert.equal(runner.status(thread.id), "idle");
  assert.ok(new Store(h.home).items(thread.id).some((item) => item.kind === "assistant" && item.text === "last live text"));
});

test("an in-flight Auto route cannot reopen a backend during shutdown", async () => {
  const h = harness();
  let disposed = false;
  let reopened = false;
  const backend: Backend = { id: "codex", listModels: async () => { reopened ||= disposed; return []; }, dispose: async () => { disposed = true; }, runTurn: async () => ({ status: "completed" }) };
  let runner: ThreadRunner;
  const router = new Router({ home: h.home, policy: () => h.store.settings.routing, transport: null, listModels: (id) => runner.listModels(id) });
  runner = new ThreadRunner({ ...h, router, backends: { codex: backend } });
  const thread = await runner.createThread(h.store.addProject(gitRepo()).id, { backend: "codex", auto: true });
  const run = runner.send(thread.id, "review the project");
  await runner.dispose();
  await run;
  assert.equal(reopened, false, "Auto routing restarted a disposed backend");
});

test("shutdown settles an Auto route already discovering models on a warm Codex server", async () => {
  const h = harness();
  const proc = new FakeProcess();
  proc.stdin.on("data", (data: Buffer) => {
    for (const line of data.toString().split("\n")) {
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (message.method === "initialize") proc.emitLine({ id: message.id, result: {} });
      if (message.method === "model/list") proc.emitLine({ id: message.id, result: { data: [] } });
    }
  });
  const backend = new CodexBackend("fixture", fakeSpawn(proc).spawn);
  await backend.listModels();
  let runner: ThreadRunner;
  const router = new Router({ home: h.home, policy: () => h.store.settings.routing, transport: null, listModels: (id) => runner.listModels(id) });
  runner = new ThreadRunner({ ...h, router, backends: { codex: backend } });
  const thread = await runner.createThread(h.store.addProject(gitRepo()).id, { backend: "codex", auto: true });
  let runSettled = false;
  let shutdownSettled = false;
  const run = runner.send(thread.id, "review the project").then(() => { runSettled = true; });
  const shutdown = Promise.resolve().then(() => runner.dispose()).then(() => { shutdownSettled = true; });
  try {
    await waitFor(() => runSettled && shutdownSettled);
    assert.equal(runner.status(thread.id), "idle");
    assert.equal(proc.killed, true);
  } finally {
    await backend.dispose();
    await Promise.all([run, shutdown]);
  }
});

test("agent mode: a prompt runs tools, edits the project, emits items, persists, and sets the title", async () => {
  const h = harness([
    { thinking: "Check the tree first.", content: "Looking.", tool_calls: [{ name: "shell", arguments: { command: "ls" } }] },
    { tool_calls: [{ name: "apply_patch", arguments: { patch: PATCH } }] },
    { content: "Added NOTE.md." },
  ]);
  const repo = gitRepo();
  const project = h.store.addProject(repo);
  const runner = new ThreadRunner(h);
  const thread = await runner.createThread(project.id, { mode: "agent" });
  assert.equal(thread.cwd, repo);
  await runner.send(thread.id, "add a note file please");
  assert.equal(fs.readFileSync(path.join(repo, "NOTE.md"), "utf8"), "hello from modex\n");
  const items = runner.items(thread.id);
  assert.deepEqual(items.map((i) => i.kind), ["user", "thinking", "assistant", "tool", "tool", "assistant"]);
  const think = items[1] as { text: string; status: string; durationMs?: number };
  assert.equal(think.text, "Check the tree first.");
  assert.equal(think.status, "done");
  assert.ok(think.durationMs != null && think.durationMs >= 0);
  // streaming: the first assistant item was created empty, grew via item_update, and ended with the full text
  const first = items[2] as { id: string; text: string };
  assert.equal(first.text, "Looking.");
  const updates = h.events.filter((e) => e.type === "item_update" && e.id === first.id).map((e) => (e as { patch: { text?: string } }).patch.text);
  assert.ok(updates.length >= 1 && updates.at(-1) === "Looking.");
  assert.equal((h.events.find((e) => e.type === "item" && (e as { item: ThreadItem }).item.id === first.id) as { item: { text: string } }).item.text, "");
  const tools = items.filter((i): i is Extract<ThreadItem, { kind: "tool" }> => i.kind === "tool");
  assert.equal(tools[0]!.title, "$ ls");
  assert.equal(tools[0]!.status, "done");
  assert.ok(tools[0]!.output?.includes("README.md"));
  assert.equal(tools[1]!.title, "edit NOTE.md");
  assert.equal(tools[1]!.ok, true);
  assert.equal(runner.status(thread.id), "idle");
  assert.equal(h.store.thread(thread.id)?.title, "add a note file please");
  assert.ok(h.store.thread(thread.id)?.sessionHandle);
  // statuses went running → idle; items were persisted for restart
  const statuses = h.events.filter((e) => e.type === "status").map((e) => (e as { status: string }).status);
  assert.deepEqual(statuses, ["running", "idle"]);
  assert.equal(new Store(h.home).items(thread.id).length, items.length);
});

test("chat mode: edits pause on an approval card; answering resumes the turn", async () => {
  const h = harness([
    { tool_calls: [{ name: "apply_patch", arguments: { patch: PATCH } }] },
    { content: "ok" },
  ]);
  const repo = gitRepo();
  const project = h.store.addProject(repo);
  const runner = new ThreadRunner(h);
  const thread = await runner.createThread(project.id, { mode: "chat" });
  const done = runner.send(thread.id, "write NOTE.md");
  const approval = await waitFor(() => runner.items(thread.id).find((i) => i.kind === "approval"));
  assert.equal(runner.status(thread.id), "waiting");
  assert.match((approval as { question: string }).question, /Allow add NOTE.md/);
  runner.answer(thread.id, approval!.id, "yes");
  await done;
  assert.equal(fs.existsSync(path.join(repo, "NOTE.md")), true);
  assert.equal((runner.items(thread.id).find((i) => i.id === approval!.id) as { answer?: string }).answer, "yes");
  assert.equal(runner.status(thread.id), "idle");
});

test("denying an approval leaves the tree untouched and tells the model", async () => {
  const h = harness([
    { tool_calls: [{ name: "apply_patch", arguments: { patch: PATCH } }] },
    { content: "understood" },
  ]);
  const repo = gitRepo();
  const project = h.store.addProject(repo);
  const runner = new ThreadRunner(h);
  const thread = await runner.createThread(project.id, { mode: "chat" });
  const done = runner.send(thread.id, "write NOTE.md");
  const approval = await waitFor(() => runner.items(thread.id).find((i) => i.kind === "approval"));
  runner.answer(thread.id, approval!.id, "no");
  await done;
  assert.equal(fs.existsSync(path.join(repo, "NOTE.md")), false);
  const tool = runner.items(thread.id).find((i) => i.kind === "tool") as { ok: boolean; output?: string };
  assert.equal(tool.ok, false);
  assert.match(tool.output ?? "", /not approved/);
});

test("stop cancels a waiting approval and returns the thread to idle", async () => {
  const h = harness([
    { tool_calls: [{ name: "write_file", arguments: { path: "x.txt", content: "x" } }] },
    { content: "unreachable" },
  ]);
  const repo = gitRepo();
  const project = h.store.addProject(repo);
  const runner = new ThreadRunner(h);
  const thread = await runner.createThread(project.id, { mode: "chat" });
  const done = runner.send(thread.id, "go");
  await waitFor(() => runner.items(thread.id).find((i) => i.kind === "approval"));
  runner.stop(thread.id);
  await done;
  assert.equal(fs.existsSync(path.join(repo, "x.txt")), false);
  assert.equal(runner.status(thread.id), "idle");
  await assert.rejects(runner.send("nope", "x"), /unknown thread/);
});

test("two threads in the same project run concurrently and independently", async () => {
  const h = harness();
  const repo = gitRepo();
  const project = h.store.addProject(repo);
  // A backend that takes 300ms per turn: serial execution would need ≥600ms for two threads.
  const slow: Backend = {
    id: "mock",
    listModels: async () => [],
    dispose: async () => {},
    async runTurn(_text: string, _o: TurnOptions, sink: TurnSink): Promise<TurnResult> {
      await new Promise((r) => setTimeout(r, 300));
      sink.assistant("finished");
      return { status: "completed" };
    },
  };
  const runner = new ThreadRunner({ ...h, backends: { mock: slow } });
  const a = await runner.createThread(project.id, { mode: "full-access" });
  const b = await runner.createThread(project.id, { mode: "full-access" });
  const started = Date.now();
  await Promise.all([runner.send(a.id, "task a"), runner.send(b.id, "task b")]);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 550, `expected parallel execution, took ${elapsed}ms`);
  assert.equal(runner.status(a.id), "idle");
  assert.equal(runner.status(b.id), "idle");
  const order = h.events.filter((e) => e.type === "status").map((e) => e.threadId);
  assert.ok(order.indexOf(b.id) < order.lastIndexOf(a.id), "events interleave across threads");
  await assert.rejects(async () => {
    const p = runner.send(a.id, "again");
    await runner.send(a.id, "while busy");
    await p;
  }, /still working/);
});

test("worktree threads work on an isolated branch; deleting removes the worktree", async () => {
  const h = harness([
    { tool_calls: [{ name: "apply_patch", arguments: { patch: PATCH } }] },
    { content: "done" },
  ]);
  const repo = gitRepo();
  const project = h.store.addProject(repo);
  const runner = new ThreadRunner(h);
  const thread = await runner.createThread(project.id, { worktree: true, mode: "agent" });
  assert.ok(thread.worktree);
  assert.equal(thread.worktree!.branch, `modex/${thread.id}`);
  assert.ok(thread.cwd.startsWith(path.join(h.home, "worktrees")));
  await runner.send(thread.id, "note");
  assert.equal(fs.existsSync(path.join(thread.cwd, "NOTE.md")), true);
  assert.equal(fs.existsSync(path.join(repo, "NOTE.md")), false, "main checkout untouched");
  await runner.deleteThread(thread.id, true);
  assert.equal(fs.existsSync(thread.cwd), false);
  assert.equal(h.store.thread(thread.id), undefined);
  assert.equal(new Store(h.home).items(thread.id).length, 0);
});

test("reasoning with no text still yields a finished Thinking row; completion-only text is kept", async () => {
  const h = harness();
  const project = h.store.addProject(gitRepo());
  const quiet: Backend = { id: "mock", listModels: async () => [], dispose: async () => {}, async runTurn(_t, _o, sink) {
    sink.thinkingDelta("r-empty", ""); sink.thinkingDone("r-empty");
    sink.thinkingDone("r-late", "Decided to answer directly.");
    sink.assistant("hi"); return { status: "completed" };
  } };
  const runner = new ThreadRunner({ ...h, backends: { mock: quiet } });
  const thread = await runner.createThread(project.id);
  await runner.send(thread.id, "hello");
  const kinds = runner.items(thread.id).map((i) => `${i.kind}${i.kind === "thinking" ? `:${i.status}:${i.text}` : ""}`);
  assert.deepEqual(kinds, ["user", "thinking:done:", "thinking:done:Decided to answer directly.", "assistant"]);
});

test("worktree threads use the project's scripts/worktree.sh when it exists; deletion goes through it too", async () => {
  const h = harness([{ content: "ok" }]);
  const repo = gitRepo();
  // A minimal stand-in for the convention script: `new <name>` prints the path, `remove <name>` logs the call.
  fs.mkdirSync(path.join(repo, "scripts"));
  fs.writeFileSync(path.join(repo, "scripts", "worktree.sh"), `#!/usr/bin/env bash
set -e
root="$(git rev-parse --show-toplevel)"
case "$1" in
  new) mkdir -p "$root/.worktrees"; git worktree add -q -b "$2" "$root/.worktrees/$2" HEAD; echo "note: installed deps" >&2; echo "$root/.worktrees/$2";;
  remove) echo "remove $2" >> "$root/.wt-calls"; git worktree remove "$root/.worktrees/$2"; git branch -q -D "$2";;
esac
`);
  const project = h.store.addProject(repo);
  const runner = new ThreadRunner(h);
  const thread = await runner.createThread(project.id, { worktree: true });
  assert.equal(thread.worktree?.manager, "project-script");
  assert.equal(thread.worktree?.branch, `modex-${thread.id}`);
  assert.equal(thread.cwd, fs.realpathSync(path.join(repo, ".worktrees", `modex-${thread.id}`)), "cwd is the path the script printed, not ~/.modex");
  assert.equal(fs.existsSync(path.join(thread.cwd, "README.md")), true);
  await runner.send(thread.id, "hello");
  await runner.deleteThread(thread.id, true);
  assert.equal(fs.readFileSync(path.join(repo, ".wt-calls"), "utf8").trim(), `remove modex-${thread.id}`);
  assert.equal(fs.existsSync(thread.cwd), false);
});

test("worktree threads fall back to ~/.modex/worktrees when the project has no script", async () => {
  const h = harness([{ content: "ok" }]);
  const project = h.store.addProject(gitRepo());
  const runner = new ThreadRunner(h);
  const thread = await runner.createThread(project.id, { worktree: true });
  assert.equal(thread.worktree?.manager, "modex");
  assert.ok(thread.cwd.startsWith(path.join(h.home, "worktrees")));
  await runner.deleteThread(thread.id, true);
  assert.equal(fs.existsSync(thread.cwd), false);
});

test("a failing project script surfaces as an error, not a half-created thread", async () => {
  const h = harness();
  const repo = gitRepo();
  fs.mkdirSync(path.join(repo, "scripts"));
  fs.writeFileSync(path.join(repo, "scripts", "worktree.sh"), "#!/usr/bin/env bash\necho 'boom: refusing' >&2; exit 3\n");
  const project = h.store.addProject(repo);
  const runner = new ThreadRunner(h);
  await assert.rejects(runner.createThread(project.id, { worktree: true }), /scripts\/worktree.sh new modex-\w+ failed: boom: refusing/);
  assert.equal(h.store.snapshot().threads.length, 0);
});

test("a backend failure becomes an error notice, not a crash", async () => {
  const h = harness();
  const project = h.store.addProject(gitRepo());
  const failing: Backend = { id: "mock", listModels: async () => [], dispose: async () => {}, runTurn: async () => ({ status: "failed", error: "codex: not logged in" }) };
  const runner = new ThreadRunner({ ...h, backends: { mock: failing } });
  const thread = await runner.createThread(project.id);
  await runner.send(thread.id, "hi");
  assert.equal(runner.status(thread.id), "error");
  const notice = runner.items(thread.id).find((i) => i.kind === "notice") as { text: string };
  assert.match(notice.text, /not logged in/);
});

test("switching backend resets the resume handle and model; plan/effort persist", async () => {
  const h = harness([{ content: "ok" }]);
  const project = h.store.addProject(gitRepo());
  const runner = new ThreadRunner(h);
  const thread = await runner.createThread(project.id, { mode: "agent" });
  assert.equal(thread.backend, "mock");
  await runner.send(thread.id, "hello");
  assert.ok(h.store.thread(thread.id)?.sessionHandle);
  runner.updateThread(thread.id, { plan: true, effort: "high" });
  assert.equal(h.store.thread(thread.id)?.plan, true);
  const switched = runner.updateThread(thread.id, { backend: "codex" });
  assert.equal(switched.backend, "codex");
  assert.equal(switched.sessionHandle, undefined);
  assert.equal(switched.effort, undefined);
  assert.equal(switched.plan, true);
});

async function waitFor<T>(fn: () => T | undefined, ms = 3000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("Auto threads: a route item lands before the turn, the pick is applied, and a hand-picked model teaches the fit", async () => {
  const h = harness();
  const project = h.store.addProject(gitRepo());
  const seen: TurnOptions[] = [];
  const two: Backend = {
    id: "mock",
    listModels: async () => [{ id: "mini", label: "Mini", description: "fastest", efforts: ["low", "high"] }, { id: "big", label: "Big", efforts: ["low", "high"] }],
    dispose: async () => {},
    async runTurn(_t, o, sink) { seen.push(o); sink.session("s1"); sink.assistant("ok"); return { status: "completed" }; },
  };
  const { Router } = await import("../src/main/engine/routing/router.js");
  const router = new Router({ home: h.home, policy: () => h.store.settings.routing, listModels: async () => ({ models: await two.listModels() }), transport: null });
  const runner = new ThreadRunner({ ...h, backends: { mock: two }, router });
  const thread = await runner.createThread(project.id, { mode: "agent", auto: true });
  assert.equal(thread.auto, true);
  await runner.send(thread.id, "quick: rename x to y in one file");
  const items = runner.items(thread.id);
  assert.deepEqual(items.map((i) => i.kind), ["user", "route", "assistant"]);
  const route = items[1] as Extract<ThreadItem, { kind: "route" }>;
  assert.deepEqual([route.source, route.model, route.task, route.fast], ["heuristic", "mini", "small_edit", false], "tier-0 pick, offline judge");
  assert.equal(seen[0]!.model, "mini", "the backend ran on the routed model");
  assert.equal(seen[0]!.effort, "low");
  assert.equal(h.store.thread(thread.id)?.model, "mini", "the thread now shows the pick");
  assert.ok(h.events.some((e) => e.type === "thread" && (e as { thread: Thread }).thread.model === "mini"), "renderer was told");
  assert.equal(new Store(h.home).items(thread.id).length, 3, "the receipt persists");
  const status = await router.status();
  assert.deepEqual([status.live, status.fit.routes], [false, 1]);
  // Picking a bigger model by hand after an Auto pick records an upward override and says so.
  runner.updateThread(thread.id, { model: "big" });
  const notice = await waitFor(() => runner.items(thread.id).find((i) => i.kind === "notice"));
  assert.match((notice as { text: string }).text, /for small edit you chose tier 2 over Auto's tier 0/);
  assert.equal((await router.status()).fit.tasks.small_edit!.overridesUp, 1);
  // Auto off: no route item, the thread runs on whatever it has.
  runner.updateThread(thread.id, { auto: false });
  await runner.send(thread.id, "again");
  assert.deepEqual(runner.items(thread.id).slice(-2).map((i) => i.kind), ["user", "assistant"]);
  assert.equal(seen[1]!.model, "big");
});

test("Auto threads: a routing failure is a warning, not a lost turn", async () => {
  const h = harness([{ content: "fine" }]);
  const project = h.store.addProject(gitRepo());
  const { Router } = await import("../src/main/engine/routing/router.js");
  const router = new Router({ home: h.home, policy: () => h.store.settings.routing, listModels: async () => { throw new Error("no models"); }, transport: null });
  const runner = new ThreadRunner({ ...h, router });
  const thread = await runner.createThread(project.id, { auto: true });
  await runner.send(thread.id, "hello");
  const kinds = runner.items(thread.id).map((i) => i.kind);
  assert.deepEqual(kinds, ["user", "notice", "assistant"]);
  assert.match((runner.items(thread.id)[1] as { text: string }).text, /Auto routing failed \(no models\)/);
  assert.equal(runner.status(thread.id), "idle");
});

test("reused backend item ids cannot overwrite an earlier turn", async () => {
  const h = harness();
  const project = h.store.addProject(gitRepo());
  const backend: Backend = { id: "mock", listModels: async () => [], dispose: async () => {}, async runTurn(text, _o, sink) {
    sink.thinkingDelta("think-1", text);
    sink.thinkingDone("think-1");
    sink.toolStart({ id: "tool-1", name: "shell", title: text, args: {} });
    sink.toolUpdate("tool-1", { output: text, status: "done", ok: true });
    return { status: "completed" };
  } };
  const runner = new ThreadRunner({ ...h, backends: { mock: backend } });
  const thread = await runner.createThread(project.id);
  await runner.send(thread.id, "first");
  await runner.send(thread.id, "second");
  const thinking = runner.items(thread.id).filter((i) => i.kind === "thinking");
  assert.deepEqual(thinking.map((i) => i.text), ["first", "second"]);
  const tools = runner.items(thread.id).filter((i) => i.kind === "tool");
  assert.deepEqual(tools.map((i) => i.output), ["first", "second"]);
  assert.equal(new Set(runner.items(thread.id).map((i) => i.id)).size, runner.items(thread.id).length);
});

test("tool streaming coalesces disk writes and flushes final output", async (t) => {
  const h = harness();
  const project = h.store.addProject(gitRepo());
  const save = h.store.saveItems.bind(h.store);
  let writes = 0;
  h.store.saveItems = (...args) => { writes++; save(...args); };
  const backend: Backend = { id: "mock", listModels: async () => [], dispose: async () => {}, async runTurn(_text, _o, sink) {
    sink.toolStart({ id: "tool", name: "shell", title: "$ build", args: {} });
    for (let i = 1; i <= 1000; i++) sink.toolUpdate("tool", { output: "x".repeat(i) });
    // A crash may omit item/completed; the turn boundary must still save the tail.
    return { status: "failed", error: "process crashed" };
  } };
  const runner = new ThreadRunner({ ...h, backends: { mock: backend } });
  const thread = await runner.createThread(project.id);
  await runner.send(thread.id, "build");
  t.diagnostic(`${writes} full transcript writes for 1000 deltas`);
  assert.ok(writes < 10, `${writes} full transcript writes for 1000 deltas`);
  const tool = new Store(h.home).items(thread.id).find((i) => i.kind === "tool");
  assert.equal(tool?.output, "x".repeat(1000));
  assert.equal(tool?.status, "done");
});

test("deletion waits for the active turn and rejects late output after removal", async () => {
  const h = harness();
  const project = h.store.addProject(gitRepo());
  let sink!: TurnSink;
  let finish!: (result: TurnResult) => void;
  const backend: Backend = { id: "mock", listModels: async () => [], dispose: async () => {}, runTurn(_text, _o, s) {
    sink = s;
    return new Promise((resolve) => { finish = resolve; });
  } };
  const runner = new ThreadRunner({ ...h, backends: { mock: backend } });
  const thread = await runner.createThread(project.id, { worktree: true });
  const run = runner.send(thread.id, "go");
  let deleted = false;
  const deletion = runner.deleteThread(thread.id, true).then(() => { deleted = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(deleted, false, "must not remove a worktree while its backend is still running");
  assert.equal(fs.existsSync(thread.cwd), true);
  finish({ status: "interrupted" });
  await Promise.all([run, deletion]);
  const count = h.events.length;
  sink.delta("late reply");
  sink.toolUpdate("old", { output: "late" });
  assert.equal(h.events.length, count);
  assert.equal(h.store.thread(thread.id), undefined);
  assert.equal(fs.existsSync(path.join(h.home, "app/threads", `${thread.id}.json`)), false);
  assert.equal(fs.existsSync(thread.cwd), false);
});

test("backend failure closes pending approval cards before persisting", async () => {
  const h = harness();
  const project = h.store.addProject(gitRepo());
  let answer: Promise<"yes" | "no" | "always"> | undefined;
  const backend: Backend = { id: "mock", listModels: async () => [], dispose: async () => {}, async runTurn(_text, _o, sink) {
    answer = sink.approval({ question: "Run command?", canAlways: false });
    return { status: "failed", error: "server crashed" };
  } };
  const runner = new ThreadRunner({ ...h, backends: { mock: backend } });
  const thread = await runner.createThread(project.id);
  await runner.send(thread.id, "go");
  assert.equal(await answer, "no");
  const card = new Store(h.home).items(thread.id).find((i) => i.kind === "approval");
  assert.equal(card?.answer, "no");
});

test("project removal fences new work while waiting for active turns", async () => {
  const h = harness();
  const project = h.store.addProject(gitRepo());
  let finish!: (result: TurnResult) => void;
  const backend: Backend = { id: "mock", listModels: async () => [], dispose: async () => {}, runTurn() {
    return new Promise((resolve) => { finish = resolve; });
  } };
  const runner = new ThreadRunner({ ...h, backends: { mock: backend } });
  const thread = await runner.createThread(project.id);
  const idle = await runner.createThread(project.id);
  const run = runner.send(thread.id, "go");
  const removal = runner.removeProject(project.id);
  await assert.rejects(runner.createThread(project.id), /being removed/);
  await assert.rejects(runner.send(thread.id, "too late"), /being removed/);
  finish({ status: "interrupted" });
  await Promise.all([run, removal]);
  assert.equal(h.store.project(project.id), undefined);
  assert.equal(h.store.snapshot().threads.length, 0);
});

test("project removal waits for an already-started worktree creation", async () => {
  const h = harness();
  const repo = gitRepo();
  fs.mkdirSync(path.join(repo, "scripts"));
  fs.writeFileSync(path.join(repo, "scripts/worktree.sh"), '#!/bin/sh\nmkdir -p ".worktrees/$2"\nsleep 0.1\nprintf "%s/.worktrees/%s\\n" "$PWD" "$2"\n');
  const project = h.store.addProject(repo);
  const runner = new ThreadRunner(h);
  const creation = runner.createThread(project.id, { worktree: true });
  const removal = runner.removeProject(project.id);
  const thread = await creation;
  await removal;
  assert.equal(h.store.project(project.id), undefined);
  assert.equal(h.store.thread(thread.id), undefined);
  // Removing a project detaches it from Modex; the user's files/worktrees stay on disk.
  assert.equal(fs.existsSync(thread.cwd), true);
});

test("reading idle statuses does not load every transcript at startup", async () => {
  const h = harness();
  const project = h.store.addProject(gitRepo());
  const runner = new ThreadRunner(h);
  const threads = await Promise.all(Array.from({ length: 20 }, () => runner.createThread(project.id)));
  let reads = 0;
  const load = h.store.items.bind(h.store);
  h.store.items = (id) => { reads++; return load(id); };
  assert.deepEqual(threads.map((thread) => runner.status(thread.id)), Array(20).fill("idle"));
  assert.equal(reads, 0, "status-only reads must leave transcript loading to selection/send");
});

test("thread snapshots include live output before the next disk flush", async () => {
  const h = harness();
  const project = h.store.addProject(gitRepo());
  let finish!: (result: TurnResult) => void;
  const backend: Backend = { id: "mock", listModels: async () => [], dispose: async () => {}, runTurn(_text, _opts, sink) {
    sink.delta("not flushed yet");
    return new Promise((resolve) => { finish = resolve; });
  } };
  const runner = new ThreadRunner({ ...h, backends: { mock: backend } });
  const thread = await runner.createThread(project.id);
  const run = runner.send(thread.id, "go");
  // The renderer's thread:items handler calls runner.items, not Store.items.
  // Read both synchronously so the 250 ms persistence timer cannot run between them.
  assert.equal(h.store.items(thread.id).find((item) => item.kind === "assistant")?.text, "");
  assert.equal(runner.items(thread.id).find((item) => item.kind === "assistant")?.text, "not flushed yet");
  finish({ status: "completed" });
  await run;
  assert.equal(h.store.items(thread.id).find((item) => item.kind === "assistant")?.text, "not flushed yet");
});

test("a second Stop force-stops the backend when the first was not confirmed", async () => {
  const h = harness();
  const project = h.store.addProject(gitRepo());
  let forced = 0;
  let finish!: (result: TurnResult) => void;
  const backend: Backend = {
    id: "mock", listModels: async () => [], dispose: async () => {},
    forceStop: async () => { forced++; finish({ status: "interrupted" }); },
    runTurn: () => new Promise((resolve) => { finish = resolve; }),
  };
  const runner = new ThreadRunner({ ...h, backends: { mock: backend } });
  const thread = await runner.createThread(project.id);
  const run = runner.send(thread.id, "go");
  await new Promise((resolve) => setTimeout(resolve, 10));
  runner.stop(thread.id);
  assert.equal(forced, 0, "the first Stop only asks the CLI to stop");
  const deletion = runner.deleteThread(thread.id);
  await assert.rejects(runner.deleteThread(thread.id), /press Stop again/);
  runner.stop(thread.id);
  assert.equal(forced, 1);
  await Promise.all([run, deletion]);
  assert.equal(h.store.thread(thread.id), undefined);
  runner.stop(thread.id);
  assert.equal(forced, 1, "Stop on an idle thread never forces");
});

test("a second Stop without a force-capable backend keeps waiting", async () => {
  const h = harness();
  const project = h.store.addProject(gitRepo());
  let finish!: (result: TurnResult) => void;
  const backend: Backend = { id: "mock", listModels: async () => [], dispose: async () => {}, runTurn: () => new Promise((resolve) => { finish = resolve; }) };
  const runner = new ThreadRunner({ ...h, backends: { mock: backend } });
  const thread = await runner.createThread(project.id);
  const run = runner.send(thread.id, "go");
  await new Promise((resolve) => setTimeout(resolve, 10));
  runner.stop(thread.id);
  runner.stop(thread.id);
  assert.equal(runner.status(thread.id), "running");
  assert.equal(h.store.items(thread.id).some((item) => item.kind === "notice" && item.text.startsWith("Force-stopping")), false);
  finish({ status: "interrupted" });
  await run;
  assert.equal(runner.status(thread.id), "idle");
});

test("autonaming persists a generated title without adding a conversation turn", async () => {
  const h = harness();
  let titles = 0;
  const backend = Object.assign(h.backends.mock, { generateTitle: async () => { titles++; return "Fix login redirects"; } });
  const runner = new ThreadRunner({ ...h, backends: { mock: backend } });
  const thread = await runner.createThread(h.store.addProject(gitRepo()).id);
  try {
    await runner.send(thread.id, "please fix the login redirect issue");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.store.thread(thread.id)?.title, "Fix login redirects");
    assert.equal(new Store(h.home).thread(thread.id)?.title, "Fix login redirects");
    await runner.send(thread.id, "also cover logout");
    assert.equal(titles, 1);
    assert.equal(runner.items(thread.id).filter((i) => i.kind === "user").length, 2);
  } finally { await runner.dispose(); }
});

test("manual rename and deletion cancel pending autonaming", async () => {
  for (const action of ["rename", "delete"] as const) {
    const h = harness();
    let finish!: (title: string) => void;
    let signal: AbortSignal | undefined;
    const backend = Object.assign(h.backends.mock, { generateTitle: (_text: string, _opts: unknown, s: AbortSignal) => {
      signal = s;
      return new Promise<string>((resolve) => { finish = resolve; });
    } });
    const runner = new ThreadRunner({ ...h, backends: { mock: backend } });
    const thread = await runner.createThread(h.store.addProject(gitRepo()).id);
    try {
      await runner.send(thread.id, "fix login");
      assert.ok(signal, "title generation did not start");
      if (action === "rename") runner.updateThread(thread.id, { title: "My title" });
      else await runner.deleteThread(thread.id);
      assert.equal(signal.aborted, true);
      finish("Generated title");
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(h.store.thread(thread.id)?.title, action === "rename" ? "My title" : undefined);
    } finally { finish?.("late title"); await runner.dispose(); }
  }
});

test("shutdown waits for cancelled title generation to finish", async () => {
  const h = harness();
  let finish!: (title: null) => void;
  let signal: AbortSignal | undefined;
  const backend = Object.assign(h.backends.mock, { generateTitle: (_text: string, _opts: unknown, s: AbortSignal) => {
    signal = s;
    return new Promise<null>((resolve) => { finish = resolve; });
  } });
  const runner = new ThreadRunner({ ...h, backends: { mock: backend } });
  const thread = await runner.createThread(h.store.addProject(gitRepo()).id);
  await runner.send(thread.id, "fix login");
  let disposed = false;
  const closing = runner.dispose().then(() => { disposed = true; });
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(signal?.aborted, true);
    assert.equal(disposed, false);
  } finally { finish(null); await closing; }
});
