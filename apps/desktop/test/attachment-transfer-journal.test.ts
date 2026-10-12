import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { AttachmentStore } from "../src/main/engine/attachments.js";
import { PendingSends, type PendingTarget } from "../src/main/engine/pending-sends.js";
import { ComposerRecoveryWriter, UpdateRecovery } from "../src/main/engine/update-recovery.js";
import { AttachmentTransferJournal } from "../src/main/engine/attachment-transfer-journal.js";
import type { Attachment, AttachmentDraftOwner } from "../src/shared/attachments.js";
import type { ComposerRecovery } from "../src/shared/update-recovery.js";
const native = { skip: process.platform === "win32" };
const configuration = { worktree: true, settings: { backend: "mock" as const, mode: "agent" as const, plan: false, auto: false, model: "mock", effort: "high" } };
function fixture(t: TestContext, count = 2, threadSource = false, preclaimed = 0) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "modex-transfer-journal-")));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  let target: PendingTarget;
  const create = () => {
    const attachments = new AttachmentStore(path.join(home, "attachments"), { authorizeDraft: () => true, authorizeTransfer: () => true });
    const pending = new PendingSends(home), recovery = new UpdateRecovery(home, (file, owner) => attachments.validateRecovery(file, owner));
    const writer = new ComposerRecoveryWriter(recovery);
    const journal = new AttachmentTransferJournal(home, { attachments, pending, recovery, writer, proveTarget: candidate => JSON.stringify(candidate) === JSON.stringify(target) });
    return { attachments, pending, recovery, writer, journal };
  };
  const h = create(), source: AttachmentDraftOwner = threadSource ? { kind: "thread", threadId: "existing" } : { kind: "project", key: "draft:0:project", projectId: "project" };
  const capability = h.attachments.mintDraft(source);
  const files = h.attachments.stage(Array.from({ length: count }, (_, i) => ({ name: `note-${i}.txt`, data: Buffer.from(`original bytes ${i}`).toString("base64") })), { draft: capability }).staged;
  if (preclaimed) files.splice(0, preclaimed, ...h.attachments.claim("existing", files.slice(0, preclaimed), { draft: capability }));
  const original = "  original raw\nmessage 😀  ";
  const intent = h.pending.begin({ source, rawText: original, configuration, files: files.slice(0, 1) }, () => true);
  const intentId = intent.value!.id;
  h.pending.bind(intentId, record => target = threadSource
    ? { threadId: "existing", projectId: "project", createdAt: record.createdAt }
    : { ...record.creation!, projectId: "project" });
  const before: ComposerRecovery = { threads: [{ threadId: "other", text: "unrelated raw\n", attachments: [] }],
    selectedThreadId: null, projects: [{ key: "draft:0:project", projectId: "project", text: threadSource ? "" : "  intervening new text  ", attachments: threadSource ? [] : files.slice(1) }],
    draft: { revision: 0, projectId: "project", ...configuration } };
  if (threadSource) before.threads.push({ threadId: "existing", text: "  intervening new text  ", attachments: files.slice(1) });
  h.recovery.saveDrafts(before);
  const claimed = files.map(file => ({ ...file, rel: `${target!.threadId}/${path.basename(file.rel)}` }));
  const after: ComposerRecovery = { ...before, threads: [...before.threads.filter(entry => entry.threadId !== target!.threadId),
    { threadId: target!.threadId, text: "  intervening new text  ", attachments: claimed.slice(1) }],
    projects: before.projects.map(entry => ({ ...entry, text: "", attachments: [] })), selectedThreadId: target!.threadId };
  const request = { id: "transfer-1", session: h.writer.reset(), sequence: 1, snapshot: after };
  const admission = { intentId, files, authorize: () => true };
  return { ...h, home, source, files, claimed, original, intentId, before, after, request, admission,
    target: () => target, fresh: create, journalFile: path.join(home, "attachment-transfer.json"), intentFile: path.join(home, "pending-sends", `${intentId}.json`) };
}

// Isolated real file/manifest model. Authority callbacks represent main's future
// document and durable Store integration; these are not App/IPC acceptance.
for (const thread of [false, true]) {
  test(`transfer commits original message and newer composer independently (${thread ? "thread" : "project"})`, native, t => {
    const h = fixture(t, 2, thread);
    assert.deepEqual(h.journal.commit(h.request, h.admission), { status: "committed", revision: 2 });
    assert.deepEqual(h.recovery.read().drafts, h.after);
    const record = h.pending.read(h.intentId).value!;
    assert.equal(record.rawText, h.original); assert.deepEqual(record.configuration, configuration);
    assert.deepEqual(record.files, h.claimed.slice(0, 1));
    assert.deepEqual(record.owner, { kind: "thread", threadId: h.target().threadId });
    for (const file of h.claimed) assert.ok(h.attachments.validateRecovery(file, record.owner));
    assert.equal(fs.existsSync(h.journalFile), false);
    const fresh = h.fresh(); assert.deepEqual(fresh.journal.replay(), { status: "none" });
    assert.equal(fresh.recovery.read().revision, 2);
    assert.deepEqual(h.writer.save({ session: h.request.session, sequence: 1, snapshot: h.before }), { saved: false, revision: 2 });
  });
}

for (const boundary of ["journal", "manifest", "composer", "intent", "cleanup"] as const) {
  test(`fresh replay completes exactly once after ${boundary} boundary interruption`, native, t => {
    const h = fixture(t), rename = fs.renameSync, unlink = fs.unlinkSync; let injected = false;
    const targetFile = boundary === "journal" ? h.journalFile : boundary === "manifest" ? path.join(h.home, "attachments", ".manifest.json")
      : boundary === "composer" ? path.join(h.home, "update-recovery.json") : h.intentFile;
    fs.renameSync = (from, to) => {
      rename(from, to);
      if (!injected && boundary !== "cleanup" && String(to) === targetFile) { injected = true; throw new Error(`injected ${boundary}`); }
    };
    fs.unlinkSync = file => { if (!injected && boundary === "cleanup" && String(file) === h.journalFile) { injected = true; throw new Error("injected cleanup"); } unlink(file); };
    try { assert.throws(() => h.journal.commit(h.request, h.admission)); }
    finally { fs.renameSync = rename; fs.unlinkSync = unlink; }
    assert.equal(injected, true); assert.equal(fs.existsSync(h.journalFile), true);
    const fresh = h.fresh();
    assert.deepEqual(fresh.journal.replay(), { status: "committed", intentId: h.intentId, revision: 2 });
    assert.deepEqual(fresh.recovery.read().drafts, h.after); assert.equal(fresh.pending.read(h.intentId).value!.rawText, h.original);
    assert.deepEqual(fresh.pending.read(h.intentId).value!.files, h.claimed.slice(0, 1));
    assert.deepEqual(h.fresh().journal.replay(), { status: "none" });
    assert.equal(fresh.recovery.read().revision, 2);
  });
}

function interruptAfterJournal(h: ReturnType<typeof fixture>): void {
  const rename = fs.renameSync; let interrupted = false;
  fs.renameSync = (from, to) => { rename(from, to); if (String(to) === h.journalFile) { interrupted = true; throw new Error("injected journal publication"); } };
  try { assert.throws(() => h.journal.commit(h.request, h.admission)); }
  finally { fs.renameSync = rename; }
  assert.equal(interrupted, true);
}

for (const change of ["newer-composer", "newer-intent", "missing-intent", "changed-content", "unknown-journal"] as const) {
  test(`replay preserves evidence without guessing after ${change}`, native, t => {
    const h = fixture(t); interruptAfterJournal(h);
    if (change === "newer-composer") h.recovery.saveDrafts({ ...h.before, threads: [{ threadId: "other", text: "newer must survive", attachments: [] }] });
    if (change === "newer-intent") {
      const value = JSON.parse(fs.readFileSync(h.intentFile, "utf8")); value.rawText = "newer original evidence"; fs.writeFileSync(h.intentFile, JSON.stringify(value));
    }
    if (change === "missing-intent") fs.renameSync(h.intentFile, h.intentFile + ".preserved");
    if (change === "changed-content") fs.writeFileSync(path.join(h.home, "attachments", h.files[0]!.rel), "tampered bytes 00");
    if (change === "unknown-journal") { const value = JSON.parse(fs.readFileSync(h.journalFile, "utf8")); value.schema = 99; fs.writeFileSync(h.journalFile, JSON.stringify(value)); }
    const evidence = [h.journalFile, path.join(h.home, "update-recovery.json"), ...(fs.existsSync(h.intentFile) ? [h.intentFile] : [])].map(file => [file, fs.readFileSync(file)] as const);
    assert.throws(() => h.fresh().journal.replay());
    for (const [file, bytes] of evidence) assert.deepEqual(fs.readFileSync(file), bytes);
  });
}

test("zero-file transfer still preserves original text and uses one composer revision", native, t => {
  const h = fixture(t, 0); assert.deepEqual(h.journal.commit(h.request, h.admission), { status: "committed", revision: 2 });
  assert.equal(h.pending.read(h.intentId).value!.rawText, h.original); assert.deepEqual(h.pending.read(h.intentId).value!.files, []);
});

test("refused or asynchronous live authority leaves all source records unchanged", native, t => {
  for (const authorize of [() => false, (() => Promise.resolve(true)) as never]) {
    const h = fixture(t); const before = fs.readFileSync(h.intentFile);
    assert.equal(h.journal.commit(h.request, { ...h.admission, authorize }).status, "unchanged");

    assert.equal(fs.existsSync(h.journalFile), false); assert.deepEqual(fs.readFileSync(h.intentFile), before);
    for (const file of h.files) assert.ok(h.attachments.validateRecovery(file, h.source));
    assert.deepEqual(h.writer.save({ session: h.request.session, sequence: 2, snapshot: h.before }), { saved: true, revision: 2 });
    assert.deepEqual(h.journal.commit({ ...h.request, sequence: 3 }, h.admission), { status: "committed", revision: 3 });
  }
});

for (const count of [1, 2]) {
  test(`mixed and fully claimed batches preserve existing files (${count} claimed)`, native, t => {
    const h = fixture(t, 2, true, count), identities = h.files.slice(0, count).map(file => fs.statSync(path.join(h.home, "attachments", file.rel)).ino);
    assert.deepEqual(h.journal.commit(h.request, h.admission), { status: "committed", revision: 2 });
    for (const [i, inode] of identities.entries()) assert.equal(fs.statSync(path.join(h.home, "attachments", h.claimed[i]!.rel)).ino, inode);
    assert.equal(h.pending.read(h.intentId).value!.rawText, h.original);
    assert.deepEqual(h.fresh().journal.replay(), { status: "none" });
  });
}

test("a malformed envelope leaves the journal available for a subsequent valid transfer", native, t => {
  const h = fixture(t);
  assert.throws(() => h.journal.commit({ ...h.request, sequence: 0 }, h.admission));
  assert.deepEqual(h.writer.save({ session: h.request.session, sequence: 2, snapshot: h.before }), { saved: true, revision: 2 });
  assert.deepEqual(h.journal.commit({ ...h.request, sequence: 3 }, h.admission), { status: "committed", revision: 3 });
});

function interruptFinalManifestSync(h: ReturnType<typeof fixture>): void {
  const rename = fs.renameSync, sync = fs.fsyncSync, root = fs.statSync(path.join(h.home, "attachments")); let finalPublished = false, injected = false;
  fs.renameSync = (from, to) => {
    rename(from, to);
    if (String(to) === path.join(h.home, "attachments", ".manifest.json")) {
      const manifest = JSON.parse(fs.readFileSync(String(to), "utf8"));
      finalPublished = h.claimed.every(file => manifest.files.some((entry: { attachment: Attachment }) => entry.attachment.id === file.id && entry.attachment.rel === file.rel));
    }
  };
  fs.fsyncSync = fd => { const stat = fs.fstatSync(fd); if (finalPublished && !injected && stat.dev === root.dev && stat.ino === root.ino) { injected = true; throw new Error("injected final manifest directory sync"); } sync(fd); };
  try { assert.throws(() => h.journal.commit(h.request, h.admission)); }
  finally { fs.renameSync = rename; fs.fsyncSync = sync; }
  assert.equal(injected, true); assert.equal(fs.existsSync(h.journalFile), true);
  assert.equal(h.recovery.read().revision, 1);
}

test("fresh M-after construction syncs attachment root before replay can remove the journal", native, t => {
  const h = fixture(t); interruptFinalManifestSync(h);
  const root = fs.statSync(path.join(h.home, "attachments")), parent = fs.statSync(h.home), sync = fs.fsyncSync;
  let rootSynced = false, parentSynced = false;
  fs.fsyncSync = fd => {
    const stat = fs.fstatSync(fd);
    if (stat.dev === root.dev && stat.ino === root.ino) rootSynced = true;
    if (stat.dev === parent.dev && stat.ino === parent.ino) parentSynced = true;
    sync(fd);
  };
  let fresh: ReturnType<typeof h.fresh>;
  try { fresh = h.fresh(); }
  finally { fs.fsyncSync = sync; }
  assert.equal(rootSynced, true); assert.equal(parentSynced, true);
  assert.equal(fs.existsSync(h.journalFile), true);
  assert.equal(fresh.journal.replay().status, "committed");
});

for (const directory of ["attachments", "home"] as const) {
  test(`M-after startup ${directory} sync failure preserves journal and all recovery bytes`, native, t => {
    const h = fixture(t); interruptFinalManifestSync(h);
    const target = fs.statSync(directory === "attachments" ? path.join(h.home, "attachments") : h.home), sync = fs.fsyncSync;
    const evidence = [h.journalFile, path.join(h.home, "update-recovery.json"), h.intentFile].map(file => [file, fs.readFileSync(file)] as const);
    let injected = false;
    fs.fsyncSync = fd => { const stat = fs.fstatSync(fd); if (stat.dev === target.dev && stat.ino === target.ino) { injected = true; throw new Error("injected startup directory sync"); } sync(fd); };
    try { assert.throws(() => h.fresh()); }
    finally { fs.fsyncSync = sync; }
    assert.equal(injected, true);
    for (const [file, bytes] of evidence) assert.deepEqual(fs.readFileSync(file), bytes);
    assert.equal(h.fresh().journal.replay().status, "committed");
  });
}

test("replay makes the preserved journal durable before any manifest claim", native, t => {
  const h = fixture(t); interruptAfterJournal(h); const fresh = h.fresh();
  const journal = fs.statSync(h.journalFile), sync = fs.fsyncSync; let injected = false;
  fs.fsyncSync = fd => { const stat = fs.fstatSync(fd); if (stat.dev === journal.dev && stat.ino === journal.ino) { injected = true; throw new Error("injected journal checkpoint"); } sync(fd); };
  try { assert.throws(() => fresh.journal.replay()); }
  finally { fs.fsyncSync = sync; }
  assert.equal(injected, true); assert.equal(fs.existsSync(h.journalFile), true);
  for (const file of h.files) assert.ok(fresh.attachments.validateRecovery(file, h.source));
});

for (const state of ["recovery-after-manifest-before", "intent-after-recovery-before", "mixed-manifest"] as const) {
  test(`impossible or mixed three-record ordering stays preserved: ${state}`, native, t => {
    const h = fixture(t); interruptAfterJournal(h);
    const journal = JSON.parse(fs.readFileSync(h.journalFile, "utf8"));
    if (state === "recovery-after-manifest-before") fs.writeFileSync(path.join(h.home, "update-recovery.json"), JSON.stringify(journal.recovery.after));
    else if (state === "intent-after-recovery-before") {
      const preview = h.pending.adoption(h.intentId, h.claimed.slice(0, 1)); h.pending.commitAdoption(h.intentId, preview.before, preview.after);
    } else {
      const draft = h.attachments.mintDraft(h.source), transfer = h.attachments.mintTransfer(draft, h.target().threadId);
      h.attachments.claim(h.target().threadId, h.files.slice(0, 1), { draft, transfer });
    }
    const evidence = [h.journalFile, path.join(h.home, "update-recovery.json"), h.intentFile].map(file => [file, fs.readFileSync(file)] as const);
    assert.throws(() => h.fresh().journal.replay());
    for (const [file, bytes] of evidence) assert.deepEqual(fs.readFileSync(file), bytes);
  });
}

test("orphan journal temporaries block transfer and replay without discarding evidence", native, t => {
  const h = fixture(t), orphan = h.journalFile + ".unknown.tmp"; fs.writeFileSync(orphan, "preserved incomplete original journal");
  assert.throws(() => h.journal.commit(h.request, h.admission));
  assert.throws(() => h.fresh().journal.replay());
  assert.equal(fs.readFileSync(orphan, "utf8"), "preserved incomplete original journal");
  assert.equal(h.recovery.read().revision, 1);
});

test("journal stores only intent transition metadata and restores exact large raw text and immutable fields", native, t => {
  const h = fixture(t), original = JSON.parse(fs.readFileSync(h.intentFile, "utf8"));
  original.rawText = "\\".repeat(600000); fs.writeFileSync(h.intentFile, JSON.stringify(original));
  h.request.snapshot.threads.find(entry => entry.threadId === h.target().threadId)!.text = "界".repeat(600000);
  interruptAfterJournal(h);
  const body = fs.readFileSync(h.journalFile, "utf8");
  assert.ok(Buffer.byteLength(body) < 2 * 1024 * 1024); assert.equal(body.includes('"rawText"'), false);
  assert.equal(h.fresh().journal.replay().status, "committed");
  const result = h.fresh().pending.read(h.intentId).value!;
  for (const key of ["id", "createdAt", "source", "rawText", "configuration", "creation", "target"] as const) assert.deepEqual(result[key], original[key]);
  assert.equal(h.fresh().recovery.read().drafts!.threads.find(entry => entry.threadId === h.target().threadId)!.text, "界".repeat(600000));
});

test("caught authority reentry remains uncertain and cannot resume ordinary saves", native, t => {
  const h = fixture(t);
  assert.throws(() => h.journal.commit(h.request, { ...h.admission, authorize: () => { assert.throws(() => h.journal.commit(h.request, h.admission)); return false; } }));
  assert.throws(() => h.writer.save({ session: h.request.session, sequence: 2, snapshot: h.before }));
  assert.equal(fs.existsSync(h.journalFile), false); assert.equal(h.pending.read(h.intentId).value!.rawText, h.original);
});
