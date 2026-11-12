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
