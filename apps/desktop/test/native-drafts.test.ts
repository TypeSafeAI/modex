import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { Store } from "../src/main/engine/store.js";
import { ThreadRunner } from "../src/main/engine/runner.js";
import { AttachmentStore } from "../src/main/engine/attachments.js";
import { NativeDrafts } from "../src/main/engine/native-drafts.js";
import { PendingSends } from "../src/main/engine/pending-sends.js";
import { UpdateRecovery } from "../src/main/engine/update-recovery.js";
import type { Attachment, AttachmentDraftOwner } from "../src/shared/attachments.js";
import type { ComposerRecovery } from "../src/shared/update-recovery.js";
const native = { skip: process.platform === "win32" };
const config = { worktree: false, settings: { backend: "mock" as const, mode: "agent" as const, plan: false, auto: false, model: "mock" } };
const stagedInput = (name: string) => [{ name, data: Buffer.from(`original ${name} bytes`).toString("base64") }];
async function fixture(t: TestContext) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "modex-native-drafts-"))), turns: string[] = [];
  const store = new Store(home), project = store.addProject(home);
  const attachments = new AttachmentStore(path.join(home, "attachments"), {
    authorizeDraft: owner => owner.kind === "project" ? !!store.project(owner.projectId) : !!store.thread(owner.threadId),
    authorizeTransfer: (owner, threadId) => owner.kind === "thread" ? owner.threadId === threadId : store.thread(threadId)?.projectId === owner.projectId,
  });
  const runner = new ThreadRunner({ home, store, attachments, emit: () => {}, backends: {
    mock: { id: "mock", listModels: async () => [], dispose: async () => {}, runTurn: async text => { turns.push(text); return { status: "completed" }; } },
  } });
  const controller = new NativeDrafts({ store, runner, attachments });
  const owner: AttachmentDraftOwner = { kind: "project", projectId: project.id, key: `draft:0:${project.id}` };
  const draft = (text: string, files: Attachment[]): ComposerRecovery => ({ threads: [], selectedThreadId: null,
    projects: [{ key: `draft:0:${project.id}`, projectId: project.id, text, attachments: files }], draft: { revision: 0, projectId: project.id, ...config } });
  const runners = [runner];
  t.after(async () => { for (const active of runners) await active.dispose(); fs.rmSync(home, { recursive: true, force: true }); });
  return { home, store, project, attachments, runner, controller, owner, draft, turns, runners };
}

// These compose the concrete main controller with real Store/Runner and disk
// ownership, using a mock backend. Electron frame/preload/App acceptance follows.
test("owner removal prunes only empty target references and preserves unrelated drafts, files and pending originals", native, async t => {
  const h = await fixture(t), { session } = h.controller.open();
  const thread = await h.runner.createThread(h.project.id, { backend: "mock", worktree: false });
  const otherPath = path.join(h.home, "other"); fs.mkdirSync(otherPath);
  const other = h.store.addProject(otherPath), owner: AttachmentDraftOwner = { kind: "project", projectId: other.id, key: `draft:0:${other.id}` };
  const files = h.controller.stage(session, owner, stagedInput("unrelated-draft.txt")).staged;
  const originalFiles = h.controller.stage(session, owner, stagedInput("unrelated-original.txt")).staged;
  const intent = h.controller.begin(session, { source: owner, rawText: "  preserved pending  ", configuration: config, files: originalFiles });
  const snapshot = h.draft("", []);
  snapshot.threads.push({ threadId: thread.id, text: "", attachments: [] }); snapshot.selectedThreadId = thread.id;
  snapshot.projects.push({ key: owner.key, projectId: other.id, text: "  unrelated raw 😀  ", attachments: files });
  const revision = h.controller.save(session, { sequence: 1, snapshot }).revision;
  const pendingFile = path.join(h.store.dir, "pending-sends", `${intent.id}.json`);
  const original = fs.readFileSync(pendingFile), manifest = fs.readFileSync(path.join(h.home, "attachments", ".manifest.json"));
  assert.throws(() => (h.controller as any).pruneEmptyOwner({ kind: "project", id: h.project.id }, revision), /held|removal/i);
  const release = (h.controller as any).holdForOwnerRemoval();
  try {
    const result = (h.controller as any).pruneEmptyOwner({ kind: "project", id: h.project.id }, revision);
    assert.equal(result.revision, revision + 1);
    assert.deepEqual(result.drafts, { threads: [], projects: [snapshot.projects[1]], selectedThreadId: null, draft: { ...snapshot.draft, projectId: other.id } });
    assert.deepEqual(h.controller.recovery.read().drafts, result.drafts);
    assert.ok(h.store.project(h.project.id)); assert.ok(h.store.thread(thread.id), "pruning is not owner deletion");
    assert.deepEqual(fs.readFileSync(pendingFile), original); assert.deepEqual(fs.readFileSync(path.join(h.home, "attachments", ".manifest.json")), manifest);
    assert.throws(() => h.controller.open(), /restart|removal/i);
    assert.throws(() => h.controller.stage(session, owner, stagedInput("late.txt")), /restart|removal/i);
  } finally { release(); }
});

for (const content of ["raw whitespace", "attachment"]) test(`owner removal preserves a target with ${content}`, native, async t => {
  const h = await fixture(t), { session } = h.controller.open();
  const files = content === "attachment" ? h.controller.stage(session, h.owner, stagedInput("keep.txt")).staged : [];
  const revision = h.controller.save(session, { sequence: 1, snapshot: h.draft(content === "raw whitespace" ? " \n " : "", files) }).revision;
  const file = path.join(h.store.dir, "update-recovery.json"), before = fs.readFileSync(file);
  const release = (h.controller as any).holdForOwnerRemoval();
  try {
    assert.throws(() => (h.controller as any).pruneEmptyOwner({ kind: "project", id: h.project.id }, revision), /draft|unsent/i);
    assert.deepEqual(fs.readFileSync(file), before); assert.ok(h.store.project(h.project.id));
  } finally { release(); }
});

for (const target of ["source", "bound thread"]) test(`owner removal preserves a pending original's ${target}`, native, async t => {
  const h = await fixture(t), { session } = h.controller.open();
  const intent = h.controller.begin(session, { source: h.owner, rawText: "pending raw", configuration: config, files: [] });
  const thread = target === "bound thread" ? await h.controller.create(session, intent.id) : null;
  const revision = h.controller.save(session, { sequence: 1, snapshot: h.draft("", []) }).revision;
  const file = path.join(h.store.dir, "pending-sends", `${intent.id}.json`), original = fs.readFileSync(file);
  const release = (h.controller as any).holdForOwnerRemoval();
  try {
    assert.throws(() => (h.controller as any).pruneEmptyOwner(thread ? { kind: "thread", id: thread.id } : { kind: "project", id: h.project.id }, revision), /pending|saved message/i);
    assert.deepEqual(fs.readFileSync(file), original); assert.deepEqual(h.turns, []);
  } finally { release(); }
});

for (const failure of ["stale revision", "unresolved update", "corrupt record"]) test(`owner removal refuses ${failure} without deleting or rewriting it`, native, async t => {
  const h = await fixture(t), { session } = h.controller.open();
  const revision = h.controller.save(session, { sequence: 1, snapshot: h.draft("", []) }).revision;
  const file = path.join(h.store.dir, "update-recovery.json");
  if (failure === "unresolved update") h.controller.recovery.beginAttempt({ from: "0.0.10", to: "0.0.11", sha512: Buffer.alloc(64, 2).toString("base64"), revision });
  if (failure === "corrupt record") fs.writeFileSync(file, "broken original");
  const before = fs.readFileSync(file), release = (h.controller as any).holdForOwnerRemoval();
  try {
    assert.throws(() => (h.controller as any).pruneEmptyOwner({ kind: "project", id: h.project.id }, failure === "stale revision" ? revision + 1 : revision));
    assert.deepEqual(fs.readFileSync(file), before); assert.ok(h.store.project(h.project.id));
  } finally { release(); }
});

test("uncertain owner pruning keeps all attachment mutations fenced after release", native, async t => {
  const h = await fixture(t), { session } = h.controller.open();
  const revision = h.controller.save(session, { sequence: 1, snapshot: h.draft("", []) }).revision;
  const commit = h.controller.recovery.commitDrafts.bind(h.controller.recovery);
  h.controller.recovery.commitDrafts = (...args) => { commit(...args); throw new Error("lost durable acknowledgment"); };
  const release = h.controller.holdForOwnerRemoval();
  assert.throws(() => h.controller.pruneEmptyOwner({ kind: "project", id: h.project.id }, revision), /lost durable/);
  release();
  const saved = fs.readFileSync(path.join(h.store.dir, "update-recovery.json"));
  assert.throws(() => h.controller.stage(session, h.owner, stagedInput("late.txt")));
  await assert.rejects(async () => h.controller.pick(session, h.owner, 1, async () => { assert.fail("picker must remain closed"); }));
  assert.throws(() => h.controller.discard(session, h.owner, []));
  assert.throws(() => h.controller.retire(session, h.owner));
  assert.throws(() => h.controller.save(session, { sequence: 2, snapshot: h.draft("late", []) }));
  assert.throws(() => h.controller.open());
  assert.deepEqual(fs.readFileSync(path.join(h.store.dir, "update-recovery.json")), saved);
  assert.deepEqual(h.controller.readOnly().drafts, { threads: [], projects: [], selectedThreadId: null, draft: null });
  assert.deepEqual(fs.readdirSync(h.attachments.staging), []); assert.ok(h.store.project(h.project.id));
});

test("read-only native recovery returns raw drafts and original messages without issuing or replacing document authority", native, async t => {
  const h = await fixture(t), { session } = h.controller.open();
  const files = h.controller.stage(session, h.owner, stagedInput("recover.txt")).staged;
  const saved = h.draft("  unsent raw 😀  ", files);
  h.controller.save(session, { sequence: 1, snapshot: saved });
  const intent = h.controller.begin(session, { source: h.owner, rawText: "  original raw  ", configuration: config, files });
  const recoveryFile = path.join(h.store.dir, "update-recovery.json"), pendingFile = path.join(h.store.dir, "pending-sends", `${intent.id}.json`);
  const before = [fs.readFileSync(recoveryFile), fs.readFileSync(pendingFile)];
  assert.equal(typeof (h.controller as any).readOnly, "function");
  const recovery = (h.controller as any).readOnly();
  assert.deepEqual(recovery.drafts, saved); assert.equal(recovery.pending[0].rawText, "  original raw  ");
  assert.equal(recovery.pending[0].id, intent.id); assert.equal("creation" in recovery.pending[0], false); assert.equal("session" in recovery, false);
  recovery.drafts.projects[0].text = "caller mutation"; recovery.pending[0].rawText = "caller mutation";
  assert.deepEqual((h.controller as any).readOnly().drafts, saved);
  assert.deepEqual([fs.readFileSync(recoveryFile), fs.readFileSync(pendingFile)], before);
  assert.equal(h.controller.readPending(session, intent.id)!.rawText, "  original raw  ", "read-only access did not reset the existing document");
  assert.deepEqual(h.turns, []);
});

test("read-only recovery remains available while native editing is held", native, async t => {
  const h = await fixture(t), { session } = h.controller.open(), saved = h.draft("held raw draft", []);
  h.controller.save(session, { sequence: 1, snapshot: saved });
  const release = h.controller.holdForRestart();
  try {
    assert.equal(typeof (h.controller as any).readOnly, "function");
    assert.deepEqual((h.controller as any).readOnly(), { drafts: saved, pending: [] });
    assert.throws(() => h.controller.open(), /restart/);
  } finally { release(); }
});

test("main native restart hold refuses pending originals and preserves their evidence", native, async t => {
  const h = await fixture(t), { session } = h.controller.open();
  const files = h.controller.stage(session, h.owner, stagedInput("pending.txt")).staged;
  const intent = h.controller.begin(session, { source: h.owner, rawText: "  pending  ", configuration: config, files });
  const file = path.join(h.store.dir, "pending-sends", `${intent.id}.json`), before = fs.readFileSync(file);
  assert.equal(typeof (h.controller as any).holdForRestart, "function");
  assert.throws(() => (h.controller as any).holdForRestart(), /pending|saved message/i);
  assert.deepEqual(fs.readFileSync(file), before); assert.deepEqual(h.turns, []);
});

test("main native restart hold permits exact draft persistence while fencing new attachment and send work", native, async t => {
  const h = await fixture(t), { session } = h.controller.open();
  const files = h.controller.stage(session, h.owner, stagedInput("saved.txt")).staged;
  assert.equal(typeof (h.controller as any).holdForRestart, "function");
  const release = (h.controller as any).holdForRestart();
  assert.equal(h.controller.save(session, { sequence: 1, snapshot: h.draft("  preserve raw  ", files) }).saved, true);
  assert.throws(() => h.controller.stage(session, h.owner, stagedInput("late.txt")), /restart/i);
  assert.throws(() => h.controller.begin(session, { source: h.owner, rawText: "late", configuration: config, files }), /restart/i);
  assert.throws(() => h.controller.open(), /restart/i);
  release(); release();
  assert.equal(h.controller.stage(session, h.owner, stagedInput("allowed.txt")).staged.length, 1);
});

test("native project message retains original while newer draft moves, then admits one exact durable user item", native, async t => {
  const h = await fixture(t), { session } = h.controller.open();
  const original = h.controller.stage(session, h.owner, stagedInput("original.txt")).staged;
  const raw = "  original raw\nmessage 😀  ";
  h.controller.save(session, { sequence: 1, snapshot: h.draft(raw, original) });
  const intent = h.controller.begin(session, { source: h.owner, rawText: raw, configuration: config, files: original });
  const newer = h.controller.stage(session, h.owner, stagedInput("newer.txt")).staged;
  h.controller.save(session, { sequence: 2, snapshot: h.draft("  newer independently typed  ", newer) });
  const thread = await h.controller.create(session, intent.id); assert.deepEqual(h.turns, []);
  const claimed = [...original, ...newer].map(file => ({ ...file, rel: `${thread.id}/${path.basename(file.rel)}` }));
  const after: ComposerRecovery = { ...h.draft("", []), selectedThreadId: thread.id,
    threads: [{ threadId: thread.id, text: "  newer independently typed  ", attachments: claimed.slice(1) }] };
  const request = { id: "transfer-one", sequence: 3, snapshot: after, intentId: intent.id, files: [...original, ...newer] };
  const receipt = h.controller.transfer(session, request);
  assert.deepEqual(receipt, { status: "committed", revision: 3, files: claimed });
  assert.deepEqual(h.controller.transfer(session, request), receipt, "lost response retry cannot re-claim or add revision");
  assert.deepEqual(h.controller.save(session, { sequence: 2, snapshot: h.draft(raw, original) }), { saved: false, revision: 3 });
  assert.equal(h.controller.readPending(session, intent.id)!.rawText, raw);
  await h.controller.send(session, intent.id);
  assert.equal(h.turns.length, 1);
  const user = new Store(h.home).items(thread.id).find(item => item.kind === "user");
  assert.ok(user?.kind === "user"); assert.equal(user.id, intent.id); assert.equal(user.text, raw); assert.deepEqual(user.attachments, claimed.slice(0, 1));
  assert.equal(h.controller.readPending(session, intent.id), null);
  assert.deepEqual(new UpdateRecovery(h.store.dir).read().drafts, after);
  assert.equal(h.controller.stage(session, { kind: "thread", threadId: thread.id }, stagedInput("later.txt")).staged.length, 1);
});

test("existing-thread attachment-only native message uses the same ownership transaction", native, async t => {
  const h = await fixture(t), thread = await h.runner.createThread(h.project.id, { backend: "mock", auto: false }), owner = { kind: "thread" as const, threadId: thread.id };
  const { session } = h.controller.open(), files = h.controller.stage(session, owner, stagedInput("only.txt")).staged;
  const before = { ...h.draft("", []), threads: [{ threadId: thread.id, text: "", attachments: files }], selectedThreadId: thread.id };
  h.controller.save(session, { sequence: 1, snapshot: before });
  const intent = h.controller.begin(session, { source: owner, rawText: "", configuration: config, files });
  assert.equal((await h.controller.create(session, intent.id)).id, thread.id);
  const after = { ...before, threads: [{ threadId: thread.id, text: "", attachments: [] }] };
  assert.equal(h.controller.transfer(session, { id: "existing-transfer", sequence: 2, snapshot: after, intentId: intent.id, files }).status, "committed");
  await h.controller.send(session, intent.id); assert.equal(h.turns.length, 1);
  const user = h.store.items(thread.id).find(item => item.kind === "user"); assert.ok(user?.kind === "user"); assert.equal(user.text, ""); assert.equal(user.attachments!.length, 1);
});

test("unknown IDs and a second pending message sharing reserved files are refused before persistence", native, async t => {
  const h = await fixture(t), { session } = h.controller.open(), files = h.controller.stage(session, h.owner, stagedInput("original.txt")).staged;
  const input = { source: h.owner, rawText: "raw", configuration: config, files };
  assert.throws(() => h.controller.begin(session, { ...input, files: [{ ...files[0]!, id: "unknown" }] }));
  assert.equal(new PendingSends(h.store.dir).list().ids.length, 0);
  h.controller.begin(session, input);
  assert.throws(() => h.controller.begin(session, input));
  assert.equal(new PendingSends(h.store.dir).list().ids.length, 1);
  assert.throws(() => h.controller.discard(session, h.owner, files.map(file => file.id)));
});

test("navigation revokes stale sessions and late picker results without copying or deleting source bytes", native, async t => {
  const h = await fixture(t), { session } = h.controller.open();
  const selected = path.join(h.home, "selected.txt"); fs.writeFileSync(selected, "source stays intact");
  let resolve!: (paths: string[]) => void;
  const selecting = h.controller.pick(session, h.owner, 1, () => new Promise<string[]>(done => { resolve = done; }));
  h.controller.invalidate(); const next = h.controller.open(); assert.notEqual(next.session, session);
  resolve([selected]); await assert.rejects(selecting);
  assert.throws(() => h.controller.save(session, { sequence: 1, snapshot: h.draft("stale", []) }));
  assert.deepEqual(fs.readdirSync(h.attachments.staging), []); assert.equal(fs.readFileSync(selected, "utf8"), "source stays intact");
  h.controller.save(next.session, { sequence: 1, snapshot: h.draft("new current raw", []) });
});

test("creation failure keeps original pending text while normal newer autosaves remain usable", native, async t => {
  const h = await fixture(t), { session } = h.controller.open();
  fs.mkdirSync(path.join(h.home, "scripts")); fs.writeFileSync(path.join(h.home, "scripts", "worktree.sh"), '#!/bin/bash\n: > preserved-worktree-evidence\nexit 1\n');
  const files = h.controller.stage(session, h.owner, stagedInput("original.txt")).staged;
  const intent = h.controller.begin(session, { source: h.owner, rawText: "  original before failed create  ", configuration: { ...config, worktree: true }, files });
  await assert.rejects(h.controller.create(session, intent.id));
  h.controller.save(session, { sequence: 1, snapshot: h.draft("  newer after failed create  ", []) });
  assert.equal(h.controller.readPending(session, intent.id)!.rawText, "  original before failed create  ");
  assert.equal(new UpdateRecovery(h.store.dir).read().drafts!.projects[0]!.text, "  newer after failed create  ");
  assert.ok(fs.existsSync(path.join(h.home, "preserved-worktree-evidence"))); assert.deepEqual(h.turns, []);
});

test("corrupt pending startup evidence preserves all attachment files before cleanup", native, async t => {
  const h = await fixture(t), { session } = h.controller.open(), files = h.controller.stage(session, h.owner, stagedInput("original.txt")).staged;
  const intent = h.controller.begin(session, { source: h.owner, rawText: "original", configuration: config, files });
  const record = path.join(h.store.dir, "pending-sends", `${intent.id}.json`); fs.writeFileSync(record, "{preserved corrupted original");
  const old = new Date(0); fs.utimesSync(path.join(h.attachments.root, files[0]!.rel), old, old);
  assert.throws(() => new NativeDrafts({ store: h.store, runner: h.runner, attachments: h.attachments }));
  assert.equal(h.attachments.sweepStaging(), 0); assert.equal(fs.readFileSync(record, "utf8"), "{preserved corrupted original");
  assert.equal(fs.readFileSync(path.join(h.attachments.root, files[0]!.rel), "utf8"), "original original.txt bytes");
});

test("ordinary unbound remote-style sends remain supported alongside local native ownership", native, async t => {
  const h = await fixture(t), thread = await h.runner.createThread(h.project.id, { backend: "mock", auto: false });
  const files = h.attachments.stage(stagedInput("remote.txt")).staged;
  await h.runner.send(thread.id, "remote original", files);
  assert.equal(h.turns.length, 1); assert.equal(h.store.items(thread.id).filter(item => item.kind === "user").length, 1);
});

test("fresh instances restore independent newer draft and original pending message without startup creation or CLI", native, async t => {
  const h = await fixture(t), { session } = h.controller.open();
  const original = h.controller.stage(session, h.owner, stagedInput("original.txt")).staged;
  const intent = h.controller.begin(session, { source: h.owner, rawText: "  preserved original  ", configuration: config, files: original });
  const newer = h.controller.stage(session, h.owner, stagedInput("newer.txt")).staged;
  h.controller.save(session, { sequence: 1, snapshot: h.draft("  independent newer  ", newer) });
  const pendingPath = path.join(h.store.dir, "pending-sends", `${intent.id}.json`), originalBytes = fs.readFileSync(pendingPath);
  h.controller.invalidate(); await h.runner.dispose();
  const store = new Store(h.home), turns: string[] = [];
  const attachments = new AttachmentStore(h.attachments.root, {
    authorizeDraft: owner => owner.kind === "project" ? !!store.project(owner.projectId) : !!store.thread(owner.threadId),
    authorizeTransfer: (owner, id) => owner.kind === "thread" ? owner.threadId === id : store.thread(id)?.projectId === owner.projectId,
  });
  const runner = new ThreadRunner({ home: h.home, store, attachments, emit: () => {}, backends: { mock: {
    id: "mock", listModels: async () => [], dispose: async () => {}, runTurn: async text => { turns.push(text); return { status: "completed" }; },
  } } });
  h.runners.push(runner);
  const controller = new NativeDrafts({ store, runner, attachments }), opened = controller.open();
  assert.deepEqual(opened.drafts, h.draft("  independent newer  ", newer));
  assert.deepEqual(fs.readFileSync(pendingPath), originalBytes); assert.equal(store.snapshot().threads.length, 0); assert.deepEqual(turns, []);
  const open = fs.openSync, stateFile = path.join(store.dir, "state.json");
  fs.openSync = ((...args: Parameters<typeof fs.openSync>) => {
    if (String(args[0]).startsWith(`${stateFile}.`) && String(args[0]).endsWith(".tmp")) throw Object.assign(new Error("injected prewrite refusal"), { code: "EACCES" });
    return Reflect.apply(open, fs, args);
  }) as typeof fs.openSync;
  try { await assert.rejects(controller.create(opened.session, intent.id), /prewrite refusal/); }
  finally { fs.openSync = open; }
  controller.save(opened.session, { sequence: 1, snapshot: h.draft("  newer after explicit failure  ", newer) });
  const thread = await controller.create(opened.session, intent.id);
  const claimed = [...original, ...newer].map(file => ({ ...file, rel: `${thread.id}/${path.basename(file.rel)}` }));
  const after = { ...h.draft("", []), selectedThreadId: thread.id, threads: [{ threadId: thread.id, text: "  newer after explicit failure  ", attachments: claimed.slice(1) }] };
  controller.transfer(opened.session, { id: "restored-transfer", sequence: 2, snapshot: after, intentId: intent.id, files: [...original, ...newer] });
  await controller.send(opened.session, intent.id);
  assert.equal(turns.length, 1); assert.equal(controller.readPending(opened.session, intent.id), null);
  assert.equal(store.items(thread.id).filter(item => item.kind === "user").length, 1);
  assert.deepEqual(new UpdateRecovery(store.dir).read().drafts, after);
});

test("a committed transfer and failed user write recover separately from newer typing, then explicitly send exactly once", native, async t => {
  const h = await fixture(t), { session } = h.controller.open();
  const original = h.controller.stage(session, h.owner, stagedInput("original.txt")).staged;
  const raw = "  original after failed send\n  ";
  const intent = h.controller.begin(session, { source: h.owner, rawText: raw, configuration: config, files: original });
  const newer = h.controller.stage(session, h.owner, stagedInput("newer.txt")).staged;
  h.controller.save(session, { sequence: 1, snapshot: h.draft("  separate newer text  ", newer) });
  const thread = await h.controller.create(session, intent.id);
  const claimed = [...original, ...newer].map(file => ({ ...file, rel: `${thread.id}/${path.basename(file.rel)}` }));
  const after = { ...h.draft("", []), selectedThreadId: thread.id, threads: [{ threadId: thread.id, text: "  separate newer text  ", attachments: claimed.slice(1) }] };
  h.controller.transfer(session, { id: "before-failed-send", sequence: 2, snapshot: after, intentId: intent.id, files: [...original, ...newer] });
  const open = fs.openSync, itemsFile = path.join(h.store.dir, "threads", `${thread.id}.json`);
  fs.openSync = ((...args: Parameters<typeof fs.openSync>) => {
    if (String(args[0]).startsWith(`${itemsFile}.`) && String(args[0]).endsWith(".tmp")) throw Object.assign(new Error("injected user prewrite refusal"), { code: "EACCES" });
    return Reflect.apply(open, fs, args);
  }) as typeof fs.openSync;
  try { await assert.rejects(h.controller.send(session, intent.id), /user prewrite refusal/); }
  finally { fs.openSync = open; }
  assert.equal(h.store.items(thread.id).filter(item => item.kind === "user").length, 0); assert.deepEqual(h.turns, []);
  const pendingPath = path.join(h.store.dir, "pending-sends", `${intent.id}.json`), bytes = fs.readFileSync(pendingPath);
  h.controller.invalidate(); await h.runner.dispose();
  const store = new Store(h.home), turns: string[] = [];
  const attachments = new AttachmentStore(h.attachments.root, {
    authorizeDraft: owner => owner.kind === "project" ? !!store.project(owner.projectId) : !!store.thread(owner.threadId),
    authorizeTransfer: (owner, id) => owner.kind === "thread" ? owner.threadId === id : store.thread(id)?.projectId === owner.projectId,
  });
  const runner = new ThreadRunner({ home: h.home, store, attachments, emit: () => {}, backends: { mock: {
    id: "mock", listModels: async () => [], dispose: async () => {}, runTurn: async text => { turns.push(text); return { status: "completed" }; },
  } } });
  h.runners.push(runner);
  const controller = new NativeDrafts({ store, runner, attachments }), opened = controller.open();
  assert.deepEqual(turns, []); assert.deepEqual(opened.drafts, after); assert.deepEqual(fs.readFileSync(pendingPath), bytes);
  assert.equal(controller.readPending(opened.session, intent.id)!.rawText, raw);
  assert.equal((await controller.create(opened.session, intent.id)).id, thread.id);
  controller.transfer(opened.session, { id: "recovered-failed-send", sequence: 1, snapshot: after, intentId: intent.id, files: claimed });
  await controller.send(opened.session, intent.id);
  await assert.rejects(controller.send(opened.session, intent.id));
  assert.equal(turns.length, 1);
  const users = new Store(h.home).items(thread.id).filter(item => item.kind === "user");
  assert.equal(users.length, 1); assert.equal(users[0]!.text, raw); assert.deepEqual(users[0]!.attachments, claimed.slice(0, 1));
  assert.deepEqual(new UpdateRecovery(store.dir).read().drafts, after);
});

test("retiring one project draft revokes its late picker and explicit pending recovery restores only its original files", native, async t => {
  const h = await fixture(t), { session } = h.controller.open();
  const original = h.controller.stage(session, h.owner, stagedInput("original.txt")).staged;
  const intent = h.controller.begin(session, { source: h.owner, rawText: "  original survives retirement  ", configuration: config, files: original });
  const selected = path.join(h.home, "late-selection.txt"); fs.writeFileSync(selected, "external source stays intact");
  let resolve!: (files: string[]) => void;
  const selecting = h.controller.pick(session, h.owner, 1, () => new Promise<string[]>(done => { resolve = done; }));
  const rejected = assert.rejects(selecting);
  void rejected.catch(() => {});
  try { (h.controller as NativeDrafts & { retire(session: string, owner: AttachmentDraftOwner): void }).retire(session, h.owner); }
  finally { resolve([selected]); }
  await rejected;
  assert.equal(fs.readFileSync(selected, "utf8"), "external source stays intact");
  assert.equal(fs.readdirSync(h.attachments.staging).length, 1);
  assert.equal(h.controller.readPending(session, intent.id)!.rawText, "  original survives retirement  ");
  const thread = await h.controller.create(session, intent.id);
  const after = { ...h.draft("", []), selectedThreadId: thread.id, threads: [{ threadId: thread.id, text: "", attachments: [] }] };
  h.controller.transfer(session, { id: "retired-recovery", sequence: 1, snapshot: after, intentId: intent.id, files: original });
  await h.controller.send(session, intent.id);
  assert.equal(h.turns.length, 1); assert.equal(h.controller.readPending(session, intent.id), null);
});
