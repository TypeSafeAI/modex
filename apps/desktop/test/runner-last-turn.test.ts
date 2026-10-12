import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/main/engine/store.js";
import { ThreadRunner } from "../src/main/engine/runner.js";
import type { Backend, TurnResult } from "../src/main/engine/backends/types.js";
import { gitRepo, tmpdir } from "./helpers.js";

const backendReturning = (results: TurnResult[]): Backend => ({
  id: "codex",
  listModels: async () => [{ id: "gpt-6-luna", label: "Luna", efforts: ["low", "high"], isDefault: true }],
  dispose: async () => {},
  async runTurn(_text, _opts, sink) {
    sink.session("thr-1");
    return results.shift() ?? { status: "completed" };
  },
});

test("a turn that reached the model records what the cache was built with", async () => {
  const home = tmpdir("modex-last-turn-");
  const store = new Store(home);
  const project = store.addProject(gitRepo());
  const usage = { first: { cacheRead: 0, cacheWrite: 30_000, uncached: 5 }, contextTokens: 31_000, calls: 2 };
  const runner = new ThreadRunner({ home, store, emit: () => {}, backends: { codex: backendReturning([
    { status: "completed", usage },
    { status: "failed", error: "boom" },
    { status: "interrupted", usage: { ...usage, contextTokens: 32_000 } },
  ]) } });
  try {
    const thread = await runner.createThread(project.id, { backend: "codex", model: "gpt-6-luna" });
    runner.updateThread(thread.id, { effort: "high" });
    await runner.send(thread.id, "first");
    const first = store.thread(thread.id)!.lastTurn!;
    assert.deepEqual({ ...first, at: typeof first.at }, { at: "string", model: "gpt-6-luna", effort: "high", fast: false, contextTokens: 31_000 });
    await runner.send(thread.id, "second fails before any model call");
    assert.deepEqual(store.thread(thread.id)!.lastTurn, first, "no usage and not completed: the record stays");
    await runner.send(thread.id, "third is stopped after a call");
    assert.equal(store.thread(thread.id)!.lastTurn!.contextTokens, 32_000, "an interrupted turn that made calls still warmed the cache");
    runner.updateThread(thread.id, { backend: "claude" });
    assert.equal(store.thread(thread.id)!.lastTurn, undefined, "a backend switch starts a new conversation");
  } finally { await runner.dispose(); }
});

test("a completed turn from a CLI that reports no usage leaves a record without a size, and it persists", async () => {
  const home = tmpdir("modex-last-turn-");
  const store = new Store(home);
  const project = store.addProject(gitRepo());
  const runner = new ThreadRunner({ home, store, emit: () => {}, backends: { codex: backendReturning([{ status: "completed" }]) } });
  try {
    const thread = await runner.createThread(project.id, { backend: "codex", model: "gpt-6-luna" });
    await runner.send(thread.id, "hello");
    const last = store.thread(thread.id)!.lastTurn!;
    assert.deepEqual([last.model, last.fast, last.contextTokens], ["gpt-6-luna", false, undefined]);
    assert.equal(new Store(home).thread(thread.id)!.lastTurn!.model, "gpt-6-luna");
  } finally { await runner.dispose(); }
});
