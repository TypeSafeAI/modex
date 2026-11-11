import { test } from "node:test";
import assert from "node:assert/strict";
import { copyPendingTextToNewThread } from "../src/renderer/pending-message-copy.js";
import type { Thread, BridgeCommands } from "../src/shared/types.js";

test("pending text copy creates a separate empty chat without forwarding original settings or attachments", async () => {
  const original = { rawText: "  preserved original\n😀  ", files: [{ id: "reserved-original" }], configuration: { settings: { model: "private-local" } } };
  const before = JSON.stringify(original), requests: BridgeCommands["thread:create"]["req"][] = [];
  let finish!: (value: Thread) => void;
  const waiting = new Promise<Thread>(resolve => { finish = resolve; });
  let settled = false;
  const work = copyPendingTextToNewThread(original, { projectId: "p1", backend: "mock", model: "mock", mode: "chat" }, request => { requests.push(request); return waiting; });
  void work.then(() => { settled = true; });
  await Promise.resolve(); assert.equal(settled, false);
  assert.deepEqual(requests, [{ projectId: "p1", backend: "mock", model: "mock", mode: "chat", auto: false, worktree: false }]);
  const thread = { id: "fresh-thread" } as Thread;
  finish(thread);
  assert.deepEqual(await work, { thread, text: original.rawText });
  assert.equal(JSON.stringify(original), before);
});

test("failed new-chat creation leaves the pending original unchanged and rejects without retry", async () => {
  const original = { rawText: "private original" }, before = JSON.stringify(original);
  let calls = 0;
  await assert.rejects(copyPendingTextToNewThread(original, { projectId: "p1" }, async () => { calls++; throw new Error("creation failed"); }), /creation failed/);
  assert.equal(calls, 1); assert.equal(JSON.stringify(original), before);
});
