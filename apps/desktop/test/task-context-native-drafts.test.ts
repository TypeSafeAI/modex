import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Store } from "../src/main/engine/store.js";
import { ThreadRunner } from "../src/main/engine/runner.js";
import { AttachmentStore } from "../src/main/engine/attachments.js";
import { NativeDrafts } from "../src/main/engine/native-drafts.js";
import { isPendingTaskContext, type ContextDraftOwner, type TaskContextEvidence } from "../src/shared/task-context-evidence.js";
import type { ComposerRecovery } from "../src/shared/update-recovery.js";
import { tmpdir } from "./helpers.js";
import { admittedTaskContext } from "./task-context-assertions.js";

const native = { skip: process.platform === "win32" };
const configuration = { worktree: false, settings: { backend: "mock" as const, mode: "agent" as const, plan: false, auto: false, model: "mock" } };
function stack(home: string, turns: string[]) {
  const store = new Store(home);
  const attachments = new AttachmentStore(path.join(home, "attachments"), {
    authorizeDraft: owner => owner.kind === "project" ? !!store.project(owner.projectId) : !!store.thread(owner.threadId),
    authorizeTransfer: (owner, threadId) => owner.kind === "thread" ? owner.threadId === threadId : store.thread(threadId)?.projectId === owner.projectId,
  });
  const runner = new ThreadRunner({ home, store, attachments, emit: () => {}, backends: { mock: { id: "mock", runTurn: async text => { turns.push(text); return { status: "completed" }; }, listModels: async () => [], dispose: async () => {} } } });
  return { store, runner, attachments, controller: new NativeDrafts({ store, runner, attachments }) };
}
async function fixture(t: TestContext) {
  const home = tmpdir("modex-context-native-"), turns: string[] = [];
  const h = stack(home, turns), project = h.store.addProject(home);
  fs.writeFileSync(path.join(home, "selected.ts"), "file-body-must-stay-local");
  const owner: ContextDraftOwner = { kind: "project", projectId: project.id, key: `draft:0:${project.id}` };
  const { session } = h.controller.open();
  const binding = h.runner.openContextDraft(owner);
  const selected = await h.runner.selectTaskContext(binding, [{ kind: "file", path: "selected.ts" }]);
  const before: ComposerRecovery = { threads: [], projects: [{ key: owner.key, projectId: project.id, text: " Check ", attachments: [] }], selectedThreadId: null, draft: { revision: 0, projectId: project.id, ...configuration } };
  h.controller.save(session, { sequence: 1, snapshot: before });
  const runners = [h.runner]; t.after(async () => { for (const runner of runners) await runner.dispose(); });
  return { ...h, home, project, owner, session, selected, before, turns, runners };
}
function context(value: unknown): { owner: ContextDraftOwner; projectId: string; evidence: TaskContextEvidence } | undefined {
  return (value as { context?: { owner: ContextDraftOwner; projectId: string; evidence: TaskContextEvidence } } | null)?.context;
}

async function transfer(h: ReturnType<typeof stack>, session: string, intentId: string, before: ComposerRecovery) {
  const thread = await h.controller.create(session, intentId);
  const after: ComposerRecovery = { ...before, selectedThreadId: thread.id, threads: [{ threadId: thread.id, text: "", attachments: [] }], projects: before.projects.map(p => ({ ...p, text: "", attachments: [] })) };
  assert.equal(h.controller.transfer(session, { id: "context-transfer", sequence: 2, snapshot: after, intentId, files: [] }).status, "committed");
  return thread;
}

test("native pending intent owns selected context and admits it exactly once without storing the editable nonce", native, async t => {
  const h = await fixture(t);
  const input = { source: h.owner, rawText: " Check ", configuration, files: [], contextDraft: h.selected.binding };
  const intent = h.controller.begin(h.session, input), original = h.controller.readPending(h.session, intent.id)!;
  assert.deepEqual(context(original)?.evidence, h.selected.context);
  assert.equal(JSON.stringify(original).includes(h.selected.binding.nonce), false);
  await assert.rejects(h.runner.selectTaskContext(h.selected.binding, []), /draft|stale/);
  const thread = await transfer(h, h.session, intent.id, h.before);
  const bound = context(h.controller.readPending(h.session, intent.id))!;
  await h.controller.send(h.session, intent.id);
  const user = new Store(h.home).items(thread.id).find(item => item.id === intent.id);
  assert.ok(user?.kind === "user"); admittedTaskContext(user.contextEvidence, bound.evidence, thread.id, user.id); assert.equal(user.text, " Check ");
  assert.equal(h.turns.length, 1); assert.ok(h.turns[0]!.includes("selected.ts")); assert.equal(h.turns[0]!.includes("file-body-must-stay-local"), false);
  assert.equal(h.controller.readPending(h.session, intent.id), null);
  await assert.rejects(h.controller.send(h.session, intent.id)); assert.equal(h.turns.length, 1);
});

test("restart retains canonical selected context without restoring an editable nonce or starting a turn", native, async t => {
  const h = await fixture(t);
  const input = { source: h.owner, rawText: " Check ", configuration, files: [], contextDraft: h.selected.binding };
  const intent = h.controller.begin(h.session, input);
  await h.runner.dispose(); h.controller.invalidate();
  const next = stack(h.home, h.turns); h.runners.push(next.runner); const opened = next.controller.open();
  assert.ok(opened.pendingIds.includes(intent.id)); assert.deepEqual(h.turns, []);
  assert.deepEqual(context(next.controller.readPending(opened.session, intent.id))?.evidence, h.selected.context);
  await assert.rejects(next.runner.selectTaskContext(h.selected.binding, []), /draft|stale/);
  const thread = await transfer(next, opened.session, intent.id, h.before);
  const bound = context(next.controller.readPending(opened.session, intent.id))!;
  await next.controller.send(opened.session, intent.id);
  const user = next.store.items(thread.id).find(item => item.id === intent.id);
  assert.ok(user?.kind === "user"); admittedTaskContext(user.contextEvidence, bound.evidence, thread.id, user.id); assert.equal(h.turns.length, 1);
});

test("native prewrite failure preserves canonical context for one later explicit send", native, async t => {
  const h = await fixture(t);
  const input = { source: h.owner, rawText: " Check ", configuration, files: [], contextDraft: h.selected.binding };
  const intent = h.controller.begin(h.session, input), thread = await transfer(h, h.session, intent.id, h.before);
  const original = h.controller.readPending(h.session, intent.id), save = h.store.saveItems.bind(h.store); let fail = true;
  t.mock.method(h.store, "saveItems", (id: string, items: Parameters<Store["saveItems"]>[1]) => { if (fail && items.some(item => item.kind === "user")) { fail = false; throw new Error("Synthetic native user prewrite"); } save(id, items); });
  await assert.rejects(h.controller.send(h.session, intent.id), /prewrite/);
  assert.deepEqual(h.controller.readPending(h.session, intent.id), original); assert.deepEqual(h.turns, []);
  await h.controller.send(h.session, intent.id);
  const user = h.store.items(thread.id).find(item => item.id === intent.id);
  assert.ok(user?.kind === "user"); admittedTaskContext(user.contextEvidence, context(original)!.evidence, thread.id, user.id); assert.equal(h.turns.length, 1);
});

test("native target binding preserves a large accepted selection and the existing encoded message allowance", native, async t => {
  const h = await fixture(t);
  const selected = await h.runner.selectTaskContext(h.selected.binding, Array.from({ length: 180 }, (_, i) => ({ kind: "file" as const, path: `${i}-${"x".repeat(3000)}.ts` })));
  assert.ok(Buffer.byteLength(JSON.stringify(selected.context)) < 2 * 1024 * 1024);
  const rawText = "é".repeat(1024 * 1024 - 1024);
  const before = structuredClone(h.before); before.projects[0]!.text = rawText;
  h.controller.save(h.session, { sequence: 2, snapshot: before });
  const intent = h.controller.begin(h.session, { source: h.owner, rawText, configuration, files: [], contextDraft: selected.binding });
  const thread = await h.controller.create(h.session, intent.id);
  const bound = h.controller.readPending(h.session, intent.id)!;
  assert.ok(Buffer.byteLength(JSON.stringify(context(bound))) > 2 * 1024 * 1024, "a valid target-bound context needs its own metadata budget");
  const again = await h.controller.create(h.session, intent.id);
  assert.equal(again.id, thread.id); assert.deepEqual(h.controller.readPending(h.session, intent.id), bound);
  const after = { ...before, selectedThreadId: thread.id, threads: [{ threadId: thread.id, text: "", attachments: [] }], projects: before.projects.map(p => ({ ...p, text: "" })) };
  assert.equal(h.controller.transfer(h.session, { id: "large-context-transfer", sequence: 3, snapshot: after, intentId: intent.id, files: [] }).status, "committed");
  await h.controller.send(h.session, intent.id);
  const user = new Store(h.home).items(thread.id).find(item => item.id === intent.id);
  assert.ok(user?.kind === "user"); assert.equal(user.text, rawText); admittedTaskContext(user.contextEvidence, context(bound)!.evidence, thread.id, user.id);
  assert.equal(h.turns.length, 1);
});

for (const defect of ["project", "owner", "capture", "relevance", "source"] as const) {
  test(`native pending recovery refuses changed context ${defect} and preserves the original bytes`, native, async t => {
    const h = await fixture(t);
    const intent = h.controller.begin(h.session, { source: h.owner, rawText: " Check ", configuration, files: [], contextDraft: h.selected.binding });
    const record = JSON.parse(JSON.stringify(h.controller.readPending(h.session, intent.id)));
    const metadata = record.context;
    if (defect === "project") metadata.projectId = "different-project";
    if (defect === "owner") metadata.owner = { kind: "thread", threadId: "different-thread" };
    if (defect === "capture") metadata.evidence.refs[0].captureIds = [];
    if (defect === "relevance") metadata.evidence.refs[0].relations = [];
    if (defect === "source") metadata.evidence.captures[0].workspace.projectId = "different-project";
    const file = path.join(h.store.dir, "pending-sends", `${intent.id}.json`), original = JSON.stringify(record);
    fs.writeFileSync(file, original);
    assert.throws(() => h.controller.readPending(h.session, intent.id), /recovery/i);
    assert.equal(fs.readFileSync(file, "utf8"), original); assert.deepEqual(h.turns, []);
    assert.equal(isPendingTaskContext(metadata), defect === "owner", "storage must additionally bind the structurally valid owner to the original intent");
  });
}

test("many short selected references survive canonical binding without borrowing the old message structural budget", native, async t => {
  const h = await fixture(t);
  const selected = await h.runner.selectTaskContext(h.selected.binding, Array.from({ length: 600 }, (_, i) => ({ kind: "file" as const, path: `missing-${i}.ts` })));
  assert.ok(Buffer.byteLength(JSON.stringify(selected.context)) < 2 * 1024 * 1024);
  const intent = h.controller.begin(h.session, { source: h.owner, rawText: " Check ", configuration, files: [], contextDraft: selected.binding });
  const thread = await transfer(h, h.session, intent.id, h.before);
  await h.controller.send(h.session, intent.id);
  const user = new Store(h.home).items(thread.id).find(item => item.id === intent.id);
  assert.ok(user?.kind === "user"); assert.equal(user.contextEvidence?.refs.length, 600); assert.equal(h.turns.length, 1);
});

for (const mismatch of [false, true]) {
  test(`restart after a durable user write ${mismatch ? "refuses changed context and preserves both records" : "retires matching pending context without starting a turn"}`, native, async t => {
    const h = await fixture(t);
    const intent = h.controller.begin(h.session, { source: h.owner, rawText: " Check ", configuration, files: [], contextDraft: h.selected.binding });
    const thread = await transfer(h, h.session, intent.id, h.before);
    const pendingFile = path.join(h.store.dir, "pending-sends", `${intent.id}.json`), unlink = fs.unlinkSync;
    let refuse = true;
    t.mock.method(fs, "unlinkSync", (file: Parameters<typeof fs.unlinkSync>[0]) => {
      if (String(file) === pendingFile && refuse) { refuse = false; throw new Error("Synthetic pending retirement failure"); }
      return unlink(file);
    });
    await assert.rejects(h.controller.send(h.session, intent.id), /recovery|uncertain/i);
    const bytes = fs.readFileSync(pendingFile), stored = new Store(h.home), items = stored.items(thread.id);
    const user = items.find(item => item.id === intent.id); assert.ok(user?.kind === "user");
    assert.deepEqual(user.contextEvidence, context(h.controller.readPending(h.session, intent.id))!.evidence); assert.deepEqual(h.turns, []);
    if (mismatch) { user.contextEvidence!.revision++; stored.saveItems(thread.id, items); }
    const transcript = fs.readFileSync(path.join(stored.dir, "threads", `${thread.id}.json`));
    h.controller.invalidate(); await h.runner.dispose();
    const restore = () => new NativeDrafts({ store: new Store(h.home), runner: h.runner, attachments: h.attachments });
    if (mismatch) {
      assert.throws(restore, /recovery/i); assert.deepEqual(fs.readFileSync(pendingFile), bytes);
      assert.deepEqual(fs.readFileSync(path.join(stored.dir, "threads", `${thread.id}.json`)), transcript);
    } else {
      const next = restore(), opened = next.open();
      assert.equal(opened.pendingIds.includes(intent.id), false); assert.equal(fs.existsSync(pendingFile), false);
      await assert.rejects(next.send(opened.session, intent.id));
    }
    assert.equal(new Store(h.home).items(thread.id).filter(item => item.kind === "user").length, 1); assert.deepEqual(h.turns, []);
  });
}
