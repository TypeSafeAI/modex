import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Store } from "../src/main/engine/store.js";
import { TaskContextService } from "../src/main/engine/task-context-service.js";
import { TaskContextCapture } from "../src/main/engine/task-context-capture.js";
import { ThreadRunner } from "../src/main/engine/runner.js";
import { NativeDrafts } from "../src/main/engine/native-drafts.js";
import { AttachmentStore } from "../src/main/engine/attachments.js";
import type { ContextDraftOwner } from "../src/shared/task-context-evidence.js";
import { gitRepo, tmpdir } from "./helpers.js";
import { admittedTaskContext } from "./task-context-assertions.js";

const native = { skip: process.platform === "win32" };
function fixture(capture = new TaskContextCapture()) {
  const home = tmpdir("modex-context-recovery-"), store = new Store(home), project = store.addProject(gitRepo());
  const owner: ContextDraftOwner = { kind: "project", projectId: project.id, key: `draft:0:${project.id}` };
  const service = new TaskContextService({ store, capture });
  return { home, store, project, owner, service };
}

function runtime(home: string, turns: string[]) {
  const store = new Store(home), attachments = new AttachmentStore(path.join(home, "attachments"), {
    authorizeDraft: owner => owner.kind === "project" ? !!store.project(owner.projectId) : !!store.thread(owner.threadId),
    authorizeTransfer: (owner, threadId) => owner.kind === "thread" ? owner.threadId === threadId : store.thread(threadId)?.projectId === owner.projectId,
  });
  const runner = new ThreadRunner({ home, store, attachments, emit: () => {}, backends: { mock: { id: "mock", runTurn: async text => { turns.push(text); return { status: "completed" }; }, listModels: async () => [], dispose: async () => {} } } });
  return { store, runner, controller: new NativeDrafts({ store, runner, attachments }) };
}
function recovered(home: string, owner: ContextDraftOwner) {
  const service = new TaskContextService({ store: new Store(home), capture: new TaskContextCapture() });
  try { return service.readDraft(service.openContextDraft(owner)); } finally { service.dispose(); }
}

test("an ordinary durable Send does not restore its consumed selection as a new draft", native, async t => {
  const h = fixture(), turns: string[] = [], app = runtime(h.home, turns); t.after(() => app.runner.dispose());
  const selected = await app.runner.selectTaskContext(app.runner.openContextDraft(h.owner), [{ kind: "file", path: "README.md" }]);
  const thread = await app.runner.createThread(h.project.id, { backend: "mock", auto: false, contextDraft: selected.binding });
  await app.runner.send(thread.id, "Check", [], "desktop", selected.binding); await app.runner.dispose();
  assert.deepEqual(recovered(h.home, h.owner).refs, []); assert.equal(turns.length, 1);
});

for (const mismatch of [false, true]) {
  test(`user write followed by failed draft retirement ${mismatch ? "preserves mismatched original records" : "reconciles as consumed without a turn"}`, native, async t => {
    const h = fixture(), turns: string[] = [], app = runtime(h.home, turns); t.after(() => app.runner.dispose());
    const selected = await app.runner.selectTaskContext(app.runner.openContextDraft(h.owner), [{ kind: "file", path: "README.md" }]);
    const thread = await app.runner.createThread(h.project.id, { backend: "mock", auto: false, contextDraft: selected.binding });
    const save = app.store.saveItems.bind(app.store), open = fs.openSync; let deny = false;
    t.mock.method(app.store, "saveItems", (id: string, items: Parameters<Store["saveItems"]>[1]) => { save(id, items); if (items.some(item => item.kind === "user")) deny = true; });
    t.mock.method(fs, "openSync", ((...args: Parameters<typeof fs.openSync>) => {
      if (deny && String(args[0]).includes(`${path.sep}context-drafts${path.sep}`) && String(args[0]).endsWith(".tmp")) throw new Error("Synthetic post-user draft retirement failure");
      return Reflect.apply(open, fs, args);
    }) as typeof fs.openSync);
    await assert.rejects(app.runner.send(thread.id, "Check", [], "desktop", selected.binding), /recovery|retirement/i);
    deny = false; assert.deepEqual(turns, []); await app.runner.dispose();
    if (mismatch) {
      const store = new Store(h.home), items = store.items(thread.id), user = items.find(item => item.kind === "user"); assert.ok(user?.kind === "user");
      user.contextEvidence!.refs[0]!.captureIds = []; store.saveItems(thread.id, items);
      const files = fs.readdirSync(path.join(store.dir, "context-drafts")).map(name => path.join(store.dir, "context-drafts", name));
      const bytes = files.map(file => fs.readFileSync(file));
      assert.throws(() => recovered(h.home, h.owner), /recovery/i);
      assert.deepEqual(files.map(file => fs.readFileSync(file)), bytes);
    } else assert.deepEqual(recovered(h.home, h.owner).refs, []);
    assert.deepEqual(turns, []);
  });
}

test("a durable native pending intent consumes canonical draft recovery before any turn or thread creation", native, async t => {
  const h = fixture(), turns: string[] = [], app = runtime(h.home, turns); t.after(() => app.runner.dispose());
  const selected = await app.runner.selectTaskContext(app.runner.openContextDraft(h.owner), [{ kind: "file", path: "README.md" }]);
  const { session } = app.controller.open();
  const intent = app.controller.begin(session, { source: h.owner, rawText: "Check", files: [], configuration: { worktree: false, settings: { backend: "mock", mode: "agent", model: "mock", auto: false, plan: false } }, contextDraft: selected.binding });
  await app.runner.dispose();
  assert.deepEqual(recovered(h.home, h.owner).refs, []);
  assert.equal(new Store(h.home).snapshot().threads.length, 0); assert.deepEqual(turns, []);
  const next = runtime(h.home, turns); t.after(() => next.runner.dispose()); const opened = next.controller.open();
  assert.ok(opened.pendingIds.includes(intent.id)); assert.deepEqual(next.controller.readPending(opened.session, intent.id)?.context?.evidence, selected.context);
});

test("document replacement during first-thread creation retains the reserved actual thread instead of creating another", native, async t => {
  const h = fixture(), turns: string[] = [], app = runtime(h.home, turns); t.after(() => app.runner.dispose());
  const selected = await app.runner.selectTaskContext(app.runner.openContextDraft(h.owner), [{ kind: "file", path: "README.md" }]);
  const pending = app.runner.createThread(h.project.id, { backend: "mock", auto: false, contextDraft: selected.binding }).then(value => ({ value }), error => ({ error }));
  app.runner.invalidateContextDocument(); await pending;
  const actual = app.store.snapshot().threads; assert.equal(actual.length, 1);
  const binding = app.runner.openContextDraft(h.owner);
  const thread = await app.runner.createThread(h.project.id, { backend: "mock", auto: false, contextDraft: binding });
  assert.equal(thread.id, actual[0]!.id); assert.equal(app.store.snapshot().threads.length, 1); assert.deepEqual(turns, []);
});

test("restart preserves a failed worktree creation as uncertain and never repeats its script from a fresh nonce", native, async t => {
  const h = fixture(), turns: string[] = [], app = runtime(h.home, turns); t.after(() => app.runner.dispose());
  fs.mkdirSync(path.join(h.project.path, "scripts"));
  fs.writeFileSync(path.join(h.project.path, "scripts", "worktree.sh"), "#!/bin/sh\nprintf 'attempt\\n' >> attempts.log\nexit 1\n", { mode: 0o700 });
  const selected = await app.runner.selectTaskContext(app.runner.openContextDraft(h.owner), [{ kind: "file", path: "README.md" }]);
  await assert.rejects(app.runner.createThread(h.project.id, { backend: "mock", auto: false, worktree: true, contextDraft: selected.binding }), /failed/);
  await app.runner.dispose();
  const next = runtime(h.home, turns); t.after(() => next.runner.dispose()); const binding = next.runner.openContextDraft(h.owner);
  assert.deepEqual(recovered(h.home, h.owner), selected.context);
  await assert.rejects(next.runner.createThread(h.project.id, { backend: "mock", auto: false, worktree: true, contextDraft: binding }), /uncertain|unresolved|recover/i);
  assert.equal(fs.readFileSync(path.join(h.project.path, "attempts.log"), "utf8"), "attempt\n");
  assert.equal(next.store.snapshot().threads.length, 0); assert.deepEqual(turns, []);
});

test("restart restores accepted unsent context under a fresh nonce without rereading selected files", native, async t => {
  const h = fixture(); t.after(() => h.service.dispose());
  const selected = await h.service.selectTaskContext(h.service.openContextDraft(h.owner), [{ kind: "file", path: "README.md" }]);
  h.service.dispose(); fs.writeFileSync(path.join(h.project.path, "README.md"), "changed after selection");
  const capture = new TaskContextCapture(); t.mock.method(capture, "captureSelection", async () => { throw new Error("Recovery must not capture files"); });
  const next = new TaskContextService({ store: new Store(h.home), capture }); t.after(() => next.dispose());
  const binding = next.openContextDraft(h.owner);
  assert.notEqual(binding.nonce, selected.binding.nonce); assert.deepEqual(next.readDraft(binding), selected.context);
  await assert.rejects(next.selectTaskContext(selected.binding, []), /draft|stale/);
  assert.equal(h.store.snapshot().threads.length, 0);
});

test("canonical composer identity is independent of JSON property order", native, async t => {
  const h = fixture(); t.after(() => h.service.dispose());
  const selected = await h.service.selectTaskContext(h.service.openContextDraft(h.owner), [{ kind: "file", path: "README.md" }]);
  assert.ok(h.owner.kind === "project");
  const reordered: ContextDraftOwner = { key: h.owner.key, projectId: h.owner.projectId, kind: "project" };
  const binding = h.service.openContextDraft(reordered); assert.deepEqual(h.service.readDraft(binding), selected.context);
});

for (const failure of ["before-pending", "after-pending"] as const) {
  test(`native ${failure} write failure preserves its exact recovery destination`, native, async t => {
    const h = fixture(), turns: string[] = [], app = runtime(h.home, turns); t.after(() => app.runner.dispose());
    const selected = await app.runner.selectTaskContext(app.runner.openContextDraft(h.owner), [{ kind: "file", path: "README.md" }]);
    assert.ok(h.owner.kind === "project");
    const source: ContextDraftOwner = { key: h.owner.key, projectId: h.owner.projectId, kind: "project" };
    const { session } = app.controller.open(), open = fs.openSync; let pendingWritten = false, denied = false;
    t.mock.method(fs, "openSync", ((...args: Parameters<typeof fs.openSync>) => {
      const name = String(args[0]);
      if (name.includes(`${path.sep}pending-sends${path.sep}`) && name.endsWith(".tmp")) {
        if (failure === "before-pending") { denied = true; throw new Error("Synthetic pending prewrite failure"); }
        pendingWritten = true;
      }
      if (failure === "after-pending" && pendingWritten && name.includes(`${path.sep}context-drafts${path.sep}`) && name.endsWith(".tmp")) { denied = true; throw new Error("Synthetic pending draft retirement failure"); }
      return Reflect.apply(open, fs, args);
    }) as typeof fs.openSync);
    assert.throws(() => app.controller.begin(session, { source, rawText: "Check", files: [], configuration: { worktree: false, settings: { backend: "mock", mode: "agent", model: "mock", auto: false, plan: false } }, contextDraft: selected.binding }), /recovery|prewrite|retirement/i);
    assert.equal(denied, true); t.mock.restoreAll(); await app.runner.dispose();
    const context = recovered(h.home, h.owner);
    assert.deepEqual(context, failure === "before-pending" ? selected.context : { revision: 0, refs: [], captures: [], checks: [] });
    const next = runtime(h.home, turns); t.after(() => next.runner.dispose());
    const opened = next.controller.open(); assert.equal(opened.pendingIds.length, failure === "before-pending" ? 0 : 1);
    if (failure === "after-pending") assert.deepEqual(next.controller.readPending(opened.session, opened.pendingIds[0]!)?.context?.evidence, selected.context);
    assert.equal(next.store.snapshot().threads.length, 0); assert.deepEqual(turns, []);
  });
}

test("document replacement preserves accepted selection and refuses the old document's pending capture", native, async t => {
  let enter!: () => void, resume!: () => void, hold = false;
  const entered = new Promise<void>(r => { enter = r; }), held = new Promise<void>(r => { resume = r; });
  const actual = new TaskContextCapture();
  const capture = new class extends TaskContextCapture {
    override async captureSelection(...args: Parameters<TaskContextCapture["captureSelection"]>) { if (hold) { enter(); await held; } return actual.captureSelection(...args); }
  };
  const h = fixture(capture); t.after(() => h.service.dispose());
  const selected = await h.service.selectTaskContext(h.service.openContextDraft(h.owner), [{ kind: "file", path: "README.md" }]);
  hold = true; const pending = h.service.selectTaskContext(selected.binding, [{ kind: "file", path: "other.ts" }]); await entered;
  h.service.invalidateDocument(); const replacement = h.service.openContextDraft(h.owner); resume();
  await assert.rejects(pending, /draft|stale/); assert.deepEqual(h.service.readDraft(replacement), selected.context);
  await assert.rejects(h.service.candidates(selected.binding), /draft|stale/);
});

test("a failed canonical selection write preserves the previous durable selection and revision", native, async t => {
  const h = fixture(); t.after(() => h.service.dispose());
  const selected = await h.service.selectTaskContext(h.service.openContextDraft(h.owner), [{ kind: "file", path: "README.md" }]);
  const open = fs.openSync; let denied = false;
  t.mock.method(fs, "openSync", ((...args: Parameters<typeof fs.openSync>) => {
    if (String(args[0]).includes(`${path.sep}context-drafts${path.sep}`) && String(args[0]).endsWith(".tmp")) { denied = true; throw new Error("Synthetic context prewrite failure"); }
    return Reflect.apply(open, fs, args);
  }) as typeof fs.openSync);
  await assert.rejects(h.service.selectTaskContext(selected.binding, [{ kind: "file", path: "other.ts" }]), /recovery|prewrite/i);
  assert.equal(denied, true); assert.deepEqual(h.service.readDraft(selected.binding), selected.context);
  const next = new TaskContextService({ store: new Store(h.home), capture: new TaskContextCapture() }); t.after(() => next.dispose());
  assert.deepEqual(next.readDraft(next.openContextDraft(h.owner)), selected.context);
});

test("an uncertain selection replacement retains both the original and attempted metadata for recovery", native, async t => {
  const h = fixture(); t.after(() => h.service.dispose());
  const selected = await h.service.selectTaskContext(h.service.openContextDraft(h.owner), [{ kind: "file", path: "README.md" }]);
  const directory = path.join(h.store.dir, "context-drafts"), identity = fs.statSync(directory), sync = fs.fsyncSync; let denied = false;
  t.mock.method(fs, "fsyncSync", (fd: number) => {
    const stat = fs.fstatSync(fd);
    if (!denied && stat.dev === identity.dev && stat.ino === identity.ino) { denied = true; throw new Error("Synthetic context directory durability failure"); }
    sync(fd);
  });
  await assert.rejects(h.service.selectTaskContext(selected.binding, [{ kind: "file", path: "other.ts" }]), /recovery|uncertain/i);
  assert.equal(denied, true); assert.deepEqual(h.service.readDraft(selected.binding), selected.context);
  const evidence = fs.readdirSync(directory).filter(name => name.endsWith(".json")).map(name => fs.readFileSync(path.join(directory, name), "utf8")).join("\n");
  assert.ok(evidence.includes(selected.context.captures[0]!.id), "the original accepted capture must survive an ambiguous replacement");
  assert.ok(evidence.includes("other.ts"), "retain the attempted replacement rather than claim it never happened");
  assert.throws(() => h.service.openContextDraft(h.owner), /recovery|uncertain/i, "the same uncertain writer must not silently reauthorize its evidence");
});

test("Stop promptly cancels pending thread context capture and preserves its accepted selection", native, async t => {
  const h = fixture(), turns: string[] = [], app = runtime(h.home, turns);
  const thread = await app.runner.createThread(h.project.id, { backend: "mock", auto: false });
  const owner: ContextDraftOwner = { kind: "thread", threadId: thread.id };
  const selected = await app.runner.selectTaskContext(app.runner.openContextDraft(owner), [{ kind: "file", path: "README.md" }]);
  fs.writeFileSync(path.join(h.project.path, "second.ts"), "second");
  let enter!: () => void, resume!: () => void;
  const entered = new Promise<void>(r => { enter = r; }), held = new Promise<void>(r => { resume = r; }), open = fsp.open;
  t.after(async () => { resume(); await app.runner.dispose(); });
  t.mock.method(fsp, "open", ((...args: Parameters<typeof fsp.open>) => {
    if (String(args[0]) === path.join(fs.realpathSync(h.project.path), "second.ts")) { enter(); return held.then(() => Reflect.apply(open, fsp, args)); }
    return Reflect.apply(open, fsp, args);
  }) as typeof fsp.open);
  let outcome: { result?: unknown; error?: Error } | undefined;
  const pending = app.runner.selectTaskContext(selected.binding, [{ kind: "file", path: "second.ts" }]).then(result => { outcome = { result }; }, error => { outcome = { error }; });
  await entered; app.runner.stop(thread.id); await new Promise<void>(resolve => setImmediate(resolve));
  assert.ok(outcome?.error, "Stop must settle the caller while the OS read is still held");
  assert.match(outcome.error.message, /draft|stale/);
  assert.deepEqual(app.runner.snapshotContextForPending(selected.binding, owner).evidence, selected.context); assert.deepEqual(turns, []);
  resume(); await pending;
});

test("restart after a pre-user-write failure restores the selection and exact created thread for one explicit Send", native, async t => {
  const h = fixture(), turns: string[] = [], app = runtime(h.home, turns); t.after(() => app.runner.dispose());
  const selected = await app.runner.selectTaskContext(app.runner.openContextDraft(h.owner), [{ kind: "file", path: "README.md" }]);
  const thread = await app.runner.createThread(h.project.id, { backend: "mock", auto: false, contextDraft: selected.binding });
  const save = app.store.saveItems.bind(app.store);
  t.mock.method(app.store, "saveItems", (id: string, items: Parameters<Store["saveItems"]>[1]) => { if (items.some(item => item.kind === "user")) throw new Error("Synthetic unsent user prewrite failure"); save(id, items); });
  await assert.rejects(app.runner.send(thread.id, "Check", [], "desktop", selected.binding), /prewrite/); await app.runner.dispose();
  assert.deepEqual(turns, []);
  const next = runtime(h.home, turns); t.after(() => next.runner.dispose()); const binding = next.runner.openContextDraft(h.owner);
  assert.notEqual(binding.nonce, selected.binding.nonce);
  const same = await next.runner.createThread(h.project.id, { backend: "mock", auto: false, contextDraft: binding });
  assert.equal(same.id, thread.id); assert.equal(next.store.snapshot().threads.length, 1);
  await next.runner.send(same.id, "Check", [], "desktop", binding);
  const user = next.store.items(same.id).find(item => item.kind === "user"); assert.ok(user?.kind === "user");
  admittedTaskContext(user.contextEvidence, selected.context, thread.id, user.id); assert.equal(turns.length, 1);
});

for (const defect of ["schema", "scope", "context-body", "owner"] as const) {
  test(`canonical recovery refuses changed ${defect} without replacing the stored evidence`, native, async t => {
    const h = fixture(); t.after(() => h.service.dispose());
    await h.service.selectTaskContext(h.service.openContextDraft(h.owner), [{ kind: "file", path: "README.md" }]); h.service.dispose();
    const directory = path.join(h.store.dir, "context-drafts"), file = path.join(directory, fs.readdirSync(directory)[0]!);
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (defect === "schema") data.schema = 99;
    if (defect === "scope") data.scope = "a".repeat(64);
    if (defect === "context-body") data.context.body = "must not become evidence";
    if (defect === "owner") data.owner.key = `draft:1:${h.project.id}`;
    const bytes = JSON.stringify(data); fs.writeFileSync(file, bytes);
    assert.throws(() => recovered(h.home, h.owner), /recovery|preserved/i);
    assert.equal(fs.readFileSync(file, "utf8"), bytes); assert.equal(fs.readdirSync(directory).length, 1);
  });
}
