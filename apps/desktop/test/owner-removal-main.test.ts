import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { test } from "node:test";
import { OwnerRemoval } from "../src/main/engine/owner-removal.js";
import { Store } from "../src/main/engine/store.js";
import { ThreadRunner } from "../src/main/engine/runner.js";
import { Router } from "../src/main/engine/routing/router.js";
import { gitRepo, tmpdir } from "./helpers.js";
import { RestartAdmission } from "../src/main/engine/restart-admission.js";

function fixture() {
  const code = fs.readFileSync(path.resolve(import.meta.dirname, "../src/main/index.js"), "utf8");
  const start = code.indexOf("const ownerRemoval ="), end = code.indexOf("function invalidateNativeDocument(", start);
  assert.ok(start >= 0 && end > start, "main must install the owner-removal transaction");
  const messages: { channel: string; request: any }[] = [], handlers = new Map<string, Function>(), events: string[] = [], frame = {};
  const admission = new RestartAdmission();
  const context: any = { media: undefined, mediaInitializationError: undefined, OwnerRemoval, restartAdmission: admission, nativeDocument: { frame, epoch: 1, session: "session" }, documentEpoch: 1,
    nativeDraftFailure: undefined, nativeDrafts: { requiresRecovery: false,
      holdForOwnerRemoval: () => { events.push("native-hold"); return () => { events.push("native-release"); }; },
      pruneEmptyOwner: () => { events.push("prune"); return { revision: 4, drafts: { threads: [], projects: [], selectedThreadId: null, draft: null } }; } },
    runner: { holdForOwnerRemoval: () => { events.push("runner-hold"); return () => { events.push("runner-release"); }; } },
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
  vm.runInContext('handle("thread:delete", () => withOwnerRemoval({ kind: "thread", id: "t" }, remove)); handle("space:save", () => "saved"); handle("settings:update", () => "mutated"); handle("thread:stop", () => "stopped");', context);
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

for (const kind of ["thread", "project"] as const) test(`actual main ${kind} removal stops its active turn while another turn continues`, async () => {
  const h = fixture(), home = tmpdir("owner-removal-"), repo = gitRepo();
  const store = new Store(home);
  store.updateSettings({ default_backend: "mock" });
  const project = store.addProject(repo);
  const signals = new Map<string, AbortSignal>();
  const runner = new ThreadRunner({ home, store, emit: () => {},
    withOwnerRemoval: (scope, operation) => h.owner.run(scope, operation),
    router: new Router({ home, policy: () => store.settings.routing, listModels: async () => ({ models: [] }), transport: null }),
    backends: { mock: { id: "mock", listModels: async () => [], dispose: async () => {},
      runTurn: async (text, _opts, _sink, signal) => {
        signals.set(text, signal);
        await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
        return { status: "interrupted" };
      },
    } },
  });
  h.context.runner = runner;
  const target = await runner.createThread(project.id);
  const otherProject = store.addProject(tmpdir("owner-removal-other-"));
  const other = await runner.createThread(otherProject.id);
  const runs = [runner.send(target.id, "target"), runner.send(other.id, "other")];
  try {
    while (signals.size < 2) await h.tick();
    assert.throws(() => runner.holdForRestart(), /finish/i);
    h.context.remove = () => kind === "thread" ? runner.deleteThread(target.id) : runner.removeProject(project.id);
    // Enter through the runner, whose callback uses the actual main transaction holds.
    const deletion = h.context.remove(); void deletion.catch(() => {});
    await h.tick();
    assert.equal(h.owner.active, true, "deletion must reach renderer draft preparation while turns are active");
    await assert.rejects(runner.send(other.id, "late"), /restart|remov/i);
    h.reply("prepare", 3); await h.tick();
    assert.equal(signals.get("target")!.aborted, true);
    assert.equal(signals.get("other")!.aborted, false);
    h.reply("adopt", 4); await deletion;
    assert.equal(store.thread(target.id), undefined);
    assert.ok(store.thread(other.id));
    assert.equal(h.admission.held, false);
    assert.throws(() => runner.holdForRestart(), /finish/i);
  } finally {
    runner.stop(target.id); runner.stop(other.id);
    await Promise.all(runs); await runner.dispose();
    for (const dir of [home, repo, otherProject.path]) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("actual main keeps Stop available during owner removal but blocks it during restart", async () => {
  const h = fixture(), removal = h.invoke("thread:delete"); void removal.catch(() => {});
  try {
    assert.equal(await h.invoke("thread:stop"), "stopped");
  } finally {
    h.reply("prepare", 3); await h.tick(); h.reply("adopt", 4); await removal;
  }
  const release = h.admission.holdForRestart();
  try { await assert.rejects(h.invoke("thread:stop"), /restart/i); }
  finally { release(); }
});

test("main deletion waits for already-admitted requests before asking to freeze drafts", async () => {
  const h = fixture();
  let finish!: () => void;
  const running = h.admission.run(() => new Promise<void>(resolve => { finish = resolve; }));
  const deletion = h.invoke("thread:delete");
  assert.equal(h.owner.active, true);
  assert.equal(h.admission.held, true);
  assert.equal(h.messages.length, 0);
  finish(); await running; await h.tick();
  h.reply("prepare", 3); await h.tick(); h.reply("adopt", 4); await deletion;
  assert.equal(h.admission.held, false);
  assert.ok(h.events.includes("remove"));
});

test("main deletion refuses a replaced renderer while draining requests", async () => {
  const h = fixture();
  let finish!: () => void;
  const running = h.admission.run(() => new Promise<void>(resolve => { finish = resolve; }));
  const deletion = h.invoke("thread:delete");
  h.context.nativeDocument = { frame: {}, epoch: 2, session: "replacement" };
  finish(); await running;
  await assert.rejects(deletion, /workspace changed/);
  assert.equal(h.admission.held, false);
  assert.equal(h.events.includes("remove"), false);
});
