import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runDemo } from "../src/main/engine/demo.js";
import { Store } from "../src/main/engine/store.js";
import { ThreadRunner } from "../src/main/engine/runner.js";
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
  const runner = new ThreadRunner({ home, store, emit: () => {}, backends: { mock: new MockBackend(() => store.settings.mock_script, home, 0) } });
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
