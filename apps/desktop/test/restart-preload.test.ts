import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { test } from "node:test";
import { RendererRestartPreflight } from "../src/main/engine/update-renderer-preflight.js";
import { RestartDraftGuards } from "../src/shared/restart-draft-guards.js";
import { ComposerRecoveryQueue } from "../src/shared/composer-recovery-queue.js";
import { ComposerRestartPreparation } from "../src/shared/composer-restart-preparation.js";

function harness() {
  const listeners = new Map<string, Set<Function>>(), sent: { channel: string; value: any }[] = [];
  let bridge: any;
  const emit = (channel: string, value: unknown) => { for (const fn of [...listeners.get(channel) ?? []]) fn({}, value); };
  const main = new RendererRestartPreflight(value => emit("updates:prepare", value));
  const quit = new RendererRestartPreflight(value => emit("updates:prepare-quit", value));
  vm.runInNewContext(fs.readFileSync(path.resolve(import.meta.dirname, "../../src/main/preload.cjs"), "utf8"), {
    require: () => ({ contextBridge: { exposeInMainWorld: (_name: string, value: unknown) => { bridge = value; } }, webUtils: {}, ipcRenderer: {
      on: (channel: string, fn: Function) => { if (!listeners.has(channel)) listeners.set(channel, new Set()); listeners.get(channel)!.add(fn); },
      removeListener: (channel: string, fn: Function) => listeners.get(channel)?.delete(fn),
      send: (channel: string, value: any) => { sent.push({ channel, value }); if (channel === "updates:prepared") main.reply(value); if (channel === "updates:quit-prepared") quit.reply(value); },
    } }), process: { platform: "darwin" },
  });
  return { bridge, main, quit, sent, emit, listeners };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test("owner removal preload carries only payloads, keeps phase tokens separate, and forwards recovery without event authority", async () => {
  const h = harness(), observed: unknown[] = []; let released = 0;
  assert.equal(typeof h.bridge.onOwnerRemovalPreparation, "function");
  h.bridge.onOwnerRemovalPreparation(async (_invalidate: () => void, scope: unknown) => { observed.push(scope); return 3; }, () => released++);
  h.bridge.onOwnerRemovalAdoption(async (_invalidate: () => void, result: unknown) => { observed.push(result); return 4; }, () => {});
  h.emit("drafts:remove-prepare", { id: "prepare-token", type: "prepare", payload: { kind: "thread", id: "t" } }); await tick();
  h.emit("drafts:remove-adopt", { id: "adopt-token", type: "prepare", payload: { revision: 4 } }); await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(observed)), [{ kind: "thread", id: "t" }, { revision: 4 }]);
  assert.deepEqual(JSON.parse(JSON.stringify(h.sent)), [
    { channel: "drafts:remove-prepared", value: { id: "prepare-token", revision: 3 } },
    { channel: "drafts:remove-adopted", value: { id: "adopt-token", revision: 4 } },
  ]);
  h.emit("drafts:remove-prepare", { id: "adopt-token", type: "release" }); assert.equal(released, 0);
  h.emit("drafts:remove-prepare", { id: "prepare-token", type: "release" }); assert.equal(released, 1);
  const messages: unknown[] = [], off = h.bridge.onOwnerRemovalRecovery((message: unknown) => messages.push(message));
  h.emit("drafts:remove-recovery", "preserved"); off(); h.emit("drafts:remove-recovery", "ignored");
  assert.deepEqual(messages, ["preserved"]);
});

test("actual preload forwards updater state without the Electron event and unsubscribes", () => {
  const h = harness(), states: unknown[] = [], state = { phase: "downloading", received: 4, total: 10 };
  assert.equal(typeof h.bridge.onUpdateState, "function");
  const remove = h.bridge.onUpdateState((value: unknown) => states.push(value));
  h.emit("updates:state", state); assert.deepEqual(states, [state]);
  remove(); h.emit("updates:state", { phase: "ready" }); assert.deepEqual(states, [state]);
});

test("actual preload keeps fresh recovery Quit independent of a revoked restart acknowledgment", async t => {
  const h = harness(); assert.equal(typeof h.bridge.onRecoveryQuitPreparation, "function");
  const guards = new RestartDraftGuards(), snapshot = { threads: [], projects: [], draft: null, selectedThreadId: null };
  let writes = 0, held = false;
  const queue = new ComposerRecoveryQueue(snapshot, async () => { writes++; return { saved: true, revision: 4 }; });
  const preparation = new ComposerRestartPreparation({ queue, guards, validate() {}, snapshot: () => snapshot,
    requiredEditors: () => ["pages"], freezeAttachments: () => true, releaseAttachments() {}, held: value => { held = value; } });
  const remove = guards.register("pages", async () => {});
  h.bridge.onRestartPreparation((invalidate: () => void) => preparation.prepare(invalidate), () => { void preparation.release(); });
  h.bridge.onRecoveryQuitPreparation((invalidate: () => void) => preparation.prepareQuit(invalidate), () => preparation.releaseQuit());
  t.after(async () => { h.quit.release(); h.main.release(); await tick(); });
  await h.main.prepare(); const originalId = h.sent.find(row => row.channel === "updates:prepared")!.value.id;
  remove(); guards.register("pages", async () => {}); assert.throws(() => h.main.assertPrepared());
  assert.equal(await h.quit.prepare(), 4); h.quit.assertPrepared(); assert.equal(preparation.canClose, true);
  h.emit("updates:prepare-quit", { type: "release", id: originalId });
  assert.equal(preparation.canClose, true); assert.equal(writes, 1);
  guards.register("late", async () => {});
  assert.throws(() => h.quit.assertPrepared()); assert.throws(() => h.main.assertPrepared()); assert.equal(preparation.canClose, false);
  h.quit.release(); assert.equal(held, true); assert.equal(queue.held, true); assert.equal(guards.frozen, true);
});

test("unsubscribing fresh Quit preparation cannot release or unregister the original restart hold", async () => {
  const h = harness(); assert.equal(typeof h.bridge.onRecoveryQuitPreparation, "function");
  let originalReleased = 0, quitReleased = 0;
  h.bridge.onRestartPreparation(async () => 2, () => originalReleased++);
  const unsubscribe = h.bridge.onRecoveryQuitPreparation(async () => 2, () => quitReleased++);
  await h.main.prepare(); await h.quit.prepare(); unsubscribe();
  assert.throws(() => h.quit.assertPrepared()); h.main.assertPrepared();
  h.quit.release(); assert.equal(quitReleased, 1); assert.equal(originalReleased, 0);
  assert.equal(h.listeners.get("updates:prepare")?.size, 1);
  assert.equal(h.listeners.get("updates:prepare-quit")?.size, 0);
  h.main.release(); assert.equal(originalReleased, 1);
});

for (const early of ["release", "unsubscribe"]) test(`an early ${early} cannot run a deferred prepare callback after cancellation`, async () => {
  const h = harness(); let prepared = 0, released = 0, held = false;
  assert.equal(typeof h.bridge.onRestartPreparation, "function");
  const unsubscribe = h.bridge.onRestartPreparation(async () => { prepared++; held = true; return 1; }, () => { released++; held = false; });
  const pending = h.main.prepare(), rejected = assert.rejects(pending, /cancel|changed/i);
  if (early === "unsubscribe") unsubscribe();
  h.main.release(); await rejected; await tick();
  assert.equal(prepared, 0); assert.equal(released, 1); assert.equal(held, false);
  assert.equal(h.sent.filter(row => row.value.revision).length, 0);
});

test("actual preload preserves post-ack editor invalidation and waits for matching main release", async () => {
  const h = harness(), guards = new RestartDraftGuards(); let released = 0;
  assert.equal(typeof h.bridge.onRestartPreparation, "function");
  const disposeEditor = guards.register("pages", async () => {});
  h.bridge.onRestartPreparation(async (invalidated: () => void) => { await guards.prepare(["pages"], invalidated); return 7; }, () => { released++; guards.release(); });
  assert.equal(await h.main.prepare(), 7); h.main.assertPrepared();
  disposeEditor();
  assert.throws(() => h.main.assertPrepared()); assert.equal(guards.frozen, true); assert.equal(released, 0);
  h.emit("updates:prepare", { type: "release", id: "other" }); assert.equal(released, 0);
  h.main.release(); assert.equal(released, 1); assert.equal(guards.frozen, false);
});

test("disposing a prepared subscription revokes main but keeps its hold until main releases", async () => {
  const h = harness(); let released = 0;
  assert.equal(typeof h.bridge.onRestartPreparation, "function");
  const unsubscribe = h.bridge.onRestartPreparation(async () => 4, () => released++);
  await h.main.prepare(); unsubscribe(); unsubscribe();
  assert.throws(() => h.main.assertPrepared()); assert.equal(released, 0);
  assert.throws(() => h.bridge.onRestartPreparation(async () => 9, () => {}), /release|prepar/i);
  h.main.release(); assert.equal(released, 1);
  const next = h.bridge.onRestartPreparation(async () => 9, () => {});
  assert.equal(await h.main.prepare(), 9); h.main.release(); next();
});

test("a late positive promise cannot revive an invalidated or released preparation", async () => {
  const h = harness(); let resolve!: (revision: number) => void, invalidate!: () => void, released = 0;
  assert.equal(typeof h.bridge.onRestartPreparation, "function");
  h.bridge.onRestartPreparation((cb: () => void) => { invalidate = cb; return new Promise<number>(done => { resolve = done; }); }, () => released++);
  const preparing = h.main.prepare(); const rejected = assert.rejects(preparing, /changed|cancel/i);
  await tick(); invalidate(); await rejected; h.main.release(); resolve(10); await tick();
  assert.equal(released, 1); assert.equal(h.sent.filter(row => row.value.revision).length, 0);
  assert.throws(() => h.main.assertPrepared());
});

test("malformed positive receipts and preparation exceptions refuse restart until main releases", async () => {
  for (const value of [0, -1, NaN, 1.5, "7"]) {
    const h = harness(); let released = 0;
    assert.equal(typeof h.bridge.onRestartPreparation, "function");
    h.bridge.onRestartPreparation(async () => value, () => released++);
    await assert.rejects(h.main.prepare(), /save|revision|prepar/i);
    assert.equal(released, 0); h.main.release(); assert.equal(released, 1);
  }
});
