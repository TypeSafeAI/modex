import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { Store } from "../src/main/engine/store.js";
import { ThreadRunner } from "../src/main/engine/runner.js";
import { Router } from "../src/main/engine/routing/router.js";
import type { Backend } from "../src/main/engine/backends/types.js";
import { gitRepo, tmpdir } from "./helpers.js";

function harness(backend: Partial<Backend> = {}, beforeDeleteThread?: (id: string) => Promise<void>) {
  const home = tmpdir("update-restart-");
  const repo = gitRepo();
  const store = new Store(home);
  store.updateSettings({ default_backend: "mock" });
  const project = store.addProject(repo);
  const runner = new ThreadRunner({ home, store, emit: () => {}, beforeDeleteThread,
    router: new Router({ home, policy: () => store.settings.routing, listModels: async () => ({ models: [] }), transport: null }),
    // A completed turn always carries at least one item; a silent completion is a failure card.
    backends: { mock: { id: "mock", listModels: async () => [], dispose: async () => {}, runTurn: async (_text, _options, sink) => { sink.assistant("done"); return { status: "completed" }; }, ...backend } },
  });
  return { runner, store, project, close: async () => {
    await runner.dispose();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  } };
}

test("restart hold blocks direct runner admission and cancelled preflight restores it", async () => {
  const h = harness();
  try {
    const thread = await h.runner.createThread(h.project.id);
    const release = h.runner.holdForRestart();
    assert.throws(() => h.runner.holdForRestart(), /restart/i);
    await assert.rejects(h.runner.createThread(h.project.id), /restart/i);
    await assert.rejects(h.runner.send(thread.id, "late phone message"), /restart/i);
    await assert.rejects(h.runner.retry(thread.id), /restart/i);
    await assert.rejects(h.runner.deleteThread(thread.id), /restart/i);
    await assert.rejects(h.runner.removeProject(h.project.id), /restart/i);
    await assert.rejects(h.runner.followUp(thread.id), /restart/i);
    assert.throws(() => h.runner.updateThread(thread.id, { title: "late edit" }), /restart/i);
    assert.throws(() => h.runner.updateThread(thread.id, { model: "late" }, { fromRouter: true }), /restart/i);
    assert.throws(() => h.runner.updateThread(thread.id, { title: "late" }, { automaticTitle: true }), /restart/i);
    assert.match((await h.runner.listModels("mock")).error!, /restart/i);
    assert.equal(h.store.items(thread.id).length, 0);
    release();
    const next = h.runner.holdForRestart();
    release(); // An old cancellation must not release a later installation attempt.
    await assert.rejects(h.runner.createThread(h.project.id), /restart/i);
    next();
    await h.runner.send(thread.id, "after cancellation");
    assert.ok(h.store.items(thread.id).some(item => item.kind === "user" && item.text === "after cancellation"));
  } finally { await h.close(); }
});

test("restart refuses an active approval without interrupting the turn or changing its answer", async () => {
  let aborted = false;
  let answer: string | undefined;
  let entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const h = harness({ runTurn: async (_text, _opts, sink, signal) => {
    signal.addEventListener("abort", () => { aborted = true; });
    const approval = sink.approval({ question: "Allow this command?", canAlways: false });
    entered();
    answer = await approval;
    return { status: "completed" };
  } });
  const thread = await h.runner.createThread(h.project.id);
  const running = h.runner.send(thread.id, "work");
  try {
    assert.throws(() => h.runner.holdForRestart(), /finish/i);
    await waiting;
    assert.equal(h.runner.status(thread.id), "waiting");
    assert.throws(() => h.runner.holdForRestart(), /finish/i);
    assert.equal(aborted, false);
    assert.equal(answer, undefined);
    const approval = h.runner.items(thread.id).find(item => item.kind === "approval");
    assert.ok(approval);
    h.runner.answer(thread.id, approval.id, "no");
    await running;
    assert.equal(answer, "no");
    h.runner.holdForRestart()();
  } finally { h.runner.stop(thread.id); await running; await h.close(); }
});

test("restart refuses worktree creation and deletion already admitted before the hold", async () => {
  let finishDelete!: () => void;
  const deletion = new Promise<void>(resolve => { finishDelete = resolve; });
  const h = harness({}, () => deletion);
  const creating = h.runner.createThread(h.project.id, { worktree: true });
  try {
    assert.throws(() => h.runner.holdForRestart(), /finish/i);
    assert.throws(() => h.runner.holdForOwnerRemoval(), /worktree operations/i);
    const thread = await creating;
    const removing = h.runner.deleteThread(thread.id, true);
    assert.throws(() => h.runner.holdForRestart(), /finish/i);
    assert.throws(() => h.runner.holdForOwnerRemoval(), /worktree operations/i);
    finishDelete();
    await removing;
    h.runner.holdForRestart()();
  } finally { finishDelete(); await creating; await h.close(); }
});

test("model discovery already running must finish before restart admission", async () => {
  let finish!: () => void;
  const discovered = new Promise<[]>(resolve => { finish = () => resolve([]); });
  const h = harness({ listModels: () => discovered });
  try {
    const listing = h.runner.listModels("mock");
    assert.throws(() => h.runner.holdForRestart(), /finish/i);
    finish();
    await listing;
    h.runner.holdForRestart()();
  } finally { finish(); await h.close(); }
});

test("a pending follow-up suggestion finishes before restart without being aborted", async () => {
  let finish!: () => void;
  const pending = new Promise<null>(resolve => { finish = () => resolve(null); });
  const h = harness();
  let signal: AbortSignal | undefined;
  h.runner.router.followUp = async (_input, abort) => { signal = abort; return pending; };
  try {
    const thread = await h.runner.createThread(h.project.id);
    await h.runner.send(thread.id, "completed turn");
    const suggestion = h.runner.followUp(thread.id);
    assert.throws(() => h.runner.holdForRestart(), /finish/i);
    assert.equal(signal?.aborted, false);
    finish();
    await suggestion;
    h.runner.holdForRestart()();
  } finally { finish(); await h.close(); }
});

test("background model learning finishes its persisted notice before restart", async () => {
  const h = harness();
  let finish!: () => void;
  const learning = new Promise<{ task: string; from: number; to: number }>(resolve => { finish = () => resolve({ task: "small_edit", from: 1, to: 2 }); });
  h.runner.router.noteOverride = () => learning;
  try {
    const thread = await h.runner.createThread(h.project.id, { auto: true, model: "small" });
    h.store.saveItems(thread.id, [{ id: "route-1", kind: "route", backend: "mock", model: "small", fast: false, source: "heuristic", task: "small_edit", confidence: 1, complexity: 1, pinned: false, reasons: [], durationMs: 1, at: new Date().toISOString() }]);
    h.runner.updateThread(thread.id, { model: "big" });
    assert.throws(() => h.runner.holdForRestart(), /finish/i);
    finish();
    await new Promise<void>(resolve => setImmediate(resolve));
    h.runner.holdForRestart()();
    assert.ok(h.store.items(thread.id).some(item => item.kind === "notice" && item.text.includes("you chose tier 2")));
  } finally { finish(); await h.close(); }
});

test("owner removal lets an admitted Auto turn finish routing while refusing new edits", async () => {
  let ranModel: string | undefined;
  const h = harness({ runTurn: async (_text, opts) => { ranModel = opts.model; return { status: "completed" }; } });
  let entered!: () => void, finish!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const route = h.runner.router.route.bind(h.runner.router);
  h.runner.router.route = async (...args) => {
    const receipt = await route(...args);
    receipt.decision.model = "routed-model";
    receipt.item.model = "routed-model";
    entered(); await gate;
    return receipt;
  };
  const thread = await h.runner.createThread(h.project.id, { auto: true });
  const turn = h.runner.send(thread.id, "hello");
  let release: (() => void) | undefined;
  try {
    await ready;
    release = h.runner.holdForOwnerRemoval();
    assert.throws(() => h.runner.updateThread(thread.id, { model: "external-edit" }), /restart|remov/i);
    await assert.rejects(h.runner.createThread(h.project.id), /restart|remov/i);
    finish(); await turn;
    assert.equal(ranModel, "routed-model");
    assert.equal(h.store.thread(thread.id)?.model, "routed-model");
    assert.equal(h.runner.items(thread.id).some(item => item.kind === "notice" && /routing failed|routing stopped/i.test(item.text)), false);
  } finally { finish(); release?.(); await turn; await h.close(); }
});
