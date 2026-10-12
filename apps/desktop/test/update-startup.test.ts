import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { UpdateRecovery } from "../src/main/engine/update-recovery.js";
import { readUpdateStartup } from "../src/main/engine/update-startup.js";

test("an interrupted native attempt exposes preserved drafts and does not clear its receipt", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "modex-update-startup-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const recovery = new UpdateRecovery(dir);
  const revision = recovery.saveDrafts({ projects: [], threads: [{ threadId: "thread-1", attachments: [], text: "Unsent" }], draft: null, selectedThreadId: "thread-1" });
  const id = recovery.beginAttempt({ from: "0.0.10", to: "0.0.11", sha512: Buffer.alloc(64, 4).toString("base64"), revision });
  const startup = readUpdateStartup(recovery, "0.0.10");
  assert.equal(startup.recovery?.outcome, "uncertain");
  assert.equal(startup.recovery?.targetVersion, "0.0.11");
  assert.equal(startup.drafts?.threads[0]?.text, "Unsent");
  assert.equal(recovery.read().attempt?.id, id);
  assert.throws(() => recovery.saveDrafts(startup.drafts), /recovery/i);
  const installed = readUpdateStartup(recovery, "0.0.11");
  assert.equal(installed.recovery, null);
  assert.equal(installed.drafts?.threads[0]?.text, "Unsent");
  assert.equal(recovery.read().attempt?.outcome, "installed");
});

test("corrupt recovery opens a restricted recovery screen without replacing evidence", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "modex-update-startup-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "update-recovery.json");
  fs.writeFileSync(file, "preserve these unsupported bytes");
  const startup = readUpdateStartup(new UpdateRecovery(dir), "0.0.10");
  assert.equal(startup.recovery?.outcome, "unreadable");
  assert.equal(startup.drafts, null);
  assert.equal(fs.readFileSync(file, "utf8"), "preserve these unsupported bytes");
});

test("a normal startup does not invent a native attempt or write a recovery file", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "modex-update-startup-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(readUpdateStartup(new UpdateRecovery(dir), "0.0.10"), { drafts: null, recovery: null });
  assert.deepEqual(fs.readdirSync(dir), []);
});


test("renderer reload after service disposal stays read-only without inventing a native receipt", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "modex-update-startup-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const recovery = new UpdateRecovery(dir);
  recovery.saveDrafts({ projects: [], threads: [{ threadId: "thread-1", attachments: [], text: "Saved before disposal" }], draft: null, selectedThreadId: "thread-1" });
  const file = path.join(dir, "update-recovery.json");
  const before = fs.readFileSync(file, "utf8");
  for (const phase of ["draining", "staging", "recovery", "uncertain", "staged"] as const) {
    const restored = readUpdateStartup(recovery, "0.0.10", phase);
    assert.ok(restored.recovery, `${phase} must not mount editable composers`);
    assert.equal(restored.drafts?.threads[0]?.text, "Saved before disposal");
    assert.equal(fs.readFileSync(file, "utf8"), before);
  }
  // The in-process fence does not fabricate an irreversible native attempt. A new
  // process can resume normal editing if native admission never happened.
  assert.equal(readUpdateStartup(new UpdateRecovery(dir), "0.0.10").recovery, null);
  assert.equal(recovery.read().attempt, null);
});

test("reversible preparation does not strand a replacement renderer in recovery", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "modex-update-startup-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const recovery = new UpdateRecovery(dir);
  assert.equal(readUpdateStartup(recovery, "0.0.10", "preparing").recovery, null);
  assert.equal(readUpdateStartup(recovery, "0.0.10", "idle").recovery, null);
});
