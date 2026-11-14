import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/main/engine/store.js";
import { ThreadRunner } from "../src/main/engine/runner.js";
import type { TaskContextEvidence } from "../src/shared/task-context-evidence.js";
import { gitRepo, tmpdir } from "./helpers.js";

test("human relevance is revision-bound, reversible, body-free and durable without refreshing captures", async t => {
  const store = new Store(tmpdir("modex-context-confirm-")), project = store.addProject(gitRepo());
  const runner = new ThreadRunner({ home: store.dir, store, emit: () => {} }); t.after(() => runner.dispose());
  const thread = await runner.createThread(project.id, { backend: "mock", auto: false }), at = new Date().toISOString();
  const context: TaskContextEvidence = { revision: 1, refs: [{ id: "ref", target: { kind: "file", path: "README.md" }, relations: [{ kind: "relevant", provenance: "model-proposed", role: "file", source: { kind: "model-proposal", turn: { thread: thread.id, turn: "U", attempt: "A", backend: "mock" }, leaseId: "lease", receiptId: "receipt", requestId: "request", at } }], captureIds: [] }], captures: [], checks: [] };
  store.saveItems(thread.id, [{ kind: "user", id: "U", text: "Request", at, contextEvidence: context }]);
  const confirm = (runner as unknown as { confirmTaskContext?: (thread: string, turn: string, revision: number, refs: string[]) => TaskContextEvidence }).confirmTaskContext;
  assert.equal(typeof confirm, "function", "a renderer cannot mint a human confirmation receipt");
  const initial = runner.taskContext(thread.id, "U");
  assert.throws(() => confirm!.call(runner, thread.id, "foreign", 1, ["ref"]));
  assert.throws(() => confirm!.call(runner, thread.id, "U", 0, ["ref"]));
  assert.throws(() => confirm!.call(runner, thread.id, "U", 1, ["foreign"]));
  assert.deepEqual(runner.taskContext(thread.id, "U"), initial);
  const save = store.saveItems.bind(store); store.saveItems = () => { throw Error("synthetic confirmation storage failure"); };
  try { assert.throws(() => confirm!.call(runner, thread.id, "U", 1, ["ref"]), /synthetic confirmation storage failure/); }
  finally { store.saveItems = save; }
  assert.deepEqual(runner.taskContext(thread.id, "U"), initial);
  const result = confirm!.call(runner, thread.id, "U", 1, ["ref"]);
  assert.equal(result.revision, 2); assert.deepEqual(result.captures, []);
  assert.equal(result.refs[0]!.relations.filter(r => r.provenance === "model-proposed").length, 1);
  const human = result.refs[0]!.relations.find(r => r.provenance === "user-confirmed")!;
  assert.equal(human.source.kind, "human");
  assert.deepEqual(new Store(store.home).items(thread.id).find(i => i.kind === "user")!.contextEvidence, result);
  const cleared = confirm!.call(runner, thread.id, "U", result.revision, []);
  assert.equal(cleared.refs[0]!.relations.some(r => r.provenance === "user-confirmed"), false);
  assert.equal(cleared.refs[0]!.relations.some(r => r.provenance === "model-proposed"), true);
  assert.deepEqual(initial, context, "prior snapshots stay unchanged");
});

test("reading a recovered draft returns its metadata without recapture and rejects a closed nonce", async t => {
  const store = new Store(tmpdir("modex-context-draft-read-")), project = store.addProject(gitRepo());
  const runner = new ThreadRunner({ home: store.dir, store, emit: () => {} }); t.after(() => runner.dispose());
  const binding = runner.openContextDraft({ kind: "project", projectId: project.id, key: `draft:0:${project.id}` });
  const selected = await runner.selectTaskContext(binding, [{ kind: "file", path: "README.md" }]);
  const read = (runner as unknown as { draftTaskContext?: (value: typeof binding) => TaskContextEvidence }).draftTaskContext;
  assert.equal(typeof read, "function", "a read cannot be implemented by selecting and recapturing refs");
  const first = read!.call(runner, selected.binding); assert.deepEqual(first, selected.context);
  first.refs.length = 0; assert.deepEqual(read!.call(runner, selected.binding), selected.context);
  runner.closeContextDraft(selected.binding);
  assert.throws(() => read!.call(runner, selected.binding), /draft|stale/);
});
