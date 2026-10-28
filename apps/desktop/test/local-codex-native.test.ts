import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { LocalConnectionStore } from "../src/main/engine/local-models/connections.js";
import { LocalExecution } from "../src/main/engine/local-models/execution.js";
import { SecretStore, testCipher } from "../src/main/engine/secrets.js";
import type { Observation } from "../src/shared/conversation-events.js";
import type { TurnSink } from "../src/main/engine/backends/types.js";
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
  } finally {
    await execution.dispose();
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

test("AC1: a person's own local server completes a shell read through the installed Codex", { skip: !process.env.MODEX_LM3_LIVE && "set MODEX_LM3_LIVE=1, MODEX_LM3_URL and MODEX_LM3_MODEL to run against a server you already run", timeout: 600_000 }, async () => {
  const url = process.env.MODEX_LM3_URL, model = process.env.MODEX_LM3_MODEL, token = process.env.MODEX_LM3_TOKEN;
  assert.ok(url && model, "MODEX_LM3_URL and MODEX_LM3_MODEL are required");
  const home = tmpdir("lm3-live-home-");
  const connections = new LocalConnectionStore(home, new SecretStore(home, testCipher));
  const execution = new LocalExecution(home, connections);
  const observations: Observation[] = [];
  const notices: string[] = [];
  const started = Date.now();
  try {
    const connection = connections.create({ label: "Live", runtime: "responses", url, ...(token ? { token } : {}) });
    const thread = { id: "live-1", cwd: workspace(), localTarget: { schema: 1 as const, harness: "codex" as const, model: { schema: 1 as const, connection: { id: connection.id, revision: 1 }, id: model } }, localContextTokens: Number(process.env.MODEX_LM3_CONTEXT ?? 32768) };
    const result = await execution.backend(thread).runTurn("Run `cat fixture.txt` in the current directory and reply with exactly the word it contains.", { cwd: thread.cwd, mode: "agent", plan: false, model }, sinkFor(observations, notices), AbortSignal.timeout(540_000));
    const tools = observations.filter(o => o.type === "tool.start").map(o => (o as Extract<Observation, { type: "tool.start" }>).tool);
    const done = observations.filter(o => o.type === "tool.done").map(o => (o as Extract<Observation, { type: "tool.done" }>).outcome);
    const reply = observations.filter(o => o.type === "message.done").map(o => (o as Extract<Observation, { type: "message.done" }>).text ?? "").join("\n");
    record("live", { kind: "installed codex CLI against the person's own local server", cli: process.env.MODEX_CODEX_BIN ?? "codex", url, model, contextTokens: thread.localContextTokens, ms: Date.now() - started, tools, outcomes: done, reply, notices, result: { status: result.status, error: result.error, detail: result.detail, usage: result.usage } });
    assert.equal(result.status, "completed", `turn failed: ${result.error} ${JSON.stringify(result.detail)} notices=${notices.join(" | ")}`);
    assert.ok(tools.some(t => t.name === "shell"), `the model ran no shell tool: ${JSON.stringify(tools)} reply=${reply}`);
    assert.ok(done.includes("succeeded"), `tool outcomes: ${done.join(", ")}`);
    assert.match(reply, new RegExp(SENTINEL), `the reply does not carry the file's word: ${reply}`);
  } finally { await execution.dispose(); }
});
