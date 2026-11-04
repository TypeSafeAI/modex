import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { spawnSync } from "node:child_process";
import { cliSpawn } from "../src/main/engine/backends/health.js";
import type { CliExecutable } from "../src/main/engine/cli-path.js";
import { LocalConnectionStore } from "../src/main/engine/local-models/connections.js";
import { LocalExecution } from "../src/main/engine/local-models/execution.js";
import { SecretStore, testCipher } from "../src/main/engine/secrets.js";
import type { Observation } from "../src/shared/conversation-events.js";
import type { TurnSink } from "../src/main/engine/backends/types.js";
import { globalCodexConfig, realCodexConfig } from "./local-global-config-guard.js";
import { tmpdir } from "./helpers.js";

/**
 * LM-3's native checks (#379), each run only on request because each starts the installed `codex` CLI:
 *
 * - `MODEX_LM3_WIRE=1`: the real Codex against a scripted loopback Responses server in this process.
 *   It proves the harness path (private home, pinned provider, token handling, a real shell tool run
 *   by Codex, the sentinel coming back in the next request) with no model and no inference.
 * - `MODEX_LM3_LIVE=1` with `MODEX_LM3_URL` and `MODEX_LM3_MODEL` (and `MODEX_LM3_TOKEN`,
 *   `MODEX_LM3_CONTEXT` as needed): the same turn against a server the person already runs. AC1.
 *   Modex starts, installs and downloads nothing; the server and model are the person's.
 *
 * - `MODEX_LM3_WIRE=1` also runs the redirect check (#380): the configured loopback server answers with a
 *   307 to a second loopback server, and the receipt records what Codex's HTTP client did with the
 *   request body and the bearer token. Codex has no setting that constrains redirects; this records the
 *   behaviour Modex documents rather than a boundary it enforces.
 *
 * Each writes a receipt under `MODEX_LM3_REPORT` (a directory) when set: request shapes, offered tool
 * names, whether the token was ever reflected into model input, the configuration provenance the child
 * was admitted on, and the turn's result. Never the token.
 */

const SENTINEL = "LM3-FIXTURE-SENTINEL-7f3a";
const TOKEN = "LM3_WIRE_TOKEN_a1b2c3";
const EDITED = "LM3-APPROVED-EDIT-8c42\n";
const CHECK = `const fs = require('node:fs'); const ok = fs.readFileSync('result.txt', 'utf8') === ${JSON.stringify(EDITED)}; fs.appendFileSync('checks.jsonl', JSON.stringify({ok, exitCode: ok ? 0 : 1}) + ${JSON.stringify("\n")}); console.log(ok ? 'fixture check passed' : 'fixture check failed'); process.exit(ok ? 0 : 1);\n`;

test("the live smoke's independent check fails on wrong file bytes and records the real exit result", () => {
  const cwd = workspace();
  fs.writeFileSync(path.join(cwd, "check.cjs"), CHECK);
  fs.writeFileSync(path.join(cwd, "result.txt"), "wrong\n");
  assert.equal(spawnSync(process.execPath, ["check.cjs"], { cwd }).status, 1);
  fs.writeFileSync(path.join(cwd, "result.txt"), EDITED);
  assert.equal(spawnSync(process.execPath, ["check.cjs"], { cwd }).status, 0);
  assert.deepEqual(fs.readFileSync(path.join(cwd, "checks.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line)), [{ ok: false, exitCode: 1 }, { ok: true, exitCode: 0 }]);
});

interface Seen { path: string; model: unknown; toolNames: string[]; hasSentinel: boolean; credentialReflected: boolean; authorization: "bearer" | "none" | "other" }

function sinkFor(observations: Observation[], notices: string[]): TurnSink {
  return {
    observe: o => { observations.push(o); },
    approval: async () => "no",
    notice: (level, text) => { notices.push(`${level}: ${text}`); },
    session: () => {},
  };
}

function record(name: string, receipt: unknown): void {
  const dir = process.env.MODEX_LM3_REPORT;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(receipt, null, 2) + "\n");
}

function workspace(): string {
  const cwd = tmpdir("lm3-native-cwd-");
  fs.writeFileSync(path.join(cwd, "fixture.txt"), `${SENTINEL}\n`);
  return cwd;
}

/** A Responses server that asks for one shell read, then answers once it sees the sentinel come back. */
function scriptedResponses(seen: Seen[]): Promise<http.Server> {
  const sse = (res: http.ServerResponse, events: Record<string, unknown>[]) => {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    for (const event of events) res.write(`event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  };
  const completed = (id: string, output: unknown[]) => ({ type: "response.completed", response: { id, object: "response", status: "completed", output, usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 0 }, output_tokens: 30, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 130 } } });
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(raw); } catch { /* recorded as empty */ }
      const tools = Array.isArray(body.tools) ? body.tools as { name?: string; type?: string }[] : [];
      const auth = req.headers.authorization ?? "";
      seen.push({ path: req.url ?? "", model: body.model, toolNames: tools.map(t => t.name ?? t.type ?? "?"), hasSentinel: raw.includes(SENTINEL), credentialReflected: raw.includes(TOKEN),
        authorization: auth === `Bearer ${TOKEN}` ? "bearer" : auth ? "other" : "none" });
      if (req.url !== "/v1/responses" || req.method !== "POST") { res.writeHead(404); res.end(); return; }
      if (auth !== `Bearer ${TOKEN}`) { res.writeHead(401); res.end(); return; }
      const n = seen.length;
      if (!raw.includes(SENTINEL)) {
        const exec = tools.find(t => t.name === "exec_command") ? "exec_command" : tools.find(t => t.name === "shell") ? "shell" : null;
        if (!exec) { res.writeHead(500); res.end("no shell tool offered"); return; }
        const args = exec === "exec_command" ? { cmd: "cat fixture.txt" } : { command: ["cat", "fixture.txt"] };
        const item = { type: "function_call", id: `fc_${n}`, call_id: `call_${n}`, name: exec, arguments: JSON.stringify(args), status: "completed" };
        sse(res, [{ type: "response.created", response: { id: `resp_${n}`, object: "response", status: "in_progress", output: [] } }, { type: "response.output_item.added", output_index: 0, item }, { type: "response.output_item.done", output_index: 0, item }, completed(`resp_${n}`, [item])]);
      } else {
        const item = { type: "message", id: `msg_${n}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: `The file contains ${SENTINEL}.`, annotations: [] }] };
        sse(res, [{ type: "response.created", response: { id: `resp_${n}`, object: "response", status: "in_progress", output: [] } }, { type: "response.output_item.added", output_index: 0, item }, { type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: item.id, delta: `The file contains ${SENTINEL}.` }, { type: "response.output_item.done", output_index: 0, item }, completed(`resp_${n}`, [item])]);
      }
    });
  });
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(server)));
}

test("the installed Codex runs a shell read through LocalExecution against a scripted loopback Responses server", { skip: !process.env.MODEX_LM3_WIRE && "set MODEX_LM3_WIRE=1 to start the installed codex CLI", timeout: 120_000 }, async () => {
  const seen: Seen[] = [];
  const server = await scriptedResponses(seen);
  const global = globalCodexConfig();
  const home = tmpdir("lm3-wire-home-");
  const connections = new LocalConnectionStore(home, new SecretStore(home, testCipher));
  const execution = new LocalExecution(home, connections);
  const observations: Observation[] = [];
  const notices: string[] = [];
  try {
    const port = (server.address() as AddressInfo).port;
    const connection = connections.create({ label: "Wire fixture", runtime: "responses", url: `http://127.0.0.1:${port}/v1`, token: TOKEN });
    const model = "scripted-fixture-model";
    const thread = { id: "wire-1", cwd: workspace(), localTarget: { schema: 1 as const, harness: "codex" as const, model: { schema: 1 as const, connection: { id: connection.id, revision: 1 }, id: model } }, localContextTokens: 32768 };
    const result = await execution.backend(thread).runTurn("Read fixture.txt and tell me the word it contains.", { cwd: thread.cwd, mode: "agent", plan: false, model }, sinkFor(observations, notices), AbortSignal.timeout(90_000));
    const tools = observations.filter(o => o.type === "tool.start").map(o => (o as Extract<Observation, { type: "tool.start" }>).tool);
    const done = observations.filter(o => o.type === "tool.done").map(o => (o as Extract<Observation, { type: "tool.done" }>).outcome);
    const reply = observations.filter(o => o.type === "message.done").map(o => (o as Extract<Observation, { type: "message.done" }>).text ?? "").join("\n");
    const provenance = execution.provenance(thread.id);
    record("wire", { kind: "scripted Responses fixture with the installed codex CLI and a real shell tool run; not a model test", cli: process.env.MODEX_CODEX_BIN ?? "codex", requests: seen, tools, outcomes: done, reply, notices, provenance, result: { status: result.status, error: result.error, usage: result.usage } });
    assert.equal(result.status, "completed", `turn failed: ${result.error} ${JSON.stringify(result.detail)} notices=${notices.join(" | ")}`);
    assert.ok(seen.length >= 2, `expected two Responses requests, saw ${seen.length}`);
    assert.ok(seen.every(r => r.path === "/v1/responses" && r.model === model && r.authorization === "bearer"), JSON.stringify(seen));
    assert.equal(seen[0]!.hasSentinel, false);
    assert.equal(seen.at(-1)!.hasSentinel, true, "the shell read's output reached the next model request");
    assert.ok(seen.every(r => !r.credentialReflected), "the token never appears in model input");
    assert.ok(seen.every(r => !r.toolNames.includes("view_image") && !r.toolNames.includes("web_search")), `unqualified tools offered: ${seen[0]!.toolNames.join(", ")}`);
    assert.ok(tools.some(t => t.name === "shell"), `no shell tool observed: ${JSON.stringify(tools)}`);
    assert.ok(done.includes("succeeded"), `tool outcomes: ${done.join(", ")}`);
    assert.match(reply, new RegExp(SENTINEL));
    assert.ok(provenance, "the child was admitted on its effective configuration");
    assert.ok(provenance.layers.some(l => l.source === "sessionFlags"), JSON.stringify(provenance));
    assert.equal(provenance.managedRequirements, false);
    await execution.dispose();
    assert.deepEqual(global.unchanged(), { sha256: global.sha256, bytes: true, mtimeMs: true, tree: true }, "AC4: the installed Codex left the person's home alone");
  } finally {
    await execution.dispose();
    global.restore();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

interface Hop { server: "A" | "B"; method: string; url: string; host: string; authorization: "bearer" | "none" | "other"; bodyBytes: number; hasPrompt: boolean }

/** Two loopback servers: A, the configured destination, redirects every request to B, which answers with a plain message. */
function redirecting(hops: Hop[], status: 307 | 302): Promise<{ a: http.Server; b: http.Server }> {
  const PROMPT = "LM5-REDIRECT-PROMPT-9c1d";
  const listen = (server: http.Server) => new Promise<http.Server>(resolve => server.listen(0, "127.0.0.1", () => resolve(server)));
  const observe = (name: "A" | "B", req: http.IncomingMessage, raw: string) => {
    const auth = req.headers.authorization ?? "";
    hops.push({ server: name, method: req.method ?? "", url: req.url ?? "", host: req.headers.host ?? "", authorization: auth === `Bearer ${TOKEN}` ? "bearer" : auth ? "other" : "none", bodyBytes: raw.length, hasPrompt: raw.includes(PROMPT) });
  };
  const b = http.createServer((req, res) => { const chunks: Buffer[] = []; req.on("data", c => chunks.push(c)); req.on("end", () => {
    observe("B", req, Buffer.concat(chunks).toString("utf8"));
    const item = { type: "message", id: "msg_b", role: "assistant", status: "completed", content: [{ type: "output_text", text: "answered by B", annotations: [] }] };
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of [{ type: "response.created", response: { id: "resp_b", object: "response", status: "in_progress", output: [] } }, { type: "response.output_item.added", output_index: 0, item }, { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id: "resp_b", object: "response", status: "completed", output: [item], usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 5, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 15 } } }]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  }); });
  const a = http.createServer((req, res) => { const chunks: Buffer[] = []; req.on("data", c => chunks.push(c)); req.on("end", () => {
    observe("A", req, Buffer.concat(chunks).toString("utf8"));
    res.writeHead(status, { location: `http://127.0.0.1:${(b.address() as AddressInfo).port}${req.url ?? "/"}` }); res.end();
  }); });
  return Promise.all([listen(a), listen(b)]).then(([a, b]) => ({ a, b }));
}

test("redirect: the installed Codex follows a 307 from the configured loopback server, re-sending the body without the token", { skip: !process.env.MODEX_LM3_WIRE && "set MODEX_LM3_WIRE=1 to start the installed codex CLI", timeout: 120_000 }, async () => {
  const receipts: Record<string, unknown> = {};
  for (const status of [307, 302] as const) {
    const hops: Hop[] = [];
    const { a, b } = await redirecting(hops, status);
    const home = tmpdir("lm5-redirect-home-");
    const connections = new LocalConnectionStore(home, new SecretStore(home, testCipher));
    const execution = new LocalExecution(home, connections);
    const observations: Observation[] = [];
    const notices: string[] = [];
    try {
      const connection = connections.create({ label: "Redirecting fixture", runtime: "responses", url: `http://127.0.0.1:${(a.address() as AddressInfo).port}/v1`, token: TOKEN });
      const model = "scripted-fixture-model";
      const thread = { id: `redirect-${status}`, cwd: workspace(), localTarget: { schema: 1 as const, harness: "codex" as const, model: { schema: 1 as const, connection: { id: connection.id, revision: 1 }, id: model } }, localContextTokens: 32768 };
      const result = await execution.backend(thread).runTurn("LM5-REDIRECT-PROMPT-9c1d: reply with one word.", { cwd: thread.cwd, mode: "chat", plan: false, model }, sinkFor(observations, notices), AbortSignal.timeout(60_000));
      const reply = observations.filter(o => o.type === "message.done").map(o => (o as Extract<Observation, { type: "message.done" }>).text ?? "").join("\n");
      receipts[String(status)] = { status, hops, reply, notices, result: { status: result.status, error: result.error } };
      const toA = hops.filter(h => h.server === "A"), toB = hops.filter(h => h.server === "B");
      assert.ok(toA.length >= 1 && toA[0]!.authorization === "bearer" && toA[0]!.hasPrompt, JSON.stringify(hops));
      // What is proven about the token: it never follows a redirect. What is documented: the body does, on a 307.
      assert.ok(toB.every(h => h.authorization === "none"), `the bearer token followed the redirect: ${JSON.stringify(hops)}`);
      if (status === 307) assert.ok(toB.some(h => h.method === "POST" && h.hasPrompt), `expected the 307 to be followed with the body (documented behaviour): ${JSON.stringify(hops)}`);
    } finally {
      await execution.dispose();
      await Promise.all([a, b].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    }
  }
  record("redirect", { kind: "installed codex CLI against a loopback server that redirects to a second loopback server; no model, no inference", cli: process.env.MODEX_CODEX_BIN ?? "codex", ...receipts });
});

type Failure = "overflow-http" | "overflow-stream" | "oom-500" | "unavailable-503" | "dropped" | "child-exit" | "stop";
interface FailureHop { n: number; path: string; model: unknown; hasToolOutput: boolean; bytes: number }

/**
 * A Responses server that asks for one side-effecting shell command, then fails the request that carries its
 * output in the way `mode` names: a context overflow (as an HTTP 400, as most local servers return it, or as a
 * streamed `response.failed`), an out-of-memory 500, a 503 while a model reloads, a connection dropped
 * mid-stream, or no answer at all while the test kills the child or stops the turn (#380 AC4).
 */
function failingResponses(mode: Failure, hops: FailureHop[], held: { request?: http.ServerResponse; arrived?: () => void }): Promise<http.Server> {
  const head = (res: http.ServerResponse) => res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const event = (res: http.ServerResponse, e: Record<string, unknown>) => res.write(`event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`);
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(raw); } catch { /* recorded as empty */ }
      const tools = Array.isArray(body.tools) ? body.tools as { name?: string }[] : [];
      const n = hops.length + 1;
      hops.push({ n, path: req.url ?? "", model: body.model, hasToolOutput: raw.includes("function_call_output"), bytes: raw.length });
      if (req.url !== "/v1/responses" || req.method !== "POST" || req.headers.authorization !== `Bearer ${TOKEN}`) { res.writeHead(404); res.end(); return; }
      if (n === 1) {
        const exec = tools.find(t => t.name === "exec_command") ? "exec_command" : "shell";
        const args = exec === "exec_command" ? { cmd: "echo ran >> tool-count.txt" } : { command: ["bash", "-lc", "echo ran >> tool-count.txt"] };
        const item = { type: "function_call", id: "fc_1", call_id: "call_1", name: exec, arguments: JSON.stringify(args), status: "completed" };
        head(res);
        for (const e of [{ type: "response.created", response: { id: "resp_1", object: "response", status: "in_progress", output: [] } }, { type: "response.output_item.added", output_index: 0, item }, { type: "response.output_item.done", output_index: 0, item },
          { type: "response.completed", response: { id: "resp_1", object: "response", status: "completed", output: [item], usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 0 }, output_tokens: 10, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 110 } } }]) event(res, e);
        res.end();
        return;
      }
      // Every later request is a failure of the kind named; a retry would land here again and be counted.
      if (mode === "overflow-http") { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { type: "invalid_request_error", code: "context_length_exceeded", message: "This model's maximum context length is 4096 tokens." } })); return; }
      if (mode === "oom-500") { res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: "CUDA error: out of memory" } })); return; }
      if (mode === "unavailable-503") { res.writeHead(503, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: "model is loading" } })); return; }
      head(res);
      event(res, { type: "response.created", response: { id: `resp_${n}`, object: "response", status: "in_progress", output: [] } });
      if (mode === "overflow-stream") {
        event(res, { type: "response.failed", response: { id: `resp_${n}`, object: "response", status: "failed", output: [], error: { code: "context_length_exceeded", message: "Your input exceeds the context window of this model." } } });
        res.end();
        return;
      }
      const partial = { type: "message", id: `msg_${n}`, role: "assistant", status: "in_progress", content: [] };
      event(res, { type: "response.output_item.added", output_index: 0, item: partial });
      event(res, { type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: partial.id, delta: "Partial answer" });
      if (mode === "dropped") { setTimeout(() => req.socket.destroy(), 50); return; }
      // child-exit and stop: hold the stream open until the test acts.
      held.request = res;
      held.arrived?.();
    });
  });
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(server)));
}

for (const mode of ["overflow-http", "overflow-stream", "oom-500", "unavailable-503", "dropped", "child-exit", "stop"] as const) {
  test(`AC4 (${mode}): a local turn whose server fails after a tool ran ends failed or interrupted; the recording server observes no retry and no other model, and the tool does not run twice`, { skip: !process.env.MODEX_LM3_WIRE && "set MODEX_LM3_WIRE=1 to start the installed codex CLI", timeout: 120_000 }, async () => {
    const hops: FailureHop[] = [];
    let arrived!: () => void;
    const holding = new Promise<void>(resolve => { arrived = resolve; });
    const held: { request?: http.ServerResponse; arrived?: () => void } = { arrived };
    const server = await failingResponses(mode, hops, held);
    const home = tmpdir("lm5-ac4-home-");
    const connections = new LocalConnectionStore(home, new SecretStore(home, testCipher));
    const children: ChildProcess[] = [];
    const spawnImpl = ((bin: string, args: string[], opts: SpawnOptions) => { const child = cliSpawn(bin, args, opts); children.push(child); return child; }) as typeof cliSpawn;
    const execution = new LocalExecution(home, connections, (process.env.MODEX_CODEX_BIN ?? "codex") as CliExecutable, spawnImpl);
    const observations: Observation[] = [];
    const notices: string[] = [];
    const abort = new AbortController();
    try {
      const port = (server.address() as AddressInfo).port;
      const connection = connections.create({ label: "Failing fixture", runtime: "responses", url: `http://127.0.0.1:${port}/v1`, token: TOKEN });
      const model = "scripted-fixture-model";
      const cwd = workspace();
      const thread = { id: `ac4-${mode}`, cwd, localTarget: { schema: 1 as const, harness: "codex" as const, model: { schema: 1 as const, connection: { id: connection.id, revision: 1 }, id: model } }, localContextTokens: 32768 };
      const turn = execution.backend(thread).runTurn("LM5-AC4: append a line to tool-count.txt.", { cwd, mode: "agent", plan: false, model }, sinkFor(observations, notices), AbortSignal.any([abort.signal, AbortSignal.timeout(90_000)]));
      if (mode === "child-exit" || mode === "stop") {
        await Promise.race([holding, turn]);
        if (mode === "child-exit") for (const child of children) child.kill("SIGKILL");
        else abort.abort();
      }
      const result = await turn;
      // A late retry would arrive after the turn ended: give it time to show up.
      await new Promise(r => setTimeout(r, 1500));
      held.request?.destroy();
      const ran = fs.existsSync(path.join(cwd, "tool-count.txt")) ? fs.readFileSync(path.join(cwd, "tool-count.txt"), "utf8").split("\n").filter(Boolean).length : 0;
      const started = observations.filter(o => o.type === "tool.start").length;
      const outcomes = observations.filter(o => o.type === "tool.done").map(o => (o as Extract<Observation, { type: "tool.done" }>).outcome);
      record(`ac4-${mode}`, { kind: "installed codex CLI against a scripted loopback Responses server that fails after one tool ran; no model, no inference", cli: process.env.MODEX_CODEX_BIN ?? "codex", mode, hops, toolRuns: ran, toolStarts: started, outcomes, notices, result: { status: result.status, error: result.error, detail: result.detail } });
      assert.notEqual(result.status, "completed", `a failed local turn was reported completed: ${JSON.stringify({ result, hops, notices })}`);
      assert.equal(result.status, mode === "stop" ? "interrupted" : "failed", JSON.stringify({ result, notices }));
      // Codex words a 500 as a cloud service's "high demand"; for a local server that is not what happened.
      if (mode === "oom-500") assert.match(result.error ?? "", /local server.*HTTP 500/i, `the error names the local server's failure: ${result.error}`);
      assert.doesNotMatch(result.error ?? "", /high demand/i, `the error claims a cloud service's load: ${result.error}`);
      assert.equal(hops.length, 2, `expected exactly the tool request and the failed one, no retry: ${JSON.stringify(hops)}`);
      assert.ok(hops.every(h => h.path === "/v1/responses" && h.model === model), `every request names the selected model at the configured server: ${JSON.stringify(hops)}`);
      assert.equal(ran, 1, "the side-effecting command ran exactly once");
      assert.equal(started, 1, "one tool dispatch, never a second");
      assert.ok(!outcomes.includes("succeeded") || outcomes.length === 1, JSON.stringify(outcomes));
      assert.ok(!observations.some(o => o.type === "message.done" && /Partial answer/.test((o as Extract<Observation, { type: "message.done" }>).text ?? "") && result.status === "completed"));
    } finally {
      held.request?.destroy();
      await execution.dispose();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
}

interface CompactionHop { n: number; method: string; path: string; model: unknown; authorization: "bearer" | "none" | "other"; inputItems: number; hasToolOutput: boolean; summaryRequest: boolean; hasSummary: boolean; hasPrompt: boolean; lastInputHead: string }

test("AC1 compaction: the configured loopback server observes inline compaction after the local child passes its auto-compact limit", { skip: !process.env.MODEX_LM3_WIRE && "set MODEX_LM3_WIRE=1 to start the installed codex CLI", timeout: 120_000 }, async () => {
  const PROMPT = "LM5-AC1-COMPACTION-PROMPT-31e2", SUMMARY = "LM5-AC1-SUMMARY-77b0";
  const hops: CompactionHop[] = [];
  const usage = (total: number) => ({ input_tokens: total - 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 10, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: total });
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(raw); } catch { /* recorded as empty */ }
      const input = Array.isArray(body.input) ? body.input : [];
      const tools = Array.isArray(body.tools) ? body.tools as { name?: string }[] : [];
      const auth = req.headers.authorization ?? "";
      const last = JSON.stringify(input.at(-1) ?? "");
      // Codex's compaction asks for a summary of the conversation so far as the newest user input.
      const summaryRequest = /summar|checkpoint|handoff|compact/i.test(last) && !last.includes(PROMPT) && !last.includes(SUMMARY);
      const n = hops.length + 1;
      hops.push({ n, method: req.method ?? "", path: req.url ?? "", model: body.model, authorization: auth === `Bearer ${TOKEN}` ? "bearer" : auth ? "other" : "none", inputItems: input.length,
        hasToolOutput: raw.includes("function_call_output"), summaryRequest, hasSummary: raw.includes(SUMMARY), hasPrompt: raw.includes(PROMPT), lastInputHead: last.slice(0, 160) });
      if (auth !== `Bearer ${TOKEN}`) { res.writeHead(401); res.end(); return; }
      if (req.url !== "/v1/responses") { res.writeHead(404); res.end(); return; }
      const reply = (item: Record<string, unknown>, total: number) => {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        for (const e of [{ type: "response.created", response: { id: `resp_${n}`, object: "response", status: "in_progress", output: [] } }, { type: "response.output_item.added", output_index: 0, item }, { type: "response.output_item.done", output_index: 0, item },
          { type: "response.completed", response: { id: `resp_${n}`, object: "response", status: "completed", output: [item], usage: usage(total) } }]) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
        res.end();
      };
      const message = (text: string) => ({ type: "message", id: `msg_${n}`, role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] });
      if (summaryRequest) { reply(message(`Summary: the person asked to read fixture.txt. ${SUMMARY}`), 500); return; }
      if (!raw.includes("function_call_output") && !raw.includes(SUMMARY)) {
        const exec = tools.find(t => t.name === "exec_command") ? "exec_command" : "shell";
        const args = exec === "exec_command" ? { cmd: "cat fixture.txt" } : { command: ["cat", "fixture.txt"] };
        // Usage far above the 85% auto-compact limit Modex sets: Codex must compact before it samples again.
        reply({ type: "function_call", id: `fc_${n}`, call_id: `call_${n}`, name: exec, arguments: JSON.stringify(args), status: "completed" }, 31_000);
        return;
      }
      reply(message(`The file contains ${SENTINEL}.`), 600);
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
  const home = tmpdir("lm5-ac1-compaction-home-");
  const connections = new LocalConnectionStore(home, new SecretStore(home, testCipher));
  const execution = new LocalExecution(home, connections);
  const observations: Observation[] = [];
  const notices: string[] = [];
  try {
    const connection = connections.create({ label: "Compaction fixture", runtime: "responses", url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, token: TOKEN });
    const model = "scripted-fixture-model";
    const thread = { id: "ac1-compaction", cwd: workspace(), localTarget: { schema: 1 as const, harness: "codex" as const, model: { schema: 1 as const, connection: { id: connection.id, revision: 1 }, id: model } }, localContextTokens: 32768 };
    const result = await execution.backend(thread).runTurn(`${PROMPT}: read fixture.txt and tell me the word it contains.`, { cwd: thread.cwd, mode: "agent", plan: false, model }, sinkFor(observations, notices), AbortSignal.timeout(90_000));
    await new Promise(r => setTimeout(r, 1000));
    const kinds = observations.map(o => o.type);
    record("ac1-compaction", { kind: "installed codex CLI auto-compacting a local child against a scripted loopback Responses server; no model, no inference", cli: process.env.MODEX_CODEX_BIN ?? "codex", hops, observationKinds: [...new Set(kinds)], notices, result: { status: result.status, error: result.error }, provenance: execution.provenance(thread.id) });
    assert.equal(result.status, "completed", `turn failed: ${result.error} notices=${notices.join(" | ")} hops=${JSON.stringify(hops)}`);
    const summaries = hops.filter(h => h.summaryRequest);
    assert.ok(summaries.length >= 1, `Codex did not compact past its limit; nothing to place: ${JSON.stringify(hops)}`);
    // Where compaction went: the configured server, its Responses path, the selected model, with the connection's token.
    assert.ok(summaries.every(h => h.method === "POST" && h.path === "/v1/responses" && h.model === model && h.authorization === "bearer"), JSON.stringify(summaries));
    assert.ok(hops.every(h => h.path === "/v1/responses" && h.model === model), `every request, compaction included, reached the configured server for the selected model: ${JSON.stringify(hops)}`);
    assert.ok(hops.some(h => h.n > summaries[0]!.n && h.hasSummary && !h.summaryRequest), `the compacted history (with the server's summary) carried the turn on: ${JSON.stringify(hops)}`);
    assert.ok(observations.some(o => o.type === "message.done" && ((o as Extract<Observation, { type: "message.done" }>).text ?? "").includes(SENTINEL)), "the turn finished after compaction");
  } finally {
    await execution.dispose();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("AC3: a turn queued behind another profile of the same server and then stopped sends that server nothing", { skip: !process.env.MODEX_LM3_WIRE && "set MODEX_LM3_WIRE=1 to start the installed codex CLI", timeout: 120_000 }, async t => {
  const FIRST = "LM5-AC3-FIRST-1a9e", QUEUED = "LM5-AC3-QUEUED-5c0d";
  const requests: { path: string; first: boolean; queued: boolean }[] = [];
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  let arrived!: () => void;
  const holding = new Promise<void>(resolve => { arrived = resolve; });
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", c => chunks.push(c));
    req.on("end", async () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      requests.push({ path: req.url ?? "", first: raw.includes(FIRST), queued: raw.includes(QUEUED) });
      arrived();
      await released;
      const item = { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "done", annotations: [] }] };
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const e of [{ type: "response.created", response: { id: "resp_1", object: "response", status: "in_progress", output: [] } }, { type: "response.output_item.added", output_index: 0, item }, { type: "response.output_item.done", output_index: 0, item },
        { type: "response.completed", response: { id: "resp_1", object: "response", status: "completed", output: [item], usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 5, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 15 } } }]) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
      res.end();
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
  const home = tmpdir("lm5-ac3-home-");
  const connections = new LocalConnectionStore(home, new SecretStore(home, testCipher));
  const execution = new LocalExecution(home, connections);
  try {
    const port = (server.address() as AddressInfo).port;
    const one = connections.create({ label: "Profile one", runtime: "responses", url: `http://127.0.0.1:${port}/v1`, token: TOKEN });
    const two = connections.create({ label: "Profile two", runtime: "ollama", url: `http://127.0.0.1:${port}`, token: TOKEN });
    const model = "scripted-fixture-model";
    const target = (id: string) => ({ schema: 1 as const, harness: "codex" as const, model: { schema: 1 as const, connection: { id, revision: 1 }, id: model } });
    const a = { id: "ac3-a", cwd: workspace(), localTarget: target(one.id), localContextTokens: 32768 };
    const b = { id: "ac3-b", cwd: workspace(), localTarget: target(two.id), localContextTokens: 32768 };
    const first = execution.backend(a).runTurn(`${FIRST}: reply with one word.`, { cwd: a.cwd, mode: "chat", plan: false, model }, sinkFor([], []), AbortSignal.any([t.signal, AbortSignal.timeout(90_000)]));
    // A failed admission or child startup can finish without ever reaching the server.
    // Surface that result and enter cleanup instead of waiting for an impossible request.
    await Promise.race([
      holding,
      first.then(result => { throw new Error(`first turn ended before reaching the fixture: ${JSON.stringify(result)}`); }),
    ]);
    const stop = new AbortController();
    const queued = execution.backend(b).runTurn(`${QUEUED}: reply with one word.`, { cwd: b.cwd, mode: "chat", plan: false, model }, sinkFor([], []), stop.signal);
    await new Promise(r => setTimeout(r, 500));
    stop.abort();
    const stopped = await queued;
    release();
    const done = await first;
    await new Promise(r => setTimeout(r, 1000));
    record("ac3-queued-cancel", { kind: "installed codex CLI; two connection profiles for one scripted loopback server; the second turn queued, then stopped", cli: process.env.MODEX_CODEX_BIN ?? "codex", requests, first: done.status, queued: stopped.status });
    assert.equal(stopped.status, "interrupted");
    assert.equal(done.status, "completed", JSON.stringify(done));
    assert.equal(requests.filter(r => r.queued).length, 0, `the stopped turn reached the server: ${JSON.stringify(requests)}`);
    assert.ok(requests.length >= 1 && requests.every(r => r.first), JSON.stringify(requests));
    assert.equal(execution.provenance(b.id), undefined, "no child was opened for the stopped turn");
  } finally {
    release();
    await execution.dispose();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("AC1: a person's local server reads, requests an approved edit and runs an observed test through Codex", { skip: !process.env.MODEX_LM3_LIVE && "set MODEX_LM3_LIVE=1, MODEX_LM3_URL and MODEX_LM3_MODEL to run against an approved server/model", timeout: 1_200_000 }, async () => {
  const url = process.env.MODEX_LM3_URL, model = process.env.MODEX_LM3_MODEL, token = process.env.MODEX_LM3_TOKEN;
  assert.ok(url && model, "MODEX_LM3_URL and MODEX_LM3_MODEL are required");
  const home = tmpdir("lm3-live-home-");
  const connections = new LocalConnectionStore(home, new SecretStore(home, testCipher));
  const execution = new LocalExecution(home, connections);
  const observations: Observation[] = [];
  const notices: string[] = [];
  const realConfiguration = realCodexConfig();
  const global = globalCodexConfig();
  let session: string | undefined;
  const approvals: { command: string; decision: string }[] = [];
  const stages: { name: string; status: string; error?: string; ms: number }[] = [];
  const started = Date.now();
  try {
    const connection = connections.create({ label: "Live", runtime: "responses", url, ...(token ? { token } : {}) });
    const thread = { id: "live-1", cwd: workspace(), localTarget: { schema: 1 as const, harness: "codex" as const, model: { schema: 1 as const, connection: { id: connection.id, revision: 1 }, id: model } }, localContextTokens: Number(process.env.MODEX_LM3_CONTEXT ?? 32768) };
    const sink: TurnSink = { ...sinkFor(observations, notices), session: id => { session = id; } };
    const result = await execution.backend(thread).runTurn("Run `cat fixture.txt` in the current directory and reply with exactly the word it contains.", { cwd: thread.cwd, mode: "agent", plan: false, model }, sink, AbortSignal.timeout(540_000));
    stages.push({ name: "read", status: result.status, error: result.error, ms: Date.now() - started });
    const tools = observations.filter(o => o.type === "tool.start").map(o => (o as Extract<Observation, { type: "tool.start" }>).tool);
    const done = observations.filter(o => o.type === "tool.done").map(o => (o as Extract<Observation, { type: "tool.done" }>).outcome);
    const reply = observations.filter(o => o.type === "message.done").map(o => (o as Extract<Observation, { type: "message.done" }>).text ?? "").join("\n");
    record("live", { kind: "installed codex CLI against the person's own local server", cli: process.env.MODEX_CODEX_BIN ?? "codex", url, model, contextTokens: thread.localContextTokens, ms: Date.now() - started, tools, outcomes: done, reply, notices, result: { status: result.status, error: result.error, detail: result.detail, usage: result.usage } });
    assert.equal(result.status, "completed", `turn failed: ${result.error} ${JSON.stringify(result.detail)} notices=${notices.join(" | ")}`);
    assert.ok(tools.some(t => t.name === "shell"), `the model ran no shell tool: ${JSON.stringify(tools)} reply=${reply}`);
    assert.ok(done.includes("succeeded"), `tool outcomes: ${done.join(", ")}`);
    assert.match(reply, new RegExp(SENTINEL), `the reply does not carry the file's word: ${reply}`);
    assert.ok(session, "the native read reported its session for the explicit continuation");
    const expected = EDITED;
    const write = "printf 'LM3-APPROVED-EDIT-8c42\\n' > result.txt";
    fs.writeFileSync(path.join(thread.cwd, "check.cjs"), CHECK);
    const allowed = new Set([write, "node check.cjs"]);
    sink.approval = async request => {
      const command = request.action?.tool === "command" ? String(request.action.input?.command ?? "") : "";
      const accepted = request.action?.cwd === thread.cwd && allowed.has(command);
      approvals.push({ command, decision: accepted ? "yes" : "no" });
      return accepted ? "yes" : "no";
    };
    const beforeEdit = Date.now();
    const edited = await execution.backend(thread).runTurn(`Use the shell, requesting permission for this exact command: ${write}. Then run exactly node check.cjs. Do not change check.cjs or fixture.txt, and do not use apply_patch.`,
      { cwd: thread.cwd, mode: "chat", plan: false, model, resume: session }, sink, AbortSignal.timeout(540_000));
    stages.push({ name: "approved edit and test", status: edited.status, error: edited.error, ms: Date.now() - beforeEdit });
    assert.equal(edited.status, "completed", edited.error);
    assert.equal(fs.readFileSync(path.join(thread.cwd, "result.txt"), "utf8"), expected);
    assert.equal(fs.readFileSync(path.join(thread.cwd, "fixture.txt"), "utf8"), `${SENTINEL}\n`);
    assert.equal(fs.readFileSync(path.join(thread.cwd, "check.cjs"), "utf8"), CHECK, "the independent test was not rewritten by the model");
    assert.deepEqual(fs.readFileSync(path.join(thread.cwd, "checks.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line)), [{ ok: true, exitCode: 0 }], "the test actually executed exactly once on the resulting file");
    assert.ok(approvals.some(a => a.command === write && a.decision === "yes"), "the file write crossed the explicit approval callback");
  } finally {
    await execution.dispose();
    const syntheticConfiguration = global.unchanged();
    const personalConfiguration = realConfiguration();
    global.restore();
    record("live-workflow", { kind: "native local model qualification; harness approves only two exact fixture commands, not human acceptance", url, model,
      contextTokens: Number(process.env.MODEX_LM3_CONTEXT ?? 32768), stages, approvals, observations, notices,
      configurationUnchanged: syntheticConfiguration, realConfiguration: personalConfiguration, ms: Date.now() - started });
    assert.deepEqual(syntheticConfiguration, { sha256: global.sha256, bytes: true, mtimeMs: true, tree: true });
    assert.equal(personalConfiguration.unchanged, true, "the real user's Codex configuration stayed byte-identical");
  }
});
