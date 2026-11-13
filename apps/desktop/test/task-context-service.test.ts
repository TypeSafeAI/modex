import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/main/engine/store.js";
import { ThreadRunner } from "../src/main/engine/runner.js";
import { TaskContextCapture } from "../src/main/engine/task-context-capture.js";
import { TaskContextService } from "../src/main/engine/task-context-service.js";
import { gitRepo, tmpdir } from "./helpers.js";
import type { ContextDraftOwner } from "../src/shared/task-context-evidence.js";

function setup(capture = new TaskContextCapture()) {
  const store = new Store(tmpdir("modex-context-service-"));
  const project = store.addProject(gitRepo());
  const other = store.addProject(gitRepo());
  const runner = new ThreadRunner({ home: store.dir, store, emit: () => {} });
  const service = new TaskContextService({ store, capture });
  const owner: ContextDraftOwner = { kind: "project", projectId: project.id, key: `draft:0:${project.id}` };
  return { store, project, other, runner, service, owner };
}

test("explicit draft selection stays main-bound and an admitted first thread consumes it once", async t => {
  const f = setup(); t.after(() => f.runner.dispose());
  const before = f.store.space.list().length;
  const opened = f.service.openContextDraft(f.owner);
  const selected = await f.service.selectTaskContext(opened, [{ kind: "file", path: "README.md" }]);
  assert.equal(selected.binding.revision, 1); assert.equal(selected.context.refs.length, 1);
  assert.equal(selected.context.refs[0]!.relations[0]!.provenance, "user-confirmed");
  assert.equal(selected.context.captures[0]!.revision.state, "available");
  const thread = await f.runner.createThread(f.project.id, { backend: "mock", auto: false });
  assert.throws(() => f.service.consumeContextDraft(selected.binding, thread.id, "U"), /created|bound/);
  f.service.bindCreatedThread(selected.binding, thread.id);
  const record = f.service.consumeContextDraft(selected.binding, thread.id, "U");
  assert.deepEqual(record, selected.context);
  assert.deepEqual(f.service.consumeContextDraft(selected.binding, thread.id, "U"), record);
  assert.throws(() => f.service.consumeContextDraft(selected.binding, thread.id, "U2"), /consumed|request/);
  await assert.rejects(f.service.selectTaskContext(selected.binding, []), /draft|consumed/);
  assert.equal(f.store.space.list().length, before, "context selection creates no Notes");
});

test("stale revisions, forged owner and foreign or moved Notes cannot modify selected context", async t => {
  const f = setup(); t.after(() => f.runner.dispose());
  const binding = f.service.openContextDraft(f.owner);
  const selected = await f.service.selectTaskContext(binding, [{ kind: "file", path: "README.md" }]);
  await assert.rejects(f.service.selectTaskContext(binding, []), /stale|revision/);
  await assert.rejects(f.service.selectTaskContext({ ...selected.binding, owner: { kind: "project", projectId: f.other.id, key: `draft:0:${f.other.id}` } }, []), /draft|owner/);
  const foreign = f.store.space.create({ containerId: f.store.space.projectFor(f.other.id)!.id, title: "Foreign", markdown: "outside secret" });
  await assert.rejects(f.service.selectTaskContext(selected.binding, [{ kind: "note", pageId: foreign.id }]), /outside|project/);
  assert.deepEqual(f.service.readDraft(selected.binding), selected.context);
  const own = f.store.space.create({ containerId: f.store.space.projectFor(f.project.id)!.id, title: "Own", markdown: "own" });
  f.store.space.moveNodes([own.id], f.store.space.projectFor(f.other.id)!.id);
  await assert.rejects(f.service.selectTaskContext(selected.binding, [{ kind: "note", pageId: own.id }]), /outside|project/);
});

test("closed or replaced drafts reject an old asynchronous capture before attaching it", async t => {
  const actual = new TaskContextCapture(); let enter!: () => void, resume!: () => void;
  const entered = new Promise<void>(r => { enter = r; }), held = new Promise<void>(r => { resume = r; });
  const capture = new class extends TaskContextCapture { override async captureSelection(...args: Parameters<TaskContextCapture["captureSelection"]>) { enter(); await held; return actual.captureSelection(...args); } };
  const f = setup(capture); t.after(() => f.runner.dispose());
  const binding = f.service.openContextDraft(f.owner);
  const pending = f.service.selectTaskContext(binding, [{ kind: "file", path: "README.md" }]);
  await entered; f.service.closeContextDraft(binding);
  const replacement = f.service.openContextDraft(f.owner); resume();
  await assert.rejects(pending, /draft|stale|closed/);
  assert.deepEqual(f.service.readDraft(replacement).refs, []);
});

test("project removal or a foreign thread prevents transfer despite a matching renderer nonce", async t => {
  const f = setup(); t.after(() => f.runner.dispose());
  const binding = f.service.openContextDraft(f.owner);
  const otherThread = await f.runner.createThread(f.other.id, { backend: "mock", auto: false });
  assert.throws(() => f.service.bindCreatedThread(binding, otherThread.id), /project|thread/);
  f.store.removeProject(f.project.id);
  await assert.rejects(f.service.selectTaskContext(binding, [{ kind: "file", path: "README.md" }]), /project|draft/);
});

test("explicit own-project Note selection records the returned revision and digest without creating or editing a Note", async t => {
  const f = setup(); t.after(() => f.runner.dispose());
  const note = f.store.space.create({ containerId: f.store.space.projectFor(f.project.id)!.id, title: "Selected", markdown: "abc" });
  const before = f.store.space.list();
  const binding = f.service.openContextDraft(f.owner);
  const selected = await f.service.selectTaskContext(binding, [{ kind: "note", pageId: note.id }]);
  assert.equal(selected.context.refs[0]!.relations[0]!.kind, "relevant");
  assert.deepEqual(selected.context.captures[0]!.revision, { state: "available", algorithm: "sha256", digest: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", bytes: 3, noteRevision: note.revision });
  assert.deepEqual(selected.context.captures[0]!.noteVersion, { via: "read", updatedAt: note.updatedAt, revision: note.revision });
  assert.equal(JSON.stringify(selected.context).includes('"markdown"'), false);
  assert.deepEqual(f.store.space.list(), before);
});

test("a Note moved or edited while hashing waits cannot attach to the selected project draft", async t => {
  for (const action of ["move", "edit"] as const) {
    let entered!: () => void, resume!: () => void;
    const started = new Promise<void>(r => { entered = r; }), held = new Promise<void>(r => { resume = r; });
    const capture = new TaskContextCapture({ reader: async () => { entered(); await held; return { state: "unavailable", reason: "missing" }; }, head: async () => ({ state: "unavailable", reason: "not-repository" }) });
    const f = setup(capture); t.after(() => f.runner.dispose());
    const note = f.store.space.create({ containerId: f.store.space.projectFor(f.project.id)!.id, title: "Selected", markdown: "abc" });
    const binding = f.service.openContextDraft(f.owner);
    const occupying = capture.capture(f.project.path, [{ kind: "file", path: "one" }, { kind: "file", path: "two" }], { kind: "human", actionId: "occupy", at: new Date().toISOString() }, "selected", new AbortController().signal);
    await started;
    const pending = f.service.selectTaskContext(binding, [{ kind: "note", pageId: note.id }]);
    await new Promise<void>(resolve => setImmediate(resolve));
    if (action === "move") f.store.space.moveNodes([note.id], f.store.space.projectFor(f.other.id)!.id);
    else f.store.space.save({ ...note, markdown: "changed" });
    resume(); await occupying;
    await assert.rejects(pending, /stale|project|changed/);
    assert.equal(f.service.readDraft(binding).refs.length, 0);
  }
});

test("one mixed file and Note selection has one capture boundary and repository HEAD observation", async t => {
  let heads = 0;
  const capture = new TaskContextCapture({ head: async () => { heads++; return { state: "unavailable", reason: "not-repository" }; } });
  const f = setup(capture); t.after(() => f.runner.dispose());
  const note = f.store.space.create({ containerId: f.store.space.projectFor(f.project.id)!.id, title: "Selected", markdown: "abc" });
  const binding = f.service.openContextDraft(f.owner);
  const selected = await f.service.selectTaskContext(binding, [{ kind: "note", pageId: note.id }, { kind: "file", path: "README.md" }]);
  assert.equal(heads, 1, "file and Note jobs share one boundary/budget rather than independent batches");
  assert.equal(selected.context.captures.length, 2);
});

test("a first-send worktree keeps original selection provenance and marks its new workspace uncaptured", async t => {
  const f = setup(); t.after(() => f.runner.dispose());
  const binding = f.service.openContextDraft(f.owner);
  const selected = await f.service.selectTaskContext(binding, [{ kind: "file", path: "README.md" }]);
  assert.deepEqual(selected.context.captures[0]!.workspace, { kind: "project", projectId: f.project.id });
  const thread = await f.runner.createThread(f.project.id, { backend: "mock", auto: false, worktree: true });
  assert.notEqual(thread.cwd, f.project.path);
  f.service.bindCreatedThread(selected.binding, thread.id);
  const consumed = f.service.consumeContextDraft(selected.binding, thread.id, "U");
  assert.equal(consumed.captures.length, 2);
  assert.deepEqual(consumed.captures[0]!.revision, selected.context.captures[0]!.revision);
  assert.deepEqual(consumed.captures[1]!.workspace, { kind: "thread", projectId: f.project.id, threadId: thread.id });
  assert.deepEqual(consumed.captures[1]!.revision, { state: "unavailable", reason: "not-captured" });
  assert.equal(consumed.refs[0]!.captureIds.length, 2);
});

test("cancelling a removal's pending capture preserves previously accepted selections", async t => {
  let entered!: () => void;
  const started = new Promise<void>(r => { entered = r; });
  let calls = 0;
  const capture = new class extends TaskContextCapture {
    override async captureSelection(...args: Parameters<TaskContextCapture["captureSelection"]>) {
      if (++calls > 1) {
        entered();
        await new Promise<void>(resolve => { if (args[5].aborted) resolve(); else args[5].addEventListener("abort", () => resolve(), { once: true }); });
      }
      return super.captureSelection(...args);
    }
  };
  const f = setup(capture); t.after(() => f.runner.dispose());
  const selected = await f.service.selectTaskContext(f.service.openContextDraft(f.owner), [{ kind: "file", path: "README.md" }]);
  const pending = f.service.selectTaskContext(selected.binding, [{ kind: "file", path: "README.md" }, { kind: "file", path: "package.json" }]);
  await started; f.service.cancelProjectCaptures(f.project.id);
  await assert.rejects(pending, /stale|draft/);
  assert.deepEqual(f.service.readDraft(selected.binding), selected.context, "a refused removal can keep its original confirmed context");
});

test("after transfer, repeated reads use the authoritative stored turn and never invent a missing record", async t => {
  const f = setup(); t.after(() => f.runner.dispose());
  const selected = await f.service.selectTaskContext(f.service.openContextDraft(f.owner), [{ kind: "file", path: "README.md" }]);
  const thread = await f.runner.createThread(f.project.id, { backend: "mock", auto: false });
  f.service.bindCreatedThread(selected.binding, thread.id);
  const admitted = f.service.consumeContextDraft(selected.binding, thread.id, "U");
  const stored = structuredClone(admitted); stored.revision++;
  const user = { kind: "user" as const, id: "U", text: "Check", at: new Date().toISOString(), contextEvidence: stored };
  f.store.saveItems(thread.id, [user]);
  assert.deepEqual(f.service.consumeContextDraft(selected.binding, thread.id, "U"), stored);
  f.store.saveItems(thread.id, [{ kind: "user", id: "U", text: "Check", at: user.at }]);
  assert.throws(() => f.service.consumeContextDraft(selected.binding, thread.id, "U"), /context|record|preserved/);
});
