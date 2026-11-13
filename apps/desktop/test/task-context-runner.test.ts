import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { Store } from "../src/main/engine/store.js";
import { ThreadRunner } from "../src/main/engine/runner.js";
import { TaskContextCapture } from "../src/main/engine/task-context-capture.js";
import { PagesAgents } from "../src/main/engine/pages-agents.js";
import { TaskContextAgents } from "../src/main/engine/task-context-agents.js";
import type { Backend, TurnSink } from "../src/main/engine/backends/types.js";
import type { ThreadEvent } from "../src/shared/types.js";
import type { TaskContextEvidence } from "../src/shared/task-context-evidence.js";
import { taskRecord } from "../src/shared/task-context.js";
import { gitRepo, tmpdir } from "./helpers.js";
import { CodexBackend } from "../src/main/engine/backends/codex.js";
import { FakeProcess, fakeSpawn } from "./fakeproc.js";
import { codexServer } from "./conversation-fixtures.js";

function setup(t: TestContext, run: Backend["runTurn"], capture = new TaskContextCapture(), backendId: "claude" | "codex" = "claude") {
  const home = tmpdir("modex-context-runner-"), store = new Store(home), project = store.addProject(gitRepo()), events: ThreadEvent[] = [];
  const pages = new PagesAgents({ space: store.space, notes: store.space, capture, enabled: id => store.project(id)?.pagesMaintenance === true,
    scope: id => { const p = store.space.projectFor(id); return p ? { id: p.id, rel: p.rel } : null; } });
  const proposals = new TaskContextAgents({ store });
  const runner = new ThreadRunner({ home, store, contextCapture: capture, pages, taskContext: proposals, emit: event => events.push(structuredClone(event)), backends: { [backendId]: { id: backendId, identity: () => "cli", listModels: async () => [], dispose: async () => {}, runTurn: (text: string, opts: Parameters<Backend["runTurn"]>[1], sink: TurnSink, signal: AbortSignal) => text === "Check" || text.startsWith("Check\n\nModex selected") ? run(text, opts, sink, signal) : Promise.resolve({ status: "completed" as const }) } } });
  t.after(async () => { await runner.dispose(); await pages.dispose(); await proposals.dispose(); });
  return { home, store, project, runner, events, proposals };
}
function user(home: string, threadId: string) {
  const item = new Store(home).items(threadId).find(item => item.kind === "user"); assert.ok(item?.kind === "user"); return item;
}
const native = { runtime: "synthetic-runtime", item: "read-1" };
function start(sink: TurnSink, filename: string) { sink.observe({ type: "tool.start", source: "read-start", native, tool: { name: "Read", title: "read file", args: { file_path: filename } } }); }

for (const [name, field] of [["Read", "file_path"], ["Write", "file_path"], ["NotebookEdit", "notebook_path"], ["Grep", "path"]] as const) {
  test(`credential redaction cannot turn a ${name} target into an observed decoy file`, async t => {
    const { claudeSecretSink } = await import("../src/main/engine/backends/claude-secret-sink.js");
    const secret = "sk-orca-synthetic-context-path-123456";
    const h = setup(t, async (_text, opts, sink) => {
      const protectedSink = claudeSecretSink(sink, secret);
      protectedSink.sink.observe({ type: "tool.start", native, tool: { name, title: "native target", args: { [field]: path.join(opts.cwd, "src", `${secret}.ts`) } } });
      protectedSink.sink.observe({ type: "tool.done", native, outcome: "succeeded" }); protectedSink.finish();
      return { status: "completed" };
    });
    fs.mkdirSync(path.join(h.project.path, "src"));
    fs.writeFileSync(path.join(h.project.path, "src", `${secret}.ts`), "actual target");
    fs.writeFileSync(path.join(h.project.path, "src", "[redacted].ts"), "different decoy");
    const thread = await h.runner.createThread(h.project.id, { backend: "claude", auto: false }); await h.runner.send(thread.id, "Check");
    const items = h.runner.items(thread.id), context = user(h.home, thread.id).contextEvidence;
    assert.deepEqual(context?.refs ?? [], [], "an unavailable native identity must not name the redacted decoy");
    assert.deepEqual(context?.captures ?? [], [], "the decoy must never be opened for a context hash");
    const record = taskRecord(items, { threadId: thread.id, title: "Task", cwd: h.project.path });
    assert.deepEqual(record.context?.files, []); assert.deepEqual(record.files, []);
    assert.equal(JSON.stringify(items).includes(secret), false);
  });
}

test("redacting a Write body preserves its public target and a genuine literal redaction-marker filename", async t => {
  const { claudeSecretSink } = await import("../src/main/engine/backends/claude-secret-sink.js");
  const secret = "sk-orca-synthetic-context-body-123456";
  const h = setup(t, async (_text, opts, sink) => {
    const protectedSink = claudeSecretSink(sink, secret);
    for (const filename of ["README.md", "[redacted].ts"]) {
      const ref = { runtime: "fixture", item: filename };
      protectedSink.sink.observe({ type: "tool.start", native: ref, tool: { name: "Write", title: "Write public file", args: { file_path: path.join(opts.cwd, filename), content: secret } } });
      protectedSink.sink.observe({ type: "tool.done", native: ref, outcome: "succeeded" });
    }
    protectedSink.finish(); return { status: "completed" };
  });
  fs.writeFileSync(path.join(h.project.path, "[redacted].ts"), "literal file");
  const thread = await h.runner.createThread(h.project.id, { backend: "claude", auto: false }); await h.runner.send(thread.id, "Check");
  const items = h.runner.items(thread.id), context = user(h.home, thread.id).contextEvidence!;
  assert.deepEqual(context.refs.map(r => r.target), [{ kind: "file", path: "README.md" }, { kind: "file", path: "[redacted].ts" }]);
  assert.equal(context.captures.length, 2); assert.equal(JSON.stringify(items).includes(secret), false);
});

for (const shape of ["actions", "cwd", "patch"] as const) {
  test(`Codex credential redaction preserves only real public targets for ${shape}`, async t => {
    const secret = "synthetic-codex-context-credential-123456", proc = new FakeProcess();
    const backend = new CodexBackend("codex", fakeSpawn(proc).spawn, { args: [], env: {}, redact: text => text.split(secret).join("[redacted]") });
    t.after(() => backend.dispose());
    const h = setup(t, (text, opts, sink, signal) => backend.runTurn(text, opts, sink, signal), undefined, "codex");
    fs.mkdirSync(path.join(h.project.path, "src"));
    fs.writeFileSync(path.join(h.project.path, "src", "literal-[redacted].ts"), "decoy");
    fs.mkdirSync(path.join(h.project.path, "[redacted]")); fs.writeFileSync(path.join(h.project.path, "[redacted]", "README.md"), "cwd decoy");
    const item = shape === "patch" ? { type: "fileChange", id: "patch", changes: [
      { path: path.join(h.project.path, "src", `${secret}.ts`), kind: { type: "update" }, diff: "" },
      { path: path.join(h.project.path, "README.md"), kind: { type: "update", move_path: path.join(h.project.path, `${secret}.md`) }, diff: secret },
      { path: path.join(h.project.path, "src", "literal-[redacted].ts"), kind: { type: "update" }, diff: "" },
    ] } : { type: "commandExecution", id: "read", command: `cat ${secret}`, cwd: shape === "cwd" ? path.join(h.project.path, secret) : h.project.path, commandActions: [
      { type: "unknown" }, { type: "read", path: shape === "cwd" ? "README.md" : `src/${secret}.ts` },
      { type: "read", path: path.join(h.project.path, "README.md") },
      { type: "read", path: path.join(h.project.path, "src", "literal-[redacted].ts") },
    ] };
    const params = { threadId: "fixture-thread", turnId: "fixture-turn" };
    codexServer(proc, [
      { method: "turn/started", params: { threadId: params.threadId, turn: { id: params.turnId } } },
      { method: "item/started", params: { ...params, item } },
      { method: "item/completed", params: { ...params, item: { ...item, status: "completed", exitCode: 0 } } },
      { method: "turn/completed", params: { threadId: params.threadId, turn: { id: params.turnId, status: "completed" } } },
    ].map(line => JSON.stringify(line)));
    const thread = await h.runner.createThread(h.project.id, { backend: "codex", auto: false }); await h.runner.send(thread.id, "Check");
    const items = h.runner.items(thread.id), context = user(h.home, thread.id).contextEvidence!;
    assert.deepEqual(context.refs.map(ref => ref.target), [{ kind: "file", path: "README.md" }, { kind: "file", path: "src/literal-[redacted].ts" }]);
    assert.equal(context.captures.length, 2);
    assert.equal(JSON.stringify(items).includes(secret), false);
    assert.deepEqual(taskRecord(items, { threadId: thread.id, title: "Task", cwd: h.project.path }).context?.files.map(file => file.path), ["README.md", "src/literal-[redacted].ts"]);
  });
}

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

test("independent model proposals persist roles before reply and return opaque IDs without changing a frozen task", async t => {
  let enter!: () => void, release!: () => void, result: { refIds: string[]; accepted: number } | undefined;
  const entered = new Promise<void>(r => { enter = r; }), held = new Promise<void>(r => { release = r; });
  const h = setup(t, async (_text, opts) => {
    enter(); await held; assert.ok(opts.taskContext, "runner must attach the independent proposal channel");
    const response = await fetch(opts.taskContext.url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: "proposal-1", method: "tools/call", params: { name: "propose_refs", arguments: { refs: [
      { target: { kind: "file", path: "README.md" }, role: "file" }, { target: { kind: "file", path: "README.md" }, role: "test" }, { target: { kind: "note", pageId: note.id }, role: "note" },
    ] } } }) });
    const body = await response.json() as { result: { isError?: boolean; content: { text: string }[] } };
    assert.equal(body.result.isError, undefined); result = JSON.parse(body.result.content[0]!.text);
    const durable = user(h.home, thread.id).contextEvidence!;
    assert.equal(durable.refs.length, 2, "metadata must be on disk before the proposal reply");
    return { status: "completed" };
  });
  const note = h.store.space.create({ containerId: h.store.space.projectFor(h.project.id)!.id, title: "Candidate", markdown: "unread-private-note-body" });
  const thread = await h.runner.createThread(h.project.id, { backend: "claude", auto: false });
  const selected = await h.runner.selectTaskContext(h.runner.openContextDraft({ kind: "thread", threadId: thread.id }), [{ kind: "file", path: "README.md" }]);
  const running = h.runner.send(thread.id, "Check", [], "desktop", selected.binding); t.after(async () => { release(); await running; }); await entered;
  const initial = user(h.home, thread.id), saved = h.runner.saveTaskNote(thread.id, initial.id), frozen = structuredClone(h.store.space.taskSnapshot(saved.pageId));
  release(); await running;
  assert.ok(result); assert.equal(result.accepted, 2); assert.equal(new Set(result.refIds).size, 2);
  assert.ok(result.refIds.every(id => /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id)));
  const context = user(h.home, thread.id).contextEvidence!;
  assert.deepEqual(context.refs.map(ref => ref.id).sort(), [...result.refIds].sort()); assert.equal(context.captures.length, 1); assert.deepEqual(context.checks, []);
  assert.deepEqual(context.refs.flatMap(ref => ref.relations.filter(r => r.provenance === "model-proposed").map(r => "role" in r ? r.role : undefined)), ["file", "test", "note"]);
  assert.equal(context.refs.some(ref => ref.relations.some(r => r.provenance === "observed")), false);
  assert.equal(JSON.stringify(context).includes("unread-private-note-body"), false); assert.deepEqual(h.store.space.taskSnapshot(saved.pageId), frozen);
  assert.equal(h.store.project(h.project.id)!.pagesMaintenance, undefined);
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
  assert.deepEqual(taskRecord(h.runner.items(thread.id), { threadId: thread.id, title: "Task", cwd: h.project.path }).context?.files.map(file => file.path), [relative]);
});

test("private attempt connections stay out of native streams, raw logs, diagnostics, session IDs and request cards", async t => {
  const secrets: string[] = []; let deniedWrites = 0;
  const h = setup(t, async (_text, opts, sink) => {
    assert.ok(opts.taskContext && opts.pages);
    for (const url of [opts.taskContext.url, opts.pages.url]) secrets.push(url, new URL(url).pathname.split("/").at(-1)!);
    const message = { runtime: "fixture", item: "message" }, reasoning = { runtime: "fixture", item: "reasoning" };
    sink.observe({ type: "message.start", native: message, phase: "final" });
    for (const secret of secrets) { sink.observe({ type: "message.delta", native: message, text: `before ${secret.slice(0, 11)}` }); sink.observe({ type: "message.delta", native: message, text: `${secret.slice(11)} after. ` }); }
    sink.observe({ type: "message.done", native: message });
    sink.observe({ type: "reasoning.start", native: reasoning });
    sink.observe({ type: "reasoning.delta", native: reasoning, representation: "summary", index: 0, text: secrets[1]!.slice(0, 17) });
    sink.observe({ type: "reasoning.delta", native: reasoning, representation: "summary", index: 0, text: `${secrets[1]!.slice(17)}.` });
    sink.observe({ type: "reasoning.done", native: reasoning });
    sink.observe({ type: "tool.start", native, tool: { name: "Read", title: `read ${secrets[0]}`, args: { file_path: "README.md", echoedConfiguration: secrets[0] } } });
    sink.output?.(native, "x".repeat(300000) + secrets[0]!.slice(0, 25)); sink.output?.(native, secrets[0]!.slice(25) + " done.");
    sink.observe({ type: "tool.update", native, progress: { output: secrets[2]!.slice(0, 23) } });
    sink.observe({ type: "tool.done", native, outcome: "succeeded", progress: { output: `result ${secrets[2]}` } });
    const control = new AbortController(), request = { runtime: "fixture", request: "private-approval" };
    const answer = sink.approval({ native: request, question: `Allow ${secrets[0]}?`, canAlways: true, action: { backend: "claude", tool: "Bash", title: "echo connection", input: { command: `echo ${secrets[1]}` } } }, control.signal);
    queueMicrotask(() => control.abort()); assert.equal(await answer, "no");
    await sink.deliverRequest?.(request, async () => { deniedWrites++; });
    const withdrawal = new AbortController();
    const question = sink.question?.({ native: { runtime: "fixture", request: "private-question" }, blocking: true, questions: [{ id: "q", header: "Context", text: secrets[2]!, options: null, allowOther: true, secret: false }] }, withdrawal.signal);
    queueMicrotask(() => withdrawal.abort()); await question;
    sink.notice("warn", `native diagnostic ${secrets[3]}`); sink.session(secrets[0]!);
    return { status: "failed", error: `reconnect ${secrets[0]}`, detail: { connection: secrets[2] }, recovery: [secrets[1]!] };
  });
  const thread = await h.runner.createThread(h.project.id, { backend: "claude", auto: false }); await h.runner.send(thread.id, "Check");
  const items = h.runner.items(thread.id), tool = items.find(item => item.kind === "tool"); assert.ok(tool?.kind === "tool");
  let logs = "", offset = 0;
  for (;;) { const page = h.runner.toolLogs.read(thread.id, tool.id, offset); assert.ok(page); logs += page.text; if (page.next === null) break; offset = page.next; }
  const published = JSON.stringify([items, new Store(h.home).items(thread.id), h.store.thread(thread.id), h.events, logs]);
  for (const secret of secrets) assert.equal(published.includes(secret), false, "private connection escaped through a native publication path");
  assert.equal(h.store.thread(thread.id)!.sessionHandle, undefined); assert.equal(items.some(item => item.kind === "approval" || item.kind === "question"), false);
  assert.equal(deniedWrites, 1); assert.deepEqual(user(h.home, thread.id).contextEvidence!.refs.map(ref => ref.target), [{ kind: "file", path: "README.md" }]);
  assert.deepEqual(taskRecord(items, { threadId: thread.id, title: "Task", cwd: h.project.path }).context?.files.map(file => file.path), ["README.md"]);
});

test("secret-bearing native targets and another lease's token cannot become invented or model-proposed refs", async t => {
  const h = setup(t, async (_text, opts, sink) => {
    assert.ok(opts.pages && opts.taskContext); const token = new URL(opts.pages.url).pathname.split("/").at(-1)!;
    start(sink, `src/${token}.ts`); sink.observe({ type: "tool.done", native, outcome: "succeeded" });
    const response = await fetch(opts.taskContext.url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: "cross-lease-token", method: "tools/call", params: { name: "propose_refs", arguments: { refs: [{ target: { kind: "file", path: `src/${token}.ts` }, role: "file" }] } } }) });
    const body = await response.json() as { result: { isError?: boolean } }; assert.equal(body.result.isError, true);
    return { status: "completed" };
  });
  const thread = await h.runner.createThread(h.project.id, { backend: "claude", auto: false }); await h.runner.send(thread.id, "Check");
  assert.equal(user(h.home, thread.id).contextEvidence?.refs.length ?? 0, 0, "redacting display must not invent a different target identity");
  assert.deepEqual(taskRecord(h.runner.items(thread.id), { threadId: thread.id, title: "Task", cwd: h.project.path }).context?.files, [], "portable legacy context must not infer targets from redacted display input");
});

test("backend completion seals Notes admission before a different lease's asynchronous cleanup", async t => {
  let releaseHash!: () => void, hashEntered!: () => void, releaseCleanup!: () => void, cleanupEntered!: () => void;
  const heldHash = new Promise<void>(r => { releaseHash = r; }), hashing = new Promise<void>(r => { hashEntered = r; });
  const heldCleanup = new Promise<void>(r => { releaseCleanup = r; }), cleaning = new Promise<void>(r => { cleanupEntered = r; });
  const capture = new TaskContextCapture(), actualCapture = capture.captureNotes.bind(capture); let reply!: Promise<{ result?: { isError?: boolean } }>;
  t.mock.method(capture, "captureNotes", async (...args: Parameters<TaskContextCapture["captureNotes"]>) => { hashEntered(); await heldHash; return actualCapture(...args); });
  const h = setup(t, async (_text, opts) => {
    assert.ok(opts.pages);
    reply = fetch(opts.pages.url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: "late-read", method: "tools/call", params: { name: "read", arguments: { id: note.id } } }) }).then(response => response.json() as Promise<{ result?: { isError?: boolean } }>);
    await hashing; return { status: "completed" };
  }, capture);
  h.store.setPagesMaintenance(h.project.id, true);
  const note = h.store.space.create({ containerId: h.store.space.projectFor(h.project.id)!.id, title: "Late", markdown: "actual returned body" });
  const prepare = h.proposals.prepare.bind(h.proposals);
  t.mock.method(h.proposals, "prepare", async (...args: Parameters<TaskContextAgents["prepare"]>) => {
    const lease = await prepare(...args); return { ...lease, close: async () => { await lease.close(); cleanupEntered(); await heldCleanup; } };
  });
  const thread = await h.runner.createThread(h.project.id, { backend: "claude", auto: false }), running = h.runner.send(thread.id, "Check");
  try {
    await cleaning; releaseHash(); const response = await reply;
    assert.equal(response.result?.isError, true, "a successful backend result ends admission before cleanup awaits");
    assert.equal(user(h.home, thread.id).contextEvidence?.refs.length ?? 0, 0);
  } finally { releaseHash(); releaseCleanup(); await running; }
});

test("a connection cleanup failure after a backend exception cannot expose the private URL", async t => {
  let url = "";
  const h = setup(t, async (_text, opts) => { url = opts.taskContext!.url; throw new Error("Synthetic backend exception"); });
  const prepare = h.proposals.prepare.bind(h.proposals);
  t.mock.method(h.proposals, "prepare", async (...args: Parameters<TaskContextAgents["prepare"]>) => {
    const lease = await prepare(...args); return { ...lease, close: async () => { await lease.close(); throw new Error(`Synthetic close failure ${lease.connection.url}`); } };
  });
  const thread = await h.runner.createThread(h.project.id, { backend: "claude", auto: false }); await h.runner.send(thread.id, "Check");
  assert.ok(url); const published = JSON.stringify([h.runner.items(thread.id), h.events]);
  assert.equal(published.includes(url), false); assert.equal(published.includes(new URL(url).pathname.split("/").at(-1)!), false);
  assert.match(published, /Synthetic close failure/, "preserve the failure without its private connection");
  assert.match(published, /Synthetic backend exception/, "retain the first failure as well as cleanup evidence");
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
