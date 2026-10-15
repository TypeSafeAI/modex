import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeBackend } from "../src/main/engine/backends/claude.js";
import type { ClaudeQuery } from "../src/main/engine/backends/claude.js";
import type { ApprovalRequest, TurnOptions } from "../src/main/engine/backends/types.js";
import { collectSink, FakeProcess } from "./fakeproc.js";
import { tmpdir } from "./helpers.js";

// These tests drive the real Agent SDK `query()` — its initialize handshake, `canUseTool` routing, cancels,
// `interrupt()` and exit reporting — against a fake `claude` executable, so the SDK's side of the protocol is
// the shipped one and only the CLI is scripted. The scripted `query()` in fakeproc.ts covers the rest.

/** What the fake CLI does after the handshake. `user` runs on the prompt; `interrupt` on an interrupt request. */
interface Script {
  user: string;
  interrupt?: string;
}

/** Writes a fake `claude` (a Node script without an extension, so the SDK runs it directly) and its log path. */
function fakeClaude(script: Script): { bin: string; log: () => Record<string, unknown>[] } {
  const dir = tmpdir();
  const bin = path.join(dir, "claude");
  const logPath = path.join(dir, "log.jsonl");
  fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const log = (o) => fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(o) + "\\n");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const later = (ms, f) => setTimeout(f, ms);
const answers = new Map();
const answered = (id) => new Promise((r) => answers.set(id, r));
log({ argv: process.argv.slice(2), clientApp: process.env.CLAUDE_AGENT_SDK_CLIENT_APP });
readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  const msg = JSON.parse(line);
  log({ in: msg });
  if (msg.type === "control_request" && msg.request.subtype === "initialize") {
    return out({ type: "control_response", response: { subtype: "success", request_id: msg.request_id, response: { commands: [], models: [], account: {} } } });
  }
  if (msg.type === "control_response") return answers.get(msg.response.request_id)?.(msg.response);
  if (msg.type === "control_request" && msg.request.subtype === "interrupt") {
    out({ type: "control_response", response: { subtype: "success", request_id: msg.request_id, response: {} } });
    ${script.interrupt ?? ""}
    return;
  }
  if (msg.type === "user") { ${script.user} }
}).on("close", () => { log({ stdin: "closed" }); process.exit(0); });
`, { mode: 0o755 });
  const log = () => fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>) : [];
  return { bin, log };
}

const init = `out({ type: "system", subtype: "init", session_id: "s1", model: "fake", permissionMode: "acceptEdits", claude_code_version: "9.9.9", apiKeySource: "none", tools: [], mcp_servers: [] });`;
const result = (subtype = "success") => `out({ type: "result", subtype: "${subtype}", is_error: ${subtype !== "success"}, errors: [], session_id: "s1", num_turns: 1, result: "", usage: { output_tokens: 1 } });`;
const bashCall = `out({ type: "assistant", session_id: "s1", parent_tool_use_id: null, message: { id: "m1", role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "npm test" } }] } });`;
const ask = `out({ type: "control_request", request_id: "p1", request: { subtype: "can_use_tool", tool_name: "Bash", tool_use_id: "tu1", input: { command: "npm test" }, permission_suggestions: [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm test" }], behavior: "allow", destination: "localSettings" }] } });`;
const options: TurnOptions = { cwd: process.cwd(), mode: "agent", plan: false, model: "" };
const until = async (cond: () => boolean, ms = 5000) => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
};

test("Agent SDK: a turn streams, replies and completes through the real query()", async () => {
  const cli = fakeClaude({
    user: `${init}
      out({ type: "stream_event", session_id: "s1", parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } } });
      out({ type: "stream_event", session_id: "s1", parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } } });
      out({ type: "assistant", session_id: "s1", parent_tool_use_id: null, message: { id: "m1", role: "assistant", content: [{ type: "text", text: "Hello" }] } });
      ${result()}`,
  });
  const { sink, events } = collectSink();
  const r = await new ClaudeBackend(cli.bin, spawn).runTurn("hi", options, sink, new AbortController().signal);
  assert.equal(r.status, "completed");
  assert.deepEqual(events.filter((e) => /^(delta|assistant|session)/.test(e)), ["session:s1", "delta:Hel", "delta:lo", "assistant:Hello", "session:s1"]);
  const [first] = cli.log();
  const argv = first!.argv as string[];
  assert.ok(argv.includes("--include-partial-messages"));
  assert.ok(argv.includes("--permission-mode=acceptEdits"));
  assert.equal(first!.clientApp, "modex");
  await until(() => cli.log().some((e) => e.stdin === "closed"));
  assert.ok(cli.log().some((e) => e.stdin === "closed"), "the turn ends Claude's input");
});

test("Agent SDK: a permission request reaches the approval card after its tool row and the answer reaches Claude", async () => {
  const cli = fakeClaude({
    user: `${init}
      ${bashCall}
      ${ask}
      const reply = await answered("p1");
      log({ reply });
      out({ type: "user", session_id: "s1", parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "ok", is_error: false }] } });
      ${result()}`,
  });
  const { sink, events, requests } = collectSink(["always"]);
  const r = await new ClaudeBackend(cli.bin, spawn).runTurn("test it", options, sink, new AbortController().signal);
  assert.equal(r.status, "completed");
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.canAlways, true);
  const order = events.filter((e) => e.startsWith("tool_start") || e.startsWith("approval"));
  assert.deepEqual(order, ["tool_start:tu1:$ npm test", "approval:Allow Bash: $ npm test?"]);
  const reply = cli.log().find((e) => e.reply)?.reply as { response: { behavior: string; updatedPermissions?: unknown[] } };
  assert.equal(reply.response.behavior, "allow");
  assert.equal(reply.response.updatedPermissions?.length, 1, "'always' forwards the CLI's suggestion");
});

test("Agent SDK: a permission request Claude cancels aborts the approval and gets no answer", async () => {
  const cli = fakeClaude({
    user: `${init}
      ${bashCall}
      ${ask}
      later(100, () => out({ type: "control_cancel_request", request_id: "p1" }));
      later(200, () => { ${result()} });`,
  });
  const { sink } = collectSink();
  let cancelled: AbortSignal | undefined;
  const waiting = { ...sink, approval: (_req: ApprovalRequest, signal?: AbortSignal) => {
    cancelled = signal;
    return new Promise<"no">((r) => signal?.addEventListener("abort", () => r("no")));
  } };
  const r = await new ClaudeBackend(cli.bin, spawn).runTurn("test it", options, waiting, new AbortController().signal);
  assert.equal(r.status, "completed");
  assert.equal(cancelled?.aborted, true);
  assert.ok(!cli.log().some((e) => (e.in as { type?: string } | undefined)?.type === "control_response"), "nothing answers a withdrawn request");
});

test("Agent SDK: Stop interrupts Claude, which ends its turn and exits on end of input", async () => {
  const cli = fakeClaude({
    user: `${init}
      out({ type: "stream_event", session_id: "s1", parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "work" } } });`,
    interrupt: result("error_during_execution"),
  });
  const { sink, events } = collectSink();
  const ac = new AbortController();
  const run = new ClaudeBackend(cli.bin, spawn, { interruptGraceMs: 10_000 }).runTurn("go", options, sink, ac.signal);
  await until(() => events.includes("delta:work"));
  const t0 = Date.now();
  ac.abort();
  assert.deepEqual(await run, { status: "interrupted" });
  assert.ok(Date.now() - t0 < 5000, "a clean interrupt does not wait out the grace window");
  const log = cli.log();
  assert.ok(log.some((e) => (e.in as { request?: { subtype?: string } } | undefined)?.request?.subtype === "interrupt"), "Claude was asked to stop");
  assert.ok(log.some((e) => e.stdin === "closed"), "Claude exited on its own, after its input ended");
});

test("Agent SDK: a launch deferred past Stop cannot leave a process running", { timeout: 10_000 }, async (t) => {
  // The fake transport has no OS handle; keep Node alive through the SDK's unreferenced close grace.
  const keepAlive = setTimeout(() => {}, 10_000);
  t.after(() => clearTimeout(keepAlive));
  const waiting = new FakeProcess();
  t.after(() => waiting.kill());
  let launch: (() => SpawnedProcess) | undefined;
  let forwarded: AbortSignal | undefined;
  const delayedQuery: ClaudeQuery = (params) => {
    const factory = params.options?.spawnClaudeCodeProcess;
    assert.ok(factory);
    return query({ ...params, options: { ...params.options, spawnClaudeCodeProcess: (spawnOpts) => {
      forwarded = spawnOpts.signal;
      launch = () => factory({ ...spawnOpts, command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] });
      // Keep the real SDK waiting while the backend has no assigned process.
      return waiting;
    } } });
  };
  const ac = new AbortController();
  const run = new ClaudeBackend("claude", undefined, { interruptGraceMs: 10 }, delayedQuery).runTurn("go", options, collectSink().sink, ac.signal);
  const initialize: unknown = JSON.parse(await waiting.waitFor((line) => line.includes('"subtype":"initialize"')));
  assert.ok(initialize && typeof initialize === "object" && "request_id" in initialize);
  waiting.emitLine({ type: "control_response", response: { subtype: "success", request_id: initialize.request_id, response: { commands: [], models: [], account: {} } } });
  ac.abort();
  assert.deepEqual(await run, { status: "interrupted" });
  assert.equal(forwarded?.aborted, true, "the SDK forwards cancellation after its close grace");
  assert.ok(launch);
  const child = launch();
  t.after(() => child.kill("SIGKILL"));
  const errors: Error[] = [];
  child.on("error", (error: Error) => errors.push(error));
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(child.killed, true, "the already-aborted signal kills the delayed launch");
  await exited;
  assert.ok(errors.some((error) => error.name === "AbortError"));
});

test("Agent SDK: Stop kills a Claude that ignores the interrupt", async () => {
  const cli = fakeClaude({ user: init });
  const { sink, events } = collectSink();
  const ac = new AbortController();
  const run = new ClaudeBackend(cli.bin, spawn, { interruptGraceMs: 50 }).runTurn("go", options, sink, ac.signal);
  await until(() => events.includes("session:s1"));
  ac.abort();
  assert.deepEqual(await run, { status: "interrupted" });
});

test("Agent SDK: a failed exit reports the CLI's stderr and exit code, not the SDK's wording", async () => {
  const cli = fakeClaude({ user: `process.stderr.write("warning: something\\nInvalid API key · Please run /login\\n"); later(20, () => process.exit(1));` });
  const r = await new ClaudeBackend(cli.bin, spawn).runTurn("go", options, collectSink().sink, new AbortController().signal);
  assert.equal(r.status, "failed");
  assert.equal(r.error, "warning: something\nInvalid API key · Please run /login");
  assert.equal(r.detail?.exitCode, 1);
  assert.match(String(r.detail?.sdkError), /exited with code 1/);
});

// Opt-in: a real turn on the installed `claude` (or MODEX_CLAUDE_BIN), using its login. It calls the model.
const smoke = { skip: process.env.MODEX_CLAUDE_SMOKE !== "1" && "set MODEX_CLAUDE_SMOKE=1 to run against the installed claude", timeout: 180_000 };
const real: TurnOptions = { cwd: process.cwd(), mode: "chat", plan: false, model: process.env.MODEX_CLAUDE_SMOKE_MODEL ?? "haiku" };

test("Agent SDK smoke (installed claude): a reply completes", smoke, async (t) => {
  const { sink, events } = collectSink();
  const ac = new AbortController();
  t.after(() => ac.abort());
  const r = await new ClaudeBackend().runTurn("Reply with exactly the word pong and nothing else.", real, sink, ac.signal);
  assert.equal(r.status, "completed", JSON.stringify(r));
  assert.ok(events.some((e) => e.startsWith("assistant:") && /pong/i.test(e)), events.join("\n"));
});

test("Agent SDK smoke (installed claude): a Bash call asks for approval and a denial is honoured", smoke, async (t) => {
  const { sink, events, requests } = collectSink(["no"]);
  const ac = new AbortController();
  t.after(() => ac.abort());
  const r = await new ClaudeBackend().runTurn("Use the Bash tool to run exactly: echo modex-smoke. If it is denied, reply with the word denied.", real, sink, ac.signal);
  assert.equal(r.status, "completed", JSON.stringify(r));
  assert.ok(requests.some((q) => q.action?.tool === "Bash"), JSON.stringify(requests));
  assert.ok(events.some((e) => e.startsWith("assistant:") && /denied/i.test(e)), events.join("\n"));
  assert.ok(!events.some((e) => e.startsWith("tool_update:") && e.includes(":true:")), "a denied call must not succeed");
});

test("Agent SDK smoke (installed claude): Stop interrupts a streaming reply", smoke, async (t) => {
  const { sink, events } = collectSink();
  const ac = new AbortController();
  t.after(() => ac.abort());
  const run = new ClaudeBackend().runTurn("Count from 1 to 400, one number per line.", real, sink, ac.signal);
  await until(() => events.some((e) => e.startsWith("delta:")), 120_000);
  const t0 = Date.now();
  ac.abort();
  assert.deepEqual(await run, { status: "interrupted" });
  assert.ok(Date.now() - t0 < 10_000, `Stop took ${Date.now() - t0}ms`);
});
