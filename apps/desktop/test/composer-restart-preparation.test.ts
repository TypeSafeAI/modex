import assert from "node:assert/strict";
import { test } from "node:test";
import { ComposerRecoveryQueue } from "../src/shared/composer-recovery-queue.js";
import { ComposerRestartPreparation } from "../src/shared/composer-restart-preparation.js";
import { RestartDraftGuards } from "../src/shared/restart-draft-guards.js";
import type { ComposerRecovery } from "../src/shared/update-recovery.js";
const snapshot: ComposerRecovery = { threads: [{ threadId: "thread", text: "  raw draft 😀  ", attachments: [] }], projects: [], selectedThreadId: "thread", draft: null };
function harness(save = async (_value: ComposerRecovery) => ({ saved: true, revision: 3 })) {
  const guards = new RestartDraftGuards(), queue = new ComposerRecoveryQueue(snapshot, save);
  const state = { held: false, attachmentsHeld: false, invalidated: 0 };
  const options = { queue, guards, validate() {}, snapshot: () => snapshot, requiredEditors: () => ["pages"],
    freezeAttachments: () => { state.attachmentsHeld = true; return true; }, releaseAttachments: () => { state.attachmentsHeld = false; }, held: (value: boolean) => { state.held = value; } };
  const preparation = new ComposerRestartPreparation(options);
  return { guards, queue, state, options, preparation, invalidate: () => { state.invalidated++; } };
}
test("composer preparation freezes before editor flush and seals the exact saved revision until main releases", async () => {
  const h = harness(); let finish!: () => void;
  h.guards.register("pages", () => { assert.equal(h.state.held, true); assert.equal(h.state.attachmentsHeld, true); return new Promise<void>(resolve => { finish = resolve; }); });
  const preparing = h.preparation.prepare(h.invalidate);
  void preparing.catch(() => {});
  assert.equal(h.state.held, true); finish(); assert.equal(await preparing, 3);
  assert.equal(h.queue.held, true); assert.equal(h.guards.frozen, true);
  assert.equal((h.preparation as any).canClose, true, "confirmed durable preparation must permit the native restart to close the window");
  assert.throws(() => h.queue.update({ ...snapshot, threads: [] }));
  await h.preparation.release(); assert.equal(h.queue.held, false); assert.equal(h.guards.frozen, false); assert.equal(h.state.held, false);
  assert.equal((h.preparation as any).canClose, false);
});
test("editor replacement after acknowledgment revokes preparation without reopening drafts", async () => {
  const h = harness(), remove = h.guards.register("pages", async () => {});
  await h.preparation.prepare(h.invalidate); remove();
  assert.equal(h.state.invalidated, 1); assert.equal(h.state.held, true); assert.equal(h.queue.held, true);
  assert.equal((h.preparation as any).canClose, false, "editor membership changes revoke permission to close");
  await h.preparation.release(); assert.equal(h.state.held, false);
});
test("save failures preserve renderer holds until main acknowledges cancellation", async () => {
  const h = harness(async () => { throw new Error("disk refused"); }); h.guards.register("pages", async () => {});
  await assert.rejects(h.preparation.prepare(h.invalidate), /disk refused/);
  assert.equal(h.state.held, true); assert.equal(h.guards.frozen, true); assert.equal(h.state.attachmentsHeld, true);
  await h.preparation.release(); assert.equal(h.state.held, false); assert.equal(h.state.attachmentsHeld, false);
});
test("main release while a save is outstanding prevents a late acknowledgment from sealing a new hold", async () => {
  let finish!: (receipt: { saved: boolean; revision: number }) => void;
  const h = harness(() => new Promise(resolve => { finish = resolve; })); h.guards.register("pages", async () => {});
  const preparing = h.preparation.prepare(h.invalidate), rejected = assert.rejects(preparing, /cancel|changed/i);
  void rejected.catch(() => {});
  for (let attempt = 0; !finish && attempt < 5; attempt++) await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(typeof finish, "function", "preparation must reach the save before cancellation");
  await h.preparation.release(); finish({ saved: true, revision: 4 }); await rejected;
  assert.equal(h.queue.held, false); assert.equal(h.state.held, false); assert.equal(h.guards.frozen, false);
});
test("busy attachment work refuses preparation without taking ownership of another hold", async () => {
  const h = harness(); h.options.freezeAttachments = () => false;
  await assert.rejects(h.preparation.prepare(h.invalidate), /attachment/i);
  await h.preparation.release(); assert.equal(h.state.held, false); assert.equal(h.guards.frozen, false);
});

test("fresh recovery Quit rechecks held editors without writing R or reviving the old acknowledgment", async () => {
  let writes = 0, quitRevoked = 0, flushes = 0;
  const h = harness(async () => { writes++; return { saved: true, revision: 3 }; });
  const remove = h.guards.register("pages", async () => { flushes++; });
  await h.preparation.prepare(h.invalidate); remove();
  const removeReplacement = h.guards.register("pages", async () => { flushes++; });
  assert.equal(typeof (h.preparation as any).prepareQuit, "function");
  assert.equal(await (h.preparation as any).prepareQuit(() => quitRevoked++), 3);
  assert.equal(writes, 1); assert.equal(flushes, 2); assert.equal(h.state.invalidated, 1);
  assert.equal(h.preparation.canClose, true);
  removeReplacement(); assert.equal(quitRevoked, 1); assert.equal(h.preparation.canClose, false);
  (h.preparation as any).releaseQuit();
  assert.equal(h.queue.held, true); assert.equal(h.guards.frozen, true); assert.equal(h.state.held, true);
  await h.preparation.release();
});

test("raw composer drift revokes closing and cannot be hidden by a fresh recovery Quit", async () => {
  let writes = 0;
  const h = harness(async () => { writes++; return { saved: true, revision: 3 }; }); h.guards.register("pages", async () => {});
  await h.preparation.prepare(h.invalidate);
  h.options.snapshot = () => ({ ...snapshot, threads: [{ ...snapshot.threads[0]!, text: "newer raw input" }] });
  assert.equal(h.preparation.canClose, false);
  assert.equal(typeof (h.preparation as any).prepareQuit, "function");
  await assert.rejects((h.preparation as any).prepareQuit(() => {}), /saved|changed|draft/i);
  assert.equal(writes, 1); assert.equal(h.queue.held, true); assert.equal(h.options.snapshot().threads[0]!.text, "newer raw input");
  (h.preparation as any).releaseQuit(); await h.preparation.release();
});

test("failed fresh Quit flush retains all holds and a matching release permits only another proof attempt", async () => {
  const h = harness(); let fail = false;
  h.guards.register("pages", async () => { if (fail) throw new Error("Page save failed"); });
  await h.preparation.prepare(h.invalidate); fail = true;
  assert.equal(typeof (h.preparation as any).prepareQuit, "function");
  await assert.rejects((h.preparation as any).prepareQuit(() => {}), /Page save failed/);
  assert.equal(h.preparation.canClose, false); assert.equal(h.state.invalidated, 1);
  (h.preparation as any).releaseQuit(); assert.equal(h.queue.held, true); assert.equal(h.guards.frozen, true);
  fail = false; assert.equal(await (h.preparation as any).prepareQuit(() => {}), 3);
  (h.preparation as any).releaseQuit(); assert.equal(h.preparation.canClose, false);
  await h.preparation.release();
});

test("an unrelated uncertain attachment transfer cannot authorize recovery Quit", async () => {
  const h = harness(), hold = h.queue.holdForTransfer(); await hold.drained;
  assert.equal(typeof (h.preparation as any).prepareQuit, "function");
  await assert.rejects((h.preparation as any).prepareQuit(() => {}), /prepar|saved|recovery/i);
  assert.equal(h.queue.held, true); assert.equal(h.preparation.canClose, false);
  h.queue.refuseTransfer(hold.token);
});

test("document teardown revokes local close permissions immediately while retaining all editing holds", async () => {
  const h = harness(); let quitRevoked = 0;
  h.guards.register("pages", async () => {}); await h.preparation.prepare(h.invalidate);
  await h.preparation.prepareQuit(() => quitRevoked++); assert.equal(h.preparation.canClose, true);
  assert.equal(typeof (h.preparation as any).invalidate, "function");
  (h.preparation as any).invalidate();
  assert.equal(h.preparation.canClose, false); assert.equal(quitRevoked, 1);
  assert.equal(h.state.held, true); assert.equal(h.queue.held, true); assert.equal(h.guards.frozen, true);
  await h.preparation.release();
});
