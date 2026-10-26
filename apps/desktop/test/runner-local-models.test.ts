import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/main/engine/store.js";
import { ThreadRunner, type RunnerOptions } from "../src/main/engine/runner.js";
import { SecretStore, testCipher } from "../src/main/engine/secrets.js";
import { LocalConnectionStore } from "../src/main/engine/local-models/connections.js";
import { LocalExecution } from "../src/main/engine/local-models/execution.js";
import type { Backend, TurnOptions, TurnSink } from "../src/main/engine/backends/types.js";
import { gitRepo, tmpdir } from "./helpers.js";

const MODEL = "qwen3.8-flash-next-iq3_s";

/** A runner whose cloud Codex and local execution are both counters: the test asserts which one a turn reached. */
async function setup(localResult: () => Promise<{ status: "completed" | "failed"; error?: string }> = async () => ({ status: "completed" })) {
  const home = tmpdir("lm3-runner-");
  const store = new Store(home);
  const connections = new LocalConnectionStore(home, new SecretStore(home, testCipher));
  const connection = connections.create({ label: "Local", runtime: "responses", url: "http://127.0.0.1:18501" });
  const local = new LocalExecution(home, connections);
  const counts = { cloud: 0, local: 0, titles: 0, adapters: 0, forgotten: 0, localForceStops: 0, cloudForceStops: 0 };
  const turns: TurnOptions[] = [];
  let release: (() => void) | undefined;
  const cloud: Backend = { id: "codex", identity: () => "chatgpt-1", listModels: async () => [], dispose: async () => {}, forceStop: async () => { counts.cloudForceStops++; },
    runTurn: async () => { counts.cloud++; return { status: "completed" }; }, generateTitle: async () => { counts.titles++; return "cloud title"; } };
  mock.method(local, "backend", () => ({ ...cloud, identity: undefined, generateTitle: undefined, forceStop: async () => { counts.localForceStops++; },
    runTurn: async (_text: string, opts: TurnOptions, sink: TurnSink) => {
      counts.local++; turns.push(opts); sink.session("native-1"); sink.observe({ type: "message.done", native: { runtime: "r", thread: "native-1", item: "m1" }, text: "local reply", phase: "final" });
      if (release) await new Promise<void>(resolve => { release = resolve; });
      return localResult();
    } }));
  mock.method(local, "forget", async () => { counts.forgotten++; });
  const options = { home, store, emit: () => {}, backends: { codex: cloud }, localExecution: local,
    knowledge: { prepare: async () => { counts.adapters++; throw new Error("must not prepare external tools"); } },
    pages: { prepare: async () => { counts.adapters++; throw new Error("must not prepare external tools"); } },
  };
  const runner = new ThreadRunner(options as unknown as RunnerOptions);
  const thread = await runner.createThread(store.addProject(gitRepo()).id, { backend: "codex", model: "gpt-6-astra", auto: true });
  const target = { schema: 1 as const, harness: "codex" as const, model: { schema: 1 as const, connection: { id: connection.id, revision: 1 }, id: MODEL } };
  const select = () => runner.updateThread(thread.id, { localTarget: target, localContextTokens: 32768 });
  const hold = () => { release = () => {}; };
  return { store, connections, connection, runner, thread, target, select, turns, counts, hold, release: () => release?.() };
}

test("selecting a local target pins the thread and its turns run on local execution without any cloud call", async () => {
  const h = await setup();
  try {
    const selected = h.select();
    assert.deepEqual(selected.localTarget, h.target);
    assert.equal(selected.model, MODEL);
    assert.equal(selected.backend, "codex");
    assert.equal(selected.auto, false);
    assert.equal(selected.plan, false);
    assert.equal(selected.effort, undefined);
    assert.equal(h.counts.forgotten, 1, "selection starts a fresh native conversation");
    await h.runner.send(h.thread.id, "read the fixture");
    assert.deepEqual({ cloud: h.counts.cloud, local: h.counts.local, titles: h.counts.titles, adapters: h.counts.adapters }, { cloud: 0, local: 1, titles: 0, adapters: 0 });
    assert.equal(h.turns[0]?.account, undefined);
    assert.equal(h.turns[0]?.model, MODEL);
    assert.equal(h.turns[0]?.knowledge, undefined);
    assert.equal(h.turns[0]?.pages, undefined);
    const after = h.store.thread(h.thread.id)!;
    assert.equal(after.sessionHandle, "native-1");
    assert.equal(after.codexAccount, undefined, "a local turn binds no account");
    assert.equal(after.status, "idle");
    assert.equal(await h.runner.followUp(h.thread.id), null);
    assert.throws(() => h.runner.updateThread(h.thread.id, { auto: true }), /Local threads run without Auto/);
    assert.throws(() => h.runner.updateThread(h.thread.id, { plan: true }), /Local threads run without Auto/);
    assert.throws(() => h.runner.updateThread(h.thread.id, { model: "gpt-6-astra" }), /different local target/);
    assert.throws(() => h.runner.updateThread(h.thread.id, { backend: "claude" }), /different local target/);
    h.runner.updateThread(h.thread.id, { mode: "chat", approvals: "yolo", title: "renamed" });
    assert.equal(h.store.thread(h.thread.id)!.title, "renamed");
  } finally { await h.runner.dispose(); }
});

test("a failed local turn stays failed: no credit fallback, no cloud retry", async () => {
  const h = await setup(async () => ({ status: "failed", error: "Insufficient usage credits" }));
  try {
    h.select();
    await h.runner.send(h.thread.id, "read");
    assert.equal(h.counts.local, 1);
    assert.equal(h.counts.cloud, 0);
    const thread = h.store.thread(h.thread.id)!;
    assert.equal(thread.status, "error");
    assert.equal(thread.model, MODEL, "the thread stays on its local model");
    assert.deepEqual(thread.localTarget, h.target);
  } finally { await h.runner.dispose(); }
});

test("a forged, stale or unloadable persisted target never reaches a cloud backend", async () => {
  const h = await setup();
  try {
    h.store.updateThread(h.thread.id, { localTarget: { ...h.target, model: { ...h.target.model, connection: { id: h.connection.id, revision: 99 } } }, localContextTokens: 32768, auto: true, model: MODEL });
    await h.runner.send(h.thread.id, "read");
    assert.deepEqual({ cloud: h.counts.cloud, local: h.counts.local }, { cloud: 0, local: 0 });
    assert.ok(h.store.items(h.thread.id).some(i => i.kind === "notice" && /Local execution stopped: .*changed or was deleted/.test(i.text)));
    assert.equal(h.store.thread(h.thread.id)!.status, "error");
    h.store.updateThread(h.thread.id, { localTarget: h.target, model: "gpt-6-astra" });
    await h.runner.send(h.thread.id, "read");
    assert.deepEqual({ cloud: h.counts.cloud, local: h.counts.local }, { cloud: 0, local: 0 });
    assert.ok(h.store.items(h.thread.id).some(i => i.kind === "notice" && /no longer matches its local target/.test(i.text)));
    const runner = new ThreadRunner({ home: tmpdir("lm3-nolocal-"), store: h.store, emit: () => {}, backends: { codex: { id: "codex", listModels: async () => [], dispose: async () => {}, runTurn: async () => { h.counts.cloud++; return { status: "completed" }; } } } });
    try {
      h.store.updateThread(h.thread.id, { localTarget: h.target, model: MODEL, status: "idle" });
      await runner.send(h.thread.id, "read");
      assert.equal(h.counts.cloud, 0, "a build without local execution refuses rather than routing to cloud");
      assert.ok(h.store.items(h.thread.id).some(i => i.kind === "notice" && /unavailable in this build/.test(i.text)));
    } finally { await runner.dispose(); }
  } finally { await h.runner.dispose(); }
});

test("clearing the target drops the native handle and returns to the default cloud model; a paired desktop cannot select one", async () => {
  const h = await setup();
  try {
    h.select();
    h.store.updateThread(h.thread.id, { sessionHandle: "native-1", codexAccount: "old-account" });
    const cleared = h.runner.updateThread(h.thread.id, { localTarget: null });
    assert.equal(cleared.localTarget, undefined);
    assert.equal(cleared.localContextTokens, undefined);
    assert.equal(cleared.sessionHandle, undefined);
    assert.equal(cleared.codexAccount, undefined);
    assert.equal(cleared.model, h.store.settings.default_model.codex ?? "");
    assert.equal(h.counts.forgotten, 2);
    const ignored = h.runner.updateThread(h.thread.id, { localTarget: h.target, localContextTokens: 32768, title: "from phone" }, { by: "paired-desktop" });
    assert.equal(ignored.localTarget, undefined);
    assert.equal(ignored.title, "from phone");
    assert.throws(() => h.runner.updateThread(h.thread.id, { localTarget: { ...h.target, model: { ...h.target.model, id: "" } } }), /Invalid local target/);
    assert.throws(() => h.runner.updateThread(h.thread.id, { localTarget: h.target, localContextTokens: 10 }), /context window/);
    assert.equal(h.store.thread(h.thread.id)!.localTarget, undefined, "a refused selection changes nothing");
  } finally { await h.runner.dispose(); }
});

test("while a local turn runs its settings are locked, and a second Stop force-stops only the thread's own child", async () => {
  const h = await setup();
  try {
    h.select();
    h.hold();
    const turn = h.runner.send(h.thread.id, "long");
    while (h.counts.local < 1) await new Promise(r => setTimeout(r, 5));
    assert.throws(() => h.runner.updateThread(h.thread.id, { localTarget: null }), /Wait for the local turn/);
    assert.throws(() => h.runner.updateThread(h.thread.id, { localContextTokens: 8192 }), /Wait for the local turn/);
    h.runner.stop(h.thread.id);
    h.runner.stop(h.thread.id);
    assert.equal(h.counts.localForceStops, 1);
    assert.equal(h.counts.cloudForceStops, 0);
    assert.ok(h.store.items(h.thread.id).some(i => i.kind === "notice" && /this thread's local Codex/.test(i.text)));
    h.release();
    await turn;
  } finally { await h.runner.dispose(); }
});

test("deleting a local thread ends its child, and disposing the runner disposes local execution", async () => {
  const h = await setup();
  try {
    h.select();
    await h.runner.deleteThread(h.thread.id, false);
    assert.equal(h.counts.forgotten, 2);
  } finally { await h.runner.dispose(); }
});
