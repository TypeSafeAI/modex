import assert from "node:assert/strict";
import { test } from "node:test";
import { Store } from "../src/main/engine/store.js";
import { ThreadRunner } from "../src/main/engine/runner.js";
import type { Backend, TurnOptions } from "../src/main/engine/backends/types.js";
import { gitRepo, tmpdir } from "./helpers.js";
import { local } from "./fakeproc.js";

for (const backendId of ["codex", "claude"] as const) {
  test(`${backendId}: runner blocks exhausted Auto before executing any coding turn`, async () => {
    const home = tmpdir(), store = new Store(home), project = store.addProject(gitRepo());
    const reads: string[] = []; let runs = 0;
    const backend: Backend = { id: backendId, identity: () => "account-a", listModels: async () => [{ id: "sonnet", label: "Sonnet", efforts: ["low", "medium", "high"] }],
      quota: async account => { reads.push(account!); return { at: Date.now(), windows: [{ key: "plan", remainingPercent: 0 }] }; },
      runTurn: async () => { runs++; return { status: "completed" }; }, dispose: async () => {} };
    const runner = new ThreadRunner({ home, store, emit: () => {}, backends: { [backendId]: backend } });
    try {
      const thread = await runner.createThread(project.id, { backend: backendId, auto: true });
      await runner.send(thread.id, "fix a typo");
      assert.deepEqual(reads, ["account-a"]);
      assert.equal(runs, 0);
      await runner.retry(thread.id);
      assert.equal(runs, 0, "Retry must obtain a safe quota admission before executing");
      assert.equal(runner.status(thread.id), "error");
    } finally { await runner.dispose(); }
  });

  test(`${backendId}: quota, catalogue and coding use one captured identity despite active-account changes`, async () => {
    const home = tmpdir(), store = new Store(home), project = store.addProject(gitRepo());
    let active = "account-a";
    const reads: string[] = [], catalogues: string[] = [], turns: TurnOptions[] = [];
    const backend: Backend = { id: backendId, identity: () => active,
      listModels: async account => { catalogues.push(account!); active = "account-b"; return [{ id: "sonnet", label: "Sonnet", efforts: ["low", "medium", "high"] }]; },
      quota: async account => { reads.push(account!); return { at: Date.now(), windows: [{ key: "plan", remainingPercent: 10 }] }; },
      runTurn: async (_text, opts, sink) => { turns.push(opts); sink.session("saved"); local(sink).assistant("done"); return { status: "completed" }; }, dispose: async () => {} };
    const runner = new ThreadRunner({ home, store, emit: () => {}, backends: { [backendId]: backend } });
    try {
      const thread = await runner.createThread(project.id, { backend: backendId, auto: true });
      await runner.send(thread.id, "fix a typo");
      await runner.send(thread.id, "fix another typo");
      assert.deepEqual(reads, ["account-a", "account-a"]);
      assert.deepEqual(catalogues, ["account-a"]);
      assert.deepEqual(turns.map(t => t.account), ["account-a", "account-a"]);
      assert.deepEqual(turns.map(t => t.conserveCredits), [true, true]);
      assert.equal(turns[1]?.resume, "saved");
    } finally { await runner.dispose(); }
  });
}

test("Retry retains conservation after a failed attempt even when fresh telemetry becomes unknown", async () => {
  const home = tmpdir(), store = new Store(home), project = store.addProject(gitRepo());
  let reads = 0; const turns: TurnOptions[] = [];
  const backend: Backend = { id: "codex", identity: () => "account-a", listModels: async () => [{ id: "gpt-6-sol", label: "Sol", efforts: ["low", "medium", "high", "xhigh"] }],
    quota: async () => ++reads === 1 ? { at: Date.now(), windows: [{ key: "plan", remainingPercent: 10 }] } : undefined,
    runTurn: async (_text, opts) => { turns.push(opts); return { status: "failed", error: "temporary network issue" }; }, dispose: async () => {} };
  const runner = new ThreadRunner({ home, store, emit: () => {}, backends: { codex: backend } });
  try {
    const thread = await runner.createThread(project.id, { backend: "codex", auto: true });
    await runner.send(thread.id, "fix a typo");
    await runner.retry(thread.id);
    assert.equal(reads, 2);
    assert.deepEqual(turns.map(t => t.conserveCredits), [true, true]);
    assert.equal(runner.items(thread.id).filter(i => i.kind === "user").length, 1);
  } finally { await runner.dispose(); }
});

test("a quota-blocked Retry preserves conservation for a later attempt with unknown telemetry", async () => {
  const home = tmpdir(), store = new Store(home), project = store.addProject(gitRepo());
  let reads = 0; const turns: TurnOptions[] = [];
  const backend: Backend = { id: "codex", identity: () => "a", listModels: async () => [{ id: "gpt-6-sol", label: "Sol", efforts: ["low", "high"] }],
    quota: async () => ++reads <= 2 ? { at: Date.now(), windows: [{ key: "plan", remainingPercent: reads === 1 ? 10 : 0 }] } : undefined,
    runTurn: async (_text, opts) => { turns.push(opts); return { status: "failed", error: "network" }; }, dispose: async () => {} };
  const runner = new ThreadRunner({ home, store, emit: () => {}, backends: { codex: backend } });
  try {
    const thread = await runner.createThread(project.id, { backend: "codex", auto: true });
    await runner.send(thread.id, "fix typo");
    await runner.retry(thread.id);
    await runner.retry(thread.id);
    assert.equal(reads, 3);
    assert.deepEqual(turns.map(t => t.conserveCredits), [true, true]);
  } finally { await runner.dispose(); }
});
