import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { SpawnOptions } from "node:child_process";
import { LocalConnectionStore } from "../src/main/engine/local-models/connections.js";
import { LocalExecution } from "../src/main/engine/local-models/execution.js";
import { LocalModelsService } from "../src/main/engine/local-models/service.js";
import { ThreadRunner, type RunnerOptions } from "../src/main/engine/runner.js";
import { Router } from "../src/main/engine/routing/router.js";
import { SecretStore, testCipher } from "../src/main/engine/secrets.js";
import { Store } from "../src/main/engine/store.js";
import type { ThreadEvent } from "../src/shared/types.js";
import { FakeProcess, fakeSpawn } from "./fakeproc.js";
import { gitRepo, tmpdir } from "./helpers.js";

const MODEL = "scripted-fixture-model";
const TOKEN = "LM2-AC3-TOKEN-7d1e";

function reported(args: string[]) {
  const flags: Record<string, any> = {};
  const origins: Record<string, unknown> = {};
  const origin = { name: { type: "sessionFlags" }, version: "sha256:flags" };
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "-c") continue;
    const setting = args[++i]!; const eq = setting.indexOf("=");
    const keys = setting.slice(0, eq).split("."); const value = JSON.parse(setting.slice(eq + 1));
    let node = flags; for (const key of keys.slice(0, -1)) node = node[key] ??= {}; node[keys.at(-1)!] = value;
    origins[keys.join(".")] = origin;
  }
  const config: Record<string, any> = { model: null, model_reasoning_summary: null, openai_base_url: null, mcp_servers: {}, ...structuredClone(flags) };
  for (const provider of Object.values(config.model_providers ?? {}) as Record<string, unknown>[]) Object.assign(provider, { experimental_bearer_token: null, auth: null, http_headers: null, env_http_headers: null, query_params: null, ...provider });
  return { config, origins, layers: [{ name: { type: "sessionFlags" }, version: "sha256:flags", config: flags }, { name: { type: "user", file: "/private/home/.codex/config.toml", profile: null }, version: "sha256:empty", config: {} }, { name: { type: "system", file: "/etc/codex/config.toml" }, version: "sha256:empty", config: {} }] };
}

type Turn = (proc: FakeProcess, done: (status: "completed" | "failed", message?: string) => void) => void;

/** A real runner and real local execution over a scripted Codex whose every output repeats the connection's token. */
async function setup(turn: Turn) {
  const home = tmpdir("lm2-ac3-");
  const store = new Store(home);
  const secrets = new SecretStore(home, testCipher);
  const connections = new LocalConnectionStore(home, secrets);
  const connection = connections.create({ label: "Local", runtime: "responses", url: "http://127.0.0.1:18512/v1", token: TOKEN });
  const spawnImpl = ((bin: string, args: string[], opts: SpawnOptions) => {
    const proc = new FakeProcess();
    proc.stdin.on("data", (d: Buffer) => {
      for (const line of d.toString().trim().split("\n")) {
        const m = JSON.parse(line);
        if (m.method === "initialize") proc.emitLine({ id: m.id, result: { userAgent: "codex/0.166.0" } });
        if (m.method === "config/read") proc.emitLine({ id: m.id, result: reported(args) });
        if (m.method === "configRequirements/read") proc.emitLine({ id: m.id, result: { supportsIndependentSpeedModes: true, requirements: null } });
        if (m.method === "thread/start") proc.emitLine({ id: m.id, result: { thread: { id: "native-1" }, model: m.params.model, modelProvider: m.params.modelProvider } });
        if (m.method === "turn/start") {
          proc.emitLine({ id: m.id, result: { turn: { id: "turn" } } });
          proc.emitLine({ method: "turn/started", params: { threadId: "native-1", turn: { id: "turn" } } });
          turn(proc, (status, message) => proc.emitLine({ method: "turn/completed", params: { threadId: "native-1", turn: { id: "turn", status, ...(message ? { error: { message } } : {}) } } }));
        }
      }
    });
    return fakeSpawn(proc).spawn(bin, args, opts);
  }) as ConstructorParameters<typeof LocalExecution>[3];
  const local = new LocalExecution(home, connections, "codex", spawnImpl);
  const events: ThreadEvent[] = [];
  const router = new Router({ home, policy: () => store.settings.routing, listModels: async () => ({ models: [] }), transport: async () => ({ answers: {} }) });
  const unused = { id: "codex", listModels: async () => [], dispose: async () => {}, runTurn: async () => { throw new Error("a local turn reached the cloud backend"); } };
  const runner = new ThreadRunner({ home, store, router, emit: (e: ThreadEvent) => events.push(e), backends: { codex: unused }, localExecution: local } as unknown as RunnerOptions);
  const thread = await runner.createThread(store.addProject(gitRepo()).id, { backend: "codex", model: "gpt-6-astra", auto: true });
  runner.updateThread(thread.id, { localTarget: { schema: 1, harness: "codex", model: { schema: 1, connection: { id: connection.id, revision: 1 }, id: MODEL } }, localContextTokens: 32768 });
  return { home, store, secrets, local, runner, thread, events };
}

/** Every record a person can read or carry away. A `secrets.json` entry holds the token only as ciphertext, so it is read as its bytes too. */
function records(h: Awaited<ReturnType<typeof setup>>): Record<string, string> {
  const out: Record<string, string> = {
    "renderer events": JSON.stringify(h.events),
    "thread snapshot": JSON.stringify(h.store.thread(h.thread.id)),
    "thread items": JSON.stringify(h.store.items(h.thread.id)),
    "configuration provenance": JSON.stringify(h.local.provenance(h.thread.id) ?? null),
  };
  for (const name of fs.readdirSync(h.home, { recursive: true, encoding: "utf8" })) {
    const file = path.join(h.home, name);
    if (fs.statSync(file).isFile()) out[`disk: ${name}`] = fs.readFileSync(file, "latin1");
  }
  return out;
}

function assertNoToken(h: Awaited<ReturnType<typeof setup>>, reached: RegExp): void {
  const found = records(h);
  assert.ok(Object.values(found).some(text => reached.test(text)), `the scripted output never reached a record, so this check proved nothing: ${Object.keys(found).join(", ")}`);
  for (const [where, text] of Object.entries(found)) {
    assert.equal(text.includes(TOKEN), false, `the token reached ${where}`);
    assert.equal(text.includes(TOKEN.slice(-8)), false, `the token's tail reached ${where}`);
  }
}

test("a token repeated in a local turn's message, tool output and diagnostics reaches no renderer event, snapshot, record or file", async () => {
  const h = await setup((proc, done) => {
    proc.stderr.write(`warn: request with bearer ${TOKEN}\n`);
    proc.emitLine({ method: "item/started", params: { threadId: "native-1", turnId: "turn", item: { type: "commandExecution", id: "c1", command: `curl -H "Authorization: Bearer ${TOKEN}" http://127.0.0.1/`, cwd: "/tmp", status: "inProgress" } } });
    proc.emitLine({ method: "item/commandExecution/outputDelta", params: { threadId: "native-1", turnId: "turn", itemId: "c1", delta: `TOOL-MARK ${TOKEN}\n` } });
    proc.emitLine({ method: "item/completed", params: { threadId: "native-1", turnId: "turn", item: { type: "commandExecution", id: "c1", command: `curl ${TOKEN}`, cwd: "/tmp", status: "completed", exitCode: 0, aggregatedOutput: `TOOL-MARK ${TOKEN}\n` } } });
    proc.emitLine({ method: "item/started", params: { threadId: "native-1", turnId: "turn", item: { type: "agentMessage", id: "m1", text: "", phase: "final_answer" } } });
    proc.emitLine({ method: "item/agentMessage/delta", params: { threadId: "native-1", turnId: "turn", itemId: "m1", delta: `REPLY-MARK ${TOKEN}` } });
    proc.emitLine({ method: "item/completed", params: { threadId: "native-1", turnId: "turn", item: { type: "agentMessage", id: "m1", text: `REPLY-MARK ${TOKEN}`, phase: "final_answer" } } });
    done("completed");
  });
  try {
    await h.runner.send(h.thread.id, "read");
    assert.equal(h.store.thread(h.thread.id)!.status, "idle");
    assertNoToken(h, /REPLY-MARK/);
    assertNoToken(h, /TOOL-MARK/);
  } finally { await h.runner.dispose(); }
});

test("a failed local turn's error and the child's stderr are redacted in the failure record and its diagnostic detail", async () => {
  const h = await setup((proc, done) => {
    proc.stderr.write(`fatal: bearer ${TOKEN} refused\n`);
    proc.emitLine({ method: "error", params: { threadId: "native-1", turnId: "turn", willRetry: false, error: { message: `upstream rejected ${TOKEN}` } } });
    done("failed", `FAIL-MARK server said ${TOKEN}`);
  });
  try {
    await h.runner.send(h.thread.id, "read");
    assertNoToken(h, /FAIL-MARK/);
  } finally { await h.runner.dispose(); }
});

test("a local child that dies leaves only redacted stderr in the failure detail", async () => {
  const h = await setup(proc => {
    proc.stderr.write(`EXIT-MARK panic with bearer ${TOKEN}\n`);
    setTimeout(() => proc.close(101), 20);
  });
  try {
    await h.runner.send(h.thread.id, "read");
    assertNoToken(h, /EXIT-MARK/);
  } finally { await h.runner.dispose(); }
});

test("a token split across streamed message and tool deltas never reassembles in a renderer event, a record or the kept tool log", async () => {
  const cut = TOKEN.length >> 1;
  // Past the transcript's preview, so main keeps the raw output as a tool log on disk.
  const filler = "x".repeat(300 * 1024);
  const h = await setup((proc, done) => {
    proc.emitLine({ method: "item/started", params: { threadId: "native-1", turnId: "turn", item: { type: "commandExecution", id: "c1", command: "cat", cwd: "/tmp", status: "inProgress" } } });
    proc.emitLine({ method: "item/commandExecution/outputDelta", params: { threadId: "native-1", turnId: "turn", itemId: "c1", delta: `TOOL-SPLIT-MARK ${TOKEN.slice(0, cut)}` } });
    proc.emitLine({ method: "item/commandExecution/outputDelta", params: { threadId: "native-1", turnId: "turn", itemId: "c1", delta: `${TOKEN.slice(cut)}\n${filler}` } });
    proc.emitLine({ method: "item/completed", params: { threadId: "native-1", turnId: "turn", item: { type: "commandExecution", id: "c1", command: "cat", cwd: "/tmp", status: "completed", exitCode: 0 } } });
    proc.emitLine({ method: "item/started", params: { threadId: "native-1", turnId: "turn", item: { type: "agentMessage", id: "m1", text: "", phase: "final_answer" } } });
    proc.emitLine({ method: "item/agentMessage/delta", params: { threadId: "native-1", turnId: "turn", itemId: "m1", delta: `SPLIT-MARK ${TOKEN.slice(0, cut)}` } });
    proc.emitLine({ method: "item/agentMessage/delta", params: { threadId: "native-1", turnId: "turn", itemId: "m1", delta: TOKEN.slice(cut) } });
    proc.emitLine({ method: "item/completed", params: { threadId: "native-1", turnId: "turn", item: { type: "agentMessage", id: "m1", text: `SPLIT-MARK ${TOKEN}`, phase: "final_answer" } } });
    done("completed");
  });
  try {
    await h.runner.send(h.thread.id, "read");
    assertNoToken(h, /SPLIT-MARK/);
    assertNoToken(h, /TOOL-SPLIT-MARK/);
    const found = records(h);
    assert.ok(Object.keys(found).some(where => where.startsWith("disk:") && found[where]!.includes("TOOL-SPLIT-MARK")), `the long output reached no file on disk, so the tool log went unchecked: ${Object.keys(found).join(", ")}`);
    for (const [where, text] of Object.entries(found)) assert.equal(text.includes(TOKEN.slice(0, cut)), false, `the token's start reached ${where}`);
  } finally { await h.runner.dispose(); }
});

test("a discovery failure that repeats the token in its status, headers or body leaves it out of every reply", async () => {
  for (const [status, body] of [[401, `{"error":"bad bearer ${TOKEN}"}`], [500, `panic ${TOKEN}`], [200, `not json ${TOKEN}`]] as const) {
    const server = http.createServer((_req, res) => { res.writeHead(status, { "x-echo": TOKEN }); res.end(body); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const home = tmpdir("lm2-ac3-discovery-");
    try {
      const service = new LocalModelsService(home, new SecretStore(home, testCipher), { timeoutMs: 1000 });
      const created = await service.handle({ op: "create", input: { label: "Local", runtime: "responses", url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token: TOKEN } });
      const connection = (created as { connection: { id: string; revision: number } }).connection;
      const reply = await service.handle({ op: "discover", connection: { id: connection.id, revision: connection.revision }, requestId: "r1" });
      assert.equal(JSON.stringify(reply).includes(TOKEN), false, `status ${status} repeated the token in a reply: ${JSON.stringify(reply)}`);
      assert.equal(JSON.stringify(await service.handle({ op: "list" })).includes(TOKEN), false);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  }
});
