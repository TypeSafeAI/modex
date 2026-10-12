import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { AttachmentRecoveryFile, RecoveryFileWriteError, parseRecoveryJSON, recoveryJSON, type RecoveryFileSnapshot } from "../src/main/engine/attachment-recovery-file.js";
interface Record { schema: 1; text: string }
const validate = (value: unknown): void => {
  if (!value || typeof value !== "object" || Object.keys(value).sort().join() !== "schema,text" || !("schema" in value) || value.schema !== 1
    || !("text" in value) || typeof value.text !== "string") throw new Error("unsupported record");
};
const record = (text = "  original raw\n\t😀  "): Record => ({ schema: 1, text });
function fixture(t: TestContext, validator = validate) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "modex-recovery-file-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, "new", "nested");
  const file = new AttachmentRecoveryFile<Record>(directory, "intent.json", 4096, validator);
  return { root, directory, file, fresh: () => new AttachmentRecoveryFile<Record>(directory, "intent.json", 4096, validator) };
}
const native = { skip: process.platform === "win32" };

test("bounded recovery JSON rejects aliases, accessors, invalid unicode and ambiguous decoded members", () => {
  const input = { schema: 1, text: "raw 😀\n" }; assert.deepEqual(parseRecoveryJSON(recoveryJSON(input, 128), 128), input);
  let reads = 0;
  const accessor = { schema: 1, get text() { reads++; return "hidden"; } };
  const cycle: unknown[] = []; cycle.push(cycle);
  for (const value of [accessor, cycle, { text: "\ud800" }, { text: "\udc00" }, { text: "x".repeat(129) }, { text: () => "hidden" }, Array(2)]) {
    assert.throws(() => recoveryJSON(value, 128), /recovery/i);
  }
  assert.equal(reads, 0);
  for (const body of ['{"schema":1,"text":"original","text":"hidden"}', '{"text":"original","te\\u0078t":"hidden"}', '['.repeat(13) + '0' + ']'.repeat(13)]) {
    assert.throws(() => parseRecoveryJSON(body, 4096), /recovery/i);
  }
});

test("data-only serialization uses captured descriptors instead of a second read of caller properties", () => {
  let getterCalls = 0;
  const value = new Proxy({ schema: 1, text: "original" }, { get() { getterCalls++; throw new Error("second read"); } });
  assert.equal(recoveryJSON(value, 128), '{"schema":1,"text":"original"}');
  assert.equal(getterCalls, 0);
});

test("fixed-file snapshots survive restart, are immutable and reject forged or cross-instance write proofs", native, t => {
  const h = fixture(t), empty = h.file.read(), input = record();
  const saved = h.file.write(empty, input); input.text = "mutated caller";
  assert.deepEqual(saved.value, record()); assert.ok(Object.isFrozen(saved.value));
  assert.equal(fs.statSync(h.file.file).mode & 0o777, 0o600);
  const fresh = h.fresh(); assert.deepEqual(fresh.read().value, record());
  assert.throws(() => fresh.write(saved, record("foreign proof")), /recovery/i);
  assert.throws(() => h.file.write({ value: null, sha256: null } as RecoveryFileSnapshot<Record>, record()), /recovery/i);
  assert.throws(() => h.file.write(empty, record()), /recovery/i);
  const next = h.file.write(saved, record("next"));
  h.file.remove(next); assert.equal(h.fresh().read().value, null);
  h.file.remove(h.file.read());
});

test("a same-byte file replacement invalidates its old compare-and-replace proof", native, t => {
  const h = fixture(t), saved = h.file.write(h.file.read(), record());
  fs.renameSync(h.file.file, h.file.file + ".preserved"); fs.writeFileSync(h.file.file, recoveryJSON(record(), 4096));
  assert.throws(() => h.file.write(saved, record("overwrite")), /recovery/i);
  assert.deepEqual(h.fresh().read().value, record());
});

for (const raw of [Buffer.from('{"schema":99}'), Buffer.from('{"schema":1,"text":"first","text":"last"}'), Buffer.alloc(4097, 32), Buffer.from([0xff])]) {
  test(`unknown, duplicate, oversized or invalid UTF-8 evidence is retained (${raw.length} bytes)`, t => {
    const h = fixture(t); fs.writeFileSync(h.file.file, raw);
    assert.throws(() => h.file.read()); assert.deepEqual(fs.readFileSync(h.file.file), raw);
  });
}

for (const replacement of ["file-symlink", "directory-symlink", "directory-regular"] as const) {
  test(`recovery refuses a ${replacement} without touching replacement evidence`, native, t => {
    const h = fixture(t), saved = h.file.write(h.file.read(), record());
    const outside = path.join(h.root, "outside"); fs.mkdirSync(outside); const target = path.join(outside, "intent.json"); fs.writeFileSync(target, "outside");
    if (replacement === "file-symlink") { fs.renameSync(h.file.file, h.file.file + ".preserved"); fs.symlinkSync(target, h.file.file); }
    else {
      fs.renameSync(h.directory, h.directory + ".preserved");
      if (replacement === "directory-symlink") fs.symlinkSync(outside, h.directory);
      else { fs.mkdirSync(h.directory); fs.writeFileSync(h.file.file, "replacement"); }
    }
    assert.throws(() => h.file.read()); assert.throws(() => h.file.write(saved, record()));
    assert.equal(fs.readFileSync(target, "utf8"), "outside");
  });
}

for (const phase of ["open", "file-sync", "rename", "directory-sync"] as const) {
  test(`a ${phase} failure reports proven unchanged only before any candidate exists`, native, t => {
    const h = fixture(t), saved = h.file.write(h.file.read(), record());
    const open = fs.openSync, sync = fs.fsyncSync, rename = fs.renameSync; let injected = false;
    fs.openSync = ((...args: Parameters<typeof fs.openSync>) => {
      if (phase === "open" && typeof args[0] === "string" && args[0].endsWith(".tmp")) { injected = true; throw new Error("injected open"); }
      return Reflect.apply(open, fs, args);
    }) as typeof fs.openSync;
    fs.fsyncSync = fd => {
      if (!injected && ((phase === "file-sync" && fs.fstatSync(fd).isFile()) || (phase === "directory-sync" && fs.fstatSync(fd).isDirectory()))) {
        injected = true; throw new Error("injected fsync");
      }
      sync(fd);
    };
    fs.renameSync = (from, to) => { if (phase === "rename") { injected = true; throw new Error("injected rename"); } rename(from, to); };
    try { assert.throws(() => h.file.write(saved, record("candidate")), error => error instanceof RecoveryFileWriteError && error.unchanged === (phase === "open")); }
    finally { fs.openSync = open; fs.fsyncSync = sync; fs.renameSync = rename; }
    assert.equal(injected, true);
    assert.deepEqual(h.fresh().read().value, record(phase === "directory-sync" ? "candidate" : record().text));
    if (phase === "open") assert.deepEqual(h.file.write(saved, record("retry")).value, record("retry"));
    else {
      assert.throws(() => h.file.write(h.file.read(), record("retry")), error => error instanceof RecoveryFileWriteError && !error.unchanged);
      if (phase !== "directory-sync") assert.equal(fs.readdirSync(h.directory).filter(name => name.endsWith(".tmp")).length, 1);
    }
  });
}

test("failed removal durability cannot be reported as a proven unchanged refusal", native, t => {
  const h = fixture(t), saved = h.file.write(h.file.read(), record()); const sync = fs.fsyncSync;
  fs.fsyncSync = () => { throw new Error("injected removal sync"); };
  try { assert.throws(() => h.file.remove(saved), error => error instanceof RecoveryFileWriteError && !error.unchanged); }
  finally { fs.fsyncSync = sync; }
  assert.equal(h.fresh().read().value, null);
  assert.throws(() => h.file.remove(h.file.read()), error => error instanceof RecoveryFileWriteError && !error.unchanged);
});

test("a validator cannot hide reentrant writes and no candidate is created", native, t => {
  let attempt = false; let h: ReturnType<typeof fixture>; let empty: RecoveryFileSnapshot<Record>;
  h = fixture(t, value => { validate(value); if (attempt) { attempt = false; assert.throws(() => h.file.write(empty, record("nested")), /recovery/i); } });
  empty = h.file.read(); attempt = true;
  assert.throws(() => h.file.write(empty, record()), /recovery/i);
  assert.deepEqual(fs.readdirSync(h.directory), []);
});

test("Windows refuses strong recovery writes without claiming durability", { skip: process.platform !== "win32" }, t => {
  const h = fixture(t), empty = h.file.read();
  assert.throws(() => h.file.write(empty, record()), error => error instanceof RecoveryFileWriteError && error.unchanged);
  assert.deepEqual(fs.readdirSync(h.directory), []);
});

test("a same-inode BOM insertion invalidates a prior exact-byte write proof", native, t => {
  const h = fixture(t), saved = h.file.write(h.file.read(), record());
  const before = fs.statSync(h.file.file), original = fs.readFileSync(h.file.file);
  const changed = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), original]);
  fs.writeFileSync(h.file.file, changed);
  assert.equal(fs.statSync(h.file.file).ino, before.ino);
  assert.throws(() => h.file.write(saved, record("overwrite")), /recovery/i);
  assert.throws(() => h.file.remove(saved), /recovery/i);
  assert.throws(() => h.file.read());
  assert.deepEqual(fs.readFileSync(h.file.file), changed);
});

test("initial UTF-8 BOM evidence is refused and preserved without decoder normalization", t => {
  const h = fixture(t), bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(recoveryJSON(record(), 4096))]);
  fs.writeFileSync(h.file.file, bytes);
  assert.throws(() => h.file.read()); assert.throws(() => h.fresh().read());
  assert.deepEqual(fs.readFileSync(h.file.file), bytes);
});

for (const fault of ["file-fsync", "ancestor-fsync", "replaced-during-sync"] as const) {
  test(`checkpoint preserves bytes and latches after ${fault}`, native, t => {
    const h = fixture(t), saved = h.file.write(h.file.read(), record()), body = fs.readFileSync(h.file.file);
    const original = fs.fsyncSync, identity = fs.statSync(h.file.file), ancestor = fs.statSync(h.root); let injected = false;
    fs.fsyncSync = fd => {
      const stat = fs.fstatSync(fd);
      if (!injected && ((fault === "ancestor-fsync" && stat.dev === ancestor.dev && stat.ino === ancestor.ino)
        || (fault !== "ancestor-fsync" && stat.dev === identity.dev && stat.ino === identity.ino))) {
        injected = true;
        if (fault === "replaced-during-sync") { fs.renameSync(h.file.file, h.file.file + ".preserved"); fs.writeFileSync(h.file.file, body); }
        else throw new Error("injected checkpoint durability");
      }
      original(fd);
    };
    try { assert.throws(() => h.file.checkpoint(saved), error => error instanceof RecoveryFileWriteError && !error.unchanged); }
    finally { fs.fsyncSync = original; }
    assert.equal(injected, true); assert.deepEqual(fs.readFileSync(h.file.file), body);
    assert.throws(() => h.file.write(h.file.read(), record("must preserve")), error => error instanceof RecoveryFileWriteError && !error.unchanged);
    const fresh = h.fresh(); fresh.checkpoint(fresh.read()); assert.deepEqual(fs.readFileSync(h.file.file), body);
  });
}
