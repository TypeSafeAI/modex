import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { Store } from "../src/main/engine/store.js";
import { ThreadRunner } from "../src/main/engine/runner.js";
import { TaskContextCapture } from "../src/main/engine/task-context-capture.js";
import { PagesAgents } from "../src/main/engine/pages-agents.js";
import type { Backend, TurnSink } from "../src/main/engine/backends/types.js";
import type { ThreadEvent } from "../src/shared/types.js";
import type { TaskContextEvidence } from "../src/shared/task-context-evidence.js";
import { gitRepo, tmpdir } from "./helpers.js";

function setup(t: TestContext, run: Backend["runTurn"], capture = new TaskContextCapture(), backendId: "claude" | "codex" = "claude") {
  const home = tmpdir("modex-context-runner-"), store = new Store(home), project = store.addProject(gitRepo()), events: ThreadEvent[] = [];
  const pages = new PagesAgents({ space: store.space, notes: store.space, capture, enabled: id => store.project(id)?.pagesMaintenance === true,
    scope: id => { const p = store.space.projectFor(id); return p ? { id: p.id, rel: p.rel } : null; } });
  const runner = new ThreadRunner({ home, store, contextCapture: capture, pages, emit: event => events.push(structuredClone(event)), backends: { [backendId]: { id: backendId, identity: () => "cli", listModels: async () => [], dispose: async () => {}, runTurn: (text: string, opts: Parameters<Backend["runTurn"]>[1], sink: TurnSink, signal: AbortSignal) => text === "Check" ? run(text, opts, sink, signal) : Promise.resolve({ status: "completed" as const }) } } });
  t.after(async () => { await runner.dispose(); await pages.dispose(); });
  return { home, store, project, runner, events };
}
function user(home: string, threadId: string) {
  const item = new Store(home).items(threadId).find(item => item.kind === "user"); assert.ok(item?.kind === "user"); return item;
}
const native = { runtime: "synthetic-runtime", item: "read-1" };
function start(sink: TurnSink, filename: string) { sink.observe({ type: "tool.start", source: "read-start", native, tool: { name: "Read", title: "read file", args: { file_path: filename } } }); }

test("accepted native read intent precedes success; duplicate completion records one body-free after-result capture", async t => {
  let enter!: () => void, finish!: () => void;
  const entered = new Promise<void>(r => { enter = r; }), held = new Promise<void>(r => { finish = r; });
  const capture = new TaskContextCapture(), actual = capture.capture.bind(capture); let captures = 0;
  t.mock.method(capture, "capture", (...args: Parameters<TaskContextCapture["capture"]>) => { captures++; return actual(...args); });
  const h = setup(t, async (_text, opts, sink) => {
    start(sink, path.join(opts.cwd, "README.md")); enter(); await held;
    sink.observe({ type: "tool.done", source: "read-done", native, outcome: "succeeded" });
    sink.observe({ type: "tool.done", source: "read-done-duplicate", native, outcome: "succeeded" });
    return { status: "completed" };
  }, capture);
  fs.writeFileSync(path.join(h.project.path, "README.md"), "private-file-body-f621");
  const thread = await h.runner.createThread(h.project.id, { backend: "claude", auto: false });
  const running = h.runner.send(thread.id, "Check"); t.after(async () => { finish(); await running; }); await entered;
  try {
    const pending = user(h.home, thread.id).contextEvidence; assert.ok(pending);
    assert.equal(pending.refs.length, 1); assert.deepEqual(pending.refs[0]!.target, { kind: "file", path: "README.md" });
    assert.deepEqual(pending.refs[0]!.relations.map(r => [r.kind, r.provenance]), [["read", "native-requested"]]); assert.equal(captures, 0);
  } finally { finish(); }
  await running; const context = user(h.home, thread.id).contextEvidence!;
  assert.equal(context.refs.length, 1); assert.equal(context.captures.length, 1); assert.equal(captures, 1);
  assert.deepEqual(context.refs[0]!.relations.map(r => r.provenance), ["native-requested", "observed"]);
  assert.equal(context.captures[0]!.phase, "after-native-result");
  assert.deepEqual(context.captures[0]!.revision, { state: "available", algorithm: "sha256", digest: createHash("sha256").update("private-file-body-f621").digest("hex"), bytes: 22 });
  const tool = h.runner.items(thread.id).find(item => item.kind === "tool"); assert.ok(tool?.kind === "tool" && tool.origin);
  assert.deepEqual(context.captures[0]!.source, { kind: "native", itemId: tool.id, origin: tool.origin });
  assert.equal(JSON.stringify(context).includes("private-file-body-f621"), false); assert.equal(context.refs[0]!.relations.some(r => r.kind === "relevant"), false);
});

test("native path identity survives transcript argument preview truncation", async t => {
  const relative = Array.from({ length: 223 }, (_, i) => `d${String(i).padStart(3, "0")}${"x".repeat(13)}`).join("/");
  const capture = new TaskContextCapture({ reader: async () => ({ state: "unavailable", reason: "missing" }) });
  const h = setup(t, async (_text, opts, sink) => {
    assert.ok(path.join(opts.cwd, relative).length > 4000);
    start(sink, path.join(opts.cwd, relative)); sink.observe({ type: "tool.done", native, outcome: "succeeded" }); return { status: "completed" };
  }, capture);
  const thread = await h.runner.createThread(h.project.id, { backend: "claude", auto: false }); await h.runner.send(thread.id, "Check");
  const context = user(h.home, thread.id).contextEvidence!;
  assert.deepEqual(context.refs.map(r => r.target), [{ kind: "file", path: relative }]);
  assert.deepEqual(context.captures[0]!.target, { kind: "file", path: relative });
});

test("successful Claude changes and structured searches retain separate operation relations without parsing output", async t => {
  const h = setup(t, async (_text, opts, sink) => {
    for (const [name, args] of [["Write", { file_path: path.join(opts.cwd, "created.ts") }], ["Edit", { file_path: "created.ts" }], ["Grep", { path: "created.ts", pattern: "x" }], ["Bash", { command: "cat invented.ts" }], ["Read", { file_path: "../private.txt" }]] as const) {
      const ref = { runtime: "synthetic", item: name };
      sink.observe({ type: "tool.start", native: ref, tool: { name, title: name, args } });
      sink.observe({ type: "tool.done", native: ref, outcome: "succeeded", progress: { output: "Read fabricated.ts and verified all checks" } });
    }
    return { status: "completed" };
  });
  fs.writeFileSync(path.join(h.project.path, "created.ts"), "x");
  const thread = await h.runner.createThread(h.project.id, { backend: "claude", auto: false }); await h.runner.send(thread.id, "Check");
  const context = user(h.home, thread.id).contextEvidence; assert.ok(context);
  assert.deepEqual(context.refs.map(r => r.target), [{ kind: "file", path: "created.ts" }]);
  assert.deepEqual(context.refs[0]!.relations.filter(r => r.provenance === "observed").map(r => r.kind), ["changed", "changed", "searched"]);
  assert.equal(context.captures.length, 3); assert.deepEqual(context.checks, []);
});

test("Codex native command actions use their reported cwd and ignore shell prose and outside paths", async t => {
  const h = setup(t, async (_text, opts, sink) => {
    sink.observe({ type: "tool.start", native, tool: { name: "shell", title: "native command", args: { command: "arbitrary" }, exec: { command: "arbitrary", cwd: path.join(opts.cwd, "sub"), actions: [{ kind: "read", path: "file.ts" }, { kind: "search", path: "file.ts", query: "x" }, { kind: "read", path: "../../private.txt" }] } } });
    sink.observe({ type: "tool.done", native, outcome: "succeeded" });
    return { status: "completed" };
  }, new TaskContextCapture(), "codex");
  fs.mkdirSync(path.join(h.project.path, "sub")); fs.writeFileSync(path.join(h.project.path, "sub/file.ts"), "x");
  const thread = await h.runner.createThread(h.project.id, { backend: "codex", auto: false }); await h.runner.send(thread.id, "Check");
  const context = user(h.home, thread.id).contextEvidence; assert.ok(context);
  assert.deepEqual(context.refs.map(r => r.target), [{ kind: "file", path: "sub/file.ts" }]);
  assert.deepEqual(context.refs[0]!.relations.filter(r => r.provenance === "observed").map(r => r.kind), ["read", "searched"]);
  assert.equal(context.captures.length, 1);
});

test("Codex final patch arguments record actual changed and moved paths when start had none", async t => {
  const h = setup(t, async (_text, _opts, sink) => {
    sink.observe({ type: "tool.start", native, tool: { name: "apply_patch", title: "edit", args: { files: [] } } });
    sink.observe({ type: "tool.done", native, outcome: "succeeded", progress: { args: { files: [{ path: "old.ts", movePath: "new.ts", kind: "update" }] } } });
    return { status: "completed" };
  }, new TaskContextCapture(), "codex");
  fs.writeFileSync(path.join(h.project.path, "new.ts"), "new");
  const thread = await h.runner.createThread(h.project.id, { backend: "codex", auto: false }); await h.runner.send(thread.id, "Check");
  const context = user(h.home, thread.id).contextEvidence; assert.ok(context);
  assert.deepEqual(context.refs.map(r => r.target), [{ kind: "file", path: "old.ts" }, { kind: "file", path: "new.ts" }]);
  assert.ok(context.refs.every(r => r.relations.some(r => r.kind === "changed" && r.provenance === "observed")));
  assert.deepEqual(context.captures[0]!.revision, { state: "unavailable", reason: "missing" }); assert.equal(context.captures[1]!.revision.state, "available");
});

test("Stop returns while a real capture slot is held and its late result cannot replace the unavailable receipt", async t => {
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(r => { release = r; }), started = new Promise<void>(r => { entered = r; });
  const capture = new TaskContextCapture({ reader: async () => { entered(); await held; return { state: "available", algorithm: "sha256", digest: "a".repeat(64), bytes: 1 }; } });
  const h = setup(t, async (_text, opts, sink) => { start(sink, path.join(opts.cwd, "README.md")); sink.observe({ type: "tool.done", native, outcome: "succeeded" }); return { status: "completed" }; }, capture);
  const thread = await h.runner.createThread(h.project.id, { backend: "claude", auto: false });
  const running = h.runner.send(thread.id, "Check"); t.after(async () => { release(); await running; }); await started;
  const before = user(h.home, thread.id).contextEvidence!; assert.deepEqual(before.captures[0]!.revision, { state: "unavailable", reason: "not-captured" });
  h.runner.stop(thread.id);
  await running;
  assert.deepEqual(user(h.home, thread.id).contextEvidence, before);
  release(); await new Promise<void>(r => setImmediate(r));
  assert.deepEqual(user(h.home, thread.id).contextEvidence, before);
});

test("a changed coding workspace invalidates a pending capture instead of relabeling its result", async t => {
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(r => { release = r; }), started = new Promise<void>(r => { entered = r; });
  const capture = new TaskContextCapture({ reader: async () => { entered(); await held; return { state: "available", algorithm: "sha256", digest: "b".repeat(64), bytes: 1 }; } });
  const h = setup(t, async (_text, opts, sink) => { start(sink, path.join(opts.cwd, "README.md")); sink.observe({ type: "tool.done", native, outcome: "succeeded" }); return { status: "completed" }; }, capture);
  const thread = await h.runner.createThread(h.project.id, { backend: "claude", auto: false });
  const running = h.runner.send(thread.id, "Check"); t.after(async () => { release(); await running; }); await started;
  const before = user(h.home, thread.id).contextEvidence!;
  h.store.updateThread(thread.id, { cwd: gitRepo() }); release(); await running;
  assert.deepEqual(user(h.home, thread.id).contextEvidence, before);
});

test("Retry preserves an unfinished receipt and rejects the old attempt's late capture and events", async t => {
  let release!: () => void, entered!: () => void, firstSink: TurnSink | undefined, reads = 0;
  const held = new Promise<void>(r => { release = r; }), started = new Promise<void>(r => { entered = r; });
  const capture = new TaskContextCapture({ reader: async () => {
    reads++;
    if (reads === 1) { entered(); await held; }
    return { state: "available", algorithm: "sha256", digest: (reads === 1 ? "a" : "d").repeat(64), bytes: 1 };
  } });
  const h = setup(t, async (_text, opts, sink) => {
    if (!firstSink) firstSink = sink;
    else start(firstSink, path.join(opts.cwd, "stale.ts"));
    start(sink, path.join(opts.cwd, "README.md")); sink.observe({ type: "tool.done", native, outcome: "succeeded" });
    return { status: "completed" };
  }, capture);
  const thread = await h.runner.createThread(h.project.id, { backend: "claude", auto: false });
  const running = h.runner.send(thread.id, "Check"); t.after(async () => { release(); await running; }); await started;
  h.runner.stop(thread.id); await running; await h.runner.retry(thread.id);
  const context = user(h.home, thread.id).contextEvidence!;
  assert.deepEqual(context.refs.map(r => r.target), [{ kind: "file", path: "README.md" }]); assert.equal(context.captures.length, 2);
  assert.deepEqual(context.captures[0]!.revision, { state: "unavailable", reason: "not-captured" });
  assert.equal(context.captures[1]!.revision.state, "available");
  assert.equal(new Set(context.captures.map(c => c.source.kind === "native" ? c.source.origin.attempt : "")).size, 2);
  release(); await new Promise<void>(r => setImmediate(r));
  assert.deepEqual(user(h.home, thread.id).contextEvidence, context);
  let reopenedReads = 0;
  const reopened = new ThreadRunner({ home: h.home, store: new Store(h.home), emit: () => {}, contextCapture: new TaskContextCapture({ reader: async () => { reopenedReads++; throw new Error("Unexpected recovery read"); } }) });
  try { assert.deepEqual(reopened.items(thread.id).find(item => item.kind === "user")?.contextEvidence, context); assert.equal(reopenedReads, 0); }
  finally { await reopened.dispose(); }
});

test("an asynchronous capture persistence failure retains its unavailable receipt in memory and on disk", async t => {
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(r => { release = r; }), started = new Promise<void>(r => { entered = r; });
  const capture = new TaskContextCapture({ reader: async () => { entered(); await held; return { state: "available", algorithm: "sha256", digest: "c".repeat(64), bytes: 1 }; } });
  const h = setup(t, async (_text, opts, sink) => { start(sink, path.join(opts.cwd, "README.md")); sink.observe({ type: "tool.done", native, outcome: "succeeded" }); return { status: "completed" }; }, capture);
  const thread = await h.runner.createThread(h.project.id, { backend: "claude", auto: false });
  const running = h.runner.send(thread.id, "Check"); t.after(async () => { release(); await running; }); await started;
  const before = user(h.home, thread.id).contextEvidence!, save = h.store.saveItems.bind(h.store);
  h.store.saveItems = (id, items) => { if (items.some(item => item.kind === "user" && item.contextEvidence?.captures.some(c => c.revision.state === "available"))) throw new Error("Synthetic capture persistence failure"); save(id, items); };
  t.after(() => { h.store.saveItems = save; }); release(); await running;
  assert.deepEqual(user(h.home, thread.id).contextEvidence, before);
  assert.deepEqual(h.runner.items(thread.id).find(item => item.kind === "user")?.contextEvidence, before);
  assert.equal(h.events.some(event => event.type === "item_update" && "contextEvidence" in event.patch && event.patch.contextEvidence?.captures.some(c => c.revision.state === "available")), false);
});

test("an uncertain post-rename context write preserves its disk candidate and fences further Store writes", async t => {
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(r => { release = r; }), started = new Promise<void>(r => { entered = r; });
  const capture = new TaskContextCapture({ reader: async () => { entered(); await held; return { state: "available", algorithm: "sha256", digest: "e".repeat(64), bytes: 1 }; } });
  const h = setup(t, async (_text, opts, sink) => { start(sink, path.join(opts.cwd, "README.md")); sink.observe({ type: "tool.done", native, outcome: "succeeded" }); return { status: "completed" }; }, capture);
  const thread = await h.runner.createThread(h.project.id, { backend: "claude", auto: false });
  const running = h.runner.send(thread.id, "Check"); await started;
  const before = user(h.home, thread.id).contextEvidence!, sync = fs.fsyncSync; let failed = false;
  const mock = t.mock.method(fs, "fsyncSync", (fd: number) => {
    if (!failed && fs.fstatSync(fd).isDirectory()) { failed = true; throw new Error("Synthetic post-rename directory sync failure"); }
    sync(fd);
  });
  release(); await assert.rejects(running, /storage requires recovery/i); mock.mock.restore();
  assert.equal(failed, true); assert.equal(h.store.supportsDurableAdmission, false);
  assert.deepEqual(h.runner.items(thread.id).find(item => item.kind === "user")?.contextEvidence, before);
  const disk = user(h.home, thread.id).contextEvidence!; assert.equal(disk.captures[0]!.revision.state, "available");
  assert.throws(() => h.store.saveItems(thread.id, h.runner.items(thread.id)), /storage requires recovery/i);
  assert.deepEqual(user(h.home, thread.id).contextEvidence, disk);
  assert.equal(h.events.some(event => event.type === "item_update" && "contextEvidence" in event.patch && event.patch.contextEvidence?.captures.some(c => c.revision.state === "available")), false);
});

for (const outcome of ["failed", "denied", "interrupted", "unknown"] as const) {
  test(`a native ${outcome} read never becomes observed or starts a hash`, async t => {
    const capture = new TaskContextCapture(); let captures = 0;
    t.mock.method(capture, "capture", async () => { captures++; return []; });
    const h = setup(t, async (_text, opts, sink) => { start(sink, path.join(opts.cwd, "README.md")); sink.observe({ type: "tool.done", native, outcome }); return { status: "completed" }; }, capture);
    const thread = await h.runner.createThread(h.project.id, { backend: "claude", auto: false }); await h.runner.send(thread.id, "Check");
    const context = user(h.home, thread.id).contextEvidence; assert.ok(context);
    assert.equal(context.refs.length, 1); assert.equal(context.refs[0]!.relations.some(r => r.provenance === "observed"), false); assert.equal(captures, 0);
  });
}

test("a metadata persistence failure cannot mutate live context or publish a false update", async t => {
  let caught: unknown; let install = () => {}, restore = () => {};
  const h = setup(t, async (_text, opts, sink) => { install(); try { start(sink, path.join(opts.cwd, "README.md")); } catch (error) { caught = error; } finally { restore(); } return { status: "failed", error: "fixture ended" }; });
  const save = h.store.saveItems.bind(h.store);
  install = () => { h.store.saveItems = (id, items) => { if (items.some(item => item.kind === "user" && item.contextEvidence)) throw new Error("Synthetic metadata persistence failure"); save(id, items); }; };
  restore = () => { h.store.saveItems = save; }; t.after(restore);
  const thread = await h.runner.createThread(h.project.id, { backend: "claude", auto: false }); await h.runner.send(thread.id, "Check");
  assert.ok(caught instanceof Error && /metadata persistence/.test(caught.message));
  assert.equal(user(h.home, thread.id).contextEvidence, undefined);
  assert.equal(h.runner.items(thread.id).find(item => item.kind === "user")?.contextEvidence, undefined);
  assert.equal(h.events.some(event => event.type === "item_update" && "contextEvidence" in event.patch), false);
});

test("actual runner Notes history receipts are durable before reply and rotate across explicit Retry", async t => {
  let h!: ReturnType<typeof setup>; const urls: string[] = [], durable: TaskContextEvidence[] = [];
  h = setup(t, async (_text, opts) => {
    assert.ok(opts.pages); urls.push(opts.pages.url);
    const response = await fetch(opts.pages.url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: "history-1", method: "tools/call", params: { name: "history", arguments: { id: note.id } } }) });
    const result = await response.json() as { result: { isError?: boolean } }; assert.equal(result.result.isError, undefined);
    const context = user(h.home, thread.id).contextEvidence; if (context) durable.push(context);
    return { status: "completed" };
  });
  h.store.setPagesMaintenance(h.project.id, true);
  const note = h.store.space.create({ containerId: h.store.space.projectFor(h.project.id)!.id, title: "Note", markdown: "current-nine" });
  t.mock.method(h.store.space, "history", () => [4, 8].map(revision => ({ page: { ...note, revision, markdown: `private-history-${revision}` }, actor: "human", summary: "history", checkpointAt: note.updatedAt })));
  const thread = await h.runner.createThread(h.project.id, { backend: "claude", auto: false }); await h.runner.send(thread.id, "Check"); await h.runner.retry(thread.id);
  assert.equal(durable.length, 2); assert.notEqual(urls[0], urls[1]);
  const context = user(h.home, thread.id).contextEvidence!; assert.equal(context.refs.length, 1); assert.equal(context.captures.length, 4);
  assert.deepEqual(context.captures.map(c => c.noteVersion?.revision), [8, 4, 8, 4]);
  const sources = context.refs[0]!.relations.map(r => r.source); assert.ok(sources.every(s => s.kind === "notes-read" && !s.nativeLink));
  assert.equal(new Set(sources.map(s => s.kind === "notes-read" ? s.turn.attempt : "")).size, 2);
  assert.equal(new Set(sources.map(s => s.kind === "notes-read" ? s.leaseId : "")).size, 2);
  for (const text of ["private-history-4", "private-history-8", ...urls.map(url => new URL(url).pathname.split("/").at(-1)!)]) assert.equal(JSON.stringify(context).includes(text), false);
});
