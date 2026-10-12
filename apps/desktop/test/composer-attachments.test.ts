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

const recovery = (drafts: ComposerAttachments) => drafts;

test("recovery sees pending work in inactive drafts and a refused freeze keeps late files usable", async () => {
  const { drafts } = setup(); const state = recovery(drafts);
  const held = deferred<ReturnType<typeof result>>();
  const work = drafts.stage("draft:0:project-a", 1, () => held.promise);
  drafts.get("thread-b");
  assert.equal(state.isBusy(), true);
  assert.equal(state.snapshot(), null); assert.equal(state.freezeForRecovery(), null);
  held.resolve(result("late")); await work;
  assert.equal(state.isBusy(), false);
  const snapshot = state.snapshot()!;
  assert.deepEqual(snapshot.find(entry => entry.key === "draft:0:project-a")!.attachments, [file("late")]);
  assert.equal(Reflect.set(snapshot[0]!.attachments[0]!, "name", "caller edit"), false);
  assert.equal(Reflect.set(snapshot, "length", 0), false);
  assert.equal(drafts.get("draft:0:project-a").attachments[0]!.name, "late");
  assert.deepEqual(drafts.beginSend("draft:0:project-a"), [file("late")]);
});

test("retired drafts stay busy until pending staging and cleanup both settle", async () => {
  const staged = deferred<ReturnType<typeof result>>(); const removed = deferred<void>();
  const calls: string[][] = [];
  const drafts = new ComposerAttachments(() => {}, async files => { calls.push(files.map(f => f.id)); await removed.promise; });
  const state = recovery(drafts); const work = drafts.stage("a", 1, () => staged.promise);
  drafts.retire("a");
  assert.equal(state.isBusy(), true); assert.equal(state.freezeForRecovery(), null);
  staged.resolve(result("late")); await Promise.resolve();
  assert.deepEqual(calls, [["late"]]); assert.equal(state.isBusy(), true);
  removed.resolve(); await work;
  assert.equal(state.isBusy(), false); assert.deepEqual(state.snapshot(), []);
});

test("discard is counted before notifying recovery and a failed discard releases the reservation", async () => {
  const held = deferred<void>(); let observe = false; let state: ReturnType<typeof recovery>;
  const observed: boolean[] = [];
  const drafts = new ComposerAttachments(() => { if (observe) observed.push(state.isBusy()); }, () => held.promise);
  state = recovery(drafts); await drafts.stage("a", 1, async () => result("remove"));
  observe = true; drafts.remove("a", "remove");
  assert.equal(observed[0], true, "no idle notification before an asynchronous discard starts");
  assert.equal(state.freezeForRecovery(), null);
  held.reject(new Error("disk refused")); await held.promise.catch(() => {}); await Promise.resolve(); await Promise.resolve();
  assert.equal(state.isBusy(), false); assert.match(drafts.get("a").warning!, /Could not remove/);
});

test("recovery tracks empty sends and moved send batches until their actual result", async () => {
  const { drafts } = setup(); const state = recovery(drafts);
  assert.deepEqual(drafts.beginSend("empty"), []);
  assert.equal(state.isBusy(), true); assert.equal(state.freezeForRecovery(), null);
  drafts.finishSend("empty", true);
  await drafts.stage("draft", 1, async () => result("sent")); drafts.beginSend("draft");
  drafts.move("draft", "thread"); drafts.retire("thread");
  assert.equal(state.isBusy(), true); assert.equal(state.snapshot(), null);
  drafts.finishSend("thread", true);
  assert.equal(state.isBusy(), false); assert.ok(state.snapshot());
});

test("startup restoration validates and copies all drafts atomically alongside lazy empty reads", () => {
  const { drafts } = setup(); const state = recovery(drafts); drafts.get("thread-a");
  const entries = [{ key: "thread-a", attachments: [file("a")] }, { key: "draft:0:project-b", attachments: [file("b")] }];
  assert.equal(state.restore(entries), true);
  entries[0]!.attachments[0]!.name = "mutated input"; entries.pop();
  assert.equal(drafts.get("thread-a").attachments[0]!.name, "a");
  assert.deepEqual(drafts.get("draft:0:project-b").attachments, [file("b")]);
  assert.equal(state.restore([]), false, "startup restoration cannot overwrite already restored state");
  assert.deepEqual(state.snapshot()!.map(entry => entry.key).sort(), ["draft:0:project-b", "thread-a"]);
});

test("invalid and conflicting restores leave live drafts unchanged without partial insertion", async () => {
  const { drafts } = setup(); const state = recovery(drafts);
  const bad = [
    [{ key: "first", attachments: [file("a")] }, { key: "last", attachments: null }],
    [{ key: "a", attachments: [file("duplicate")] }, { key: "b", attachments: [file("duplicate")] }],
    [{ key: "same", attachments: [] }, { key: "same", attachments: [] }],
    [{ key: "a", attachments: Array.from({ length: 21 }, (_, i) => file(`file-${i}`)) }],
  ];
  for (const entries of bad) { assert.equal(state.restore(entries), false); assert.deepEqual(state.snapshot(), []); }
  await drafts.stage("live", 1, async () => result("original"));
  assert.equal(state.restore([{ key: "other", attachments: [file("new")] }]), false);
  assert.deepEqual(state.snapshot(), [{ key: "live", attachments: [file("original")] }]);
});

test("a recovery hold refuses all mutations until refusal resumes normal editing", async () => {
  const { drafts, discarded } = setup(); const state = recovery(drafts);
  await drafts.stage("a", 1, async () => result("kept"));
  assert.deepEqual(state.freezeForRecovery(), [{ key: "a", attachments: [file("kept")] }]);
  assert.equal(state.freezeForRecovery(), null);
  let called = false; await drafts.stage("new", 1, async () => { called = true; return result("never"); });
  drafts.remove("a", "kept"); drafts.retire("a"); drafts.move("a", "new");
  drafts.dismissWarning("a"); drafts.finishSend("a", false);
  assert.equal(drafts.beginSend("a"), null); assert.equal(state.restore([]), false);
  assert.equal(called, false); assert.deepEqual(discarded, []);
  assert.deepEqual(state.snapshot(), [{ key: "a", attachments: [file("kept")] }]);
  state.resumeAfterRecovery();
  assert.deepEqual(drafts.beginSend("a"), [file("kept")]);
  drafts.finishSend("a", false); assert.deepEqual(drafts.get("a").attachments, [file("kept")]);
});

test("disposal preserves late attachment evidence and cannot notify or create new drafts", async () => {
  let changed = 0; const discarded: string[] = [];
  const drafts = new ComposerAttachments(() => changed++, async files => { discarded.push(...files.map(f => f.id)); });
  const state = recovery(drafts); const held = deferred<ReturnType<typeof result>>();
  await drafts.stage("a", 1, async () => result("kept"));
  const work = drafts.stage("b", 1, () => held.promise);
  state.dispose(); const before = changed;
  drafts.get("never-created"); drafts.retire("a"); drafts.remove("a", "kept"); drafts.move("a", "new");
  state.resumeAfterRecovery(); assert.equal(state.restore([]), false); assert.equal(drafts.beginSend("a"), null);
  let called = false; await drafts.stage("c", 1, async () => { called = true; return result("never"); });
  held.resolve(result("late")); await work;
  assert.equal(changed, before); assert.equal(called, false); assert.deepEqual(discarded, []);
  assert.equal(state.snapshot(), null); assert.equal(state.freezeForRecovery(), null);
});

test("moving a draft cannot overwrite a live target or lose its pending reservation", async () => {
  const { drafts } = setup(); const state = recovery(drafts);
  await drafts.stage("from", 1, async () => result("source"));
  await drafts.stage("target", 1, async () => result("existing"));
  assert.throws(() => drafts.move("from", "target"), /draft|target|conflict/i);
  assert.deepEqual(drafts.get("from").attachments, [file("source")]);
  assert.deepEqual(drafts.get("target").attachments, [file("existing")]);
  const held = deferred<ReturnType<typeof result>>(); const work = drafts.stage("from", 1, () => held.promise);
  drafts.get("empty-target"); drafts.move("from", "empty-target");
  assert.equal(state.isBusy(), true); assert.equal(state.snapshot(), null);
  held.resolve(result("late")); await work;
  assert.deepEqual(drafts.get("empty-target").attachments, [file("source"), file("late")]);
});

test("restore rejects malformed data without reading getters or changing live state", () => {
  const { drafts } = setup(); let reads = 0;
  const getter = { key: "a", get attachments() { reads++; return []; } };
  const malformed: unknown[] = [[getter], [,], [{ key: "a", attachments: [undefined] }],
    [{ key: "a", attachments: [{ ...file("x"), size: NaN }] }],
    [{ key: "a", attachments: [{ ...file("x"), extra: true }] }],
    [{ key: "a", attachments: [], extra: true }]];
  for (const input of malformed) { assert.equal(drafts.restore(input), false); assert.deepEqual(drafts.snapshot(), []); }
  assert.equal(reads, 0);
});

test("restore cannot publish over a recovery hold acquired during input validation", () => {
  const { drafts } = setup();
  const input = new Proxy({ key: "a", attachments: [file("new")] }, {
    getPrototypeOf(target) { drafts.freezeForRecovery(); return Reflect.getPrototypeOf(target); },
  });
  assert.equal(drafts.restore([input]), false);
  assert.deepEqual(drafts.snapshot(), []);
});

test("staged results views and send batches cannot mutate retained recovery metadata", async () => {
  const { drafts } = setup(); const staged = result("original");
  await drafts.stage("a", 1, async () => staged);
  staged.staged[0]!.name = "changed transport";
  const view = drafts.get("a"); view.attachments[0]!.name = "changed view"; view.attachments.length = 0;
  const sent = drafts.beginSend("a")!; sent[0]!.name = "changed sender"; sent.length = 0;
  drafts.finishSend("a", false);
  assert.deepEqual(drafts.snapshot(), [{ key: "a", attachments: [file("original")] }]);
});

test("disposing while removal is pending suppresses its warning and completion notification", async () => {
  const held = deferred<void>(); let changes = 0; let removals = 0;
  const drafts = new ComposerAttachments(() => changes++, () => { removals++; return held.promise; });
  await drafts.stage("a", 1, async () => result("old"));
  drafts.remove("a", "old"); assert.equal(drafts.isBusy(), true);
  drafts.dispose(); const before = changes;
  held.reject(new Error("late removal failure")); await held.promise.catch(() => {}); await Promise.resolve(); await Promise.resolve();
  assert.equal(changes, before); assert.equal(removals, 1); assert.equal(drafts.isBusy(), false);
  assert.equal(drafts.get("a").warning, null);
});

test("recovery MIME limits match the persisted model and preserve exact metadata", () => {
  for (const mime of ["x".repeat(201), "x".repeat(256), "text/\0plain"]) {
    const { drafts } = setup(); const attachment = { ...file("mime"), mime };
    assert.equal(drafts.restore([{ key: "a", attachments: [attachment] }]), true);
    assert.deepEqual(drafts.snapshot(), [{ key: "a", attachments: [attachment] }]);
  }
  const { drafts } = setup();
  assert.equal(drafts.restore([{ key: "a", attachments: [{ ...file("mime"), mime: "x".repeat(257) }] }]), false);
  assert.deepEqual(drafts.snapshot(), []);
});

for (const action of ["dispose", "retire"] as const) {
  test(`a ${action} during the pending notification prevents a new picker from starting`, async () => {
    let called = 0; const discarded: string[] = [];
    const drafts = new ComposerAttachments(() => {
      if (drafts.get("a").copying) {
        if (action === "dispose") drafts.dispose();
        else drafts.retire("a");
      }
    }, async files => { discarded.push(...files.map(file => file.id)); });
    await drafts.stage("a", 1, async () => { called++; return result("never"); });
    assert.equal(called, 0); assert.deepEqual(discarded, []);
    assert.equal(drafts.isBusy(), false);
    assert.deepEqual(drafts.snapshot(), action === "dispose" ? null : []);
  });
}

const claimedFile = (id: string, thread = "thread-1"): Attachment => ({ ...file(id), rel: `${thread}/${id}` });

test("project transfer atomically adopts sent and intervening files, preserving failed-send editing and restart", async () => {
  const { drafts, discarded } = setup(), source = "draft:0:project-1";
  await drafts.stage(source, 1, async () => result("sent")); drafts.beginSend(source);
  await drafts.stage(source, 1, async () => result("new"));
  await drafts.stage("thread-2", 1, async () => result("independent")); drafts.beginSend("thread-2");
  const seal = drafts.beginTransfer(source, "thread-1")!;
  assert.deepEqual(seal.snapshot.find(entry => entry.key === source)!.attachments, [file("sent"), file("new")]);
  assert.deepEqual(seal.snapshot.find(entry => entry.key === "thread-2")!.attachments, [file("independent")]);
  assert.ok(Object.isFrozen(seal.snapshot[0]!.attachments[0]));
  let called = false;
  await drafts.stage(source, 1, async () => { called = true; return result("blocked"); });
  drafts.remove(source, "new"); drafts.finishSend(source, false);
  assert.equal(called, false); assert.deepEqual(discarded, []);
  const claimed = [claimedFile("new"), claimedFile("sent")];
  assert.equal(drafts.adoptTransfer(seal.token, claimed), true);
  claimed[0]!.name = "mutated reply";
  assert.equal(drafts.adoptTransfer(seal.token, claimed), false);
  assert.equal(drafts.get("thread-1").copying, false);
  drafts.finishSend("thread-1", false);
  assert.deepEqual(drafts.get("thread-1").attachments, [claimedFile("sent"), claimedFile("new")]);
  await drafts.stage("thread-1", 1, async () => result("after"));
  drafts.remove("thread-1", "new"); await Promise.resolve();
  assert.deepEqual(drafts.beginSend("thread-1"), [claimedFile("sent"), file("after")]);
  drafts.finishSend("thread-1", false); drafts.finishSend("thread-2", false);
  const snapshot = drafts.freezeForRecovery()!; assert.ok(snapshot);
  const fresh = setup().drafts; assert.equal(fresh.restore(snapshot), true);
  assert.deepEqual(fresh.get("thread-1").attachments, [claimedFile("sent"), file("after")]);
});

test("same-thread transfer handles mixed claimed and staged files without moving the draft", async () => {
  const { drafts } = setup();
  assert.equal(drafts.restore([{ key: "thread-1", attachments: [claimedFile("old"), file("staged")] }]), true);
  drafts.beginSend("thread-1");
  const seal = drafts.beginTransfer("thread-1", "thread-1")!;
  assert.equal(drafts.adoptTransfer(seal.token, [claimedFile("staged"), claimedFile("old")]), true);
  drafts.finishSend("thread-1", false);
  assert.deepEqual(drafts.get("thread-1").attachments, [claimedFile("old"), claimedFile("staged")]);
  drafts.beginSend("thread-1");
  const allClaimed = drafts.beginTransfer("thread-1", "thread-1")!;
  assert.equal(drafts.adoptTransfer(allClaimed.token, [claimedFile("old"), claimedFile("staged")]), true);
});

for (const fault of ["missing", "extra", "wrong-id", "wrong-owner", "changed-size", "changed-name", "duplicate"] as const) {
  test(`transfer ${fault} response leaves source sealed with no partial metadata change`, async () => {
    const { drafts } = setup(), source = "draft:0:project-1";
    await drafts.stage(source, 1, async () => result("sent")); drafts.beginSend(source);
    await drafts.stage(source, 1, async () => result("new"));
    const seal = drafts.beginTransfer(source, "thread-1")!;
    const reply = [claimedFile("sent"), claimedFile("new")];
    if (fault === "missing") reply.pop();
    if (fault === "extra") reply.push(claimedFile("extra"));
    if (fault === "wrong-id") reply[1]!.id = "unknown";
    if (fault === "wrong-owner") reply[1]!.rel = "other-thread/new";
    if (fault === "changed-size") reply[1]!.size++;
    if (fault === "changed-name") reply[1]!.name = "changed";
    if (fault === "duplicate") reply[1] = reply[0]!;
    assert.equal(drafts.adoptTransfer(seal.token, reply), false);
    assert.deepEqual(drafts.get(source).attachments, [file("new")]);
    assert.equal(drafts.get(source).copying, true);
    assert.deepEqual(drafts.get("thread-1").attachments, []);
    assert.equal(drafts.freezeForRecovery(), null);
    // A main-proved refusal may release; malformed success alone never does.
    assert.equal(drafts.refuseTransfer(seal.token), true);
    drafts.finishSend(source, false);
    assert.deepEqual(drafts.get(source).attachments, [file("sent"), file("new")]);
  });
}

test("touched targets and forged or cross-controller tokens cannot adopt or release a sealed source", async () => {
  const { drafts } = setup(), other = setup().drafts, source = "draft:0:project-1";
  await drafts.stage(source, 1, async () => result("sent")); drafts.beginSend(source);
  const seal = drafts.beginTransfer(source, "thread-1")!;
  await drafts.stage("thread-1", 1, async () => result("unrelated"));
  assert.equal(drafts.adoptTransfer(seal.token, [claimedFile("sent")]), false);
  assert.equal(other.adoptTransfer(seal.token, [claimedFile("sent")]), false);
  assert.equal(other.refuseTransfer(seal.token), false);
  assert.equal(drafts.refuseTransfer({} as typeof seal.token), false);
  assert.equal(drafts.get(source).copying, true);
  assert.deepEqual(drafts.get("thread-1").attachments, [file("unrelated")]);
  assert.throws(() => drafts.move(source, "thread-3"), /pending/i);
});

for (const action of ["retire", "dispose"] as const) {
  test(`${action} during transfer preserves evidence and refuses stale replies`, async () => {
    const { drafts, discarded } = setup(), source = "draft:0:project-1";
    await drafts.stage(source, 1, async () => result("sent")); drafts.beginSend(source);
    await drafts.stage(source, 1, async () => result("new"));
    const seal = drafts.beginTransfer(source, "thread-1")!;
    if (action === "retire") drafts.retire(source); else drafts.dispose();
    assert.equal(drafts.adoptTransfer(seal.token, [claimedFile("sent"), claimedFile("new")]), false);
    assert.equal(drafts.refuseTransfer(seal.token), false);
    drafts.finishSend(source, false);
    assert.deepEqual(discarded, []);
    assert.equal(drafts.isBusy(), true);
    assert.equal(drafts.snapshot(), null);
  });
}

test("transfer waits for picker and discard completion without blocking independent turns", async () => {
  const picker = deferred<ReturnType<typeof result>>(), discard = deferred<void>();
  const drafts = new ComposerAttachments(() => {}, () => discard.promise), source = "draft:0:project-1";
  await drafts.stage(source, 1, async () => result("sent")); drafts.beginSend(source);
  const work = drafts.stage(source, 1, () => picker.promise);
  assert.equal(drafts.beginTransfer(source, "thread-1"), null);
  picker.resolve(result("remove")); await work;
  drafts.remove(source, "remove");
  assert.equal(drafts.beginTransfer(source, "thread-1"), null);
  discard.resolve(); await discard.promise; await Promise.resolve();
  const seal = drafts.beginTransfer(source, "thread-1")!; assert.ok(seal);
  assert.deepEqual(drafts.beginSend("independent"), []);
  drafts.finishSend("independent", true);
  assert.equal(drafts.refuseTransfer(seal.token), true);
  assert.equal(drafts.refuseTransfer(seal.token), false);
});

test("transfer revalidates its lifetime after untrusted response inspection", async () => {
  const { drafts, discarded } = setup(), source = "draft:0:project-1";
  await drafts.stage(source, 1, async () => result("sent")); drafts.beginSend(source);
  const seal = drafts.beginTransfer(source, "thread-1")!;
  const reply = new Proxy([claimedFile("sent")], { ownKeys(target) { drafts.retire(source); return Reflect.ownKeys(target); } });
  assert.equal(drafts.adoptTransfer(seal.token, reply), false);
  assert.deepEqual(drafts.get("thread-1").attachments, []);
  assert.deepEqual(discarded, []);
});

test("a deferred discard exposes its send hold until cleanup settles", async () => {
  const discarded = deferred<void>();
  const drafts = new ComposerAttachments(() => {}, () => discarded.promise);
  await drafts.stage("thread-1", 2, async () => result("remove", "keep"));
  drafts.remove("thread-1", "remove");
  assert.equal(drafts.get("thread-1").copying, true);
  assert.equal(drafts.get("thread-1").sending, false);
  assert.equal(drafts.beginSend("thread-1"), null);
  discarded.resolve(); await discarded.promise; await Promise.resolve();
  assert.equal(drafts.get("thread-1").copying, false);
  assert.deepEqual(drafts.beginSend("thread-1"), [file("keep")]);
});

interface NativeComposerAttachments {
  editableSnapshot(): readonly { key: string; attachments: readonly Readonly<Attachment>[] }[];
  restorePending(key: string, files: readonly Attachment[]): boolean;
}
const nativeComposer = (drafts: ComposerAttachments) => drafts as ComposerAttachments & NativeComposerAttachments;

test("ordinary recovery snapshots keep newer attachments while the original send and picker remain pending", async () => {
  const { drafts } = setup(), native = nativeComposer(drafts);
  await drafts.stage("draft:0:p1", 1, async () => result("original"));
  drafts.beginSend("draft:0:p1");
  await drafts.stage("draft:0:p1", 1, async () => result("newer"));
  const held = deferred<ReturnType<typeof result>>(), picking = drafts.stage("draft:0:p1", 1, () => held.promise);
  assert.equal(drafts.snapshot(), null);
  assert.deepEqual(native.editableSnapshot(), [{ key: "draft:0:p1", attachments: [file("newer")] }]);
  held.resolve(result("picked")); await picking;
  assert.deepEqual(native.editableSnapshot()[0]!.attachments, [file("newer"), file("picked")]);
});

test("a restored pending original reserves its own batch separately from the newer editable composer", () => {
  const { drafts } = setup(), native = nativeComposer(drafts);
  assert.equal(drafts.restore([{ key: "thread1", attachments: [file("original"), file("newer")] }]), true);
  assert.equal(native.restorePending("thread1", [file("original")]), true);
  assert.deepEqual(drafts.get("thread1").attachments, [file("newer")]);
  assert.equal(drafts.get("thread1").sending, true);
  assert.equal(native.restorePending("thread1", [file("original")]), false);
  const sealed = drafts.beginTransfer("thread1", "thread1")!;
  const claimed = [file("original"), file("newer")].map(value => ({ ...value, rel: `thread1/${value.id}` }));
  assert.equal(drafts.adoptTransfer(sealed.token, claimed), true);
  drafts.finishSend("thread1", true);
  assert.deepEqual(native.editableSnapshot(), [{ key: "thread1", attachments: [claimed[1]!] }]);
});

test("attachment removal reports the captured current owner key after a move", async () => {
  const removed: { key?: string; files: Attachment[] }[] = [];
  const drafts = new ComposerAttachments(() => {}, async (files, key?: string) => { removed.push({ key, files }); });
  await drafts.stage("draft:0:p1", 1, async () => result("newer"));
  drafts.move("draft:0:p1", "thread1"); drafts.remove("thread1", "newer");
  assert.deepEqual(removed, [{ key: "thread1", files: [file("newer")] }]);
});
