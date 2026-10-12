import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import type { Attachment } from "../src/shared/attachments.js";
import { PendingSends, PENDING_TEXT_CHARACTERS, type PendingSendInput } from "../src/main/engine/pending-sends.js";
import { UpdateRecovery, copyComposerRecovery } from "../src/main/engine/update-recovery.js";
import { RecoveryFileWriteError } from "../src/main/engine/attachment-recovery-file.js";

const configuration = () => ({ worktree: true, settings: { backend: "mock" as const, mode: "agent" as const, plan: true, auto: false, model: "model", effort: "high" } });
const file = (): Attachment => ({ id: "file-1", name: "note.txt", kind: "file", mime: "text/plain", size: 1, rel: "staging/file-1-note.txt" });
const input = (files: Attachment[] = []): PendingSendInput => ({ source: { kind: "project", key: "draft:0:project-1", projectId: "project-1" },
  rawText: "  original unsent\n\t😀  ", configuration: configuration(), files });
const native = { skip: process.platform === "win32" };
function fixture(t: TestContext) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "modex-pending-send-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const pending = new PendingSends(home), directory = path.join(home, "pending-sends");
  return { home, pending, directory, fresh: () => new PendingSends(home), file: (id: string) => path.join(directory, `${id}.json`) };
}
const target = (record: NonNullable<ReturnType<PendingSends["read"]>["value"]>) => {
  assert.equal(record.source.kind, "project"); assert.ok(record.creation);
  return { threadId: record.creation.threadId, projectId: "project-1", createdAt: record.creation.createdAt };
};

// Callbacks here model main-owned authority only. Live registry/Store/IPC and
// cross-record replay are separate adapter acceptance, not implied by these tests.
test("pending original text/configuration and main-generated creation identity survive new instances without caller aliases", native, t => {
  const h = fixture(t), original = input([file()]); let authorized = 0;
  const saved = h.pending.begin(original, record => {
    authorized++; assert.ok(Object.isFrozen(record.configuration.settings)); assert.ok(Object.isFrozen(record.files[0]));
    assert.equal(record.target, null); return true;
  });
  assert.equal(authorized, 1); assert.ok(saved.value);
  original.rawText = "new typing"; original.configuration.settings.model = "changed"; original.files[0]!.name = "changed";
  const restored = h.fresh().read(saved.value.id);
  assert.equal(restored.value!.rawText, input().rawText);
  assert.deepEqual(restored.value!.configuration, configuration());
  assert.deepEqual(restored.value!.files, [file()]);
  assert.deepEqual(restored.value!.creation, saved.value.creation);
  assert.equal(restored.value!.target, null);
  assert.deepEqual(h.pending.list(), { ids: [saved.value.id], evidence: [] });
  assert.throws(() => h.pending.adoption(saved.value!.id, [file()]), /recovery/i);
  assert.throws(() => h.pending.complete(saved.value!.id, () => true), /recovery/i);
});

test("refused or asynchronous authority and malformed input create no pending file", t => {
  const h = fixture(t); let reads = 0;
  assert.throws(() => h.pending.begin(input(), () => false), /recovery/i);
  assert.throws(() => h.pending.begin(input(), (() => Promise.resolve(true)) as never), /recovery/i);
  assert.throws(() => h.pending.begin({ ...input(), get rawText() { reads++; return "secret"; } }, () => true), /recovery/i);
  assert.equal(reads, 0); assert.deepEqual(fs.readdirSync(h.directory), []);
});

for (const field of ["threadId", "projectId", "createdAt"] as const) {
  test(`binding refuses a ${field} mismatch with the persisted main creation identity`, native, t => {
    const h = fixture(t), saved = h.pending.begin(input(), () => true), id = saved.value!.id, before = fs.readFileSync(h.file(id));
    assert.throws(() => h.pending.bind(id, record => ({ ...target(record), [field]: field === "createdAt" ? "2026-10-01T00:00:00.000Z" : "unrelated" })), /recovery/i);
    assert.deepEqual(fs.readFileSync(h.file(id)), before);
  });
}

test("binding a main-confirmed target is idempotent and leaves original ownership until the claim journal commits", native, t => {
  const h = fixture(t), saved = h.pending.begin(input([file()]), () => true), id = saved.value!.id;
  const bound = h.pending.bind(id, target), again = h.pending.bind(id, target);
  assert.equal(bound.sha256, again.sha256);
  assert.deepEqual(bound.value!.owner, input().source);
  assert.deepEqual(bound.value!.files, [file()]);
  assert.equal(bound.value!.rawText, input().rawText);
});

test("ordinary draft saves remain independent while creation is pending and both raw texts survive restart", native, t => {
  const h = fixture(t), saved = h.pending.begin(input(), () => true);
  const recovery = new UpdateRecovery(h.home);
  const newer = { threads: [], selectedThreadId: null, projects: [{ key: "draft:1:project-2", projectId: "project-2", text: "  new independent raw\ntext  ", attachments: [] }],
    draft: { revision: 1, projectId: "project-2", ...configuration() } };
  recovery.saveDrafts(newer);
  assert.deepEqual(new UpdateRecovery(h.home).read().drafts, newer);
  assert.equal(h.fresh().read(saved.value!.id).value!.rawText, input().rawText);
});

test("claim adoption requires exact file IDs/metadata and keeps raw text/settings unchanged", native, t => {
  const h = fixture(t), saved = h.pending.begin(input([file()]), () => true), id = saved.value!.id;
  const bound = h.pending.bind(id, target), tid = bound.value!.target!.threadId;
  const claimed = { ...file(), rel: `${tid}/file-1-note.txt` };
  for (const files of [[], [claimed, claimed], [{ ...claimed, id: "foreign" }], [{ ...claimed, name: "renamed" }], [{ ...claimed, rel: "other/file-1-note.txt" }]]) {
    assert.throws(() => h.pending.adoption(id, files)); assert.equal(h.pending.read(id).sha256, bound.sha256);
  }
  const { before, after } = h.pending.adoption(id, [claimed]);
  assert.equal(h.pending.read(id).sha256, bound.sha256, "journal preview does not persist");
  const committed = h.pending.commitAdoption(id, before, after);
  assert.deepEqual(committed.value!.owner, { kind: "thread", threadId: tid });
  assert.deepEqual(committed.value!.files, [claimed]);
  assert.equal(committed.value!.rawText, input().rawText);
  assert.deepEqual(committed.value!.configuration, configuration());
  assert.throws(() => h.pending.complete(id, () => false), /recovery/i);
  h.pending.complete(id, record => record.rawText === input().rawText && record.files[0]!.rel === claimed.rel);
  assert.equal(h.fresh().read(id).value, null);
  h.pending.complete(id, () => { throw new Error("absent intent must not re-admit anything"); });
});

test("a stale or cross-instance journal proof cannot overwrite a newer pending record", native, t => {
  const h = fixture(t), saved = h.pending.begin(input(), () => true), id = saved.value!.id;
  h.pending.bind(id, target); const preview = h.pending.adoption(id, []), foreign = h.fresh().read(id);
  assert.throws(() => h.pending.commitAdoption(id, foreign, preview.after), /recovery/i);
  const newer = { ...preview.before.value!, rawText: "newer preserved message evidence" };
  fs.writeFileSync(h.file(id), JSON.stringify(newer));
  assert.throws(() => h.pending.commitAdoption(id, preview.before, preview.after), /recovery/i);
  assert.deepEqual(h.fresh().read(id).value, newer);
});

test("post-replacement intent fsync failure preserves the after-record for fresh-process three-record replay", native, t => {
  const h = fixture(t), saved = h.pending.begin(input(), () => true), id = saved.value!.id;
  h.pending.bind(id, target); const preview = h.pending.adoption(id, []), sync = fs.fsyncSync, directory = fs.statSync(h.directory);
  fs.fsyncSync = fd => { const s = fs.fstatSync(fd); if (s.dev === directory.dev && s.ino === directory.ino) throw new Error("injected intent sync"); sync(fd); };
  try { assert.throws(() => h.pending.commitAdoption(id, preview.before, preview.after), error => error instanceof RecoveryFileWriteError && !error.unchanged); }
  finally { fs.fsyncSync = sync; }
  assert.deepEqual(h.fresh().read(id).value, preview.after);
  assert.throws(() => h.pending.complete(id, () => true), error => error instanceof RecoveryFileWriteError && !error.unchanged);
});

test("orphan temporary and unknown directory entries preserve evidence and block new admissions", native, t => {
  const h = fixture(t); fs.writeFileSync(path.join(h.directory, "unresolved.tmp"), "original raw evidence");
  assert.deepEqual(h.pending.list(), { ids: [], evidence: ["unresolved.tmp"] });
  assert.throws(() => h.pending.begin(input(), () => true), /recovery/i);
  assert.equal(fs.readFileSync(path.join(h.directory, "unresolved.tmp"), "utf8"), "original raw evidence");
});

test("mismatched record IDs and unsupported schemas are never adopted or overwritten", native, t => {
  const h = fixture(t), saved = h.pending.begin(input(), () => true), id = saved.value!.id;
  for (const record of [{ ...saved.value!, schema: 99 }, { ...saved.value!, id: "00000000-0000-4000-8000-000000000000" }]) {
    const bytes = JSON.stringify(record); fs.writeFileSync(h.file(id), bytes);
    assert.throws(() => h.fresh().read(id)); assert.throws(() => h.pending.bind(id, target));
    assert.equal(fs.readFileSync(h.file(id), "utf8"), bytes);
  }
});

test("oversized raw text and excessive file batches reject before authority or persistence", t => {
  const h = fixture(t); let calls = 0;
  for (const value of [{ ...input(), rawText: "x".repeat(PENDING_TEXT_CHARACTERS + 1) }, input(Array.from({ length: 21 }, (_, i) => ({ ...file(), id: `file-${i}`, rel: `staging/file-${i}-note.txt` })))]) {
    assert.throws(() => h.pending.begin(value, () => { calls++; return true; }));
  }
  assert.equal(calls, 0); assert.deepEqual(fs.readdirSync(h.directory), []);
});

test("caught authorization reentry does not create or delete an original pending message", native, t => {
  const h = fixture(t), original = h.pending.begin(input(), () => true), id = original.value!.id;
  assert.throws(() => h.pending.begin(input(), () => {
    assert.throws(() => h.pending.complete(id, () => true), /recovery/i); return true;
  }), /recovery/i);
  assert.deepEqual(h.pending.list().ids, [id]); assert.equal(h.pending.read(id).sha256, original.sha256);
});

test("an existing thread intent has no creation authority and cannot bind to another thread", native, t => {
  const h = fixture(t), saved = h.pending.begin({ ...input(), source: { kind: "thread", threadId: "existing-thread" } }, () => true), id = saved.value!.id;
  assert.equal(saved.value!.creation, null);
  assert.throws(() => h.pending.bind(id, () => ({ threadId: "different-thread", projectId: "project-1", createdAt: "2026-10-11T00:00:00.000Z" })), /recovery/i);
  const bound = h.pending.bind(id, () => ({ threadId: "existing-thread", projectId: "project-1", createdAt: "2026-10-11T00:00:00.000Z" }));
  assert.equal(bound.value!.owner.kind, "thread");
});

for (const rawText of ["\\".repeat(600_000), "界".repeat(600_000)]) {
  test(`pending records preserve already accepted escaped/non-ASCII composer text (${Buffer.byteLength(rawText)} raw bytes)`, native, t => {
    const h = fixture(t), value = { ...input(), rawText };
    const accepted = copyComposerRecovery({ threads: [], selectedThreadId: null,
      projects: [{ key: "draft:0:project-1", projectId: "project-1", text: rawText, attachments: [] }],
      draft: { revision: 0, projectId: "project-1", ...configuration() } });
    const saved = h.pending.begin(value, () => true);
    assert.equal(h.fresh().read(saved.value!.id).value!.rawText, accepted.projects[0]!.text);
  });
}

for (const kind of ["project", "thread"] as const) {
  test(`pending ${kind} text accepts the composer's exact non-ASCII byte boundary`, native, t => {
    const h = fixture(t);
    const snapshot = (text: string) => kind === "project"
      ? { threads: [], projects: [{ key: "draft:0:project-1", projectId: "project-1", text, attachments: [] }], selectedThreadId: null,
        draft: { revision: 0, projectId: "project-1", ...configuration() } }
      : { threads: [{ threadId: "existing-thread", text, attachments: [] }], projects: [], selectedThreadId: null, draft: null };
    const count = Math.floor((2 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(snapshot("")))) / 3);
    const rawText = "界".repeat(count);
    copyComposerRecovery(snapshot(rawText));
    assert.throws(() => copyComposerRecovery(snapshot(rawText + "界")), /recovery/i);
    const source = kind === "project" ? input().source : { kind: "thread" as const, threadId: "existing-thread" };
    const saved = h.pending.begin({ ...input(), source, rawText }, () => true);
    assert.equal(h.fresh().read(saved.value!.id).value!.rawText, rawText);
    assert.throws(() => h.pending.begin({ ...input(), source, rawText: rawText + "界" }, () => true), /recovery/i);
  });
}

test("pending replay checkpoint re-establishes durability without altering immutable original fields", native, t => {
  const h = fixture(t), saved = h.pending.begin(input(), () => true), id = saved.value!.id;
  const pending = h.fresh(), proof = pending.read(id);
  const inode = fs.statSync(h.file(id)).ino;
  pending.checkpoint(id, proof);
  assert.equal(fs.statSync(h.file(id)).ino, inode);
  assert.equal(pending.read(id).sha256, saved.sha256);
  const before = fs.readFileSync(h.file(id));
  assert.throws(() => pending.checkpoint(id, saved), /recovery/i);
  assert.deepEqual(fs.readFileSync(h.file(id)), before);
});
