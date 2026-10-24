import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/main/engine/store.js";
import { ThreadRunner, type RunnerOptions } from "../src/main/engine/runner.js";
import { SecretStore, testCipher } from "../src/main/engine/secrets.js";
import { LocalConnectionStore } from "../src/main/engine/local-models/connections.js";
import { LocalExecution } from "../src/main/engine/local-models/execution.js";
import type { Backend, TurnOptions } from "../src/main/engine/backends/types.js";
import { gitRepo, tmpdir } from "./helpers.js";

async function setup() {
  const home = tmpdir("strata-runner-");
  const store = new Store(home);
  const connections = new LocalConnectionStore(home, new SecretStore(home, testCipher));
  const c = connections.create({ label: "Strata", runtime: "responses", url: "http://127.0.0.1:18501" });
  const local = new LocalExecution(home, connections);
  let cloudCalls = 0, localCalls = 0, titles = 0, adapters = 0;
  const turns: TurnOptions[] = [];
  const cloud: Backend = { id: "codex", listModels: async () => [], dispose: async () => {}, runTurn: async () => { cloudCalls++; return { status: "completed" }; }, generateTitle: async () => { titles++; return "cloud title"; } };
  mock.method(local, "backend", () => ({ ...cloud, generateTitle: undefined, runTurn: async (_text: string, opts: TurnOptions, sink: Parameters<Backend["runTurn"]>[2]) => {
    localCalls++; turns.push(opts); sink.notice("info", "local result"); return { status: "failed", error: "Insufficient usage credits" };
  } }));
  const options = { home, store, emit: () => {}, backends: { codex: cloud }, localExecution: local,
    knowledge: { prepare: async () => { adapters++; throw new Error("must not prepare external tools"); } },
    pages: { prepare: async () => { adapters++; throw new Error("must not prepare external tools"); } },
  };
  const runner = new ThreadRunner(options as RunnerOptions);
  const thread = await runner.createThread(store.addProject(gitRepo()).id, { backend: "codex" });
  const target = { schema: 1 as const, harness: "codex" as const, model: { schema: 1 as const, connection: { id: c.id, revision: 1 }, id: "qwen3.8-flash-next-iq3_s" } };
  const select = () => runner.updateThread(thread.id, { localTarget: target, localContextTokens: 32768 } as never);
  return { store, connections, c, runner, thread, target, select, turns, counts: () => ({ cloudCalls, localCalls, titles, adapters }) };
}

test("local selection persists and dispatches without cloud accounts, auxiliary calls or fallback", async () => {
  const h = await setup();
  try {
    h.select();
    assert.deepEqual((h.store.thread(h.thread.id) as any).localTarget, h.target);
    assert.equal(h.store.thread(h.thread.id)?.auto, false);
    await h.runner.send(h.thread.id, "read the fixture");
    assert.deepEqual(h.counts(), { cloudCalls: 0, localCalls: 1, titles: 0, adapters: 0 });
    assert.equal(h.turns[0]?.account, undefined);
    assert.equal(h.turns[0]?.model, "qwen3.8-flash-next-iq3_s");
    assert.equal(await h.runner.followUp(h.thread.id), null);
    assert.throws(() => h.runner.updateThread(h.thread.id, { auto: true }), /local/i);
    assert.throws(() => h.runner.updateThread(h.thread.id, { plan: true }), /local/i);
  } finally { await h.runner.dispose(); }
});

test("forged or stale persisted local targets never reach a cloud backend", async () => {
  const h = await setup();
  try {
    h.store.updateThread(h.thread.id, { localTarget: { ...h.target, model: { ...h.target.model, connection: { id: h.c.id, revision: 99 } } }, localContextTokens: 32768, auto: true } as never);
    await h.runner.send(h.thread.id, "read");
    assert.deepEqual(h.counts(), { cloudCalls: 0, localCalls: 0, titles: 0, adapters: 0 });
    assert.ok(h.store.items(h.thread.id).some(i => i.kind === "notice" && /local connection.*changed/i.test(i.text)));
  } finally { await h.runner.dispose(); }
});

test("clearing a local target clears its native handle before returning to cloud", async () => {
  const h = await setup();
  try {
    h.select();
    h.store.updateThread(h.thread.id, { sessionHandle: "local-native", codexAccount: "old-account" });
    h.runner.updateThread(h.thread.id, { localTarget: null } as never);
    const current = h.store.thread(h.thread.id) as any;
    assert.equal(current.localTarget, undefined);
    assert.equal(current.sessionHandle, undefined);
    assert.equal(current.codexAccount, undefined);
  } finally { await h.runner.dispose(); }
});
