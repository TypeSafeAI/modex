import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { SpawnOptions } from "node:child_process";
import { LocalConnectionStore } from "../src/main/engine/local-models/connections.js";
import { SecretStore, testCipher } from "../src/main/engine/secrets.js";
import { FakeProcess, fakeSpawn, collectSink } from "./fakeproc.js";
import { tmpdir } from "./helpers.js";
const modulePath = "../src/main/engine/local-models/execution.js";

async function setup() {
  const home = tmpdir("strata-exec-");
  const connections = new LocalConnectionStore(home, new SecretStore(home, testCipher));
  const connection = connections.create({ label: "Strata", runtime: "responses", url: "http://127.0.0.1:18501/v1", token: "LOCAL_TOKEN_SENTINEL" });
  const target = { schema: 1 as const, harness: "codex" as const, model: { schema: 1 as const, connection: { id: connection.id, revision: 1 }, id: "qwen3.8-flash-next-iq3_s" } };
  const children: { proc: FakeProcess; args: string[]; opts: SpawnOptions }[] = [];
  const spawnImpl = ((bin: string, args: string[], opts: SpawnOptions) => {
    const proc = new FakeProcess();
    children.push({ proc, args, opts });
    proc.stdin.on("data", (d: Buffer) => {
      for (const line of d.toString().trim().split("\n")) {
        const m = JSON.parse(line);
        if (m.method === "initialize") proc.emitLine({ id: m.id, result: { userAgent: "codex/0.164.0" } });
        if (m.method === "thread/start") proc.emitLine({ id: m.id, result: { thread: { id: `native-${children.length}` }, model: m.params.model, modelProvider: m.params.modelProvider } });
        if (m.method === "turn/start") proc.emitLine({ id: m.id, result: { turn: { id: "turn" } } });
      }
    });
    return fakeSpawn(proc).spawn(bin, args, opts);
  }) as ConstructorParameters<typeof import("../src/main/engine/backends/codex.js").CodexBackend>[1];
  const { LocalExecution } = await import(modulePath);
  const execution = new LocalExecution(home, connections, "codex", spawnImpl);
  const thread = { id: "modex-1", localTarget: target, localContextTokens: 32768, cwd: tmpdir("strata-cwd-") };
  const opts = { cwd: thread.cwd, mode: "agent" as const, plan: false, model: target.model.id };
  const finish = (n = 0) => children[n]!.proc.emitLine({ method: "turn/completed", params: { threadId: `native-${n + 1}`, turn: { id: "turn", status: "completed" } } });
  return { home, connections, connection, target, execution, children, thread, opts, finish };
}

test("local executor scopes credentials and configuration to a native child and pins exact model", async () => {
  const h = await setup();
  try {
    const run = h.execution.backend(h.thread).runTurn("read", h.opts, collectSink().sink, new AbortController().signal);
    while (!h.children[0]) await new Promise(r => setTimeout(r, 5));
    const child = h.children[0]!;
    await child.proc.waitFor(line => line.includes('"turn/start"'));
    assert.equal(child.opts.env?.MODEX_LOCAL_TOKEN, "LOCAL_TOKEN_SENTINEL");
    assert.equal(child.opts.env?.OPENAI_API_KEY, undefined);
    assert.notEqual(child.opts.env?.CODEX_HOME, process.env.CODEX_HOME);
    assert.notEqual(child.opts.env?.HOME, process.env.HOME);
    assert.equal(fs.existsSync(child.opts.env!.CODEX_HOME!), true, "Codex requires its private home to exist before spawn");
    assert.equal(child.args.join(" ").includes("LOCAL_TOKEN_SENTINEL"), false);
    assert.ok(child.args.includes('model_providers.modex_local.base_url="http://127.0.0.1:18501/v1"'));
    assert.ok(child.args.includes("model_context_window=32768"));
    assert.ok(child.args.includes("features.view_image=false"), "unqualified image tools must not be offered");
    assert.ok(child.args.includes('shell_environment_policy.exclude=["MODEX_LOCAL_TOKEN"]'), "the connection credential must not enter the tool shell");
    const start = child.proc.sent(m => m.method === "thread/start")[0]!;
    assert.equal(start.params.allowProviderModelFallback, false);
    assert.equal(start.params.model, "qwen3.8-flash-next-iq3_s");
    h.finish();
    assert.equal((await run).status, "completed");
    const oldHandle = { ...h.opts, resume: "native-1" };
    await h.execution.dispose();
    const again = await h.execution.backend(h.thread).runTurn("continue", oldHandle, collectSink().sink, new AbortController().signal);
    assert.equal(again.status, "failed");
    assert.match(again.error, /resume|restart|fresh/i);
    assert.equal(h.children.length, 1);
  } finally { await h.execution.dispose(); }
});

test("stale connection revisions and inherited project config fail before any native process", async () => {
  const h = await setup();
  try {
    h.connections.update(h.connection.id, 1, { token: "ROTATED" });
    const stale = await h.execution.backend(h.thread).runTurn("read", h.opts, collectSink().sink, new AbortController().signal);
    assert.equal(stale.status, "failed");
    assert.equal(h.children.length, 0);
    const fresh = { ...h.thread, localTarget: { ...h.target, model: { ...h.target.model, connection: { id: h.connection.id, revision: 2 } } } };
    fs.mkdirSync(path.join(h.thread.cwd, ".codex"));
    fs.writeFileSync(path.join(h.thread.cwd, ".codex", "config.toml"), 'model_provider="cloud"');
    const blocked = await h.execution.backend(fresh).runTurn("read", h.opts, collectSink().sink, new AbortController().signal);
    assert.equal(blocked.status, "failed");
    assert.match(blocked.error, /configuration/i);
    assert.equal(h.children.length, 0);
  } finally { await h.execution.dispose(); }
});

test("a cancelled turn queued for the same service starts no process or request", async () => {
  const h = await setup();
  try {
    const first = h.execution.backend(h.thread).runTurn("first", h.opts, collectSink().sink, new AbortController().signal);
    while (!h.children[0]) await new Promise(r => setTimeout(r, 5));
    await h.children[0]!.proc.waitFor(line => line.includes('"turn/start"'));
    const abort = new AbortController();
    const second = h.execution.backend({ ...h.thread, id: "modex-2" }).runTurn("second", h.opts, collectSink().sink, abort.signal);
    abort.abort();
    assert.equal((await second).status, "interrupted");
    assert.equal(h.children.length, 1);
    h.finish();
    assert.equal((await first).status, "completed");
    assert.equal(h.children.length, 1);
  } finally { await h.execution.dispose(); }
});

test("IPv4 and mapped IPv6 profiles share one inference slot", async () => {
  const h = await setup();
  try {
    const c = h.connections.create({ label: "mapped", runtime: "responses", url: "http://[::ffff:127.0.0.1]:18501" });
    const mapped = { ...h.thread, id: "mapped", localTarget: { ...h.target, model: { ...h.target.model, connection: { id: c.id, revision: 1 } } } };
    const first = h.execution.backend(h.thread).runTurn("first", h.opts, collectSink().sink, new AbortController().signal);
    while (!h.children[0]) await new Promise(r => setTimeout(r, 5));
    await h.children[0]!.proc.waitFor(line => line.includes('"turn/start"'));
    const abort = new AbortController();
    const queued = h.execution.backend(mapped).runTurn("queued", h.opts, collectSink().sink, abort.signal);
    await new Promise(r => setTimeout(r, 30));
    const before = h.children.length;
    abort.abort(); h.finish();
    if (h.children[1]) h.finish(1);
    await Promise.all([first, queued]);
    assert.equal(before, 1, "mapped aliases must not start a second inference while the first is active");
  } finally { await h.execution.dispose(); }
});
