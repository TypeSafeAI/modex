import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { test } from "node:test";
import { OwnerRemoval } from "../src/main/engine/owner-removal.js";
import { RestartAdmission } from "../src/main/engine/restart-admission.js";

function fixture() {
  const code = fs.readFileSync(path.resolve(import.meta.dirname, "../src/main/index.js"), "utf8");
  const start = code.indexOf("const ownerRemoval ="), end = code.indexOf("function invalidateNativeDocument(", start);
  assert.ok(start >= 0 && end > start, "main must install the owner-removal transaction");
  const messages: { channel: string; request: any }[] = [], handlers = new Map<string, Function>(), events: string[] = [], frame = {};
  const admission = new RestartAdmission();
  const context: any = { OwnerRemoval, restartAdmission: admission, nativeDocument: { frame, epoch: 1, session: "session" }, documentEpoch: 1,
    nativeDraftFailure: undefined, nativeDrafts: { requiresRecovery: false,
      holdForOwnerRemoval: () => { events.push("native-hold"); return () => { events.push("native-release"); }; },
      pruneEmptyOwner: () => { events.push("prune"); return { revision: 4, drafts: { threads: [], projects: [], selectedThreadId: null, draft: null } }; } },
    runner: { holdForRestart: () => { events.push("runner-hold"); return () => { events.push("runner-release"); }; } },
    store: { snapshot: () => ({ threads: [], projects: [] }) },
    win: { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: (channel: string, request: any) => { messages.push({ channel, request }); } } },
    currentDraftRecovery: () => context.nativeDraftFailure ? { message: context.nativeDraftFailure } : null,
    isTrustedTerminalSender: () => true, shuttingDown: false,
    rendererPreflight: { allowsPersistence: () => false }, recoveryQuitPreflight: { allowsPersistence: () => false },
    desktopCommands: new Map(), SPAWNS: new Set(), ipcMain: { handle: (channel: string, fn: Function) => handlers.set(channel, fn) },
  };
  vm.createContext(context); vm.runInContext(code.slice(start, end), context);
  const dispatchStart = code.indexOf("const RESTART_CONTROL ="), dispatchEnd = code.indexOf("function nativeFor(", dispatchStart);
  vm.runInContext(code.slice(dispatchStart, dispatchEnd), context);
  context.remove = async () => { events.push("remove"); };
  vm.runInContext('handle("thread:delete", () => withOwnerRemoval({ kind: "thread", id: "t" }, remove)); handle("space:save", () => "saved"); handle("settings:update", () => "mutated");', context);
  const owner = vm.runInContext("ownerRemoval", context) as OwnerRemoval<object, unknown>;
  const invoke = (channel: string) => handlers.get(channel)!({ senderFrame: frame }, {});
  const reply = (phase: "prepare" | "adopt", revision: number) => {
    const request = messages.find(row => row.channel === (phase === "prepare" ? "drafts:remove-prepare" : "drafts:remove-adopt"))!.request;
    owner.reply(context.nativeDocument, { phase, id: request.id, revision });
  };
  const tick = () => new Promise<void>(resolve => setImmediate(resolve));
  return { context, owner, invoke, reply, tick, messages, events, admission };
}

test("actual main deletion dispatch avoids self-counting and allows only exact-document preparation saves", async () => {
  const h = fixture(), result = h.invoke("thread:delete"); void result.catch(() => {});
  assert.equal(h.admission.held, true); assert.equal(h.owner.active, true);
  assert.equal(await h.invoke("space:save"), "saved");
  await assert.rejects(h.invoke("settings:update"), /restart/i);
  h.reply("prepare", 3); await h.tick();
  await assert.rejects(h.invoke("space:save"), /restart/i);
  h.reply("adopt", 4); await result;
  assert.equal(h.admission.held, false);
  assert.deepEqual(h.events, ["runner-hold", "native-hold", "prune", "remove", "native-release", "runner-release"]);
});

test("actual main uncertain deletion enters recovery and sends the renderer a read-only transition", async () => {
  const h = fixture();
  h.context.nativeDrafts.pruneEmptyOwner = () => { h.context.nativeDrafts.requiresRecovery = true; throw new Error("lost write acknowledgment"); };
  const result = h.invoke("thread:delete"); void result.catch(() => {}); h.reply("prepare", 3);
  await assert.rejects(result, /lost write/);
  assert.match(h.context.nativeDraftFailure, /lost write/); assert.equal(h.admission.held, true);
  assert.ok(h.messages.some(row => row.channel === "drafts:remove-recovery"));
  assert.equal(h.events.includes("remove"), false);
});

test("actual main without a native draft document refuses removal instead of trusting an old disk snapshot", async () => {
  const h = fixture(); h.context.nativeDocument = undefined;
  await assert.rejects(h.invoke("thread:delete"), /workspace/i);
  assert.deepEqual(h.events, []); assert.equal(h.admission.held, false);
});
