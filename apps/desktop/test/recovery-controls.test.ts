import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { test, type TestContext } from "node:test";
import { DocumentRestartPreflight, type RestartRequest } from "../src/main/engine/update-renderer-preflight.js";
import { UpdateRecovery } from "../src/main/engine/update-recovery.js";

function controls() {
  const code = fs.readFileSync(path.resolve(import.meta.dirname, "../src/main/index.js"), "utf8");
  const start = code.indexOf("function requireReadOnlyRecoveryDocument("), end = code.indexOf('handle("space:export",', start);
  assert.ok(start >= 0 && end > start, "main must bind recovery controls to a read-only document");
  const handlers = new Map<string, Function>(), frame = {}, calls: string[] = [], requests: RestartRequest[] = [];
  const context: any = { readOnlyDocument: { frame, epoch: 3 }, nativeDocument: undefined, documentEpoch: 3,
    recoveryQuitOperation: undefined, restartCoordinator: undefined, nativeDrafts: undefined, nativeDraftFailure: undefined,
    currentDraftRecovery: () => ({ outcome: "recovery" }), isTrustedTerminalSender: () => true, win: {},
    app: { quit: () => calls.push("quit") }, shell: { openPath: async (value: string) => { calls.push(value); return ""; } },
    store: { dir: "/fixed/main/recovery" }, setImmediate: (fn: Function) => fn(), updates: { check: () => null },
    handle: (name: string, fn: Function, options: any) => { if (name !== "updates:check") assert.equal(options?.localOnly, true); handlers.set(name, fn); } };
  context.recoveryQuitPreflight = new DocumentRestartPreflight(() => context.nativeDocument, (_document, request) => requests.push(request), 1000);
  vm.runInNewContext(code.slice(start, end), context);
  return { context, calls, requests, editable: (t: TestContext, outcome: "uncertain" | "staged" = "uncertain") => {
    context.readOnlyDocument = undefined; context.nativeDocument = { frame, epoch: 3, session: "main-owned" };
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "modex-recovery-quit-")); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const recovery = new UpdateRecovery(home), revision = recovery.saveDrafts({ threads: [], projects: [], draft: null, selectedThreadId: null });
    const id = recovery.beginAttempt({ from: "0.0.10", to: "0.0.11", sha512: Buffer.alloc(64, 1).toString("base64"), revision });
    if (outcome === "staged") recovery.recordOutcome(id, "staged");
    context.nativeDrafts = { recovery }; return { recovery, revision, file: path.join(home, "update-recovery.json") };
  }, invoke: (channel: string, event: unknown = { senderFrame: frame }) => handlers.get(channel)!(undefined, event) };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

for (const state of ["preparing", "draining", "staging"]) for (const editable of [false, true]) test(`recovery Quit refuses ${state} in ${editable ? "the held" : "a replacement"} document`, async t => {
  const h = controls(); if (editable) h.editable(t);
  h.context.restartCoordinator = { state };
  t.after(() => h.context.recoveryQuitPreflight.release());
  const pending = Promise.resolve().then(() => h.invoke("updates:quit")); void pending.catch(() => {});
  await tick();
  if (h.requests.length) h.context.recoveryQuitPreflight.reply(h.context.nativeDocument, { id: h.requests[0]!.id, revision: 1 });
  await assert.rejects(pending, /still preparing/i);
  assert.deepEqual(h.requests, []); assert.deepEqual(h.calls, []);
});

test("navigation before deferred recovery Quit cannot prepare the replacement document", async t => {
  const h = controls(); h.editable(t); t.after(() => h.context.recoveryQuitPreflight.release());
  const pending = h.invoke("updates:quit");
  h.context.recoveryQuitOperation = undefined;
  h.context.recoveryQuitPreflight.invalidate();
  h.context.nativeDocument = { frame: {}, epoch: 4, session: "replacement" }; h.context.documentEpoch = 4;
  await assert.rejects(pending, /changed/);
  assert.deepEqual(h.requests, [], "old requests must never freeze a replacement document");
  assert.deepEqual(h.calls, []);
});

for (const outcome of ["uncertain", "staged"] as const) test(`main coalesces recovery Quit and validates the real ${outcome} receipt without rewriting it`, async t => {
  const h = controls(), saved = h.editable(t, outcome), before = fs.readFileSync(saved.file); t.after(() => h.context.recoveryQuitPreflight.release());
  const first = Promise.resolve().then(() => h.invoke("updates:quit")), second = Promise.resolve().then(() => h.invoke("updates:quit"));
  void first.catch(() => {}); void second.catch(() => {}); await tick();
  assert.equal(h.requests.length, 1, "one fresh main-owned preparation"); assert.deepEqual(h.calls, []);
  h.context.recoveryQuitPreflight.reply(h.context.nativeDocument, { id: h.requests[0]!.id, revision: saved.revision });
  await Promise.all([first, second]); assert.deepEqual(h.calls, ["quit"]);
  await h.invoke("updates:quit"); assert.deepEqual(h.calls, ["quit"]); assert.deepEqual(fs.readFileSync(saved.file), before);
});

for (const failure of ["revoked", "receipt", "navigation"] as const) test(`main refuses ${failure} recovery Quit without releasing editing holds`, async t => {
  const h = controls(), saved = h.editable(t); t.after(() => h.context.recoveryQuitPreflight.release());
  const pending = Promise.resolve().then(() => h.invoke("updates:quit")); void pending.catch(() => {}); await tick();
  assert.equal(h.requests.length, 1, "recovery Quit must request its own proof");
  if (failure === "receipt") fs.writeFileSync(saved.file, JSON.stringify({ ...saved.recovery.read(), revision: saved.revision + 1 }));
  if (failure === "navigation") {
    h.context.nativeDocument = { frame: {}, epoch: 4, session: "replacement" }; h.context.documentEpoch = 4;
    h.context.recoveryQuitPreflight.invalidate();
  } else {
    h.context.recoveryQuitPreflight.reply(h.context.nativeDocument, { id: h.requests[0]!.id, revision: saved.revision });
    if (failure === "revoked") h.context.recoveryQuitPreflight.reply(h.context.nativeDocument, { id: h.requests[0]!.id, error: "Editor changed" });
  }
  await assert.rejects(pending, /changed|ready|recovery/i); assert.equal(h.calls.includes("quit"), false);
  assert.equal(h.context.recoveryQuitOperation, undefined);
});

test("recovery controls allow ordinary Quit and only the fixed recovery directory", async () => {
  const h = controls();
  await h.invoke("updates:recovery-folder"); await h.invoke("updates:quit");
  assert.deepEqual(h.calls, ["/fixed/main/recovery", "quit"]);
});

test("recovery controls refuse stale, paired and editable documents", async () => {
  for (const change of [(h: any) => { h.context.documentEpoch++; }, (h: any) => { h.context.nativeDocument = {}; },
    (h: any) => { h.context.currentDraftRecovery = () => null; }, (h: any) => { h.context.isTrustedTerminalSender = () => false; }]) {
    const h = controls(); change(h);
    for (const channel of ["updates:quit", "updates:recovery-folder"]) await assert.rejects(async () => h.invoke(channel), /recovery/i);
    assert.deepEqual(h.calls, []);
  }
  const h = controls();
  await assert.rejects(async () => h.invoke("updates:quit", {}), /recovery/i);
  await assert.rejects(async () => h.invoke("updates:quit", null), /recovery/i);
  assert.deepEqual(h.calls, []);
});

test("recovery folder launch failures reach the renderer", async () => {
  const h = controls(); h.context.shell.openPath = async () => "Open failed";
  await assert.rejects(async () => h.invoke("updates:recovery-folder"), /Open failed/);
});

for (const state of ["preparing", "draining", "staging"]) test(`ordinary Quit cannot interrupt ${state}`, () => {
  const code = fs.readFileSync(path.resolve(import.meta.dirname, "../src/main/index.js"), "utf8");
  const start = code.indexOf('app.on("before-quit",'), end = code.indexOf("async function capture(", start);
  let callback!: (event: { preventDefault(): void }) => void, closes = 0, prevented = false;
  const context = { app: { on: (_name: string, fn: typeof callback) => { callback = fn; } }, shutdownComplete: false,
    shuttingDown: false, checkingWindowClose: false, restartCoordinator: { state }, releaseRecoveryQuit: () => {},
    win: { isDestroyed: () => false, once: () => {}, webContents: { once: () => {} }, close: () => { closes++; } } };
  vm.runInNewContext(code.slice(start, end), context);
  callback({ preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true); assert.equal(closes, 0);
});

test("local updater controls dispatch only main-owned actions and fixed state", async () => {
  const h = controls(), state = { phase: "ready", release: null };
  h.context.automaticUpdates = true;
  h.context.updateState = () => state;
  h.context.updateInstallation = { state: () => state, check: async () => ({ ...state, release: { version: "0.0.11" } }),
    download: async () => { h.calls.push("download"); return state; }, cancel: () => { h.calls.push("cancel"); },
    install: async () => { h.calls.push("install"); return state; } };
  assert.equal(await h.invoke("updates:state"), state);
  assert.equal(await h.invoke("updates:download"), state);
  await h.invoke("updates:cancel"); assert.equal(await h.invoke("updates:install"), state);
  assert.equal((await h.invoke("updates:check")).version, "0.0.11");
  assert.deepEqual(h.calls, ["download", "cancel", "install"]);
});

test("a platform without native drafts binds recovery controls through its trusted state read", async () => {
  const h = controls(); h.context.readOnlyDocument = undefined;
  h.context.updateState = () => ({ phase: "recovery", canRestart: false });
  await assert.rejects(async () => h.invoke("updates:quit"), /recovery/);
  await h.invoke("updates:state"); await h.invoke("updates:recovery-folder"); await h.invoke("updates:quit");
  assert.deepEqual(h.calls, ["/fixed/main/recovery", "quit"]);
  h.context.documentEpoch++; await assert.rejects(async () => h.invoke("updates:quit"), /recovery/);
});

for (const change of ["healthy", "untrusted", "native", "unreadable"]) test(`state read cannot grant recovery controls for ${change}`, async () => {
  const h = controls(); h.context.readOnlyDocument = undefined;
  h.context.updateState = () => ({ phase: "recovery", canRestart: false });
  if (change === "healthy") h.context.currentDraftRecovery = () => null;
  if (change === "untrusted") h.context.isTrustedTerminalSender = () => false;
  if (change === "native") h.context.nativeDrafts = {};
  if (change === "unreadable") h.context.nativeDraftFailure = "unreadable originals";
  await h.invoke("updates:state");
  assert.equal(h.context.readOnlyDocument, undefined); assert.deepEqual(h.calls, []);
});

test("ordinary Quit awaits updater cleanup after service drain", async () => {
  const code = fs.readFileSync(path.resolve(import.meta.dirname, "../src/main/index.js"), "utf8");
  const start = code.indexOf('app.on("before-quit",'), end = code.indexOf("async function capture(", start);
  let callback!: (event: { preventDefault(): void }) => void, finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; }), calls: string[] = [];
  const context: any = { app: { on: (_name: string, fn: typeof callback) => { callback = fn; }, quit: () => calls.push("quit") },
    shutdownComplete: false, shuttingDown: false, checkingWindowClose: false, restartCoordinator: { state: "staged" }, win: null,
    drainServices: async () => { calls.push("drain"); }, updateInstallation: { dispose: () => { calls.push("dispose-update"); return pending; } },
    dialog: { showErrorBox: () => assert.fail("cleanup failed") }, console };
  vm.runInNewContext(code.slice(start, end), context);
  callback({ preventDefault() {} }); await tick();
  try { assert.deepEqual(calls, ["drain", "dispose-update"]); assert.equal(context.shutdownComplete, false); }
  finally { finish(); await tick(); }
  assert.deepEqual(calls, ["drain", "dispose-update", "quit"]); assert.equal(context.shutdownComplete, true);
});

for (const synchronous of [false, true]) test(`ordinary Quit still cleans the updater after ${synchronous ? "synchronous" : "asynchronous"} service failure`, async () => {
  const code = fs.readFileSync(path.resolve(import.meta.dirname, "../src/main/index.js"), "utf8");
  const start = code.indexOf('app.on("before-quit",'), end = code.indexOf("async function capture(", start);
  let callback!: (event: { preventDefault(): void }) => void, finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; }), calls: string[] = [], failure = new Error("partial service disposal");
  const context: any = { app: { on: (_name: string, fn: typeof callback) => { callback = fn; }, quit: () => calls.push("quit") },
    shutdownComplete: false, shuttingDown: false, checkingWindowClose: false, restartCoordinator: undefined, win: null,
    drainServices: () => { calls.push("drain"); if (synchronous) throw failure; return Promise.reject(failure); },
    updateInstallation: { dispose: () => { calls.push("dispose-update"); return pending; } },
    dialog: { showErrorBox: () => calls.push("error") }, console: { error: (_message: unknown, error: unknown) => assert.equal(error, failure) } };
  vm.runInNewContext(code.slice(start, end), context);
  try {
    callback({ preventDefault() {} }); await tick();
    assert.deepEqual(calls, ["drain", "dispose-update"]); assert.equal(context.shuttingDown, true);
  } finally { finish(); await tick(); }
  assert.deepEqual(calls, ["drain", "dispose-update", "error"]);
  assert.equal(context.shuttingDown, false); assert.equal(context.shutdownComplete, false);
});
