import assert from "node:assert/strict";
import { test } from "node:test";
import { RestartDraftGuards } from "../src/shared/restart-draft-guards.js";
import { RendererRestartPreflight, type RestartRequest } from "../src/main/engine/update-renderer-preflight.js";

function prepareWithInvalidation(guards: RestartDraftGuards, invalidated: () => void) {
  return guards.prepare(["space"], invalidated);
}

test("fresh held-editor proof is separately revocable and never releases the editing hold", async () => {
  const guards = new RestartDraftGuards(); let flushes = 0, originalRevoked = 0, quitRevoked = 0;
  const remove = guards.register("pages", async () => { flushes++; });
  await guards.prepare(["pages"], () => originalRevoked++);
  assert.equal(typeof (guards as any).prepareHeld, "function");
  const invalidate = () => { quitRevoked++; };
  await (guards as any).prepareHeld(["pages"], invalidate);
  assert.equal(flushes, 2); remove();
  assert.equal(originalRevoked, 1); assert.equal(quitRevoked, 1);
  (guards as any).releaseHeld(invalidate); assert.equal(guards.frozen, true);
  assert.throws(() => guards.assertOpen(), /restart/); guards.release();
});

test("held-editor proof refuses membership changes during flush and a stale release cannot clear a new proof", async () => {
  const guards = new RestartDraftGuards(); let flushes = 0, finish!: () => void, revoked = 0;
  guards.register("pages", async () => { if (++flushes > 1) await new Promise<void>(resolve => { finish = resolve; }); });
  await guards.prepare(["pages"], () => {});
  assert.equal(typeof (guards as any).prepareHeld, "function");
  const first = () => { revoked++; };
  const pending = (guards as any).prepareHeld(["pages"], first), rejected = assert.rejects(pending, /changed|cancelled/i);
  guards.register("late", async () => {}); finish(); await rejected; assert.equal(revoked, 1);
  (guards as any).releaseHeld(first);
  const second = () => { revoked++; };
  const next = (guards as any).prepareHeld(["pages"], second);
  (guards as any).releaseHeld(first); finish(); await next;
  guards.register("later", async () => {}); assert.equal(revoked, 2);
  assert.equal(guards.frozen, true); guards.release();
});

test("a stale registration disposer cannot remove an identical replacement", async () => {
  const guards = new RestartDraftGuards();
  let flushes = 0, invalidations = 0;
  const flush = async () => { flushes++; };
  const staleRemove = guards.register("space", flush);
  staleRemove();
  guards.register("space", flush);
  await prepareWithInvalidation(guards, () => { invalidations++; });
  staleRemove();
  assert.equal(invalidations, 0);
  guards.release();
  await prepareWithInvalidation(guards, () => { invalidations++; });
  assert.equal(flushes, 2);
  assert.equal(invalidations, 0);
  guards.release();
});

for (const change of ["register", "remove", "replace"] as const) {
  test(`editor ${change} during a pending flush vetoes restart and retains the hold`, async () => {
    const guards = new RestartDraftGuards();
    let finish!: () => void, invalidations = 0;
    const remove = guards.register("space", () => new Promise<void>(resolve => { finish = resolve; }));
    const pending = prepareWithInvalidation(guards, () => { invalidations++; });
    const rejected = assert.rejects(pending, /changed|cancelled/i);
    if (change !== "register") remove();
    if (change !== "remove") guards.register(change === "replace" ? "space" : "late-editor", async () => {});
    finish();
    await rejected;
    assert.equal(invalidations, 1);
    assert.equal(guards.frozen, true);
    assert.throws(() => guards.assertOpen(), /restart/i);
    guards.release();
    guards.assertOpen();
  });

  test(`editor ${change} after acknowledgment invalidates the main-held preparation`, async t => {
    const messages: RestartRequest[] = [];
    const main = new RendererRestartPreflight(message => messages.push(message));
    const guards = new RestartDraftGuards();
    t.after(() => { main.release(); guards.release(); });
    const remove = guards.register("space", async () => {});
    const pending = main.prepare(), id = messages[0]!.id;
    let invalidations = 0;
    await prepareWithInvalidation(guards, () => {
      invalidations++;
      assert.equal(main.reply({ id, error: "Editor membership changed." }), true);
    });
    main.reply({ id, revision: 1 });
    await pending;
    main.assertPrepared();
    if (change !== "register") remove();
    if (change !== "remove") guards.register(change === "replace" ? "space" : "late-editor", async () => {});
    assert.throws(() => main.assertPrepared(), /changed|ready/i);
    assert.equal(main.reply({ id, revision: 2 }), false, "a later success cannot revive the invalidated preparation");
    assert.equal(invalidations, 1);
    assert.equal(guards.frozen, true);
    assert.throws(() => guards.assertOpen(), /restart/i);
  });
}

test("restart freezes edits before flushing all mounted editors and refuses missing editors", async () => {
  const guards = new RestartDraftGuards();
  let finish!: () => void;
  guards.register("space", () => new Promise<void>(resolve => { finish = resolve; }));
  const flush = guards.prepare(["space"], () => {});
  assert.equal(guards.frozen, true);
  assert.throws(() => guards.assertOpen(), /restart/i);
  finish();
  await flush;
  assert.equal(guards.frozen, true);
  guards.release();
  guards.assertOpen();
  await assert.rejects(guards.prepare(["loading-editor"], () => {}), /loading/i);
  assert.equal(guards.frozen, true);
  guards.release();
});

test("releasing a timed-out preparation invalidates its eventual save acknowledgment", async () => {
  const guards = new RestartDraftGuards();
  let finish!: () => void;
  guards.register("space", () => new Promise<void>(resolve => { finish = resolve; }));
  const flush = guards.prepare(["space"], () => {});
  guards.release();
  finish();
  await assert.rejects(flush, /cancelled/i);
  guards.assertOpen();
});

test("an admitted file import survives a refused restart while its file read finishes", async () => {
  const guards = new RestartDraftGuards();
  let finishRead!: (text: string) => void;
  const file = new Promise<string>(resolve => { finishRead = resolve; });
  let imported: string | undefined;
  let importing = true;
  guards.register("space-actions", async () => { if (importing) throw new Error("Wait for the import."); });
  const work = (async () => {
    const text = await file;
    await guards.waitUntilOpen();
    guards.assertOpen();
    imported = text;
    importing = false;
  })();
  await assert.rejects(guards.prepare(["space-actions"], () => {}), /import/);
  finishRead("# Keep this imported page");
  await Promise.resolve();
  assert.equal(imported, undefined);
  assert.equal(importing, true);
  guards.release();
  await work;
  assert.equal(imported, "# Keep this imported page");
  await guards.prepare(["space-actions"], () => {});
  guards.release();
});
