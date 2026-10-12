import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import type { Attachment, AttachmentDraftOwner } from "../src/shared/attachments.js";
import { AttachmentStore } from "../src/main/engine/attachments.js";
import { copyComposerRecovery, ComposerRecoveryWriter, UpdateRecovery, type ValidateRecoveryAttachment } from "../src/main/engine/update-recovery.js";

const legacyDrafts = () => ({
  threads: [{ threadId: "thread-1", text: "Unsent private text\nsecond line" }],
  selectedThreadId: null,
  draft: { projectId: "project-1", worktree: true, text: "New chat draft",
    settings: { backend: "codex" as const, mode: "agent" as const, plan: true, auto: false, model: "gpt-test", effort: "high" } },
});
const drafts = () => ({
  threads: legacyDrafts().threads.map(thread => ({ ...thread, attachments: [] as Attachment[] })),
  selectedThreadId: null,
  projects: [{ key: "draft:0:project-1", projectId: "project-1", text: legacyDrafts().draft.text, attachments: [] as Attachment[] }],
  draft: { revision: 0, projectId: "project-1", worktree: true, settings: legacyDrafts().draft.settings },
});
const sha512 = Buffer.alloc(64, 7).toString("base64");
function fixture(t: TestContext) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "modex-update-recovery-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { home, file: path.join(home, "update-recovery.json"), store: new UpdateRecovery(home) };
}

for (const outcome of ["uncertain", "staged"] as const) test(`read-only recovery close validates ${outcome} drafts and attachments without changing the attempt`, t => {
  const h = fixture(t), files = new AttachmentStore(path.join(h.home, "attachments"), { authorizeDraft: owner => owner.kind === "thread" && owner.threadId === "thread-1" });
  const capability = files.mintDraft({ kind: "thread", threadId: "thread-1" });
  const staged = files.stage([{ name: "saved.txt", data: Buffer.from("saved bytes").toString("base64") }], { draft: capability });
  assert.deepEqual(staged.errors, []);
  const saved = drafts(); saved.threads[0]!.attachments = staged.staged;
  const recovery = new UpdateRecovery(h.home, (file, owner) => files.validateRecovery(file, owner)), revision = recovery.saveDrafts(saved);
  const id = recovery.beginAttempt({ from: "0.0.10", to: "0.0.11", sha512, revision });
  if (outcome === "staged") recovery.recordOutcome(id, "staged");
  const before = fs.readFileSync(h.file), manifest = fs.readFileSync(path.join(files.root, ".manifest.json"));
  assert.equal(typeof (recovery as any).validateRecoveryClose, "function");
  (recovery as any).validateRecoveryClose(revision);
  assert.throws(() => recovery.validateSavedDrafts(revision), /recovery/);
  assert.throws(() => recovery.saveDrafts(saved), /recovery/);
  assert.throws(() => (recovery as any).validateRecoveryClose(revision + 1), /changed/);
  const attachment = path.join(files.root, staged.staged[0]!.rel);
  fs.renameSync(attachment, `${attachment}.preserved`); fs.writeFileSync(attachment, "replaced bytes");
  assert.throws(() => (recovery as any).validateRecoveryClose(revision), /attachment|recovery/i);
  assert.deepEqual(fs.readFileSync(h.file), before); assert.deepEqual(fs.readFileSync(path.join(files.root, ".manifest.json")), manifest);
});

test("recovery close without native admission still requires an unchanged readable saved revision", t => {
  const h = fixture(t), revision = h.store.saveDrafts(drafts()), before = fs.readFileSync(h.file);
  assert.equal(typeof (h.store as any).validateRecoveryClose, "function");
  (h.store as any).validateRecoveryClose(revision);
  assert.throws(() => (h.store as any).validateRecoveryClose(0), /changed/); assert.deepEqual(fs.readFileSync(h.file), before);
  fs.writeFileSync(h.file, "unreadable recovery");
  assert.throws(() => (h.store as any).validateRecoveryClose(revision), /recovery/i);
  assert.equal(fs.readFileSync(h.file, "utf8"), "unreadable recovery");
});

test("composer recovery survives a new process without altering text or new-chat settings", t => {
  const h = fixture(t);
  const revision = h.store.saveDrafts(drafts());
  assert.equal(revision, 1);
  const restored = new UpdateRecovery(h.home).read();
  assert.deepEqual(restored.drafts, drafts());
  assert.equal(restored.revision, revision);
  assert.equal(fs.statSync(h.file).mode & 0o777, 0o600);
  restored.drafts!.threads[0]!.text = "mutated caller copy";
  assert.equal(h.store.read().drafts!.threads[0]!.text, drafts().threads[0]!.text);
  assert.deepEqual(fs.readdirSync(h.home), ["update-recovery.json"]);
});

test("a native attempt requires the acknowledged draft revision and survives an interrupted handoff", t => {
  const h = fixture(t);
  const revision = h.store.saveDrafts(drafts());
  h.store.saveDrafts({ ...drafts(), threads: [{ threadId: "thread-1", text: "newer edit", attachments: [] }] });
  assert.throws(() => h.store.beginAttempt({ from: "0.0.10", to: "0.0.11", sha512, revision }), /draft.*changed/i);
  assert.equal(h.store.read().attempt, null);
  const id = h.store.beginAttempt({ from: "0.0.10", to: "0.0.11", sha512, revision: 2 });
  const restarted = new UpdateRecovery(h.home);
  assert.equal(restarted.inspect("0.0.10").attempt?.outcome, "uncertain");
  assert.equal(restarted.read().attempt?.id, id);
  assert.throws(() => restarted.beginAttempt({ from: "0.0.10", to: "0.0.11", sha512, revision: 2 }), /recovery/i);
  assert.throws(() => restarted.saveDrafts(drafts()), /recovery/i);
  assert.equal(restarted.read().drafts?.threads[0]?.text, "newer edit");
});

test("late matching success is sticky and only the target version confirms installation", t => {
  const h = fixture(t);
  const revision = h.store.saveDrafts(drafts());
  const id = h.store.beginAttempt({ from: "0.0.10", to: "0.0.11", sha512, revision });
  assert.throws(() => h.store.recordOutcome("another-attempt", "staged"), /attempt/i);
  h.store.recordOutcome(id, "staged");
  h.store.recordOutcome(id, "uncertain");
  assert.equal(h.store.inspect("0.0.10").attempt?.outcome, "staged");
  assert.equal(h.store.inspect("0.0.12").attempt?.outcome, "staged");
  assert.equal(h.store.inspect("0.0.11").attempt?.outcome, "installed");
  assert.deepEqual(h.store.read().drafts, drafts());
  assert.equal(h.store.saveDrafts({ threads: [], projects: [], selectedThreadId: null, draft: null }), 2);
  assert.equal(new UpdateRecovery(h.home).read().drafts?.threads.length, 0);
});

test("invalid or unsupported drafts fail without overwriting the last recoverable text", t => {
  const h = fixture(t);
  h.store.saveDrafts(drafts());
  const before = fs.readFileSync(h.file);
  const bad: unknown[] = [
    { ...drafts(), attachments: ["unhandled attachment"] },
    { ...drafts(), threads: [drafts().threads[0], drafts().threads[0]] },
    { ...drafts(), draft: { ...drafts().draft, attachments: ["unhandled attachment"] } },
    { ...drafts(), threads: [{ threadId: "thread-1", text: "a".repeat(2 * 1024 * 1024) }] },
    { ...drafts(), draft: { ...drafts().draft, settings: { ...drafts().draft.settings, mode: "unsupported" } } },
  ];
  for (const input of bad) assert.throws(() => h.store.saveDrafts(input), /draft|recovery/i);
  assert.deepEqual(fs.readFileSync(h.file), before);
});

test("corrupt, oversized and unsupported recovery files are preserved and block writes", t => {
  const h = fixture(t);
  for (const raw of ["{broken", JSON.stringify({ schema: 99 }), " ".repeat(2 * 1024 * 1024 + 1)]) {
    fs.writeFileSync(h.file, raw);
    assert.throws(() => h.store.read(), /recovery/i);
    assert.throws(() => h.store.saveDrafts(drafts()), /recovery/i);
    assert.equal(fs.readFileSync(h.file, "utf8"), raw);
  }
});

test("recovery never follows a substituted file symlink", t => {
  const h = fixture(t);
  const target = path.join(h.home, "other.json");
  fs.writeFileSync(target, "do not overwrite");
  fs.symlinkSync(target, h.file);
  assert.throws(() => h.store.read(), /recovery/i);
  assert.throws(() => h.store.saveDrafts(drafts()), /recovery/i);
  assert.equal(fs.readFileSync(target, "utf8"), "do not overwrite");
});

test("a failed durable write cannot create an in-memory native attempt", t => {
  const h = fixture(t);
  const revision = h.store.saveDrafts(drafts());
  // Simulate a disk-write/rename failure without filling the shared machine's disk.
  const rename = fs.renameSync;
  fs.renameSync = () => { throw Object.assign(new Error("no space"), { code: "ENOSPC" }); };
  try {
    assert.throws(() => h.store.beginAttempt({ from: "0.0.10", to: "0.0.11", sha512, revision }), /recovery/i);
  } finally { fs.renameSync = rename; }
  assert.equal(h.store.read().attempt, null);
  assert.deepEqual(h.store.read().drafts, drafts());
  assert.deepEqual(fs.readdirSync(h.home), ["update-recovery.json"]);
});

test("proven pre-native failure releases only the matching unstarted receipt and preserves drafts", t => {
  const h = fixture(t);
  const revision = h.store.saveDrafts(drafts());
  const id = h.store.beginAttempt({ id: "coordinator-owned-attempt", from: "0.0.10", to: "0.0.11", sha512, revision });
  assert.throws(() => h.store.releaseUnstartedAttempt("wrong-attempt"), /attempt/i);
  h.store.releaseUnstartedAttempt(id);
  assert.equal(h.store.read().attempt, null);
  assert.equal(h.store.read().revision, revision);
  assert.deepEqual(h.store.read().drafts, drafts());
  const second = h.store.beginAttempt({ from: "0.0.10", to: "0.0.11", sha512, revision });
  h.store.recordOutcome(second, "staged");
  assert.throws(() => h.store.releaseUnstartedAttempt(second), /attempt/i);
});

test("post-rename fsync failure is recoverable only when the coordinator proves native checking never started", t => {
  const h = fixture(t);
  const revision = h.store.saveDrafts(drafts());
  const sync = fs.fsyncSync;
  fs.fsyncSync = fd => {
    if (fs.fstatSync(fd).isDirectory()) throw new Error("directory sync failed");
    sync(fd);
  };
  try {
    assert.throws(() => h.store.beginAttempt({ id: "known-before-write", from: "0.0.10", to: "0.0.11", sha512, revision }), /recovery/i);
  } finally { fs.fsyncSync = sync; }
  assert.equal(h.store.read().attempt?.id, "known-before-write");
  h.store.releaseUnstartedAttempt("known-before-write");
  assert.deepEqual(h.store.read().drafts, drafts());
  assert.equal(h.store.saveDrafts(drafts()), revision + 1);
});

test("a delayed autosave cannot overwrite the newer synchronous close snapshot", t => {
  const h = fixture(t);
  const writer = new ComposerRecoveryWriter(h.store);
  let session = writer.reset();
  const latest = { ...drafts(), projects: [{ ...drafts().projects[0]!, text: "Final text before close" }] };
  assert.deepEqual(writer.save({ session, sequence: 2, snapshot: latest }), { revision: 1, saved: true });
  assert.deepEqual(writer.save({ session, sequence: 1, snapshot: drafts() }), { revision: 1, saved: false });
  assert.deepEqual(h.store.read().drafts, latest);
  assert.throws(() => writer.save({ session, sequence: 0, snapshot: drafts() }), /draft/i);
  session = writer.reset();
  assert.deepEqual(writer.save({ session, sequence: 1, snapshot: drafts() }), { revision: 2, saved: true });
});

test("an older renderer document cannot write after a new document starts recovery", t => {
  const h = fixture(t);
  const writer = new ComposerRecoveryWriter(h.store);
  const oldSession = writer.reset();
  const session = writer.reset();
  writer.save({ session, sequence: 1, snapshot: drafts() });
  assert.throws(() => writer.save({ session: oldSession, sequence: 100, snapshot: { ...drafts(), draft: null } }), /draft/i);
  assert.deepEqual(h.store.read().drafts, drafts());
});


const v2Drafts = () => ({
  threads: [{ threadId: "thread-1", text: "  sk-test-secret\n🔐 raw text  ", attachments: [] }],
  selectedThreadId: "thread-1",
  projects: [
    { key: "draft:7:project-1", projectId: "project-1", text: "First project", attachments: [] },
    { key: "draft:7:project-2", projectId: "project-2", text: "Second project", attachments: [] },
  ],
  draft: { revision: 7, projectId: "project-2", worktree: true, settings: drafts().draft.settings },
});

test("version 2 preserves every live project draft and raw thread text", t => {
  const h = fixture(t);
  h.store.saveDrafts(v2Drafts());
  assert.deepEqual(new UpdateRecovery(h.home).read().drafts, v2Drafts());
  assert.equal(JSON.parse(fs.readFileSync(h.file, "utf8")).schema, 2);
});

test("strict legacy recovery normalizes in memory without rewriting its evidence", t => {
  const h = fixture(t);
  const raw = JSON.stringify({ schema: 1, revision: 4, drafts: legacyDrafts(), attempt: null }, null, 2);
  fs.writeFileSync(h.file, raw);
  assert.deepEqual(h.store.read(), {
    schema: 2, revision: 4, attempt: null,
    drafts: { threads: legacyDrafts().threads.map(thread => ({ ...thread, attachments: [] })), selectedThreadId: null,
      projects: [{ key: "draft:0:project-1", projectId: "project-1", text: legacyDrafts().draft.text, attachments: [] }],
      draft: { revision: 0, projectId: "project-1", worktree: true, settings: legacyDrafts().draft.settings } },
  });
  assert.equal(fs.readFileSync(h.file, "utf8"), raw);
});

test("escaped invalid Unicode is rejected without changing saved evidence", t => {
  const h = fixture(t);
  h.store.saveDrafts(drafts());
  const before = fs.readFileSync(h.file);
  assert.throws(() => h.store.saveDrafts({ ...drafts(), threads: [{ threadId: "thread-1", text: "\ud800", attachments: [] }] }), /recovery/i);
  assert.deepEqual(fs.readFileSync(h.file), before);
});

const attachment = (id = "file-1"): Attachment => ({
  id, name: "raw 🔐.txt", mime: "text/plain", size: 4, kind: "file", rel: `staging/${id}-raw 🔐.txt`,
});
function attachedDrafts() {
  const snapshot = drafts();
  snapshot.threads[0]!.text = "";
  snapshot.threads[0]!.attachments = [attachment()];
  snapshot.projects[0]!.text = "";
  snapshot.projects[0]!.attachments = [attachment("file-2")];
  return snapshot;
}

test("attachment-only drafts roundtrip with immutable explicit owner contexts and raw metadata", t => {
  const h = fixture(t), input = attachedDrafts(), expected = structuredClone(input);
  const seen: unknown[] = [];
  const store = new UpdateRecovery(h.home, (file, context, snapshot) => {
    assert.ok(Object.isFrozen(file)); assert.ok(Object.isFrozen(context));
    assert.ok(Object.isFrozen(snapshot.threads[0]!.attachments));
    seen.push([structuredClone(file), structuredClone(context)]);
    input.threads[0]!.attachments[0]!.name = "caller changed during validation";
    assert.equal(snapshot.threads[0]!.attachments[0]!.name, "raw 🔐.txt");
    return true;
  });
  const revision = store.saveDrafts(input);
  assert.deepEqual(store.read().drafts, expected);
  store.beginAttempt({ from: "0.0.10", to: "0.0.11", sha512, revision });
  assert.deepEqual(seen, [...Array(2)].flatMap(() => [
    [attachment(), { kind: "thread", threadId: "thread-1" }],
    [attachment("file-2"), { kind: "project", key: "draft:0:project-1", projectId: "project-1" }],
  ]));
});

test("attachment snapshots require explicit synchronous validation on save and again before native preparation", t => {
  const h = fixture(t);
  h.store.saveDrafts(drafts());
  const before = fs.readFileSync(h.file);
  assert.throws(() => h.store.saveDrafts(attachedDrafts()), /recovery/i);
  for (const result of [false, undefined, {}, Promise.resolve(true)]) {
    const validator = (() => result) as unknown as ValidateRecoveryAttachment;
    assert.throws(() => new UpdateRecovery(h.home, validator).saveDrafts(attachedDrafts()), /recovery/i);
    assert.deepEqual(fs.readFileSync(h.file), before);
  }
  const store = new UpdateRecovery(h.home, () => true);
  const revision = store.saveDrafts(attachedDrafts());
  const saved = fs.readFileSync(h.file);
  // A structurally valid record can be displayed after restart without file validation.
  assert.deepEqual(h.store.read().drafts, attachedDrafts());
  assert.throws(() => h.store.beginAttempt({ from: "0.0.10", to: "0.0.11", sha512, revision }), /recovery/i);
  assert.deepEqual(fs.readFileSync(h.file), saved);
});

test("missing, replaced and foreign attachment references refuse preparation without deleting evidence", t => {
  const h = fixture(t), snapshot = attachedDrafts();
  const file = path.join(h.home, "owned-file"), oldFile = path.join(h.home, "old-file");
  fs.writeFileSync(file, "DATA");
  const identity = fs.statSync(file);
  let owner = "thread-1";
  // Test capability only: the real AttachmentStore adapter/draft binding is integration work.
  const store = new UpdateRecovery(h.home, (metadata, context) => {
    if (context.kind === "project") return true;
    if (owner !== context.threadId || JSON.stringify(metadata) !== JSON.stringify(attachment())) return false;
    try { const stat = fs.lstatSync(file); return stat.isFile() && stat.dev === identity.dev && stat.ino === identity.ino && stat.size === metadata.size; }
    catch { return false; }
  });
  const revision = store.saveDrafts(snapshot), before = fs.readFileSync(h.file);
  const refuse = () => {
    assert.throws(() => store.beginAttempt({ from: "0.0.10", to: "0.0.11", sha512, revision }), /recovery/i);
    assert.throws(() => store.saveDrafts(snapshot), /recovery/i);
    assert.deepEqual(fs.readFileSync(h.file), before);
  };
  owner = "foreign-thread"; refuse(); owner = "thread-1";
  fs.renameSync(file, oldFile); refuse();
  fs.writeFileSync(file, "FAKE"); refuse();
  assert.equal(fs.readFileSync(file, "utf8"), "FAKE");
  assert.equal(fs.readFileSync(oldFile, "utf8"), "DATA");
});

test("validator mutation and caught same-instance reentry cannot commit a snapshot", t => {
  const h = fixture(t); h.store.saveDrafts(drafts()); const before = fs.readFileSync(h.file);
  const mutating = new UpdateRecovery(h.home, (file) => { (file as Attachment).name = "changed"; return true; });
  assert.throws(() => mutating.saveDrafts(attachedDrafts()), TypeError);
  let store: UpdateRecovery;
  store = new UpdateRecovery(h.home, () => { assert.throws(() => store.saveDrafts(drafts()), /recovery/i); return true; });
  assert.throws(() => store.saveDrafts(attachedDrafts()), /recovery/i);
  assert.deepEqual(fs.readFileSync(h.file), before);
});

test("a validator cannot overwrite a newer revision or receipt written through another instance", t => {
  const h = fixture(t); h.store.saveDrafts(drafts());
  let changed = false;
  const newer = { ...drafts(), projects: [{ ...drafts().projects[0]!, text: "newer recovery" }] };
  const store = new UpdateRecovery(h.home, () => {
    if (!changed) { changed = true; h.store.saveDrafts(newer); }
    return true;
  });
  assert.throws(() => store.saveDrafts(attachedDrafts()), /recovery/i);
  assert.equal(h.store.read().revision, 2); assert.deepEqual(h.store.read().drafts, newer);
  const writer = new UpdateRecovery(h.home, () => true);
  const revision = writer.saveDrafts(attachedDrafts());
  let nested = false;
  const preparing = new UpdateRecovery(h.home, () => {
    if (!nested) { nested = true; writer.beginAttempt({ id: "other-attempt", from: "0.0.10", to: "0.0.11", sha512, revision }); }
    return true;
  });
  assert.throws(() => preparing.beginAttempt({ id: "outer-attempt", from: "0.0.10", to: "0.0.11", sha512, revision }), /recovery/i);
  assert.equal(h.store.read().attempt?.id, "other-attempt");
});

test("saved-draft preflight validates without rewriting the acknowledged snapshot", t => {
  const h = fixture(t);
  let validations = 0;
  const store = new UpdateRecovery(h.home, () => { validations++; return true; });
  const revision = store.saveDrafts(attachedDrafts());
  const before = fs.readFileSync(h.file), priorValidations = validations;
  store.validateSavedDrafts(revision);
  assert.ok(validations > priorValidations);
  assert.deepEqual(fs.readFileSync(h.file), before);
  assert.throws(() => store.validateSavedDrafts(revision + 1), /draft.*changed/i);
  assert.deepEqual(fs.readFileSync(h.file), before);
  store.beginAttempt({ from: "0.0.10", to: "0.0.11", sha512, revision });
  const attempted = fs.readFileSync(h.file);
  assert.throws(() => store.validateSavedDrafts(revision), /recovery/i);
  assert.deepEqual(fs.readFileSync(h.file), attempted);
});

test("saved-draft preflight rejects caught validator reentry without changing recovery", t => {
  const h = fixture(t), writer = new UpdateRecovery(h.home, () => true);
  const revision = writer.saveDrafts(attachedDrafts()), before = fs.readFileSync(h.file);
  const guarded = new UpdateRecovery(h.home, () => {
    assert.throws(() => guarded.validateSavedDrafts(revision), /recovery/i);
    return true;
  });
  assert.throws(() => guarded.validateSavedDrafts(revision), /recovery/i);
  assert.deepEqual(fs.readFileSync(h.file), before);
});

test("saved-draft preflight detects a newer write by another instance and preserves it", t => {
  const h = fixture(t), writer = new UpdateRecovery(h.home, () => true);
  const revision = writer.saveDrafts(attachedDrafts());
  const newer = drafts(); newer.threads[0]!.text = "Newer input must survive";
  let changed = false;
  const guarded = new UpdateRecovery(h.home, () => {
    if (!changed) { changed = true; h.store.saveDrafts(newer); }
    return true;
  });
  assert.throws(() => guarded.validateSavedDrafts(revision), /recovery/i);
  assert.equal(h.store.read().revision, revision + 1);
  assert.deepEqual(h.store.read().drafts, newer);
});

test("duplicate references, invalid project keys and unsupported metadata never overwrite a valid record", t => {
  const h = fixture(t), store = new UpdateRecovery(h.home, () => true);
  store.saveDrafts(attachedDrafts()); const before = fs.readFileSync(h.file);
  const cases: ((v: ReturnType<typeof attachedDrafts>) => void)[] = [
    v => { v.projects[0]!.attachments = [attachment()]; },
    v => { v.projects.push(structuredClone(v.projects[0]!)); },
    v => { v.projects[0]!.key = "draft:1:project-1"; },
    v => { v.draft.projectId = "missing-project"; },
    v => { Object.assign(v, { selectedThreadId: "missing-thread" }); },
    v => { v.threads[0]!.attachments[0]!.rel = "foreign-thread/file-1-raw 🔐.txt"; },
    v => { v.threads[0]!.attachments[0]!.rel = "staging/../outside"; },
    v => { v.threads[0]!.attachments[0]!.size = -1; },
    v => { Object.assign(v.threads[0]!.attachments[0]!, { token: "unsupported" }); },
  ];
  for (const change of cases) {
    const candidate = attachedDrafts(); change(candidate);
    assert.throws(() => store.saveDrafts(candidate), /recovery/i);
    assert.deepEqual(fs.readFileSync(h.file), before);
  }
});

test("UTF-8 and escaped JSON budgets are checked before serializing an oversized snapshot", t => {
  const h = fixture(t); h.store.saveDrafts(drafts()); const before = fs.readFileSync(h.file);
  for (const text of ["🔐".repeat(300000), "\u0000".repeat(400000), "x".repeat(800000)]) {
    const candidate = drafts();
    candidate.threads = [1, 2, 3].map(n => ({ threadId: `thread-${n}`, text, attachments: [] }));
    const stringify = JSON.stringify;
    let calls = 0;
    JSON.stringify = ((...args: Parameters<typeof JSON.stringify>) => { calls++; return stringify(...args); }) as typeof JSON.stringify;
    try { assert.throws(() => h.store.saveDrafts(candidate), /recovery/i); } finally { JSON.stringify = stringify; }
    assert.equal(calls, 0);
    assert.deepEqual(fs.readFileSync(h.file), before);
  }
});

test("hostile object topology and hidden serialization hooks are rejected without invoking them", t => {
  const h = fixture(t); h.store.saveDrafts(drafts()); const before = fs.readFileSync(h.file);
  let invoked = false;
  const hook = drafts(); Object.defineProperty(hook, "toJSON", { value: () => { invoked = true; return drafts(); } });
  const getter = drafts(); Object.defineProperty(getter, "projects", { enumerable: true, get: () => { invoked = true; return []; } });
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  const tooMany = { ...drafts(), threads: Array.from({ length: 1001 }, (_, n) => ({ threadId: `thread-${n}`, text: "", attachments: [] })) };
  for (const candidate of [hook, getter, cycle, tooMany]) assert.throws(() => h.store.saveDrafts(candidate), /recovery/i);
  assert.equal(invoked, false); assert.deepEqual(fs.readFileSync(h.file), before);
});

test("invalid UTF-8 and unknown fields in both schema versions preserve exact on-disk bytes", t => {
  const h = fixture(t);
  for (const raw of [Buffer.from([0xff, 0xfe]), Buffer.from(JSON.stringify({ schema: 1, revision: 1, drafts: { ...legacyDrafts(), extra: 1 }, attempt: null })),
    Buffer.from(JSON.stringify({ schema: 2, revision: 1, drafts: drafts(), attempt: null, extra: 1 }))]) {
    fs.writeFileSync(h.file, raw);
    assert.throws(() => h.store.read(), /recovery/i);
    assert.throws(() => h.store.saveDrafts(drafts()), /recovery/i);
    assert.deepEqual(fs.readFileSync(h.file), raw);
  }
});


test("a full legacy thread list plus a project and selected empty thread remains readable", t => {
  const h = fixture(t), old = legacyDrafts();
  old.threads = Array.from({ length: 500 }, (_, n) => ({ threadId: `thread-${n}`, text: "raw" }));
  Object.assign(old, { selectedThreadId: "selected-empty" });
  const raw = JSON.stringify({ schema: 1, revision: 1, drafts: old, attempt: null });
  fs.writeFileSync(h.file, raw);
  assert.equal(h.store.read().drafts?.threads.length, 501);
  assert.equal(fs.readFileSync(h.file, "utf8"), raw);
});

test("legacy data at the disk byte limit remains readable despite bounded migration overhead", t => {
  const h = fixture(t), old = legacyDrafts();
  old.threads = [{ threadId: "thread-1", text: "x".repeat(1024 * 1024) }, { threadId: "thread-2", text: "" }];
  const record = { schema: 1, revision: 1, drafts: old, attempt: null };
  const overhead = Buffer.byteLength(JSON.stringify(record));
  old.threads[1]!.text = "x".repeat(2 * 1024 * 1024 - overhead - 1);
  const raw = JSON.stringify(record);
  assert.equal(Buffer.byteLength(raw), 2 * 1024 * 1024 - 1);
  fs.writeFileSync(h.file, raw);
  assert.equal(h.store.read().drafts?.threads[1]!.text, old.threads[1]!.text);
  assert.equal(fs.readFileSync(h.file, "utf8"), raw);
  // New writes still have the normal disk cap. Refuse an oversized migration without losing it.
  assert.throws(() => h.store.beginAttempt({ from: "0.0.10", to: "0.0.11", sha512, revision: 1 }), /recovery/i);
  assert.equal(fs.readFileSync(h.file, "utf8"), raw);
  assert.equal(h.store.saveDrafts(drafts()), 2);
});

test("duplicate decoded JSON keys at every depth preserve ambiguous recovery evidence", t => {
  const h = fixture(t);
  const records = [
    `{"schema":1,"revision":1,"drafts":${JSON.stringify(legacyDrafts())},"drafts":null,"attempt":null}`,
    `{"schema":2,"revision":1,"drafts":${JSON.stringify(drafts())},"dra\\u0066ts":null,"attempt":null}`,
    JSON.stringify({ schema: 1, revision: 1, drafts: legacyDrafts(), attempt: null }).replace('"text":', '"text":"hidden earlier text","text":'),
    JSON.stringify({ schema: 2, revision: 1, drafts: attachedDrafts(), attempt: null }).replace('"size":4', '"size":3,"s\\u0069ze":4'),
  ];
  for (const raw of records) {
    fs.writeFileSync(h.file, raw);
    assert.throws(() => h.store.read(), /recovery/i);
    assert.throws(() => h.store.saveDrafts(drafts()), /recovery/i);
    assert.equal(fs.readFileSync(h.file, "utf8"), raw);
  }
});

test("real attachment ownership restores thread-only files and multiple project drafts after restart", t => {
  const h = fixture(t);
  const contexts: AttachmentDraftOwner[] = [
    { kind: "thread", threadId: "thread-1" },
    { kind: "project", key: "draft:0:project-1", projectId: "project-1" },
    { kind: "project", key: "draft:0:project-2", projectId: "project-2" },
  ];
  const authorizeDraft = (owner: AttachmentDraftOwner) => contexts.some(context => JSON.stringify(context) === JSON.stringify(owner));
  const root = path.join(h.home, "attachments");
  const attachments = new AttachmentStore(root, { authorizeDraft });
  const files = contexts.map((owner, i) => attachments.stage([{ name: `draft-${i}.txt`, data: Buffer.from(`original-${i}`).toString("base64") }],
    { draft: attachments.mintDraft(owner) }).staged[0]!);
  const snapshot = { ...drafts(), threads: [{ threadId: "thread-1", text: "", attachments: [files[0]!] }],
    projects: contexts.slice(1).map((context, i) => ({ key: context.kind === "project" ? context.key : "", projectId: `project-${i + 1}`,
      text: i ? "secret text stays intact" : "", attachments: [files[i + 1]!] })) };
  const model = new UpdateRecovery(h.home, (file, context) => attachments.validateRecovery(file, context));
  const revision = model.saveDrafts(snapshot);
  const fresh = new AttachmentStore(root, { authorizeDraft });
  const restored = new UpdateRecovery(h.home, (file, context) => fresh.validateRecovery(file, context));
  assert.deepEqual(restored.read().drafts, snapshot);
  assert.equal(fresh.setRecoveryRetention(files), true);
  const unrelated = fresh.stage([{ name: "expired.txt", data: "YQ==" }]).staged[0]!;
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
  for (const file of [...files, unrelated]) fs.utimesSync(path.join(root, file.rel), old, old);
  assert.equal(fresh.sweepStaging(), 1);
  for (const [i, file] of files.entries()) assert.equal(fs.readFileSync(path.join(root, file.rel), "utf8"), `original-${i}`);
  restored.beginAttempt({ from: "0.0.10", to: "0.0.11", sha512, revision });
  assert.deepEqual(restored.read().drafts, snapshot);
});

for (const fault of ["missing", "replaced", "revoked-context"] as const) {
  test(`real recovery validation refuses ${fault} attachments without altering saved recovery`, t => {
    const h = fixture(t); let authorized = true;
    const attachments = new AttachmentStore(path.join(h.home, "attachments"), { authorizeDraft: () => authorized });
    const context: AttachmentDraftOwner = { kind: "thread", threadId: "thread-1" };
    const attachment = attachments.stage([{ name: "draft.txt", data: "YQ==" }], { draft: attachments.mintDraft(context) }).staged[0]!;
    const snapshot = { ...drafts(), threads: [{ threadId: "thread-1", text: "", attachments: [attachment] }] };
    const model = new UpdateRecovery(h.home, (file, owner) => attachments.validateRecovery(file, owner));
    const revision = model.saveDrafts(snapshot);
    const before = fs.readFileSync(h.file);
    const manifest = path.join(attachments.root, ".manifest.json"); const metadata = fs.readFileSync(manifest);
    const target = path.join(attachments.root, attachment.rel);
    if (fault === "revoked-context") authorized = false;
    else {
      fs.renameSync(target, target + ".preserved");
      if (fault === "replaced") fs.writeFileSync(target, "b");
    }
    assert.throws(() => model.saveDrafts(snapshot), /attachment|recovery/i);
    assert.throws(() => model.beginAttempt({ from: "0.0.10", to: "0.0.11", sha512, revision }), /attachment|recovery/i);
    assert.deepEqual(fs.readFileSync(h.file), before);
    assert.deepEqual(fs.readFileSync(manifest), metadata);
    assert.equal(fs.readFileSync(fault === "revoked-context" ? target : target + ".preserved", "utf8"), "a");
    if (fault === "replaced") assert.equal(fs.readFileSync(target, "utf8"), "b");
  });
}

test("transaction snapshot copy preserves raw drafts without caller aliases or disk writes", t => {
  const h = fixture(t);
  const input = drafts();
  input.threads[0]!.text = "  original\n\tsecret text 😀  ";
  const copied = copyComposerRecovery(input);
  assert.deepEqual(copied, input);
  input.threads[0]!.text = "later typing";
  input.draft.settings.model = "changed";
  assert.equal(copied.threads[0]!.text, "  original\n\tsecret text 😀  ");
  assert.equal(copied.draft!.settings.model, "gpt-test");
  copied.projects[0]!.text = "changed returned copy";
  assert.equal(input.projects[0]!.text, "New chat draft");
  assert.deepEqual(fs.readdirSync(h.home), []);
});

test("transaction snapshot copy retains strict schema, aggregate bounds, and data-only validation", () => {
  let accessorReads = 0;
  const accessor = { ...drafts(), get threads() { accessorReads++; return []; } };
  const circular: Record<string, unknown> = {}; circular.self = circular;
  for (const value of [
    legacyDrafts(), { ...drafts(), extra: true }, { ...drafts(), draft: null },
    { ...drafts(), threads: [drafts().threads[0], drafts().threads[0]] },
    { ...drafts(), threads: [{ threadId: "thread-1", text: "x".repeat(1024 * 1024 + 1), attachments: [] }] },
    { ...drafts(), threads: [{ threadId: "thread-1", text: "😀".repeat(512 * 1024), attachments: [] }] },
    accessor, circular,
  ]) assert.throws(() => copyComposerRecovery(value), /recovery/i);
  assert.equal(accessorReads, 0);
});

test("a sealed transfer orders delayed autosaves and close saves and acknowledges an exact duplicate once", t => {
  const h = fixture(t), writer = new ComposerRecoveryWriter(h.store), session = writer.reset();
  writer.save({ session, sequence: 1, snapshot: drafts() });
  const latest = drafts(); latest.projects[0]!.text = "new typing while create awaited";
  const request = { session, sequence: 3, id: "transfer-1", snapshot: latest };
  let claims = 0;
  const run = (snapshot: unknown) => { claims++; return { status: "committed" as const, revision: h.store.saveDrafts(snapshot) }; };
  assert.deepEqual(writer.transaction(request, run), { status: "committed", revision: 2 });
  assert.deepEqual(writer.save({ session, sequence: 2, snapshot: drafts() }), { saved: false, revision: 2 });
  assert.deepEqual(writer.save({ session, sequence: 3, snapshot: drafts() }), { saved: false, revision: 2 });
  const duplicate = writer.transaction(request, run);
  assert.deepEqual(duplicate, { status: "committed", revision: 2 });
  assert.ok(Object.isFrozen(duplicate));
  assert.equal(claims, 1);
  assert.deepEqual(h.store.read().drafts, latest);
  assert.throws(() => writer.transaction({ ...request, snapshot: drafts() }, run), /identity/i);
  writer.save({ session, sequence: 4, snapshot: drafts() });
  assert.deepEqual(writer.transaction(request, run), { status: "stale", revision: 3 });
  assert.equal(claims, 1);
});

test("transaction envelopes reject stale documents, stale sequences and accessors before callback side effects", t => {
  const h = fixture(t), writer = new ComposerRecoveryWriter(h.store), old = writer.reset(), session = writer.reset();
  writer.save({ session, sequence: 2, snapshot: drafts() });
  let calls = 0;
  const run = () => { calls++; return { status: "unchanged" as const }; };
  assert.throws(() => writer.transaction({ session: old, sequence: 99, id: "tx", snapshot: drafts() }, run), /invalid/i);
  assert.deepEqual(writer.transaction({ session, sequence: 1, id: "tx", snapshot: drafts() }, run), { status: "stale", revision: 1 });
  assert.throws(() => writer.transaction({ session, sequence: 3, id: "tx", get snapshot() { calls++; return drafts(); } }, run), /invalid/i);
  assert.equal(calls, 0);
});

test("a proven unchanged refusal permits subsequent drafts and document reset", t => {
  const h = fixture(t), writer = new ComposerRecoveryWriter(h.store), session = writer.reset();
  const request = { session, sequence: 1, id: "tx", snapshot: drafts() };
  assert.deepEqual(writer.transaction(request, (snapshot, before) => {
    assert.ok(Object.isFrozen(snapshot.threads[0]));
    assert.ok(Object.isFrozen(before));
    assert.throws(() => { (snapshot.threads[0] as { text: string }).text = "alias mutation"; }, TypeError);
    return { status: "unchanged" };
  }), { status: "unchanged", revision: 0 });
  assert.deepEqual(writer.save({ session, sequence: 2, snapshot: drafts() }), { saved: true, revision: 1 });
  assert.notEqual(writer.reset(), session);
});

for (const operation of ["save", "reset", "transaction"] as const) {
  test(`transaction ${operation} reentry cannot be hidden by catching its exception`, t => {
    const h = fixture(t), writer = new ComposerRecoveryWriter(h.store), session = writer.reset();
    const request = { session, sequence: 1, id: "tx", snapshot: drafts() };
    assert.throws(() => writer.transaction(request, () => {
      assert.throws(() => {
        if (operation === "save") writer.save(request);
        else if (operation === "reset") writer.reset();
        else writer.transaction(request, () => ({ status: "unchanged" }));
      }, /recovery/i);
      return { status: "unchanged" };
    }), /recovery/i);
    assert.throws(() => writer.save({ ...request, sequence: 2 }), /recovery/i);
    assert.throws(() => writer.reset(), /recovery/i);
    assert.equal(h.store.read().revision, 0);
  });
}

for (const fault of ["wrong-revision", "wrong-snapshot", "changed-attempt", "changed-but-unchanged", "async-result"] as const) {
  test(`a transaction with ${fault} cannot acknowledge or release uncertain writes`, t => {
    const h = fixture(t), writer = new ComposerRecoveryWriter(h.store), session = writer.reset();
    const request = { session, sequence: 1, id: "tx", snapshot: drafts() };
    assert.throws(() => writer.transaction(request, snapshot => {
      if (fault === "async-result") return Promise.resolve({ status: "unchanged" }) as never;
      const changed = copyComposerRecovery(snapshot);
      if (fault === "wrong-snapshot") changed.threads[0]!.text = "different raw text";
      const revision = h.store.saveDrafts(changed);
      if (fault === "changed-attempt") h.store.beginAttempt({ from: "0.0.10", to: "0.0.11", sha512, revision });
      if (fault === "changed-but-unchanged") return { status: "unchanged" };
      return { status: "committed", revision: revision + (fault === "wrong-revision" ? 1 : 0) };
    }), /recovery/i);
    assert.throws(() => writer.reset(), /recovery/i);
    assert.throws(() => writer.save({ ...request, sequence: 2 }), /recovery/i);
  });
}

for (const phase of ["file", "directory"] as const) {
  test(`failed ${phase} fsync holds the transaction even when the recovery record can be read`, t => {
    const h = fixture(t), writer = new ComposerRecoveryWriter(h.store), session = writer.reset();
    writer.save({ session, sequence: 1, snapshot: drafts() });
    const after = drafts(); after.threads[0]!.text = "sealed transfer draft";
    const sync = fs.fsyncSync;
    fs.fsyncSync = fd => {
      if (fs.fstatSync(fd).isDirectory() === (phase === "directory")) throw new Error("injected fsync failure");
      sync(fd);
    };
    try {
      assert.throws(() => writer.transaction({ session, sequence: 2, id: "tx", snapshot: after }, snapshot =>
        ({ status: "committed", revision: h.store.saveDrafts(snapshot) })), /recovery/i);
    } finally { fs.fsyncSync = sync; }
    assert.deepEqual(h.store.read().drafts, phase === "file" ? drafts() : after);
    assert.throws(() => writer.save({ session, sequence: 3, snapshot: drafts() }), /recovery/i);
    assert.throws(() => writer.reset(), /recovery/i);
    // The durable adapter must prove/replay its journal before constructing a
    // fresh writer. This fixture explicitly re-saves the proven target first.
    const replayed = new UpdateRecovery(h.home); replayed.saveDrafts(after);
    const fresh = new ComposerRecoveryWriter(replayed), freshSession = fresh.reset();
    assert.equal(fresh.save({ session: freshSession, sequence: 1, snapshot: after }).saved, true);
  });
}

test("a transaction captures its envelope before a callback mutates caller-owned data", t => {
  const h = fixture(t), writer = new ComposerRecoveryWriter(h.store), session = writer.reset();
  const original = drafts(), request = { session, sequence: 2, id: "original-tx", snapshot: drafts() };
  assert.deepEqual(writer.transaction(request, snapshot => {
    request.sequence = 99; request.id = "changed-tx"; request.snapshot.threads[0]!.text = "caller changed";
    return { status: "committed", revision: h.store.saveDrafts(snapshot) };
  }), { status: "committed", revision: 1 });
  assert.deepEqual(h.store.read().drafts, original);
  assert.deepEqual(writer.transaction({ session, sequence: 2, id: "original-tx", snapshot: original }, () => {
    throw new Error("must not repeat");
  }), { status: "committed", revision: 1 });
  assert.equal(writer.save({ session, sequence: 3, snapshot: drafts() }).saved, true);
});

test("journal draft commits compare complete records and replay checkpoints retain exact revision", { skip: process.platform === "win32" }, t => {
  const h = fixture(t), before = h.store.capture();
  assert.equal(h.store.commitDrafts(before, drafts()), 1);
  const after = h.store.read(), proof = h.store.capture();
  const bytes = fs.readFileSync(h.file), inode = fs.statSync(h.file).ino;
  h.store.checkpoint(proof);
  assert.deepEqual(fs.readFileSync(h.file), bytes); assert.equal(fs.statSync(h.file).ino, inode);
  assert.deepEqual(h.store.read(), after);
  assert.throws(() => h.store.commitDrafts(before, drafts()), /recovery/i);
  h.store.saveDrafts({ ...drafts(), threads: [{ threadId: "thread-1", text: "intervening new raw text", attachments: [] }] });
  const newer = fs.readFileSync(h.file);
  assert.throws(() => h.store.checkpoint(proof), /recovery/i);
  assert.deepEqual(fs.readFileSync(h.file), newer);
});

test("journal checkpoint failure preserves evidence and latches every recovery mutation until fresh replay", { skip: process.platform === "win32" }, t => {
  const h = fixture(t); h.store.saveDrafts(drafts());
  const after = h.store.read(), proof = h.store.capture(), sync = fs.fsyncSync, parent = fs.statSync(path.dirname(h.home));
  fs.fsyncSync = fd => { const stat = fs.fstatSync(fd); if (stat.dev === parent.dev && stat.ino === parent.ino) throw new Error("injected ancestor durability"); sync(fd); };
  try { assert.throws(() => h.store.checkpoint(proof), /uncertain/i); }
  finally { fs.fsyncSync = sync; }
  assert.deepEqual(new UpdateRecovery(h.home).read(), after);
  assert.throws(() => h.store.saveDrafts(drafts()), /recovery|uncertain/i);
  const fresh = new UpdateRecovery(h.home); fresh.checkpoint(fresh.capture());
  assert.deepEqual(fresh.read(), after);
});

for (const operation of ["commit", "checkpoint"] as const) {
  test(`journal ${operation} refuses a same-body inode replacement after capture`, { skip: process.platform === "win32" }, t => {
    const h = fixture(t); h.store.saveDrafts(drafts());
    const proof = h.store.capture(), bytes = fs.readFileSync(h.file);
    fs.renameSync(h.file, h.file + ".preserved"); fs.writeFileSync(h.file, bytes);
    assert.throws(() => operation === "commit" ? h.store.commitDrafts(proof, drafts()) : h.store.checkpoint(proof), /recovery/i);
    assert.deepEqual(fs.readFileSync(h.file), bytes); assert.deepEqual(fs.readFileSync(h.file + ".preserved"), bytes);
  });
}

test("journal capture refuses BOM while legacy checkpoint preserves literal bytes and migration remains read-only", { skip: process.platform === "win32" }, t => {
  const h = fixture(t), legacy = JSON.stringify({ schema: 1, revision: 1, drafts: legacyDrafts(), attempt: null }, null, 2);
  fs.writeFileSync(h.file, legacy); const proof = h.store.capture(), inode = fs.statSync(h.file).ino;
  assert.equal(proof.value!.schema, 2);
  h.store.checkpoint(proof); assert.equal(fs.readFileSync(h.file, "utf8"), legacy); assert.equal(fs.statSync(h.file).ino, inode);
  const withBOM = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(legacy)]);
  fs.writeFileSync(h.file, withBOM); assert.throws(() => h.store.capture(), /JSON|recovery/i);
  assert.deepEqual(fs.readFileSync(h.file), withBOM);
});
