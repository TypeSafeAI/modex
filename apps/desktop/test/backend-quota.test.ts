import assert from "node:assert/strict";
import { test } from "node:test";
import type { spawn, SpawnOptions } from "node:child_process";
import { CodexBackend } from "../src/main/engine/backends/codex.js";
import { AccountCodexBackend } from "../src/main/engine/backends/account-codex.js";
import { ClaudeBackend } from "../src/main/engine/backends/claude.js";
import { FakeProcess, fakeSpawn, collectSink } from "./fakeproc.js";
import { quotaState } from "../src/main/engine/routing/quota.js";
import { DEFAULT_ROUTING } from "../src/shared/types.js";

test("Codex reads balances through account/rateLimits/read without starting a coding turn", async () => {
  const proc = new FakeProcess();
  proc.stdin.on("data", (data: Buffer) => {
    const msg = JSON.parse(data.toString());
    if (msg.method === "initialize") proc.emitLine({ id: msg.id, result: {} });
    if (msg.method === "account/rateLimits/read") proc.emitLine({ id: msg.id, result: { rateLimits: { primary: { usedPercent: 90 } } } });
  });
  const backend = new CodexBackend("codex", fakeSpawn(proc).spawn);
  try {
    const q = await backend.quota();
    assert.equal(quotaState(q, DEFAULT_ROUTING).state, "low");
    assert.deepEqual(proc.sent(m => typeof m.id === "number").map(m => m.method), ["initialize", "account/rateLimits/read"]);
  } finally { await backend.dispose(); }
});

test("Codex local provider never starts a cloud balance probe", async () => {
  const f = fakeSpawn(new FakeProcess());
  const backend = new CodexBackend("codex", f.spawn, { args: [], env: {}, redact: s => s, local: { model: "local", provider: "local" } });
  assert.equal(await backend.quota(), undefined);
  assert.equal(f.calls.length, 0);
});

test("Codex account balance reads stay on the explicitly bound account after selection changes", async () => {
  let active = "b";
  const calls: { env: NodeJS.ProcessEnv; child: FakeProcess }[] = [];
  const auth = { identity: () => active, grant: async (id: string) => ({ token: `secret-${id}`, expiresAt: Date.now() + 3600_000 }), status: () => ({ available: true, active, signingIn: false, detail: "", accounts: [] }) };
  const spawnImpl = ((_bin: string, _args: string[], options: SpawnOptions) => {
    const child = new FakeProcess(); calls.push({ env: options.env!, child });
    child.stdin.on("data", (data: Buffer) => {
      const m = JSON.parse(data.toString());
      if (m.method === "initialize") child.emitLine({ id: m.id, result: {} });
      if (m.method === "account/rateLimits/read") child.emitLine({ id: m.id, result: { rateLimits: { credits: { balance: "5", hasCredits: true } } } });
    });
    return child;
  }) as unknown as typeof spawn;
  const backend = new AccountCodexBackend(auth as ConstructorParameters<typeof AccountCodexBackend>[0], "codex", spawnImpl);
  try {
    await backend.quota("a"); active = "c"; await backend.quota("a");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.env.ACCESS_TOKEN, "secret-a");
    assert.equal(calls[0]!.child.sent(m => m.method === "turn/start").length, 0);
  } finally { await backend.dispose(); }
});

test("Claude retains separate account windows from normal turns; reads do not spawn inference", async () => {
  const proc = new FakeProcess(), f = fakeSpawn(proc), backend = new ClaudeBackend("claude", f.spawn);
  assert.equal(await backend.quota("a"), undefined);
  assert.equal(f.calls.length, 0);
  const run = backend.runTurn("work", { cwd: "/w", mode: "chat", model: "sonnet", plan: false, account: "a" }, collectSink().sink, new AbortController().signal);
  await proc.waitFor(l => l.includes('"type":"user"'));
  proc.emitLine({ type: "rate_limit_event", rate_limit_info: { status: "allowed", utilization: 0.9, rateLimitType: "five_hour" } });
  proc.emitLine({ type: "rate_limit_event", rate_limit_info: { status: "allowed", utilization: 0.1, rateLimitType: "seven_day" } });
  proc.emitLine({ type: "result", subtype: "success", result: "done" });
  proc.close(0);
  await run;
  const q = await backend.quota("a");
  assert.equal(q?.windows.length, 2);
  assert.equal(quotaState(q, DEFAULT_ROUTING).state, "low", "a weekly event must not erase the binding five-hour limit");
  assert.equal(await backend.quota("b"), undefined);
  assert.equal(f.calls.length, 1);
});

test("conservation explicitly disables Claude's saved fast-mode setting", () => {
  const opts = { cwd: "/w", mode: "agent" as const, plan: false, model: "opus", fast: false, conserveCredits: true };
  const args = ClaudeBackend.args(opts);
  assert.equal(args[args.indexOf("--settings") + 1], '{"fastMode":false}');
});

test("conservation explicitly overrides an inherited Codex fast service tier with default", async () => {
  const proc = new FakeProcess();
  proc.stdin.on("data", (data: Buffer) => {
    const m = JSON.parse(data.toString());
    if (m.method === "initialize") proc.emitLine({ id: m.id, result: {} });
    if (m.method === "thread/start") proc.emitLine({ id: m.id, result: { thread: { id: "t" } } });
    if (m.method === "turn/start") {
      proc.emitLine({ id: m.id, result: { turn: { id: "u" } } });
      setImmediate(() => proc.emitLine({ method: "turn/completed", params: { threadId: "t", turn: { id: "u", status: "completed" } } }));
    }
  });
  const backend = new CodexBackend("codex", fakeSpawn(proc).spawn);
  try {
    const opts = { cwd: "/w", mode: "chat" as const, model: "gpt-6-sol", plan: false, fast: false, conserveCredits: true };
    await backend.runTurn("work", opts, collectSink().sink, new AbortController().signal);
    assert.equal(proc.sent(m => m.method === "turn/start")[0]!.params.serviceTierForTurn, "default");
  } finally { await backend.dispose(); }
});
