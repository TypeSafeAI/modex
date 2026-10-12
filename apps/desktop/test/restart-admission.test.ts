import assert from "node:assert/strict";
import { test } from "node:test";
import { RestartAdmission } from "../src/main/engine/restart-admission.js";

test("restart refuses already-admitted work without cancelling it, then fences new entry", async () => {
  const admission = new RestartAdmission();
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  let completed = false;
  const running = admission.run(async () => { await pending; completed = true; });
  assert.throws(() => admission.holdForRestart(), /finish/i);
  assert.equal(completed, false);
  finish();
  await running;
  const release = admission.holdForRestart();
  await assert.rejects(admission.run(() => assert.fail("late mutation was admitted")), /restart/i);
  assert.equal(admission.held, true);
  release();
  assert.equal(await admission.run(() => "usable again"), "usable again");
  const next = admission.holdForRestart();
  release();
  assert.equal(admission.held, true);
  next();
  assert.equal(admission.held, false);
});

test("failed and reentrant commands remain accounted for until their work settles", async () => {
  const admission = new RestartAdmission();
  await assert.rejects(admission.run(() => { throw new Error("failed request"); }), /failed request/);
  admission.holdForRestart()();
  await admission.run(async () => {
    assert.throws(() => admission.holdForRestart(), /finish/i);
    await admission.run(() => { assert.throws(() => admission.holdForRestart(), /finish/i); });
    assert.throws(() => admission.holdForRestart(), /finish/i);
  });
  admission.holdForRestart()();
});
