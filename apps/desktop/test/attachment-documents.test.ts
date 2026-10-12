import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { AttachmentDocuments, type AttachmentDocument, type DocumentAttachmentDraft } from "../src/main/engine/attachment-documents.js";
import { AttachmentStore } from "../src/main/engine/attachments.js";
import { UpdateRecovery } from "../src/main/engine/update-recovery.js";
import type { Attachment, AttachmentDraftOwner } from "../src/shared/attachments.js";
import type { ComposerRecovery } from "../src/shared/update-recovery.js";
import { tmpdir } from "./helpers.js";

const owner: AttachmentDraftOwner = { kind: "project", projectId: "project-1", key: "draft:0:project-1" };
const thread: AttachmentDraftOwner = { kind: "thread", threadId: "thread-1" };
const input = [{ name: "notes.txt", data: Buffer.from("original bytes\n").toString("base64") }];
const snapshot = (): ComposerRecovery => ({ threads: [], projects: [], selectedThreadId: null, draft: null });
const projectSnapshot = (files: Attachment[], text = ""): ComposerRecovery => ({ ...snapshot(),
  projects: [{ key: "draft:0:project-1", projectId: "project-1", text, attachments: files }],
  draft: { revision: 0, projectId: "project-1", worktree: false, settings: { backend: "mock", mode: "chat", plan: false, auto: false, model: "" } },
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function harness(t: TestContext) {
  const home = tmpdir("attachment-documents-");
  const attachments = new AttachmentStore(path.join(home, "attachments"), { authorizeDraft: () => true, authorizeTransfer: () => true });
  const recovery = new UpdateRecovery(path.join(home, "app"), (file, context) => attachments.validateRecovery(file, context));
  let allowed = true;
  const options = { attachments, readSavedDrafts: () => recovery.read().drafts, ownerExists: () => allowed };
  const registry = new AttachmentDocuments(options);
  t.after(() => { registry.invalidate(); fs.rmSync(home, { recursive: true, force: true }); });
  return { home, attachments, recovery, registry, options, removeOwner: () => { allowed = false; } };
}

test("document and draft capabilities are instance-local; equal keys never adopt unknown file IDs", t => {
  const h = harness(t);
  const { document } = h.registry.open();
  const draft = h.registry.register(document, owner);
  const [file] = h.registry.stage(draft, input).staged;
  assert.ok(file);
  assert.equal(h.registry.validate(document, owner, file), true);
  assert.equal(h.registry.validate({} as AttachmentDocument, owner, file), false);
  assert.throws(() => h.registry.stage({} as DocumentAttachmentDraft, input), /document|draft/);
  const other = new AttachmentDocuments(h.options);
  assert.throws(() => other.stage(draft, input), /document|draft/);
  h.registry.retire(draft);
  const replacement = h.registry.register(document, owner);
  assert.notEqual(replacement, draft);
  assert.equal(h.registry.validate(document, owner, file), false);
  assert.throws(() => h.registry.discard(replacement, [file.id]), /Unknown/);
  assert.throws(() => h.registry.stage(draft, input), /document|draft/);
  assert.equal(fs.readFileSync(path.join(h.attachments.root, file.rel), "utf8"), "original bytes\n");
});

test("caller mutations cannot change the registered owner or authoritative staged metadata", t => {
  const h = harness(t);
  const { document } = h.registry.open();
  const mutable = { ...owner };
  const draft = h.registry.register(document, mutable);
  const [file] = h.registry.stage(draft, input).staged;
  assert.ok(file);
  const original = { ...file };
  if (mutable.kind === "project") mutable.key = "draft:1:project-1";
  file.name = "changed.txt";
  assert.equal(h.registry.capture(document, owner), draft);
  assert.equal(h.registry.validate(document, owner, file), false);
  assert.equal(h.registry.validate(document, owner, original), true);
  assert.equal(h.registry.validate(document, thread, original), false);
  assert.equal(h.registry.validate(document, owner, { ...original, rel: "staging/forged.txt" }), false);
  h.removeOwner();
  assert.equal(h.registry.validate(document, owner, original), false);
  assert.throws(() => h.registry.stage(draft, input), /document|draft/);
});

for (const change of ["retire", "navigate"] as const) test(`picker ${change} rejects late results while preserving the source and pending-work refusal`, async t => {
  const h = harness(t);
  const { document } = h.registry.open();
  const draft = h.registry.register(document, owner);
  const source = path.join(h.home, "selected.txt");
  fs.writeFileSync(source, "user-selected bytes");
  const dialog = deferred<string[]>();
  const picking = h.registry.pick(draft, 1, () => dialog.promise);
  assert.equal(h.registry.busy, true);
  assert.throws(() => h.registry.holdForRestart(), /finish/);
  if (change === "retire") {
    h.registry.retire(draft);
    h.registry.register(document, owner);
  } else {
    const next = h.registry.open();
    h.registry.register(next.document, owner);
  }
  assert.equal(h.registry.busy, true, "revoking a lifetime does not finish the native dialog");
  assert.throws(() => h.registry.holdForRestart(), /finish/);
  dialog.resolve([source]);
  await assert.rejects(picking, /document|draft/);
  assert.equal(h.registry.busy, false);
  assert.equal(fs.readFileSync(source, "utf8"), "user-selected bytes");
  assert.deepEqual(fs.readdirSync(h.attachments.staging), []);
});

test("picker cancellation and rejection release accounting; restart holds fence new operations without deleting files", async t => {
  const h = harness(t);
  const { document } = h.registry.open();
  const draft = h.registry.register(document, owner);
  assert.deepEqual(await h.registry.pick(draft, 1, async () => []), { staged: [], errors: [] });
  await assert.rejects(h.registry.pick(draft, 1, async () => { throw new Error("dialog failed"); }), /dialog failed/);
  assert.equal(h.registry.busy, false);
  const [file] = h.registry.stage(draft, input).staged;
  assert.ok(file);
  const release = h.registry.holdForRestart();
  assert.throws(() => h.registry.stage(draft, input), /restart/);
  assert.throws(() => h.registry.discard(draft, [file.id]), /restart/);
  await assert.rejects(h.registry.pick(draft, 1, async () => assert.fail("dialog opened during hold")), /restart/);
  release();
  const next = h.registry.holdForRestart();
  release();
  assert.throws(() => h.registry.stage(draft, input), /restart/);
  next();
  assert.equal(h.registry.stage(draft, input).staged.length, 1);
  assert.equal(fs.readFileSync(path.join(h.attachments.root, file.rel), "utf8"), "original bytes\n");
});

test("strict durable restoration is the only way a new document regains saved file authority and raw drafts", t => {
  const h = harness(t);
  const initial = h.registry.open();
  const projectHandle = h.registry.register(initial.document, owner);
  const threadHandle = h.registry.register(initial.document, thread);
  const projectFiles = h.registry.stage(projectHandle, input).staged;
  const threadFiles = h.registry.stage(threadHandle, input).staged;
  const raw = snapshot();
  raw.projects.push({ key: "draft:0:project-1", projectId: "project-1", text: "  raw token=example-value\n", attachments: projectFiles });
  raw.threads.push({ threadId: "thread-1", text: "", attachments: threadFiles });
  raw.selectedThreadId = "thread-1";
  raw.draft = { revision: 0, projectId: "project-1", worktree: true, settings: { backend: "mock", mode: "agent", plan: true, auto: false, model: "raw-model" } };
  h.recovery.saveDrafts(raw);
  h.registry.invalidate();
  const freshStore = new AttachmentStore(h.attachments.root, { authorizeDraft: () => true });
  const fresh = new AttachmentDocuments({ ...h.options, attachments: freshStore });
  const restored = fresh.open();
  assert.deepEqual(restored.drafts, raw);
  assert.equal(fresh.validate(restored.document, owner, projectFiles[0]!), true);
  assert.equal(fresh.validate(restored.document, thread, threadFiles[0]!), true);
  restored.drafts!.projects[0]!.attachments[0]!.name = "renderer mutation.txt";
  assert.equal(fresh.validate(restored.document, owner, projectFiles[0]!), true);
  assert.throws(() => fresh.stage(projectHandle, input), /document|draft/);
  fresh.invalidate();
});

test("active unsaved and durable references are retained before staging cleanup", t => {
  const h = harness(t);
  const { document } = h.registry.open();
  const draft = h.registry.register(document, owner);
  const [file] = h.registry.stage(draft, input).staged;
  assert.ok(file);
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
  fs.utimesSync(path.join(h.attachments.root, file.rel), old, old);
  assert.equal(h.attachments.sweepStaging(), 0);
  const raw = projectSnapshot([file]);
  h.recovery.saveDrafts(raw);
  h.registry.discard(draft, [file.id]);
  assert.equal(h.registry.refreshRetention(), true);
  assert.equal(fs.readFileSync(path.join(h.attachments.root, file.rel), "utf8"), "original bytes\n", "durable reference protects bytes even after UI removal");
});

test("unreadable recovery preserves all staged evidence before any startup sweep", t => {
  const h = harness(t);
  const [file] = h.attachments.stage(input).staged;
  assert.ok(file);
  fs.mkdirSync(path.join(h.home, "app"), { recursive: true });
  const record = path.join(h.home, "app", "update-recovery.json");
  fs.writeFileSync(record, "{corrupt original");
  const old = new Date(0);
  fs.utimesSync(path.join(h.attachments.root, file.rel), old, old);
  const registry = new AttachmentDocuments(h.options);
  assert.throws(() => registry.open(), /recovery/i);
  assert.equal(registry.refreshRetention(), false);
  assert.equal(h.attachments.sweepStaging(), 0);
  assert.equal(fs.readFileSync(record, "utf8"), "{corrupt original");
  assert.equal(fs.readFileSync(path.join(h.attachments.root, file.rel), "utf8"), "original bytes\n");
});

test("recovery corruption after opening a document refuses new file writes and keeps existing bytes", async t => {
  const h = harness(t);
  const { document } = h.registry.open();
  const draft = h.registry.register(document, owner);
  const [file] = h.registry.stage(draft, input).staged;
  assert.ok(file);
  fs.mkdirSync(path.join(h.home, "app"), { recursive: true });
  const record = path.join(h.home, "app", "update-recovery.json");
  fs.writeFileSync(record, "{preserve malformed record");
  assert.throws(() => h.registry.stage(draft, input), /recovery/);
  assert.throws(() => h.registry.discard(draft, [file.id]), /recovery/);
  await assert.rejects(h.registry.pick(draft, 1, async () => assert.fail("dialog must not open")), /recovery/);
  assert.equal(fs.readdirSync(h.attachments.staging).length, 1);
  assert.equal(fs.readFileSync(path.join(h.attachments.root, file.rel), "utf8"), "original bytes\n");
  assert.equal(fs.readFileSync(record, "utf8"), "{preserve malformed record");
});

for (const replace of [false, true]) test(`saved ${replace ? "replaced" : "missing"} attachment refuses adoption without rewriting recovery or deleting evidence`, t => {
  const h = harness(t);
  const { document } = h.registry.open();
  const draft = h.registry.register(document, owner);
  const [file] = h.registry.stage(draft, input).staged;
  assert.ok(file);
  const raw = projectSnapshot([file], "preserve raw draft");
  h.recovery.saveDrafts(raw);
  const record = path.join(h.home, "app", "update-recovery.json");
  const before = fs.readFileSync(record);
  const original = path.join(h.attachments.root, file.rel);
  const preserved = path.join(h.home, "preserved-original.txt");
  fs.renameSync(original, preserved);
  if (replace) fs.writeFileSync(original, Buffer.alloc(file.size, 88));
  assert.throws(() => h.registry.open(), /missing|changed/);
  assert.deepEqual(fs.readFileSync(record), before);
  assert.equal(fs.readFileSync(preserved, "utf8"), "original bytes\n");
  assert.equal(h.attachments.sweepStaging(0, Date.now() + 1000), 0);
  if (replace) assert.deepEqual(fs.readFileSync(original), Buffer.alloc(file.size, 88));
});

for (const failedSave of [false, true]) test(`removal before ${failedSave ? "a failed save" : "autosave"} restores authoritative ownership in fresh instances`, t => {
  const h = harness(t);
  const { document } = h.registry.open();
  const draft = h.registry.register(document, owner);
  const [file] = h.registry.stage(draft, input).staged;
  assert.ok(file);
  const raw = projectSnapshot([file], "original unsent text");
  h.recovery.saveDrafts(raw);
  const record = path.join(h.home, "app", "update-recovery.json");
  const before = fs.readFileSync(record);
  h.registry.discard(draft, [file.id]);
  assert.equal(h.registry.validate(document, owner, file), false, "removed file is no longer admitted by this live draft");
  if (failedSave) {
    const sync = fs.fsyncSync;
    fs.fsyncSync = () => { throw new Error("injected disk sync failure"); };
    try { assert.throws(() => h.recovery.saveDrafts(snapshot()), /recovery/i); }
    finally { fs.fsyncSync = sync; }
  }
  assert.deepEqual(fs.readFileSync(record), before);
  h.registry.invalidate();
  const freshStore = new AttachmentStore(h.attachments.root, { authorizeDraft: () => true });
  const freshRecovery = new UpdateRecovery(path.join(h.home, "app"), (a, o) => freshStore.validateRecovery(a, o));
  const fresh = new AttachmentDocuments({ ...h.options, attachments: freshStore, readSavedDrafts: () => freshRecovery.read().drafts });
  const reopened = fresh.open();
  assert.deepEqual(reopened.drafts, raw);
  assert.equal(fresh.validate(reopened.document, owner, file), true);
  freshRecovery.validateSavedDrafts(freshRecovery.read().revision);
  assert.equal(fs.readFileSync(path.join(freshStore.root, file.rel), "utf8"), "original bytes\n");
  fresh.invalidate();
});

for (const change of ["retire", "navigate"] as const) test(`unsaved ${change} evidence survives later retention refresh and an age-based sweep`, t => {
  const h = harness(t);
  let { document } = h.registry.open();
  const draft = h.registry.register(document, owner);
  const [file] = h.registry.stage(draft, input).staged;
  assert.ok(file);
  const old = new Date(0);
  fs.utimesSync(path.join(h.attachments.root, file.rel), old, old);
  if (change === "retire") h.registry.retire(draft);
  else document = h.registry.open().document;
  const replacement = h.registry.register(document, owner);
  h.registry.stage(replacement, input); // Causes a later retention refresh.
  assert.equal(h.registry.validate(document, owner, file), false);
  assert.equal(h.attachments.sweepStaging(), 0);
  assert.equal(fs.readFileSync(path.join(h.attachments.root, file.rel), "utf8"), "original bytes\n");
});

interface TransferRegistry {
  beginTransfer(source: DocumentAttachmentDraft, targetThreadId: string, files: readonly Attachment[]): object;
  validateTransfer(token: object): boolean;
  adoptTransfer(token: object, files: unknown, committed: () => boolean): DocumentAttachmentDraft;
}
const transfers = (registry: AttachmentDocuments) => registry as AttachmentDocuments & TransferRegistry;
function claimForTest(h: ReturnType<typeof harness>, files: Attachment[], from = owner) {
  const draft = h.attachments.mintDraft(from), transfer = from.kind === "project" ? h.attachments.mintTransfer(draft, "thread-1") : undefined;
  return h.attachments.claim("thread-1", files, { draft, transfer });
}

for (const from of [owner, thread]) {
  test(`committed ${from.kind} transfer adopts exact authority and revokes old handles`, t => {
    const h = harness(t), registry = transfers(h.registry), { document } = registry.open(), source = registry.register(document, from);
    const files = registry.stage(source, input).staged, token = registry.beginTransfer(source, "thread-1", files);
    assert.equal(registry.validateTransfer(token), true);
    const claimed = claimForTest(h, files, from);
    assert.throws(() => registry.adoptTransfer(token, claimed, () => false));
    // The callback models the adapter's verified committed journal receipt.
    h.recovery.saveDrafts({ ...snapshot(), threads: [{ threadId: "thread-1", text: "newer raw", attachments: claimed }] });
    const adopted = registry.adoptTransfer(token, claimed, () => true);
    assert.notEqual(adopted, source); assert.equal(registry.capture(document, thread), adopted);
    assert.equal(registry.validate(document, thread, claimed[0]!), true);
    assert.throws(() => registry.stage(source, input));
    assert.equal(registry.stage(adopted, input).staged.length, 1);
    assert.equal(fs.readFileSync(path.join(h.attachments.root, claimed[0]!.rel), "utf8"), "original bytes\n");
  });
}

for (const change of ["stage", "discard", "target-touch", "retire", "navigate"] as const) {
  test(`transfer authority expires after ${change} without adopting a replacement lifetime`, t => {
    const h = harness(t), registry = transfers(h.registry), { document } = registry.open(), source = registry.register(document, owner);
    const files = registry.stage(source, input).staged, token = registry.beginTransfer(source, "thread-1", files);
    if (change === "stage") registry.stage(source, input);
    if (change === "discard") registry.discard(source, [files[0]!.id]);
    if (change === "target-touch") {
      const target = registry.register(document, thread), added = registry.stage(target, input).staged;
      registry.discard(target, added.map(file => file.id));
    }
    if (change === "retire") { registry.retire(source); registry.register(document, owner); }
    if (change === "navigate") registry.open();
    assert.equal(registry.validateTransfer(token), false);
    assert.throws(() => registry.adoptTransfer(token, [], () => true));
    assert.equal(fs.readFileSync(path.join(h.attachments.root, files[0]!.rel), "utf8"), "original bytes\n");
  });
}

test("transfer rejects unknown or partial batches and forged/cross-instance tokens", t => {
  const h = harness(t), registry = transfers(h.registry), { document } = registry.open(), source = registry.register(document, owner);
  const files = registry.stage(source, input).staged;
  assert.throws(() => registry.beginTransfer(source, "thread-1", []));
  assert.throws(() => registry.beginTransfer(source, "thread-1", [{ ...files[0]!, id: "unknown" }]));
  const token = registry.beginTransfer(source, "thread-1", files);
  assert.equal(registry.validateTransfer({}), false);
  assert.equal(transfers(new AttachmentDocuments(h.options)).validateTransfer(token), false);
  assert.throws(() => registry.adoptTransfer({}, [], () => true));
  assert.throws(() => registry.adoptTransfer(token, [{ ...files[0]!, rel: `thread-1/${path.basename(files[0]!.rel)}` }], () => true), "filenames alone do not prove manifest ownership");
  assert.equal(registry.refreshRetention(), false, "a confirmed but invalid adoption stays protected");
  assert.equal(registry.validateTransfer(token), false);
  assert.equal(registry.validate(document, owner, files[0]!), false);
});

for (const cause of ["metadata", "callback-invalidation"] as const) {
  test(`adoption rejects ${cause} without rebinding files`, t => {
    const h = harness(t), registry = transfers(h.registry), { document } = registry.open(), source = registry.register(document, owner);
    const files = registry.stage(source, input).staged, token = registry.beginTransfer(source, "thread-1", files), claimed = claimForTest(h, files);
    let callbackRan = false;
    assert.throws(() => registry.adoptTransfer(token, cause === "metadata" ? [{ ...claimed[0]!, name: "renamed.txt" }] : claimed, () => {
      callbackRan = true; if (cause === "callback-invalidation") registry.invalidate(); return true;
    }));
    assert.equal(callbackRan, true);
    assert.equal(registry.validateTransfer(token), false);
    assert.equal(registry.validate(document, owner, files[0]!), false);
    assert.equal(h.attachments.sweepStaging(0, Date.now() + 1000), 0);
    assert.equal(fs.readFileSync(path.join(h.attachments.root, claimed[0]!.rel), "utf8"), "original bytes\n");
  });
}

test("pending original references survive fresh-document retention without granting draft authority", t => {
  const h = harness(t), first = h.registry.open(), source = h.registry.register(first.document, owner);
  const files = h.registry.stage(source, input).staged;
  h.registry.invalidate();
  const freshStore = new AttachmentStore(h.attachments.root, { authorizeDraft: () => true });
  const options = { ...h.options, attachments: freshStore, readPendingAttachments: () => files };
  const registry = new AttachmentDocuments(options), { document } = registry.open(); registry.register(document, owner);
  const old = new Date(0); fs.utimesSync(path.join(h.attachments.root, files[0]!.rel), old, old);
  assert.equal(registry.refreshRetention(), true); assert.equal(freshStore.sweepStaging(), 0);
  assert.equal(registry.validate(document, owner, files[0]!), false, "retention never adopts a pending original into the editable draft");
  registry.invalidate();
});

test("unreadable pending intent evidence refuses retention refresh and preserves all staging", t => {
  const h = harness(t), files = h.attachments.stage(input).staged;
  const options = { ...h.options, readPendingAttachments: (): Attachment[] => { throw new Error("pending intent corrupted"); } };
  const registry = new AttachmentDocuments(options);
  assert.throws(() => registry.open(), /recovery/i);
  assert.equal(registry.refreshRetention(), false);
  assert.equal(h.attachments.sweepStaging(0, Date.now() + 1000), 0);
  assert.equal(fs.readFileSync(path.join(h.attachments.root, files[0]!.rel), "utf8"), "original bytes\n");
});

test("pending picker work refuses transfer capture and invalidates a prior token", async t => {
  const h = harness(t), registry = transfers(h.registry), { document } = registry.open(), source = registry.register(document, owner);
  const files = registry.stage(source, input).staged, token = registry.beginTransfer(source, "thread-1", files);
  const dialog = deferred<string[]>(), picking = registry.pick(source, 1, () => dialog.promise);
  assert.throws(() => registry.beginTransfer(source, "thread-1", files)); assert.equal(registry.validateTransfer(token), false);
  dialog.resolve([]); await picking;
  assert.equal(registry.validateTransfer(token), false);
  assert.equal(registry.validateTransfer(registry.beginTransfer(source, "thread-1", files)), true);
});

test("caught mutation reentry during committed adoption preserves files and refuses further writes", t => {
  const h = harness(t), registry = transfers(h.registry), { document } = registry.open(), source = registry.register(document, owner);
  const files = registry.stage(source, input).staged, token = registry.beginTransfer(source, "thread-1", files), claimed = claimForTest(h, files);
  assert.throws(() => registry.adoptTransfer(token, claimed, () => { assert.throws(() => registry.stage(source, input)); return true; }));
  assert.throws(() => registry.stage(source, input), /recovery/i);
  assert.equal(registry.refreshRetention(), false);
  assert.equal(fs.readFileSync(path.join(h.attachments.root, claimed[0]!.rel), "utf8"), "original bytes\n");
});

test("confirmed adoption uncertainty invalidates previously captured all-claimed transfer authority", t => {
  const h = harness(t), registry = transfers(h.registry), { document } = registry.open(), source = registry.register(document, thread);
  const files = registry.stage(source, input).staged, first = registry.beginTransfer(source, "thread-1", files), claimed = claimForTest(h, files, thread);
  h.recovery.saveDrafts({ ...snapshot(), threads: [{ threadId: "thread-1", text: "newer raw", attachments: claimed }] });
  const adopted = registry.adoptTransfer(first, claimed, () => true), second = registry.beginTransfer(adopted, "thread-1", claimed);
  assert.equal(registry.validateTransfer(second), true);
  assert.throws(() => registry.adoptTransfer(second, [{ ...claimed[0]!, name: "wrong.txt" }], () => true));
  assert.equal(registry.validateTransfer(second), false, "a captured token must not bypass the recovery latch");
});
