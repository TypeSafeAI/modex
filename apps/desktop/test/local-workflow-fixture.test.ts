import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { LocalExecution } from "../src/main/engine/local-models/execution.js";
import { LocalConnectionStore } from "../src/main/engine/local-models/connections.js";
import { SecretStore, testCipher } from "../src/main/engine/secrets.js";
import { localWorkflowSpawn } from "./local-workflow-fixture.js";
import { collectSink } from "./fakeproc.js";
import { tmpdir } from "./helpers.js";

test("Electron's local transport fixture crosses approval, checks real bytes, stops its child and refuses a lost native handle", { timeout: 20_000 }, async () => {
  const home = tmpdir("lm-workflow-home-"), cwd = tmpdir("lm-workflow-cwd-");
  fs.writeFileSync(path.join(cwd, "greeting.txt"), "hello\n");
  fs.writeFileSync(path.join(cwd, "fixture-check.cjs"), `const fs=require('node:fs'); const ok=fs.readFileSync('greeting.txt','utf8')===${JSON.stringify("hello, local\n")}; fs.appendFileSync('checks.txt',String(ok)+${JSON.stringify("\n")}); process.exit(ok?0:1);\n`);
  const connections = new LocalConnectionStore(home, new SecretStore(home, testCipher));
  const c = connections.create({ label: "Fixture", runtime: "ollama", url: "http://127.0.0.1:18345" });
  const thread = { id: "local-fixture", cwd, localContextTokens: 65536, localTarget: { schema: 1 as const, harness: "codex" as const,
    model: { schema: 1 as const, connection: { id: c.id, revision: c.revision }, id: "fixture-coder" } } };
  const execution = new LocalExecution(home, connections, "fixture-codex", localWorkflowSpawn);
  const options = { cwd, mode: "chat" as const, plan: false, model: "fixture-coder" };
  const h = collectSink(); let session: string | undefined;
  h.sink.session = id => { session = id; };
  h.sink.approval = async () => {
    assert.equal(fs.readFileSync(path.join(cwd, "greeting.txt"), "utf8"), "hello\n");
    return "yes";
  };
  try {
    const result = await execution.backend(thread).runTurn("edit and check", options, h.sink, AbortSignal.timeout(5_000));
    assert.equal(result.status, "completed", result.error);
    assert.equal(fs.readFileSync(path.join(cwd, "greeting.txt"), "utf8"), "hello, local\n");
    assert.equal(fs.readFileSync(path.join(cwd, "checks.txt"), "utf8"), "true\n");
    assert.ok(h.observations.some(o => o.type === "tool.done" && o.outcome === "succeeded"));
    assert.ok(session);
    const stop = new AbortController();
    const running = execution.backend(thread).runTurn("STOP_FIXTURE", { ...options, resume: session }, h.sink, stop.signal);
    const deadline = Date.now() + 5_000;
    while (!fs.existsSync(path.join(cwd, "stop-started.txt"))) {
      assert.ok(Date.now() < deadline, "the actual child started before Stop");
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    stop.abort();
    assert.equal((await running).status, "interrupted");
    assert.equal(fs.existsSync(path.join(cwd, "late-effect.txt")), false);
    h.sink.approval = async () => "yes";
    const continued = await execution.backend(thread).runTurn("continue", { ...options, resume: session }, h.sink, AbortSignal.timeout(5_000));
    assert.equal(continued.status, "completed", continued.error);
    assert.equal(fs.readFileSync(path.join(cwd, "edits.txt"), "utf8"), "edit\nedit\n");
    const failed = await execution.backend(thread).runTurn("SERVER_FAILURE", { ...options, resume: session }, h.sink, AbortSignal.timeout(5_000));
    assert.equal(failed.status, "failed");
    assert.equal(fs.readFileSync(path.join(cwd, "edits.txt"), "utf8"), "edit\nedit\n");
    await execution.dispose();
    const restarted = new LocalExecution(home, connections, "fixture-codex", localWorkflowSpawn);
    try {
      const lost = await restarted.backend(thread).runTurn("don't replay", { ...options, resume: session }, h.sink, AbortSignal.timeout(5_000));
      assert.equal(lost.status, "failed"); assert.match(lost.error!, /native session is gone/);
      assert.equal(fs.readFileSync(path.join(cwd, "edits.txt"), "utf8"), "edit\nedit\n");
    } finally { await restarted.dispose(); }
  } finally { await execution.dispose(); }
});
