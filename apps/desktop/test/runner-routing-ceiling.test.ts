import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Store } from "../src/main/engine/store.js";
import { ThreadRunner } from "../src/main/engine/runner.js";
import { Router } from "../src/main/engine/routing/router.js";
import type { Backend, TurnOptions, TurnSink } from "../src/main/engine/backends/types.js";
import { DEFAULT_ROUTING, type ModelInfo } from "../src/shared/types.js";
import { gitRepo, tmpdir } from "./helpers.js";

test("Auto stops before backend execution when no advertised effort fits the ceiling", async () => {
  const home = tmpdir("modex-policy-ceiling-");
  const store = new Store(home);
  const events: unknown[] = [];
  const repo = gitRepo();
  const project = store.addProject(repo);
  let runs = 0;
  const model: ModelInfo = { id: "high-only", label: "High only", efforts: ["high"] };
  const backend: Backend = {
    id: "codex",
    listModels: async () => [model],
    dispose: async () => {},
    runTurn: async (_text: string, _options: TurnOptions, _sink: TurnSink) => {
      runs++;
      return { status: "completed" };
    },
  };
  const router = new Router({
    home,
    policy: () => ({ ...DEFAULT_ROUTING, max_effort: "low" }),
    transport: null,
    listModels: async () => ({ models: [model] }),
  });
  const runner = new ThreadRunner({ home, store, emit: (event) => events.push(event), router, backends: { codex: backend } });
  const thread = await runner.createThread(project.id, { backend: "codex", auto: true });
  try {
    await runner.send(thread.id, "review the repository");
    assert.equal(runs, 0, "the existing backend model was run after the policy rejected its effort capability");
    assert.equal(runner.status(thread.id), "error");
    assert.equal(router.fit.snapshot().history.length, 0, "a blocked turn must not teach the fit or consume a route budget");
    assert.ok(runner.items(thread.id).some((item) => item.kind === "route" && item.blocked && item.reasons.some((reason) => /route was stopped/.test(reason))));
    assert.ok(runner.items(thread.id).some((item) => item.kind === "notice" && item.level === "error" && /Auto routing stopped/.test(item.text)));
  } finally {
    await runner.dispose();
  }
});

test("learning-file write failures cannot block safe coding turns or turn a completion into a failure", async () => {
  const home = tmpdir("modex-fit-write-failure-");
  const store = new Store(home);
  const project = store.addProject(gitRepo());
  const runs: TurnOptions[] = [];
  const model = { id: "gpt-6-luna", label: "Luna", efforts: ["high", "xhigh"], isDefault: true };
  const backend: Backend = {
    id: "codex", listModels: async () => [model], dispose: async () => {},
    runTurn: async (_text, options) => { runs.push(options); return { status: "completed" }; },
  };
  const router = new Router({ home, policy: () => ({ ...DEFAULT_ROUTING, premium_turns_per_day: 1 }), transport: null,
    listModels: async () => ({ models: [model] }),
  });
  const runner = new ThreadRunner({ home, store, emit: () => {}, router, backends: { codex: backend } });
  const blocker = path.join(home, "app", "routing-fit.json.tmp");
  fs.mkdirSync(blocker);
  try {
    const thread = await runner.createThread(project.id, { backend: "codex", auto: true });
    await runner.send(thread.id, "design a complex architecture; be careful");
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.effort, "xhigh");
    assert.equal(runner.status(thread.id), "idle");
    assert.equal(router.fit.premiumToday(), 1);
    assert.equal(router.fit.latest(thread.id)?.outcome, "completed");
    assert.ok(runner.items(thread.id).some((item) => item.kind === "route" && item.reasons.some((reason) => /Could not save routing learning/.test(reason))));
    fs.rmSync(blocker, { recursive: true });
    await runner.send(thread.id, "design another complex architecture; be careful");
    assert.equal(runs.length, 2);
    assert.equal(runs[1]!.effort, "high", "the in-memory premium count still enforces the budget");
    assert.equal(router.fit.premiumToday(), 1);
    assert.equal(JSON.parse(fs.readFileSync(router.fit.file, "utf8")).history.length, 2, "a later write persists the retained learning");
  } finally { await runner.dispose(); }
});

test("Auto routing exceptions cannot run a live backend with an unchecked effort", async () => {
  const home = tmpdir("modex-policy-error-");
  const store = new Store(home);
  const project = store.addProject(gitRepo());
  let runs = 0;
  const backend: Backend = {
    id: "codex", listModels: async () => [], dispose: async () => {},
    runTurn: async () => { runs++; return { status: "completed" }; },
  };
  const router = new Router({ home, policy: () => ({ ...DEFAULT_ROUTING, max_effort: "low" }), transport: null, listModels: async () => { throw new Error("model discovery unavailable"); } });
  const runner = new ThreadRunner({ home, store, emit: () => {}, router, backends: { codex: backend } });
  try {
    const thread = await runner.createThread(project.id, { backend: "codex", auto: true });
    await runner.send(thread.id, "review the repository");
    assert.equal(runs, 0);
    assert.equal(runner.status(thread.id), "error");
    assert.ok(runner.items(thread.id).some((item) => item.kind === "notice" && item.level === "error" && /model discovery unavailable/.test(item.text)));
  } finally {
    await runner.dispose();
  }
});

test("a blocked router decision cannot switch backends or discard a saved CLI session", async () => {
  const home = tmpdir("modex-policy-blocked-switch-");
  const store = new Store(home);
  const project = store.addProject(gitRepo());
  let runs = 0;
  const backend: Backend = {
    id: "codex", listModels: async () => [], dispose: async () => {},
    runTurn: async () => { runs++; return { status: "completed" }; },
  };
  const router = {
    route: async () => ({
      item: {
        id: "blocked-route", kind: "route", backend: "claude", model: "opus", effort: "high", fast: false,
        source: "heuristic", task: "feature", confidence: 0.9, complexity: 2,
        pinned: false, reasons: ["Blocked fixture."], durationMs: 0,
      },
      decision: {
        backend: "claude", model: "opus", effort: "high", fast: false, tier: 3,
        pinned: false, blocked: true, reasons: ["Cannot honor the effort ceiling."],
      },
    }),
  } as unknown as Router;
  const runner = new ThreadRunner({ home, store, emit: () => {}, router, backends: { codex: backend } });
  try {
    const thread = await runner.createThread(project.id, { backend: "codex", auto: true });
    store.updateThread(thread.id, { sessionHandle: "codex-session-1" });
    await runner.send(thread.id, "continue the existing work");
    assert.equal(runs, 0);
    assert.equal(store.thread(thread.id)?.backend, "codex");
    assert.equal(store.thread(thread.id)?.sessionHandle, "codex-session-1");
    assert.equal(runner.status(thread.id), "error");
  } finally {
    await runner.dispose();
  }
});
