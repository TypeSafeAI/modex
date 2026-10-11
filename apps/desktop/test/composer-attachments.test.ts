import { test } from "node:test";
import assert from "node:assert/strict";
import { ComposerAttachments } from "../src/renderer/composer-attachments.js";
import type { Attachment } from "../src/shared/attachments.js";
const file = (id: string): Attachment => ({ id, name: id, mime: "text/plain", size: 1, kind: "file", rel: `staging/${id}` });
const deferred = <T>() => { let resolve!: (v: T) => void; let reject!: (e: Error) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const result = (...ids: string[]) => ({ staged: ids.map(file), errors: [] });
const setup = () => { const discarded: string[] = []; const drafts = new ComposerAttachments(() => {}, async (files) => { discarded.push(...files.map(f => f.id)); }); return { drafts, discarded }; };

test("pending encoding/staging reserves slots synchronously and blocks send only for its composer", async () => {
  const { drafts } = setup(); const held = deferred<ReturnType<typeof result>>();
  const work = drafts.stage("a", 1, () => held.promise);
  assert.equal(drafts.get("a").copying, true);
  assert.equal(drafts.beginSend("a"), null);
  assert.deepEqual(drafts.beginSend("b"), []);
  held.resolve(result("one")); await work;
  assert.equal(drafts.get("a").copying, false);
  assert.deepEqual(drafts.beginSend("a"), [file("one")]);
});

test("rejections warn and release picker, staging and encoding reservations", async () => {
  for (const name of ["picker", "stage", "arrayBuffer"]) {
    const { drafts } = setup();
    await drafts.stage("a", 20, async () => { throw new Error(`${name} failed`); });
    assert.match(drafts.get("a").warning!, new RegExp(`${name} failed`));
    assert.equal(drafts.get("a").copying, false);
    await drafts.stage("a", 20, async room => { assert.equal(room, 20); return result("next"); });
    assert.deepEqual(drafts.get("a").attachments, [file("next")]);
  }
});

test("late arrival appends to captured composer after removals and newer additions", async () => {
  const { drafts, discarded } = setup();
  await drafts.stage("a", 1, async () => result("old"));
  const held = deferred<ReturnType<typeof result>>(); const work = drafts.stage("a", 1, () => held.promise);
  drafts.remove("a", "old");
  await drafts.stage("a", 1, async () => result("new"));
  await drafts.stage("b", 1, async () => result("other"));
  held.resolve(result("late")); await work;
  assert.deepEqual(drafts.get("a").attachments.map(f => f.id), ["new", "late"]);
  assert.deepEqual(drafts.get("b").attachments.map(f => f.id), ["other"]);
  assert.deepEqual(discarded, ["old"]);
});

test("overlapping operations never reserve or retain more than 20 files", async () => {
  const { drafts, discarded } = setup();
  const held = deferred<ReturnType<typeof result>>(); const work = drafts.stage("a", 19, () => held.promise);
  await drafts.stage("a", 3, async room => { assert.equal(room, 1); return result("new", "overflow"); });
  held.resolve(result(...Array.from({ length: 19 }, (_, i) => `old${i}`))); await work;
  assert.equal(drafts.get("a").attachments.length, 20);
  assert.deepEqual(discarded, ["overflow"]);
  assert.match(drafts.get("a").warning!, /20/);
});

test("picker gets remaining capacity and staged overflow is discarded", async () => {
  const { drafts, discarded } = setup();
  await drafts.stage("a", 19, async () => result(...Array.from({ length: 19 }, (_, i) => `old${i}`)));
  await drafts.stage("a", 20, async room => { assert.equal(room, 1); return result("last", "extra"); });
  assert.equal(drafts.get("a").attachments.length, 20);
  assert.deepEqual(discarded, ["extra"]);
  let called = false; await drafts.stage("a", 20, async () => { called = true; return result("never"); });
  assert.equal(called, false);
});

test("failed send restores batch alongside newer files and blocks duplicate sends across remounts", async () => {
  const { drafts } = setup();
  await drafts.stage("a", 19, async () => result(...Array.from({ length: 19 }, (_, i) => `old${i}`)));
  assert.equal(drafts.beginSend("a")!.length, 19);
  assert.equal(drafts.get("a").sending, true);
  assert.equal(drafts.beginSend("a"), null);
  await drafts.stage("a", 20, async room => { assert.equal(room, 1); return result("new"); });
  drafts.finishSend("a", false);
  assert.equal(drafts.get("a").attachments.length, 20);
  assert.equal(drafts.get("a").attachments.at(-1)!.id, "new");
  assert.equal(drafts.get("a").sending, false);
});

test("draft-to-thread handoff keeps send reservation and newer attachments", async () => {
  const { drafts } = setup();
  await drafts.stage("draft", 1, async () => result("sent")); drafts.beginSend("draft");
  await drafts.stage("draft", 1, async () => result("new"));
  drafts.move("draft", "thread");
  assert.equal(drafts.beginSend("thread"), null);
  drafts.finishSend("thread", false);
  assert.deepEqual(drafts.get("thread").attachments.map(f => f.id), ["sent", "new"]);
});

test("deleted or retired composers discard pending and newly staged results, never resurrect", async () => {
  const { drafts, discarded } = setup();
  await drafts.stage("a", 1, async () => result("old"));
  const held = deferred<ReturnType<typeof result>>(); const work = drafts.stage("a", 1, () => held.promise);
  drafts.retire("a"); held.resolve(result("late")); await work;
  assert.deepEqual(drafts.get("a").attachments, []);
  assert.deepEqual(discarded.sort(), ["late", "old"]);
  assert.equal(drafts.beginSend("a"), null);
});
