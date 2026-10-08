import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runDemo } from "../src/main/engine/demo.js";
import { Store } from "../src/main/engine/store.js";
import { ThreadRunner } from "../src/main/engine/runner.js";
import { Router } from "../src/main/engine/routing/router.js";
import { MockBackend } from "../src/main/engine/backends/mock.js";

test("demo runs from a packaged app without a source checkout", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "modex-packaged-demo-"));
  const repoPath = path.join(root, "Contents", "Resources", "app.asar");
  const scriptPath = path.join(repoPath, "demo", "mock-script.json");
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.copyFileSync("demo/mock-script.json", scriptPath);
  fs.writeFileSync(path.join(repoPath, "package.json"), '{"name":"packaged-demo"}');
  const home = path.join(root, "home");
  const store = new Store(home);
  const mock = new MockBackend(() => store.settings.mock_script, home, 0);
  const router = new Router({ home, policy: () => store.settings.routing, transport: null, listModels: async () => ({ models: await mock.listModels() }) });
  const runner = new ThreadRunner({ home, store, router, emit: () => {}, backends: { mock } });
  try {
    const options = { home, store, runner, repoPath, scriptPath, answer: "yes", capture: async () => "" };
    await runDemo(options);
    assert.equal(store.settings.mock_script, scriptPath);
    assert.ok(fs.existsSync(path.join(home, "demo-repo", "CONTRIBUTING.md")));
  } finally {
    await runner.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test("demo waits for a slow turn to reach approval before auto-answering", { timeout: 5000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "modex-slow-demo-"));
  const store = new Store(root);
  let waiting = false;
  let answered = false;
  let finish!: () => void;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const runner = {
    createThread: async () => ({ id: "demo" }), updateThread: () => {},
    send: () => new Promise<void>((resolve) => { finish = resolve; timer = setTimeout(() => { waiting = true; }, 800); }),
    status: () => waiting ? "waiting" : "idle",
    items: () => waiting ? [{ id: "approval", kind: "approval" }] : [],
    answer: () => { answered = true; finish(); },
  } as unknown as ThreadRunner;
  try {
    await runDemo({ home: root, store, runner, repoPath: root, scriptPath: "unused", answer: "yes", capture: async () => "" });
    assert.equal(answered, true);
  } finally { clearTimeout(timer); finish?.(); fs.rmSync(root, { recursive: true, force: true }); }
});


test("demo propagates a failed turn even without an automatic answer", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "modex-failed-demo-"));
  const store = new Store(root);
  const runner = { createThread: async () => ({ id: "demo" }), updateThread: () => {},
    send: async () => { throw new Error("turn could not start"); }, status: () => "idle",
  } as unknown as ThreadRunner;
  try {
    await assert.rejects(runDemo({ home: root, store, runner, repoPath: root, scriptPath: "unused", capture: async () => "" }), /turn could not start/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
