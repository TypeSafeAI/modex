import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { SpawnOptions } from "node:child_process";
import type { TurnOptions } from "../src/main/engine/backends/types.js";
import { LocalConnectionStore } from "../src/main/engine/local-models/connections.js";
import { LocalExecution } from "../src/main/engine/local-models/execution.js";
import { SecretStore, testCipher } from "../src/main/engine/secrets.js";
import { FakeProcess, fakeSpawn, collectSink } from "./fakeproc.js";
import { tmpdir } from "./helpers.js";

const MODEL = "qwen3.8-flash-next-iq3_s";

/** The effective configuration a scripted app-server reports back: the child's own `-c` flags, from the session-flags layer alone, over an empty private home and an empty system file (the shape codex-cli 0.164.0 returned on 2026-10-27). */
function effectiveConfiguration(args: string[]): { config: Record<string, any>; origins: Record<string, unknown>; layers: unknown[] } {
  const flags: Record<string, any> = {};
  const origins: Record<string, unknown> = {};
  const origin = { name: { type: "sessionFlags" }, version: "sha256:flags" };
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "-c") continue;
    const setting = args[++i]!; const eq = setting.indexOf("=");
    const path = setting.slice(0, eq).split("."); const value = JSON.parse(setting.slice(eq + 1));
    let node = flags; for (const part of path.slice(0, -1)) node = node[part] ??= {}; node[path.at(-1)!] = value;
    origins[path.join(".")] = origin;
  }
  const config: Record<string, any> = { model: null, model_reasoning_summary: null, openai_base_url: null, mcp_servers: {}, ...structuredClone(flags) };
  for (const provider of Object.values(config.model_providers ?? {}) as Record<string, unknown>[]) Object.assign(provider, { experimental_bearer_token: null, auth: null, http_headers: null, env_http_headers: null, query_params: null, ...provider });
  return { config, origins, layers: [{ name: { type: "sessionFlags" }, version: "sha256:flags", config: flags }, { name: { type: "user", file: "/private/home/.codex/config.toml", profile: null }, version: "sha256:empty", config: {} }, { name: { type: "system", file: "/etc/codex/config.toml" }, version: "sha256:empty", config: {} }] };
}

/** A local execution over a scripted app-server that answers every open with the model and provider it was asked for. */
function setup(input: { url?: string; token?: string | null; configRead?: (reported: ReturnType<typeof effectiveConfiguration>) => unknown; requirements?: unknown; rerouted?: boolean } = {}) {
  const home = tmpdir("lm3-exec-");
  const connections = new LocalConnectionStore(home, new SecretStore(home, testCipher));
  const connection = connections.create({ label: "Local", runtime: "responses", url: input.url ?? "http://127.0.0.1:18501/v1", ...(input.token === null ? {} : { token: input.token ?? "LOCAL_TOKEN_SENTINEL" }) });
  const target = { schema: 1 as const, harness: "codex" as const, model: { schema: 1 as const, connection: { id: connection.id, revision: 1 }, id: MODEL } };
  const children: { proc: FakeProcess; args: string[]; opts: SpawnOptions }[] = [];
  const spawnImpl = ((bin: string, args: string[], opts: SpawnOptions) => {
    const proc = new FakeProcess();
    children.push({ proc, args, opts });
    proc.stdin.on("data", (d: Buffer) => {
      for (const line of d.toString().trim().split("\n")) {
        const m = JSON.parse(line);
        if (m.method === "initialize") proc.emitLine({ id: m.id, result: { userAgent: "codex/0.164.0" } });
        if (m.method === "config/read") { const reported = effectiveConfiguration(args); const result = input.configRead ? input.configRead(reported) : reported; proc.emitLine(result instanceof Error ? { id: m.id, error: { code: -32601, message: result.message } } : { id: m.id, result }); }
        if (m.method === "configRequirements/read") proc.emitLine({ id: m.id, result: { supportsIndependentSpeedModes: true, requirements: input.requirements ?? null } });
        if (m.method === "thread/start") proc.emitLine({ id: m.id, result: { thread: { id: `native-${children.length}` }, model: m.params.model, modelProvider: m.params.modelProvider } });
        if (m.method === "turn/start") {
          proc.emitLine({ id: m.id, result: { turn: { id: "turn" } } }); proc.emitLine({ method: "turn/started", params: { threadId: `native-${children.length}`, turn: { id: "turn" } } });
          if (input.rerouted) proc.emitLine({ method: "model/rerouted", params: { threadId: `native-${children.length}`, turnId: "turn", fromModel: m.params.model, toModel: "gpt-5.1-codex", reason: { type: "modelUnavailable" } } });
        }
        if (m.method === "turn/interrupt") { proc.emitLine({ id: m.id, result: {} }); proc.emitLine({ method: "turn/completed", params: { threadId: `native-${children.length}`, turn: { id: "turn", status: "interrupted" } } }); }
      }
    });
    return fakeSpawn(proc).spawn(bin, args, opts);
  }) as ConstructorParameters<typeof LocalExecution>[3];
  const execution = new LocalExecution(home, connections, "codex", spawnImpl);
  const thread = { id: "modex-1", localTarget: target, localContextTokens: 32768, cwd: tmpdir("lm3-cwd-") };
  const opts = { cwd: thread.cwd, mode: "agent" as const, plan: false, model: MODEL };
  const finish = (n = 0) => children[n]!.proc.emitLine({ method: "turn/completed", params: { threadId: `native-${n + 1}`, turn: { id: "turn", status: "completed" } } });
  const spawned = async (n = 1) => { while (children.length < n) await new Promise(r => setTimeout(r, 5)); return children[n - 1]!; };
  return { home, connections, connection, target, execution, spawnImpl, children, thread, opts, finish, spawned };
}

test("a local child gets a private home, an allowlisted environment, the token in one variable the shell cannot see, and the pinned model", async () => {
  process.env.MODEX_LM3_INHERITED_SENTINEL = "must-not-reach-child";
  process.env.HTTPS_PROXY = "http://proxy.example:3128";
  const h = setup();
  try {
    const run = h.execution.backend(h.thread).runTurn("read", h.opts, collectSink().sink, new AbortController().signal);
    const child = await h.spawned();
    await child.proc.waitFor(line => line.includes('"turn/start"'));
    const env = child.opts.env!;
    assert.equal(env.MODEX_LOCAL_TOKEN, "LOCAL_TOKEN_SENTINEL");
    assert.equal(env.MODEX_LM3_INHERITED_SENTINEL, undefined);
    assert.equal(env.HTTPS_PROXY, undefined);
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.NO_PROXY, "*");
    assert.notEqual(env.HOME, process.env.HOME);
    assert.ok(env.CODEX_HOME!.startsWith(path.join(h.home, "app", "local-codex")));
    assert.equal(fs.existsSync(env.CODEX_HOME!), true, "Codex needs its home to exist before it starts");
    assert.equal((fs.statSync(path.dirname(env.CODEX_HOME!)).mode & 0o777), 0o700);
    assert.equal(child.args.join(" ").includes("LOCAL_TOKEN_SENTINEL"), false, "the token never goes on a command line");
    for (const setting of ['model_provider="modex_local"', 'model_providers.modex_local.base_url="http://127.0.0.1:18501/v1"', 'model_providers.modex_local.env_key="MODEX_LOCAL_TOKEN"',
      "model_context_window=32768", "model_auto_compact_token_limit=27852", 'web_search="disabled"', "features.view_image=false", 'shell_environment_policy.exclude=["MODEX_LOCAL_TOKEN"]']) {
      assert.ok(child.args.includes(setting), `expected ${setting} in ${child.args.join(" ")}`);
    }
    // Reasoning summaries are a cloud-model option with no local qualification: neither the child's
    // arguments nor the thread configuration ask for them (the cloud backend still does; see codex-backend tests).
    assert.equal(child.args.some(arg => arg.includes("model_reasoning_summary")), false, `no reasoning-summary override in ${child.args.join(" ")}`);
    const start = child.proc.sent(m => m.method === "thread/start")[0]!;
    assert.equal(start.params.model, MODEL);
    assert.equal(start.params.modelProvider, "modex_local");
    assert.equal(start.params.allowProviderModelFallback, false);
    assert.deepEqual(start.params.config, {}, "thread configuration carries no reasoning-summary option for a local provider");
    const turn = child.proc.sent(m => m.method === "turn/start")[0]!;
    assert.equal(turn.params.effort, null, "no effort is sent without local qualification");
    assert.equal(turn.params.serviceTierForTurn, null);
    h.finish();
    assert.equal((await run).status, "completed");
  } finally { await h.execution.dispose(); delete process.env.MODEX_LM3_INHERITED_SENTINEL; delete process.env.HTTPS_PROXY; }
});

test("a child without a token sets no credential variable or env_key", async () => {
  const h = setup({ token: null });
  try {
    const run = h.execution.backend(h.thread).runTurn("read", h.opts, collectSink().sink, new AbortController().signal);
    const child = await h.spawned();
    await child.proc.waitFor(line => line.includes('"turn/start"'));
    assert.equal("MODEX_LOCAL_TOKEN" in child.opts.env!, false);
    assert.equal(child.args.some(arg => arg.includes("env_key")), false);
    h.finish();
    assert.equal((await run).status, "completed");
  } finally { await h.execution.dispose(); }
});

test("the same thread reuses its child and native session; a restart refuses the old handle rather than resuming it elsewhere", async () => {
  const h = setup();
  try {
    const events = collectSink();
    const first = h.execution.backend(h.thread).runTurn("one", h.opts, events.sink, new AbortController().signal);
    const child = await h.spawned();
    await child.proc.waitFor(line => line.includes('"turn/start"'));
    h.finish();
    assert.equal((await first).status, "completed");
    assert.ok(events.events.includes("session:native-1"));
    const second = h.execution.backend(h.thread).runTurn("two", { ...h.opts, resume: "native-1" }, collectSink().sink, new AbortController().signal);
    await child.proc.waitFor(line => line.includes('"turn/start"') && line.includes('"two"'));
    assert.equal(h.children.length, 1, "the second turn runs on the same child");
    assert.equal(child.proc.sent(m => m.method === "thread/resume").length, 0, "a session the child opened is not re-opened");
    h.finish();
    assert.equal((await second).status, "completed");
    const home = child.opts.env!.HOME!;
    await h.execution.dispose();
    assert.equal(fs.existsSync(home), false, "the private home goes with the child");
    const stopped = await h.execution.backend(h.thread).runTurn("three", { ...h.opts, resume: "native-1" }, collectSink().sink, new AbortController().signal);
    assert.equal(stopped.status, "failed");
    assert.match(stopped.error!, /has stopped/);
    // The next Modex process: the persisted handle names a session no child of its own opened.
    const restarted = new LocalExecution(h.home, h.connections, "codex", h.spawnImpl);
    const again = await restarted.backend(h.thread).runTurn("three", { ...h.opts, resume: "native-1" }, collectSink().sink, new AbortController().signal);
    assert.equal(again.status, "failed");
    assert.match(again.error!, /Modex restarted/);
    assert.equal(h.children.length, 1, "nothing is spawned for a handle from another process");
  } finally { await h.execution.dispose(); }
});

test("a rotated token, a deleted connection or a stale revision fails before any process starts", async () => {
  const h = setup();
  try {
    h.connections.update(h.connection.id, 1, { token: "ROTATED" });
    const stale = await h.execution.backend(h.thread).runTurn("read", h.opts, collectSink().sink, new AbortController().signal);
    assert.equal(stale.status, "failed");
    assert.match(stale.error!, /changed or was deleted/);
    assert.equal(h.children.length, 0);
    const current = { ...h.thread, localTarget: { ...h.target, model: { ...h.target.model, connection: { id: h.connection.id, revision: 2 } } } };
    const run = h.execution.backend(current).runTurn("read", h.opts, collectSink().sink, new AbortController().signal);
    const child = await h.spawned();
    await child.proc.waitFor(line => line.includes('"turn/start"'));
    assert.equal(child.opts.env!.MODEX_LOCAL_TOKEN, "ROTATED");
    h.finish();
    assert.equal((await run).status, "completed");
    h.connections.delete(h.connection.id, 2);
    const gone = await h.execution.backend(current).runTurn("read", { ...h.opts, resume: "native-1" }, collectSink().sink, new AbortController().signal);
    assert.equal(gone.status, "failed");
    assert.equal(h.children.length, 1);
  } finally { await h.execution.dispose(); }
});

test("a changed target between turns starts a fresh child and drops the old native session", async () => {
  const h = setup();
  try {
    const first = h.execution.backend(h.thread).runTurn("one", h.opts, collectSink().sink, new AbortController().signal);
    const child = await h.spawned();
    await child.proc.waitFor(line => line.includes('"turn/start"'));
    h.finish();
    assert.equal((await first).status, "completed");
    const wider = { ...h.thread, localContextTokens: 65536 };
    const resumed = await h.execution.backend(wider).runTurn("two", { ...h.opts, resume: "native-1" }, collectSink().sink, new AbortController().signal);
    assert.equal(resumed.status, "failed", "the old handle does not carry over to a different configuration");
    assert.match(resumed.error!, /target changed/);
    const fresh = h.execution.backend(wider).runTurn("two", h.opts, collectSink().sink, new AbortController().signal);
    const next = await h.spawned(2);
    await next.proc.waitFor(line => line.includes('"turn/start"'));
    assert.ok(next.args.includes("model_context_window=65536"));
    assert.equal(child.proc.killed, true, "the previous child is ended");
    h.finish(1);
    assert.equal((await fresh).status, "completed");
  } finally { await h.execution.dispose(); }
});

test("inherited project configuration, localhost names, unqualified features and an account are refused before spawn", async () => {
  const h = setup();
  try {
    const refused = async (thread: typeof h.thread, opts: TurnOptions, pattern: RegExp) => {
      const result = await h.execution.backend(thread).runTurn("read", opts, collectSink().sink, new AbortController().signal);
      assert.equal(result.status, "failed");
      assert.match(result.error!, pattern);
      assert.equal(h.children.length, 0);
    };
    await refused(h.thread, { ...h.opts, plan: true }, /not qualified/);
    await refused(h.thread, { ...h.opts, knowledge: { url: "http://127.0.0.1:1/mcp", instructions: "" } }, /not qualified/);
    await refused(h.thread, { ...h.opts, attachments: [{ name: "a.png", mime: "image/png", kind: "image", path: "/a.png" }] }, /not qualified/);
    await refused(h.thread, { ...h.opts, account: "chatgpt-1" }, /target changed/);
    await refused(h.thread, { ...h.opts, model: "gpt-6-astra" }, /target changed/);
    await refused({ ...h.thread, localContextTokens: 1024 }, h.opts, /context window/);
    const named = h.connections.create({ label: "Named", runtime: "responses", url: "http://localhost:18502" });
    await refused({ ...h.thread, localTarget: { ...h.target, model: { ...h.target.model, connection: { id: named.id, revision: 1 } } } }, h.opts, /loopback IP/);
    fs.mkdirSync(path.join(h.thread.cwd, ".codex"));
    fs.writeFileSync(path.join(h.thread.cwd, ".codex", "config.toml"), 'model_provider="openai"');
    await refused(h.thread, h.opts, /project \.codex/);
  } finally { await h.execution.dispose(); }
});

test("one turn at a time reaches a port; a stopped wait starts nothing, and every loopback alias of the port shares the slot", async () => {
  const h = setup();
  try {
    const first = h.execution.backend(h.thread).runTurn("first", h.opts, collectSink().sink, new AbortController().signal);
    const child = await h.spawned();
    await child.proc.waitFor(line => line.includes('"turn/start"'));
    const mapped = h.connections.create({ label: "mapped", runtime: "responses", url: "http://[::ffff:127.0.0.1]:18501" });
    const alias = { ...h.thread, id: "modex-2", localTarget: { ...h.target, model: { ...h.target.model, connection: { id: mapped.id, revision: 1 } } } };
    const abort = new AbortController();
    const queued = h.execution.backend(alias).runTurn("second", h.opts, collectSink().sink, abort.signal);
    await new Promise(r => setTimeout(r, 30));
    assert.equal(h.children.length, 1, "the alias waits for the running turn");
    abort.abort();
    assert.equal((await queued).status, "interrupted");
    assert.equal(h.children.length, 1, "a stopped wait never spawned");
    h.finish();
    assert.equal((await first).status, "completed");
    const after = h.execution.backend(alias).runTurn("third", h.opts, collectSink().sink, new AbortController().signal);
    const next = await h.spawned(2);
    await next.proc.waitFor(line => line.includes('"turn/start"'));
    h.finish(1);
    assert.equal((await after).status, "completed");
  } finally { await h.execution.dispose(); }
});

test("force-stop reaches only the thread's own child", async () => {
  const h = setup();
  try {
    const other = { ...h.thread, id: "modex-2", cwd: tmpdir("lm3-cwd-") };
    const a = h.execution.backend(h.thread).runTurn("a", h.opts, collectSink().sink, new AbortController().signal);
    const first = await h.spawned();
    await first.proc.waitFor(line => line.includes('"turn/start"'));
    h.finish();
    await a;
    const b = h.execution.backend(other).runTurn("b", { ...h.opts, cwd: other.cwd }, collectSink().sink, new AbortController().signal);
    const second = await h.spawned(2);
    await second.proc.waitFor(line => line.includes('"turn/start"'));
    await h.execution.backend(other).forceStop!();
    assert.equal(second.proc.killed, true);
    assert.equal(first.proc.killed, false, "another thread's child keeps running");
    assert.equal((await b).status, "failed");
  } finally { await h.execution.dispose(); }
});

test("the child's effective configuration is read and admitted before any thread opens, and recorded as provenance", async () => {
  const h = setup();
  try {
    const run = h.execution.backend(h.thread).runTurn("read", h.opts, collectSink().sink, new AbortController().signal);
    const child = await h.spawned();
    await child.proc.waitFor(line => line.includes('"turn/start"'));
    const methods = child.proc.sent().map(m => m.method).filter(m => ["config/read", "configRequirements/read", "thread/start", "turn/start"].includes(m));
    assert.deepEqual(methods, ["config/read", "configRequirements/read", "thread/start", "turn/start"]);
    const read = child.proc.sent(m => m.method === "config/read")[0]!;
    assert.deepEqual(read.params, { includeLayers: true, cwd: h.thread.cwd });
    h.finish();
    assert.equal((await run).status, "completed");
    const provenance = h.execution.provenance(h.thread.id)!;
    assert.equal(provenance.sessionFlags, "sha256:flags");
    assert.deepEqual(provenance.layers.map(l => l.source), ["sessionFlags", "user", "system"]);
  } finally { await h.execution.dispose(); }
});

test("a configuration another layer governs, managed requirements or a Codex without config/read refuse the turn before thread/start", async () => {
  const cases: [string, Parameters<typeof setup>[0], RegExp][] = [
    ["managed base_url", { configRead: r => { r.origins["model_providers.modex_local.base_url"] = { name: { type: "system", file: "/etc/codex/config.toml" }, version: "sha256:m" }; return r; } }, /the system configuration at \/etc\/codex\/config.toml sets `model_providers.modex_local.base_url`/],
    ["effective destination", { configRead: r => { r.config.model_providers.modex_local.base_url = "https://api.openai.com/v1"; return r; } }, /`model_providers.modex_local.base_url` is "https:\/\/api.openai.com\/v1"/],
    ["requirements", { requirements: { allowedSandboxModes: ["read-only"] } }, /managed requirements/],
    ["old codex", { configRead: () => new Error("Method not found: config/read") }, /did not report its effective configuration \(Method not found: config\/read\)\. Local execution needs codex-cli 0.164.0 or later/],
  ];
  for (const [name, input, pattern] of cases) {
    const h = setup(input);
    try {
      const result = await h.execution.backend(h.thread).runTurn("read", h.opts, collectSink().sink, new AbortController().signal);
      assert.equal(result.status, "failed", name);
      assert.match(result.error!, pattern, name);
      const child = h.children[0]!;
      assert.equal(child.proc.sent(m => m.method === "thread/start").length, 0, `${name}: no thread is opened`);
      assert.equal(child.proc.sent(m => m.method === "turn/start").length, 0, `${name}: no content is sent`);
      assert.equal(h.execution.provenance(h.thread.id), undefined, `${name}: nothing was admitted`);
    } finally { await h.execution.dispose(); }
  }
});

test("a model reroute on a local turn interrupts it and reports it failed, never continued", async () => {
  const h = setup({ rerouted: true });
  try {
    const { sink, events } = collectSink();
    const result = await h.execution.backend(h.thread).runTurn("read", h.opts, sink, new AbortController().signal);
    assert.equal(result.status, "failed");
    assert.match(result.error!, /rerouted the turn from qwen3.8-flash-next-iq3_s to gpt-5.1-codex \(\{"type":"modelUnavailable"\}\)\. Local execution runs only the selected model, so a stop was requested/);
    const child = h.children[0]!;
    assert.equal(child.proc.sent(m => m.method === "turn/interrupt").length, 1, "the turn is interrupted at once");
    assert.ok(events.some(e => e.startsWith("notice:error:") && /rerouted/.test(e)), "the reroute is reported in the transcript");
  } finally { await h.execution.dispose(); }
});
