import assert from "node:assert/strict";
import { test } from "node:test";
import { ComposerRecoveryQueue } from "../src/shared/composer-recovery-queue.js";
import type { ComposerRecovery, DraftSaveReceipt } from "../src/shared/update-recovery.js";

const snapshot = (text: string): ComposerRecovery => ({ projects: [], threads: [{ threadId: "thread-1", attachments: [], text }], draft: null, selectedThreadId: "thread-1" });
function attachedSnapshot(): ComposerRecovery {
  const file = (id: string) => ({ id, name: "raw private 🔐.txt", mime: "text/plain", size: 4, kind: "file" as const, rel: `staging/${id}-raw private 🔐.txt` });
  return {
    threads: [{ threadId: "thread-1", text: "Thread raw input", attachments: [file("file-1")] }],
    selectedThreadId: "thread-1",
    projects: [{ key: "draft:7:project-1", projectId: "project-1", text: "Project raw input", attachments: [file("file-2")] }],
    draft: { revision: 7, projectId: "project-1", worktree: true,
      settings: { backend: "codex", mode: "agent", plan: true, auto: false, model: "raw-model", effort: "high" } },
  };
}

for (const capture of ["constructor", "update"] as const) {
  test(`recovery queue owns nested raw drafts captured by ${capture}`, async () => {
    const input = attachedSnapshot(), expected = structuredClone(input);
    const writes: ComposerRecovery[] = [];
    const queue = new ComposerRecoveryQueue(capture === "constructor" ? input : snapshot("initial"), async value => {
      writes.push(structuredClone(value)); return { revision: 1, saved: true };
    });
    if (capture === "update") queue.update(input);
    input.threads[0]!.text = "Changed thread";
    input.threads[0]!.attachments[0]!.name = "Changed filename";
    input.projects[0]!.text = "Changed project";
    input.projects[0]!.attachments.length = 0;
    input.draft!.settings.model = "Changed model";
    input.draft!.worktree = false;
    input.selectedThreadId = null;
    await queue.flush();
    assert.deepEqual(writes, [expected]);
    queue.update(expected);
    assert.equal(queue.dirty, false, "the acknowledged body describes the actual saved raw snapshot");
  });
}

for (const operation of ["async", "close"] as const) {
  test(`recovery queue does not expose mutable nested drafts to ${operation} save callbacks`, async () => {
    const expected = attachedSnapshot();
    const writes: ComposerRecovery[] = [];
    const save = (value: ComposerRecovery) => {
      assert.throws(() => { value.threads[0]!.attachments[0]!.name = "Changed filename"; }, TypeError);
      assert.throws(() => { value.projects[0]!.attachments.length = 0; }, TypeError);
      assert.throws(() => { value.draft!.settings.model = "Changed model"; }, TypeError);
      writes.push(structuredClone(value)); return 1;
    };
    const queue = new ComposerRecoveryQueue(expected, async value => ({ revision: save(value), saved: true }));
    if (operation === "async") await queue.flush();
    else assert.equal(queue.saveBeforeClose(save), true);
    assert.deepEqual(writes, [expected]);
    queue.update(structuredClone(expected));
    assert.equal(queue.dirty, false);
  });
}

for (const saved of [false, true]) test(`a delayed ${saved ? "older successful" : "discarded"} autosave cannot acknowledge text reverted after a close veto`, async () => {
  let delayed!: (receipt: DraftSaveReceipt) => void;
  const first = new Promise<DraftSaveReceipt>(resolve => { delayed = resolve; });
  const writes: string[] = [];
  const queue = new ComposerRecoveryQueue(snapshot("A"), async input => {
    writes.push(input.threads[0]!.text);
    if (writes.length === 1) return first;
    return { revision: 3, saved: true };
  });
  const flushing = queue.flush();
  await Promise.resolve(); // First autosave has been sent but not acknowledged.
  queue.update(snapshot("B"));
  assert.equal(queue.saveBeforeClose(() => 2), true);
  // Space vetoed that close; the user reverts the composer while the old reply is delayed.
  queue.update(snapshot("A"));
  delayed({ revision: 1, saved });
  await flushing;
  assert.deepEqual(writes, ["A", "A"]);
  assert.equal(queue.dirty, false);
});

test("failed saves remain dirty and newer edits are included in a coalesced flush", async () => {
  let fail = true;
  let queue: ComposerRecoveryQueue;
  const writes: string[] = [];
  queue = new ComposerRecoveryQueue(snapshot("A"), async input => {
    if (fail) throw new Error("disk unavailable");
    writes.push(input.threads[0]!.text);
    if (writes.length === 1) queue.update(snapshot("B"));
    return { revision: writes.length, saved: true };
  });
  await assert.rejects(queue.flush(), /disk/);
  assert.equal(queue.dirty, true);
  assert.equal(queue.saveBeforeClose(() => null), false);
  fail = false;
  const a = queue.flush(), b = queue.flush();
  assert.equal(a, b);
  assert.equal(await a, 2);
  assert.deepEqual(writes, ["A", "B"]);
  assert.equal(queue.dirty, false);
});

interface TransferQueue {
  holdForTransfer(): { token: object; drained: Promise<number> };
  completeTransfer(token: object, snapshot: ComposerRecovery, revision: number): void;
  refuseTransfer(token: object): void;
}
const transferable = (queue: ComposerRecoveryQueue) => queue as ComposerRecoveryQueue & TransferQueue;
for (const saved of [false, true]) test(`transfer hold drains delayed saved:${saved} without issuing a newer stale autosave`, async () => {
  let acknowledge!: (receipt: DraftSaveReceipt) => void;
  const writes: string[] = [];
  const queue = transferable(new ComposerRecoveryQueue(snapshot("old staged ownership"), async value => {
    writes.push(value.threads[0]!.text); return new Promise<DraftSaveReceipt>(resolve => { acknowledge = resolve; });
  }));
  const saving = queue.flush(); await Promise.resolve();
  const held = queue.holdForTransfer();
  acknowledge({ revision: 2, saved }); await saving; assert.equal(await held.drained, 2);
  assert.deepEqual(writes, ["old staged ownership"]);
  await assert.rejects(queue.flush(), /transfer|held/i);
  assert.equal(queue.saveBeforeClose(() => assert.fail("close save bypassed transfer hold")), false);
  const next = snapshot("newer raw after ownership transfer");
  queue.completeTransfer(held.token, next, 3); next.threads[0]!.text = "caller mutation";
  assert.equal(queue.dirty, false); await queue.flush(); assert.equal(writes.length, 1);
});

test("known unchanged transfer refusal releases hold while preserving the latest unsaved text", async () => {
  const writes: string[] = [];
  const queue = transferable(new ComposerRecoveryQueue(snapshot("latest raw"), async value => { writes.push(value.threads[0]!.text); return { saved: true, revision: 1 }; }));
  const hold = queue.holdForTransfer(); await hold.drained;
  assert.throws(() => queue.update(snapshot("unexpected edit during sealed transfer")), /transfer|held/i);
  queue.refuseTransfer(hold.token); await queue.flush();
  assert.deepEqual(writes, ["latest raw"]); assert.equal(queue.dirty, false);
});

test("transfer holds cannot be forged or cross instances and invalid acknowledgments retain the hold", async () => {
  const make = () => transferable(new ComposerRecoveryQueue(snapshot("raw"), async () => ({ saved: true, revision: 5 })));
  const queue = make(); await queue.flush(); const hold = queue.holdForTransfer(); await hold.drained;
  assert.throws(() => make().completeTransfer(hold.token, snapshot("foreign"), 6));
  assert.throws(() => queue.refuseTransfer({}));
  assert.throws(() => queue.completeTransfer(hold.token, snapshot("stale"), 4));
  await assert.rejects(queue.flush(), /transfer|held/i);
  queue.completeTransfer(hold.token, snapshot("committed raw"), 6);
  assert.equal(queue.dirty, false); assert.throws(() => queue.refuseTransfer(hold.token));
});

test("an uncertain in-flight save leaves transfer hold closed and cannot acknowledge new ownership", async () => {
  let reject!: (error: Error) => void;
  const queue = transferable(new ComposerRecoveryQueue(snapshot("preserved raw"), () => new Promise((_resolve, fail) => { reject = fail; })));
  const saving = queue.flush(); await Promise.resolve(); const hold = queue.holdForTransfer();
  const failedSave = assert.rejects(saving, /uncertain/), failedDrain = assert.rejects(hold.drained, /uncertain/);
  reject(new Error("uncertain storage")); await Promise.all([failedSave, failedDrain]);
  assert.throws(() => queue.completeTransfer(hold.token, snapshot("unproven"), 1));
  assert.throws(() => queue.refuseTransfer(hold.token));
  assert.equal(queue.dirty, true); await assert.rejects(queue.flush(), /held|transfer/i);
});
