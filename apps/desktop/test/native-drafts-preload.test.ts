import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { test } from "node:test";

function preload(platform = "darwin", openResult: unknown = { session: "main-only-session", drafts: null, pendingIds: ["original-intent"] }) {
  const calls: { channel: string; payload: any }[] = [];
  const replies = new Map<string, unknown>();
  const listeners = new Map<string, Function>();
  let exposed: any;
  const ipcRenderer = {
    invoke: async (channel: string, payload: unknown) => {
      calls.push({ channel, payload });
      if (channel === "drafts:open") return openResult;
      return replies.get(channel);
    },
    sendSync: (channel: string, payload: unknown) => { calls.push({ channel, payload }); return replies.get(channel); },
    on(channel: string, callback: Function) { listeners.set(channel, callback); }, removeListener(channel: string) { listeners.delete(channel); },
  };
  vm.runInNewContext(fs.readFileSync(path.resolve(import.meta.dirname, "../../src/main/preload.cjs"), "utf8"), {
    require: () => ({ contextBridge: { exposeInMainWorld: (_name: string, bridge: unknown) => { exposed = bridge; } }, ipcRenderer, webUtils: { getPathForFile: () => "" } }),
    process: { platform },
  });
  return { bridge: exposed, calls, replies, listeners, setOpen: (value: unknown) => { openResult = value; } };
}
const snapshot = { threads: [], projects: [], selectedThreadId: null, draft: null };

test("owner recovery notification revokes cached editing and requires a fresh read-only main response", async () => {
  const h = preload(), native = h.bridge.nativeDrafts; await native.open();
  h.bridge.onOwnerRemovalRecovery(() => {});
  h.listeners.get("drafts:remove-recovery")!({}, "uncertain deletion");
  await assert.rejects(native.save(snapshot), /before editing/);
  const recovered = { readOnly: true, drafts: snapshot, pendingIds: [], pending: [], recovery: { outcome: "recovery", message: "Preserved" } };
  h.setOpen(recovered);
  assert.deepEqual(JSON.parse(JSON.stringify(await native.open())), recovered);
  assert.equal(h.calls.filter(call => call.channel === "drafts:open").length, 2);
  assert.equal(native.saveBeforeClose(snapshot), null);
});

test("read-only preload exposes saved originals without granting an editing session", async () => {
  const result = { readOnly: true, drafts: { ...snapshot, projects: [{ key: "draft:0:p", projectId: "p", text: "  raw draft  ", attachments: [] }] },
    pendingIds: [], pending: [{ id: "original", rawText: "  raw original  ", files: [] }],
    recovery: { outcome: "recovery", message: "Services have stopped." }, session: "must-not-grant-authority" };
  const h = preload("darwin", result), native = h.bridge.nativeDrafts;
  const opened = await native.open();
  const { session: _private, ...expected } = result;
  assert.deepEqual(JSON.parse(JSON.stringify(opened)), expected);
  assert.equal(native.saveBeforeClose(snapshot), null);
  for (const edit of [() => native.save(snapshot), () => native.create("original"), () => native.send("original"),
    () => native.begin({}), () => native.stage({}, []), () => native.pick({}, 1), () => native.discard({}, []),
    () => native.retire({}), () => native.transfer({}), () => native.readPending("original")]) {
    await assert.rejects(edit, /before editing/);
  }
  assert.deepEqual(h.calls.map(call => call.channel), ["drafts:open"]);
});

test("native preload opens once and keeps its document session private", async () => {
  const h = preload();
  assert.ok(h.bridge.nativeDrafts, "explicit native draft capability is required");
  const [a, b] = await Promise.all([h.bridge.nativeDrafts.open(), h.bridge.nativeDrafts.open()]);
  assert.equal(a.session, undefined); assert.deepEqual(JSON.parse(JSON.stringify(a)), { drafts: null, pendingIds: ["original-intent"] });
  assert.deepEqual(a, b); assert.equal(h.calls.length, 1);
});

test("unknown or malformed native open replies never grant editing authority", async () => {
  for (const result of [
    { readOnly: "true", session: "stray", drafts: null, pendingIds: [] },
    { readOnly: true, session: "stray", drafts: null, pendingIds: [], pending: [] },
    { session: "", drafts: null, pendingIds: [] },
    { session: "stray", drafts: null, pendingIds: [], recovery: { outcome: "recovery", message: "Restricted" } },
  ]) {
    const h = preload("darwin", result);
    await assert.rejects(() => h.bridge.nativeDrafts.open(), /recovery/i);
    await assert.rejects(() => h.bridge.nativeDrafts.save(snapshot), /before editing/);
    assert.equal(h.bridge.nativeDrafts.saveBeforeClose(snapshot), null);
    assert.deepEqual(h.calls.map(call => call.channel), ["drafts:open"]);
  }
});

test("native saves, transfer and close-save share one preload-owned monotonically increasing sequence", async () => {
  const h = preload(), native = h.bridge.nativeDrafts;
  assert.ok(native); await native.open();
  h.replies.set("drafts:save", { saved: false, revision: 8 });
  assert.deepEqual(await native.save(snapshot), { saved: false, revision: 8 });
  h.replies.set("drafts:transfer", { status: "committed", revision: 9, files: [] });
  await native.transfer({ id: "one", intentId: "original-intent", snapshot, files: [] });
  h.replies.set("drafts:close-save", { saved: true, revision: 10 });
  assert.equal(native.saveBeforeClose(snapshot), 10);
  assert.deepEqual(h.calls.slice(1).map(call => [call.channel, call.payload.session, call.payload.sequence]), [
    ["drafts:save", "main-only-session", 1], ["drafts:transfer", "main-only-session", 2], ["drafts:close-save", "main-only-session", 3],
  ]);
});

test("native preload never acknowledges an unsaved close or starts a restored pending message", async () => {
  const h = preload(), native = h.bridge.nativeDrafts;
  assert.ok(native); assert.equal(native.saveBeforeClose(snapshot), null); assert.equal(h.calls.length, 0);
  await native.open();
  h.replies.set("drafts:close-save", { saved: false, revision: 5 });
  assert.equal(native.saveBeforeClose(snapshot), null);
  assert.deepEqual(h.calls.map(call => call.channel), ["drafts:open", "drafts:close-save"]);
  await native.readPending("original-intent");
  assert.equal(h.calls.at(-1)!.channel, "drafts:pending");
  assert.equal(h.calls.at(-1)!.payload.session, "main-only-session");
  assert.equal(h.calls.some(call => call.channel === "drafts:create" || call.channel === "drafts:send"), false);
});

test("Windows keeps the ordinary preload bridge without native durability capability", () => {
  const h = preload("win32");
  assert.equal(h.bridge.nativeDrafts, undefined); assert.equal(typeof h.bridge.invoke, "function");
  assert.equal(typeof h.bridge.pathForFile, "function");
});
