import { test } from "node:test";
import assert from "node:assert/strict";
import type { spawn, SpawnOptions } from "node:child_process";
import { AccountCodexBackend, planArgs } from "../src/main/engine/backends/account-codex.js";
import { FakeProcess, collectSink } from "./fakeproc.js";

function fixture(shortExpiry = false) {
  let active = "account-a";
  let renewed = false;
  const calls: { child: FakeProcess; args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const auth = { identity: () => active, grant: async (id: string) => ({ token: `${renewed ? "RENEWED" : "SECRET"}-${id}`, expiresAt: Date.now() + (shortExpiry && !renewed ? 10000 : 3600000) }), status: () => ({ available: true, active, signingIn: false, accounts: [], detail: "" }) };
  const spawnImpl = ((_bin: string, args: string[], options: SpawnOptions) => {
    const child = new FakeProcess(); const index = calls.length; calls.push({ child, args, env: options.env ?? {} });
    child.stdin.on("data", (data: Buffer) => {
      const message = JSON.parse(data.toString());
      if (message.method === "initialize") child.emitLine({ id: message.id, result: {} });
      if (message.method === "thread/start" || message.method === "thread/resume") child.emitLine({ id: message.id, result: { thread: { id: message.method === "thread/resume" ? message.params.threadId : `thread-${index}` } } });
      if (message.method === "turn/start") child.emitLine({ id: message.id, result: { turn: { id: "turn" } } });
    });
    return child;
  }) as unknown as typeof spawn;
  const backend = new AccountCodexBackend(auth, "path with spaces/codex", spawnImpl);
  return { backend, calls, select: (id: string) => { active = id; }, renew: () => { renewed = true; } };
}

test("accounts own distinct Codex children, token environments and resume paths", async () => {
  const f = fixture(); const sink = collectSink(); const controller = new AbortController();
  try {
    const first = f.backend.runTurn("one", { cwd: "/workspace", model: "model", mode: "chat", plan: false, account: "account-a" }, sink.sink, controller.signal);
    while (f.calls.length < 1) await new Promise((resolve) => setTimeout(resolve, 5));
    await f.calls[0]!.child.waitFor((line) => line.includes('"turn/start"'));
    assert.equal(f.backend.busy("account-a"), true);
    await assert.rejects(f.backend.releaseAccount("account-a"), /initializing/);
    f.select("account-b");
    const second = f.backend.runTurn("two", { cwd: "/workspace", model: "model", mode: "chat", plan: false, account: "account-b" }, sink.sink, controller.signal);
    while (f.calls.length < 2) await new Promise((resolve) => setTimeout(resolve, 5));
    await f.calls[1]!.child.waitFor((line) => line.includes('"turn/start"'));
    assert.equal(f.calls[0]!.env.ACCESS_TOKEN, "SECRET-account-a");
    assert.equal(f.calls[1]!.env.ACCESS_TOKEN, "SECRET-account-b");
    assert.ok(planArgs.every((arg) => f.calls[0]!.args.includes(arg)));
    assert.equal(f.calls[0]!.args.join(" ").includes("SECRET"), false);
    assert.equal(f.calls[0]!.child.killed, false);
    for (let index = 0; index < 2; index++) f.calls[index]!.child.emitLine({ method: "turn/completed", params: { threadId: `thread-${index}`, turn: { id: "turn", status: "completed" } } });
    assert.equal((await first).status, "completed"); assert.equal((await second).status, "completed");
    assert.equal(f.backend.busy("account-a"), false);
    await f.backend.releaseAccount("account-a");
    assert.equal(f.calls[0]!.child.killed, true); assert.equal(f.calls[1]!.child.killed, false);
  } finally { await f.backend.dispose(); }
});

test("initializing consumers hold leases before credential refresh resolves", async () => {
  let resolve!: (value: { token: string; expiresAt: number }) => void;
  const grant = new Promise<{ token: string; expiresAt: number }>((done) => { resolve = done; });
  const backend = new AccountCodexBackend({ identity: () => "a", grant: () => grant, status: () => ({ available: true, active: "a", signingIn: false, accounts: [], detail: "" }) });
  const controller = new AbortController();
  const pending = backend.runTurn("prompt", { cwd: "/workspace", model: "", mode: "chat", plan: false, account: "a" }, collectSink().sink, controller.signal);
  assert.equal(backend.busy("a"), true);
  await assert.rejects(backend.releaseAccount("a"));
  controller.abort(); resolve({ token: "SECRET", expiresAt: Date.now() + 3600000 });
  assert.equal((await pending).status, "interrupted");
  await backend.dispose();
});

test("renewal drains the old process and resumes without replaying an active turn", async () => {
  const f = fixture(true); const sink = collectSink().sink;
  const opts = { cwd: "/workspace", model: "", mode: "chat" as const, plan: false, account: "account-a" };
  const first = f.backend.runTurn("first", opts, sink, new AbortController().signal);
  while (!f.calls.length) await new Promise((resolve) => setTimeout(resolve, 5));
  await f.calls[0]!.child.waitFor((line) => line.includes('"turn/start"'));
  await assert.rejects(f.backend.runTurn("blocked", opts, sink, new AbortController().signal), /another turn/);
  assert.equal(f.calls[0]!.child.killed, false); assert.equal(f.calls.length, 1);
  f.calls[0]!.child.emitLine({ method: "turn/completed", params: { threadId: "thread-0", turn: { id: "turn", status: "completed" } } });
  await first; f.renew();
  const resumed = f.backend.runTurn("next", { ...opts, resume: "thread-0" }, sink, new AbortController().signal);
  while (f.calls.length < 2) await new Promise((resolve) => setTimeout(resolve, 5));
  await f.calls[1]!.child.waitFor((line) => line.includes('"turn/start"'));
  assert.equal(f.calls[0]!.child.killed, true); assert.equal(f.calls[1]!.env.ACCESS_TOKEN, "RENEWED-account-a");
  assert.ok(f.calls[1]!.child.written.some((line) => line.includes('"thread/resume"') && line.includes("thread-0")));
  f.calls[1]!.child.emitLine({ method: "turn/completed", params: { threadId: "thread-0", turn: { id: "turn", status: "completed" } } });
  assert.equal((await resumed).status, "completed"); await f.backend.dispose();
});

test("account operations block newly arriving consumers until mutation finishes", async () => {
  const f = fixture(); let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const change = f.backend.accountChange("account-a", () => gate);
  await assert.rejects(f.backend.listModels(), /sign-in or sign-out/);
  assert.equal(f.calls.length, 0);
  release(); await change; await f.backend.dispose();
});

test("explicit force-stop affects only the selected thread's account process", async () => {
  const f = fixture(); const sink = collectSink().sink;
  const first = f.backend.runTurn("first", { cwd: "/workspace", model: "", mode: "chat", plan: false, account: "account-a" }, sink, new AbortController().signal);
  const second = f.backend.runTurn("second", { cwd: "/workspace", model: "", mode: "chat", plan: false, account: "account-b" }, sink, new AbortController().signal);
  while (f.calls.length < 2) await new Promise((resolve) => setTimeout(resolve, 5));
  await Promise.all(f.calls.map((call) => call.child.waitFor((line) => line.includes('"turn/start"'))));
  await f.backend.forceStop("account-a");
  assert.equal((await first).status, "failed");
  assert.equal(f.calls[1]!.child.killed, false);
  f.calls[1]!.child.emitLine({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn", status: "completed" } } });
  assert.equal((await second).status, "completed");
  await f.backend.dispose();
});

test("unbound legacy resume never uses the selected app-owned account", async () => {
  const f = fixture();
  const result = await f.backend.runTurn("prompt", { cwd: "/workspace", model: "", mode: "chat", plan: false, resume: "old-cli-handle" }, collectSink().sink, new AbortController().signal);
  assert.equal(result.status, "failed"); assert.equal(f.calls.length, 0);
  await f.backend.dispose();
});

test("token-bearing protocol text is redacted before callbacks", async () => {
  const f = fixture(); const sink = collectSink();
  const pending = f.backend.runTurn("one", { cwd: "/workspace", model: "", mode: "chat", plan: false }, sink.sink, new AbortController().signal);
  while (!f.calls.length) await new Promise((resolve) => setTimeout(resolve, 5));
  await f.calls[0]!.child.waitFor((line) => line.includes('"turn/start"'));
  f.calls[0]!.child.emitLine({ method: "item/agentMessage/delta", params: { threadId: "thread-0", itemId: "item", delta: "SECRET-account-a" } });
  f.calls[0]!.child.emitLine({ method: "turn/completed", params: { threadId: "thread-0", turn: { id: "turn", status: "completed" } } });
  await pending;
  assert.equal(sink.events.some((event) => event.includes("SECRET")), false);
  await f.backend.dispose();
});
