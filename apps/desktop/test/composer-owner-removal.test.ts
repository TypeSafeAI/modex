import assert from "node:assert/strict";
import { test } from "node:test";
import { ComposerRecoveryQueue } from "../src/shared/composer-recovery-queue.js";
import { ComposerAttachments } from "../src/renderer/composer-attachments.js";
import type { ComposerRecovery } from "../src/shared/update-recovery.js";

const initial: ComposerRecovery = { threads: [{ threadId: "empty", text: "", attachments: [] }], selectedThreadId: "empty",
  projects: [{ key: "draft:7:other", projectId: "other", text: "  preserved raw 😀  ", attachments: [] }],
  draft: { projectId: "other", revision: 7, worktree: true, settings: { backend: "mock", mode: "agent", model: "mock", plan: true, auto: false } } };
const canonical = { ...initial, threads: [], selectedThreadId: null };
async function fixture(save = async (_snapshot: ComposerRecovery) => ({ saved: true, revision: 8 })) {
  const module = "../src/shared/composer-owner-removal.js";
  const { ComposerOwnerRemoval } = await import(module);
  let snapshot = structuredClone(initial), held = false, frozen = false, applied = 0;
  const queue = new ComposerRecoveryQueue(snapshot, save);
  const options = { queue, validate() {}, snapshot: () => snapshot,
    prepareEditors: async (_invalidated: () => void) => {}, releaseEditors: () => {},
    freezeAttachments: () => { frozen = true; return true; }, releaseAttachments: () => { frozen = false; },
    held: (value: boolean) => { held = value; },
    apply: (next: ComposerRecovery, state: unknown) => { assert.equal(queue.held, true); assert.equal(held, true); assert.equal(state, "store snapshot"); snapshot = next; applied++; } };
  const removal = new ComposerOwnerRemoval(options);
  return { removal, queue, options, state: () => ({ snapshot, held, frozen, applied }) };
}

test("owner removal flushes mounted editors before saving and propagates membership revocation", async () => {
  const order: string[] = [], h = await fixture(async () => { order.push("composer"); return { saved: true, revision: 8 }; });
  let invalidate!: () => void, revoked = 0, released = false;
  h.options.prepareEditors = async callback => { assert.equal(h.state().held, true); order.push("editors"); invalidate = callback; };
  h.options.releaseEditors = () => { released = true; };
  await h.removal.prepare(() => revoked++);
  assert.deepEqual(order, ["editors", "composer"]); invalidate(); assert.equal(revoked, 1);
  await assert.rejects(h.removal.adopt({ drafts: canonical, revision: 9, state: "store snapshot" }));
  assert.equal(h.state().held, true); await h.removal.release(); assert.equal(released, true);
});

test("owner removal saves recent raw drafts and holds editing without granting close permission", async () => {
  let written: ComposerRecovery | undefined;
  const h = await fixture(async snapshot => { written = structuredClone(snapshot); return { saved: true, revision: 8 }; });
  assert.equal(await h.removal.prepare(), 8);
  assert.deepEqual(written, initial); assert.equal(h.queue.held, true); assert.equal(h.state().held, true);
  assert.equal(h.queue.saveBeforeClose(() => { assert.fail("held deletion cannot save or close"); }), false);
  await h.removal.release(); assert.equal(h.queue.held, false); assert.equal(h.state().frozen, false);
});

test("owner removal adopts canonical refs before reopening the queue and retains the freeze until main releases", async () => {
  const h = await fixture(); await h.removal.prepare();
  assert.equal(await h.removal.adopt({ drafts: canonical, revision: 9, state: "store snapshot" }), 9);
  assert.deepEqual(h.state().snapshot, canonical); assert.equal(h.state().applied, 1);
  assert.equal(h.state().held, true); assert.equal(h.queue.held, true); assert.equal(h.queue.dirty, false);
  await h.removal.release(); assert.equal(h.queue.held, false); assert.equal(await h.queue.flush(), 9);
});

test("owner removal cannot acknowledge a stale or incorrectly applied canonical result", async () => {
  const h = await fixture(); await h.removal.prepare();
  await assert.rejects(h.removal.adopt({ drafts: canonical, revision: 8, state: "store snapshot" }), /revision|stale/i);
  assert.equal(h.state().applied, 0);
  h.options.apply = () => {};
  await assert.rejects(h.removal.adopt({ drafts: canonical, revision: 9, state: "store snapshot" }), /draft|snapshot/i);
  assert.equal(h.queue.held, true); assert.equal(h.state().held, true);
});

test("owner removal save failure releases only after main cancels", async () => {
  const h = await fixture(async () => { throw new Error("disk refused"); });
  await assert.rejects(h.removal.prepare(), /disk refused/);
  assert.equal(h.state().held, true); assert.equal(h.state().frozen, true);
  await h.removal.release(); assert.equal(h.state().held, false); assert.equal(h.state().frozen, false);
});

test("cancellation during the save cannot let its late receipt freeze editing again", async () => {
  let finish!: (receipt: { saved: boolean; revision: number }) => void;
  const h = await fixture(() => new Promise(resolve => { finish = resolve; }));
  const prepared = h.removal.prepare(), rejected = assert.rejects(prepared, /cancel|changed/i); void rejected.catch(() => {});
  for (let i = 0; !finish && i < 5; i++) await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(typeof finish, "function");
  await h.removal.release(); finish({ saved: true, revision: 8 }); await rejected;
  assert.equal(h.queue.held, false); assert.equal(h.state().held, false);
});

test("attachment removal freeze preserves unrelated pending originals and newer attachments", async () => {
  const attachments = new ComposerAttachments(() => {}, async () => assert.fail("no attachment deletion"));
  const file = { id: "original", name: "original.txt", rel: "staging/original.txt", size: 1, kind: "file" as const, mime: "text/plain" };
  assert.equal(attachments.restorePending("other", [file]), true);
  const newer = { ...file, id: "newer", name: "newer.txt", rel: "staging/newer.txt" };
  await attachments.stage("other", 1, async () => ({ staged: [newer], errors: [] }));
  const before = attachments.editableSnapshot();
  assert.notEqual((attachments as any).freezeForOwnerRemoval(), null);
  await attachments.stage("other", 1, async () => { assert.fail("staging must remain frozen"); });
  assert.deepEqual(attachments.editableSnapshot(), before); assert.equal(attachments.get("other").sending, true);
  attachments.resumeAfterRecovery(); assert.deepEqual(attachments.get("other").attachments, [newer]);
});

test("attachment removal freeze refuses an outstanding picker", async () => {
  const attachments = new ComposerAttachments(() => {}, async () => {});
  let finish!: (value: { staged: never[]; errors: never[] }) => void;
  const staging = attachments.stage("other", 1, () => new Promise(resolve => { finish = resolve; }));
  try { assert.equal((attachments as any).freezeForOwnerRemoval(), null); }
  finally { finish({ staged: [], errors: [] }); await staging; }
});
