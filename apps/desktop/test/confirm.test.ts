import { test } from "node:test";
import assert from "node:assert/strict";
import { confirmDialog, currentConfirm, resetConfirms, settleConfirm, subscribeConfirm } from "../src/renderer/confirm.js";

const ask = (title: string) => confirmDialog({ title, confirmLabel: "OK" });

test("a request is current until it is settled, and resolves with the answer", async () => {
  resetConfirms();
  const answer = ask("one");
  const current = currentConfirm()!;
  assert.equal(current.title, "one");
  assert.equal(currentConfirm(), current, "stable identity for useSyncExternalStore");
  settleConfirm(current.id, true);
  assert.equal(await answer, true);
  assert.equal(currentConfirm(), null);
});

test("requests are answered one at a time, first in first out", async () => {
  resetConfirms();
  const first = ask("first"), second = ask("second");
  assert.equal(currentConfirm()!.title, "first");
  settleConfirm(currentConfirm()!.id, false);
  assert.equal(await first, false);
  assert.equal(currentConfirm()!.title, "second");
  settleConfirm(currentConfirm()!.id, true);
  assert.equal(await second, true);
});

test("settling an id that is not current changes nothing", async () => {
  resetConfirms();
  const answer = ask("only");
  const id = currentConfirm()!.id;
  settleConfirm(id + 1, true);
  assert.equal(currentConfirm()!.id, id);
  settleConfirm(id, true); settleConfirm(id, false);
  assert.equal(await answer, true);
});

test("listeners hear every change, and reset answers everything with false", async () => {
  resetConfirms();
  let calls = 0;
  const stop = subscribeConfirm(() => { calls++; });
  const a = ask("a"), b = ask("b");
  assert.equal(calls, 1, "the second request does not change what is current");
  resetConfirms();
  assert.deepEqual(await Promise.all([a, b]), [false, false]);
  assert.equal(calls, 2);
  stop();
  void ask("c");
  assert.equal(calls, 2);
  resetConfirms();
});
