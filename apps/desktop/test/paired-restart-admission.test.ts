import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { test } from "node:test";
import { RestartAdmission } from "../src/main/engine/restart-admission.js";
import { DocumentRestartPreflight, type RestartRequest } from "../src/main/engine/update-renderer-preflight.js";

/** Execute the actual compiled Electron dispatch functions without opening a
 * window. The operation is a stub; admission and authorization are real. */
function dispatcher(pathReady: Promise<void>) {
  const code = fs.readFileSync(path.resolve(import.meta.dirname, "../src/main/index.js"), "utf8");
  const start = code.indexOf("function handle("), end = code.indexOf("\nfunction nativeFor", start);
  const hostStart = code.indexOf("invoke: async (channel, payload, authorized) => {");
  const hostEnd = code.indexOf("\n            },", hostStart);
  assert.ok(start >= 0 && end > start && hostStart >= 0 && hostEnd > hostStart);
  const host = code.slice(hostStart + "invoke: ".length, hostEnd) + "\n}";
  const handlers = new Map<string, Function>(), nativeDocument = { frame: {}, epoch: 1, session: "native" };
  const context: any = { restartAdmission: new RestartAdmission(), RESTART_CONTROL: new Set(["state:get"]), desktopCommands: new Map(),
    OWNER_REMOVAL_CONTROL: new Set(["thread:delete", "project:remove"]), ownerRemoval: { allowsPersistence: () => false },
    SPAWNS: new Set(["thread:create"]), pathReady, documentEpoch: 1, shuttingDown: false, nativeDraftFailure: undefined,
    nativeStartup: undefined, ipcMain: { handle: (name: string, fn: Function) => handlers.set(name, fn) }, isTrustedTerminalSender: () => true, win: {},
    nativeDocument, rendererPreflight: { allowsPersistence: (document: unknown) => document === nativeDocument },
    recoveryQuitPreflight: { allowsPersistence: () => false }, handlers };
  vm.createContext(context);
  context.currentDraftRecovery = () => context.nativeStartup?.recovery ?? null;
  vm.runInContext(code.slice(start, end) + `\nglobalThis.hostInvoke = (${host}); globalThis.register = handle;`, context);
  return context;
}

test("paired request owns restart admission before waiting for PATH", async () => {
  let ready!: () => void;
  const h = dispatcher(new Promise<void>(resolve => { ready = resolve; }));
  let executions = 0;
  h.register("thread:create", () => { executions++; });
  const pending = h.hostInvoke("thread:create", {}, () => true);
  void pending.catch(() => {}); // A failing RED assertion still observes the outstanding request.
  try { assert.throws(() => h.restartAdmission.holdForRestart(), /finish/); }
  finally { ready(); }
  await pending; assert.equal(executions, 1);
  h.restartAdmission.holdForRestart()();
});

test("only the current native preparation can save a page while normal main admission is held", async () => {
  const h = dispatcher(Promise.resolve()); let writes = 0;
  h.register("space:save", () => ++writes);
  const release = h.restartAdmission.holdForRestart();
  try {
    await assert.rejects(h.hostInvoke("space:save", {}, () => true), /restart/);
    await assert.rejects(h.handlers.get("space:save")({ senderFrame: {} }, {}), /restart|stale/);
    await h.handlers.get("space:save")({ senderFrame: h.nativeDocument.frame }, {});
    assert.equal(writes, 1);
    h.rendererPreflight.allowsPersistence = () => false;
    await assert.rejects(h.handlers.get("space:save")({ senderFrame: h.nativeDocument.frame }, {}), /restart/);
  } finally { release(); }
});

test("paired access revoked while PATH yields cannot execute the handler", async () => {
  const h = dispatcher(Promise.resolve());
  let authorized = true, checks = 0, executions = 0;
  h.register("thread:create", () => { executions++; });
  await assert.rejects(h.hostInvoke("thread:create", {}, () => {
    checks++; queueMicrotask(() => { authorized = false; }); return authorized;
  }), /access|authorization|unavailable/i);
  assert.equal(executions, 0); assert.ok(checks >= 2);
  h.restartAdmission.holdForRestart()();
});

test("only the pending fresh recovery Quit flush may persist a local page after service disposal", async () => {
  const h = dispatcher(Promise.resolve()), requests: RestartRequest[] = []; let writes = 0;
  h.currentDraftRecovery = () => ({ message: "Recovery required" });
  h.rendererPreflight.allowsPersistence = () => false;
  h.recoveryQuitPreflight = new DocumentRestartPreflight(() => h.nativeDocument, (_document, request) => requests.push(request));
  h.register("space:save", () => ++writes);
  const release = h.restartAdmission.holdForRestart(), pending = h.recoveryQuitPreflight.prepare(); void pending.catch(() => {});
  try {
    await assert.rejects(h.hostInvoke("space:save", {}, () => true), /recovery|restart/i);
    await h.handlers.get("space:save")({ senderFrame: h.nativeDocument.frame }, {}); assert.equal(writes, 1);
    h.recoveryQuitPreflight.reply(h.nativeDocument, { id: requests[0]!.id, revision: 4 }); await pending;
    await assert.rejects(h.handlers.get("space:save")({ senderFrame: h.nativeDocument.frame }, {}), /recovery|restart/i);
    assert.equal(writes, 1);
  } finally { h.recoveryQuitPreflight.release(); release(); }
});

for (const command of ["create", "send"] as const) test(`Companion ${command} waiting for PATH refuses ordinary Quit recovery`, async () => {
  const source = fs.readFileSync(path.resolve(import.meta.dirname, "../src/main/index.js"), "utf8");
  const start = source.indexOf("const companion = new CompanionServer("), end = source.indexOf("const companionView", start);
  assert.ok(start >= 0 && end > start);
  let finish!: () => void, touched = false, calls = 0, callbacks: any;
  const context: any = { home: "/fixture", restartAdmission: new RestartAdmission(), nativeDraftFailure: undefined, nativeStartup: undefined,
    currentDraftRecovery: () => touched ? { outcome: "recovery", message: "Services stopped" } : null,
    pathReady: new Promise<void>(resolve => { finish = resolve; }),
    CompanionServer: class { constructor(_home: string, options: unknown) { callbacks = options; } },
    runner: { createThread: () => { calls++; }, send: () => { calls++; } }, startTurn: () => {} };
  vm.runInNewContext(source.slice(start, end), context);
  const waiting = callbacks[command]("p", "message"); void waiting.catch(() => {});
  touched = true; finish(); await assert.rejects(waiting, /recovery/i); assert.equal(calls, 0);
});
