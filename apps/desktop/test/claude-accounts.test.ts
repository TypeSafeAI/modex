import { projectConversation, type ConversationEvent } from "../src/shared/conversation-events.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { spawn, SpawnOptions } from "node:child_process";
import { ClaudeAccounts, DEFAULT_COOLDOWN_MS, ORCAROUTER_BASE_URL, limitResetAt } from "../src/main/engine/claude-accounts.js";
import { ClaudeLogin } from "../src/main/engine/claude-login.js";
import { accountHealth, AccountClaudeBackend } from "../src/main/engine/backends/account-claude.js";
import { Router } from "../src/main/engine/routing/router.js";
import { Store } from "../src/main/engine/store.js";
import { ThreadRunner } from "../src/main/engine/runner.js";
import type { Backend, TurnOptions, TurnResult, TurnSink } from "../src/main/engine/backends/types.js";
import { FakeProcess, collectSink, local } from "./fakeproc.js";
import { gitRepo, tmpdir } from "./helpers.js";

const KEY = "sk-orca-SECRETkey1234567890";

function memorySecrets(available = true) {
  const values = new Map<string, string>();
  return { values, available: () => available, get: (name: string) => values.get(name) ?? null, set: (name: string, value: string) => { values.set(name, value); }, clear: (name: string) => { values.delete(name); } };
}

function pool(now = () => Date.now()) {
  const home = tmpdir("modex-claude-accounts-");
  const secrets = memorySecrets();
  return { home, secrets, accounts: new ClaudeAccounts(home, secrets, now) };
}

test("a gateway key lives only in the secret store; the account file and status never carry it", () => {
  const { accounts, secrets } = pool();
  const gateway = accounts.addGateway("Team key", `  ${KEY}  `, "anthropic/claude-opus-4.8");
  assert.equal(secrets.values.get(`claude_account:${gateway.id}`), KEY);
  assert.equal(fs.readFileSync(accounts.file, "utf8").includes("SECRET"), false);
  assert.equal((fs.statSync(accounts.file).mode & 0o777), 0o600);
  assert.equal(JSON.stringify(accounts.status()).includes("SECRET"), false);
  const { env, secret } = accounts.environment(gateway.id);
  assert.equal(secret, KEY);
  assert.deepEqual(env, { ANTHROPIC_BASE_URL: ORCAROUTER_BASE_URL, ANTHROPIC_AUTH_TOKEN: KEY, ANTHROPIC_API_KEY: "", CLAUDE_CODE_OAUTH_TOKEN: "", CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
    ANTHROPIC_MODEL: "anthropic/claude-opus-4.8", ANTHROPIC_DEFAULT_OPUS_MODEL: "anthropic/claude-opus-4.8", ANTHROPIC_DEFAULT_SONNET_MODEL: "anthropic/claude-opus-4.8", ANTHROPIC_DEFAULT_HAIKU_MODEL: "anthropic/claude-opus-4.8" });
  assert.equal(ORCAROUTER_BASE_URL.endsWith("/v1"), false, "Claude Code appends /v1/messages itself");
});

test("a profile gets its own owner-only Claude Code configuration directory and no secret", () => {
  const { accounts } = pool();
  const profile = accounts.addProfile("Work Max");
  const { env, secret } = accounts.environment(profile.id);
  assert.equal(secret, undefined);
  assert.equal(env.CLAUDE_CONFIG_DIR, path.join(accounts.profilesDir, profile.id));
  assert.equal(fs.statSync(env.CLAUDE_CONFIG_DIR!).mode & 0o777, 0o700);
  assert.deepEqual(accounts.environment("cli"), { env: {} });
});

test("input is validated before anything is stored", () => {
  const { accounts, secrets } = pool();
  assert.throws(() => accounts.addGateway("x", "sk-ant-123456789"), /sk-orca-/);
  assert.throws(() => accounts.addGateway("x", KEY, "bad model; rm -rf"), /vendor\/model/);
  assert.throws(() => accounts.addProfile("   "), /name/);
  accounts.addProfile("Work");
  assert.throws(() => accounts.addProfile("work"), /already/);
  assert.throws(() => accounts.select("00000000-0000-0000-0000-000000000000"), /no longer exists/);
  assert.equal(secrets.values.size, 0);
  const locked = new ClaudeAccounts(tmpdir("modex-claude-locked-"), memorySecrets(false));
  assert.throws(() => locked.addGateway("x", KEY), /unavailable/);
});

test("rotation skips cooling accounts in order, wraps to Claude Code's own login, and only when turned on", () => {
  let now = 1_000_000;
  const { accounts } = pool(() => now);
  const a = accounts.addProfile("A"), b = accounts.addGateway("B", KEY);
  accounts.select(a.id);
  assert.equal(accounts.identity(), a.id);
  accounts.noteLimit(a.id);
  assert.equal(accounts.identity(), a.id, "rotation is off by default");
  accounts.setRotation(true);
  assert.equal(accounts.identity(), b.id);
  assert.equal(accounts.noteLimit(b.id, now + 5000).next, "cli");
  accounts.noteLimit("cli");
  assert.equal(accounts.identity(), a.id, "every account cooling: stay on the preferred one");
  now += 5001;
  assert.equal(accounts.identity(), b.id, "B's reset time passed");
  assert.equal(accounts.status().accounts.find((x) => x.id === a.id)?.cooldownUntil, new Date(1_000_000 + DEFAULT_COOLDOWN_MS).toISOString());
  accounts.clearLimit(a.id);
  assert.equal(accounts.identity(), a.id);
});

test("removing an account clears its key or profile directory and its selection", () => {
  const { accounts, secrets } = pool();
  const g = accounts.addGateway("G", KEY), p = accounts.addProfile("P");
  const dir = accounts.environment(p.id).env.CLAUDE_CONFIG_DIR!;
  fs.writeFileSync(path.join(dir, ".credentials.json"), "{}");
  accounts.select(g.id);
  accounts.remove(g.id); accounts.remove(p.id);
  assert.equal(secrets.values.size, 0);
  assert.equal(fs.existsSync(dir), false);
  assert.equal(accounts.status().active, null);
  assert.deepEqual(accounts.status().accounts, []);
});

test("an unreadable account file is reported, not silently replaced", () => {
  const { home } = pool();
  fs.mkdirSync(path.join(home, "app"), { recursive: true });
  fs.writeFileSync(path.join(home, "app", "claude-accounts.json"), "{torn");
  assert.throws(() => new ClaudeAccounts(home, memorySecrets()).status(), /could not be read/);
  assert.equal(fs.readFileSync(path.join(home, "app", "claude-accounts.json"), "utf8"), "{torn");
});

test("usage-limit reset times are read from Claude Code's wording", () => {
  const now = Date.parse("2026-11-01T10:00:00");
  assert.equal(limitResetAt("Rate limited. Try again in 2 hours.", now), now + 7_200_000);
  assert.equal(limitResetAt("retry in 30 seconds", now), now + 30_000);
  assert.equal(limitResetAt("Claude usage limit reached. Your limit resets at 3pm", now), Date.parse("2026-11-01T15:00:00"));
  assert.equal(limitResetAt("5-hour limit reached ∙ resets 9am", now), Date.parse("2026-11-02T09:00:00"), "a passed time is tomorrow");
  assert.equal(limitResetAt("429 Too Many Requests", now), undefined);
});

test("the Claude child gets the turn's account environment, and the key is redacted from failures", async () => {
  const { accounts } = pool();
  const g = accounts.addGateway("G", KEY), p = accounts.addProfile("P");
  const envs: NodeJS.ProcessEnv[] = [];
  const spawnImpl = ((_bin: string, _args: string[], options: SpawnOptions) => {
    const child = new FakeProcess(); envs.push(options.env ?? {});
    child.stdin.on("data", () => { child.emitLine({ type: "result", subtype: "error_during_execution", is_error: true, result: `upstream rejected ${KEY}` }); });
    return child;
  }) as unknown as typeof spawn;
  const previous = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "inherited-key";
  try {
    const backend = new AccountClaudeBackend(accounts, "claude", spawnImpl);
    const run = (account?: string) => backend.runTurn("hi", { cwd: "/repo", mode: "chat", plan: false, model: "", ...(account ? { account } : {}) }, collectSink().sink, new AbortController().signal);
    const gateway = await run(g.id);
    assert.equal(envs[0]!.ANTHROPIC_AUTH_TOKEN, KEY);
    assert.equal(envs[0]!.ANTHROPIC_BASE_URL, ORCAROUTER_BASE_URL);
    assert.equal("ANTHROPIC_API_KEY" in envs[0]!, false, "an inherited API key would win over the gateway token");
    assert.equal(envs[0]!.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, "1");
    assert.equal(gateway.status, "failed");
    assert.equal(JSON.stringify(gateway).includes(KEY), false);
    assert.match(gateway.error ?? "", /\[redacted\]/);
    await run(p.id);
    assert.equal(envs[1]!.CLAUDE_CONFIG_DIR, path.join(accounts.profilesDir, p.id));
    assert.equal(envs[1]!.ANTHROPIC_AUTH_TOKEN, undefined);
    await run("cli");
    assert.equal(envs[2]!.CLAUDE_CONFIG_DIR, process.env.CLAUDE_CONFIG_DIR);
    assert.equal(envs[2]!.ANTHROPIC_API_KEY, "inherited-key", "Claude Code's own login keeps the person's environment");
    accounts.remove(g.id);
    const removed = await run(g.id);
    assert.equal(envs.length, 3, "a removed account never starts a child");
    assert.match(removed.error ?? "", /removed from Modex/);
  } finally { if (previous === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = previous; }
});

const LIMIT = "Claude AI usage limit reached|resets at 11pm";
type Step = (sink: TurnSink) => TurnResult;

async function runnerHarness(steps: Step[], setup: (accounts: ClaudeAccounts) => void) {
  const home = tmpdir("modex-claude-rotate-");
  const store = new Store(home);
  const project = store.addProject(gitRepo());
  const accounts = new ClaudeAccounts(home, memorySecrets());
  setup(accounts);
  const seen: TurnOptions[] = [];
  const backend: Backend = {
    id: "claude", identity: () => accounts.identity(), dispose: async () => {},
    listModels: async () => [{ id: "opus", label: "Opus", isDefault: true }],
    async runTurn(_text, opts, sink) { seen.push(opts); sink.session(`session-${seen.length}`); return (steps.shift() ?? (() => ({ status: "completed" as const })))(sink); },
  };
  const router = new Router({ home, policy: () => store.settings.routing, listModels: async () => ({ models: await backend.listModels() }), transport: null });
  const runner = new ThreadRunner({ home, store, emit: () => {}, router, backends: { claude: backend }, claudeAccounts: accounts });
  const thread = await runner.createThread(project.id, { backend: "claude", model: "opus" });
  return { store, runner, seen, thread, accounts };
}
const limited: Step = () => ({ status: "failed", error: LIMIT });
const replies: Step = (sink) => { local(sink).assistant("done"); return { status: "completed" }; };

test("a usage-limited Claude account rotates a fresh conversation to the next account and binds it there", async () => {
  let first = "", second = "";
  const h = await runnerHarness([limited, replies], (accounts) => {
    first = accounts.addProfile("First").id; second = accounts.addProfile("Second").id;
    accounts.select(first); accounts.setRotation(true);
  });
  try {
    await h.runner.send(h.thread.id, "hello");
    assert.deepEqual(h.seen.map((o) => o.account), [first, second]);
    assert.equal(h.seen[1]!.resume, undefined, "a fresh conversation does not resume the old profile's session");
    const t = h.store.thread(h.thread.id)!;
    assert.equal(t.claudeAccount, second);
    assert.equal(t.status, "idle");
    const notice = h.runner.items(h.thread.id).find((i) => i.kind === "notice" && i.level === "warn");
    assert.match(notice?.kind === "notice" ? notice.text : "", /Claude account "First" hit its usage limit; .* Retrying on "Second"\./);
    assert.equal(h.accounts.coolingDown(first), true);
    assert.equal(h.accounts.identity(), second, "new conversations also skip the limited account");
  } finally { await h.runner.dispose(); }
});

test("rotation never moves a turn that already started work, nor a profile conversation with a session", async () => {
  const startedThenLimited: Step = (sink) => { local(sink).assistant("half"); return { status: "failed", error: LIMIT }; };
  let first = "";
  const h = await runnerHarness([replies, limited, startedThenLimited], (accounts) => {
    first = accounts.addProfile("First").id; accounts.addProfile("Second");
    accounts.select(first); accounts.setRotation(true);
  });
  try {
    await h.runner.send(h.thread.id, "one");
    await h.runner.send(h.thread.id, "two");
    assert.equal(h.seen.length, 2, "a profile's session cannot resume in another profile");
    assert.equal(h.store.thread(h.thread.id)!.claudeAccount, first);
    const notice = h.runner.items(h.thread.id).filter((i) => i.kind === "notice" && i.level === "warn").at(-1);
    assert.match(notice?.kind === "notice" ? notice.text : "", /New Claude conversations start on "Second"\./);
  } finally { await h.runner.dispose(); }
});

test("with rotation off a limit only cools the account down; Claude Code's own login and gateways share sessions", async () => {
  let gateway = "";
  const off = await runnerHarness([limited], (accounts) => { accounts.select(accounts.addProfile("Only").id); accounts.addProfile("Other"); });
  try {
    await off.runner.send(off.thread.id, "hi");
    assert.equal(off.seen.length, 1);
    assert.equal(off.store.thread(off.thread.id)!.status, "error");
  } finally { await off.runner.dispose(); }
  const shared = await runnerHarness([replies, limited, replies], (accounts) => { gateway = accounts.addGateway("Gateway", KEY).id; accounts.setRotation(true); });
  try {
    await shared.runner.send(shared.thread.id, "one");
    assert.equal(shared.store.thread(shared.thread.id)!.claudeAccount, "cli");
    await shared.runner.send(shared.thread.id, "two");
    assert.deepEqual(shared.seen.map((o) => o.account), ["cli", "cli", gateway]);
    assert.equal(shared.seen[2]!.resume, "session-2", "a gateway continues the session in Claude Code's own directory");
  } finally { await shared.runner.dispose(); }
});

test("a dated reset is read on its day", () => {
  const now = Date.parse("2026-11-01T10:00:00");
  assert.equal(limitResetAt("Weekly limit reached ∙ resets Nov 3 at 7pm (UTC)", now), Date.parse("2026-11-03T19:00:00"));
  assert.equal(limitResetAt("Claude AI usage limit reached|resets at 11pm", now), Date.parse("2026-11-01T23:00:00"));
});

for (const operation of ["turn", "health", "login"] as const) {
  test(`profile ${operation} removes inherited authentication and endpoint overrides`, async () => {
    const { accounts } = pool();
    const profile = accounts.addProfile("Isolated");
    const names = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_BASE_URL"];
    const previous = names.map((name) => process.env[name]);
    const captured: NodeJS.ProcessEnv[] = [];
    let checks = 0;
    const spawnImpl = ((_bin: string, args: string[], options: SpawnOptions) => {
      const child = new FakeProcess();
      if (args[0] !== "--version") captured.push(options.env ?? {});
      if (args[0] === "--version" || args[0] === "auth") setImmediate(() => {
        const loggedIn = operation !== "login" || args[1] !== "status" || checks++ > 0;
        child.emitLine(args[0] === "--version" ? "2.1.316" : { loggedIn }); child.close(loggedIn ? 0 : 1);
      });
      else child.stdin.once("data", () => { child.emitLine({ type: "result", subtype: "success", result: "done" }); child.close(0); });
      return child;
    }) as unknown as typeof spawn;
    try {
      names.forEach((name) => { process.env[name] = "synthetic-inherited-value"; });
      if (operation === "turn") await new AccountClaudeBackend(accounts, "claude", spawnImpl).runTurn("hi", { cwd: "/repo", mode: "chat", plan: false, model: "", account: profile.id }, collectSink().sink, new AbortController().signal);
      else if (operation === "health") await accountHealth("claude", spawnImpl, accounts, profile.id);
      else await new ClaudeLogin(spawnImpl).run("claude", accounts.environment(profile.id).env);
      assert.equal(captured.length, operation === "login" ? 3 : 1);
      for (const env of captured) {
        assert.equal(env.CLAUDE_CONFIG_DIR, path.join(accounts.profilesDir, profile.id));
        for (const name of names) assert.equal(env[name], undefined, `${operation} inherited ${name}`);
      }
    } finally { names.forEach((name, i) => { if (previous[i] === undefined) delete process.env[name]; else process.env[name] = previous[i]; }); }
  });
}

test("a second usage-limited account cools down without a third retry", async () => {
  let first = "", second = "", third = "";
  const h = await runnerHarness([limited, limited], (accounts) => {
    first = accounts.addProfile("A").id; second = accounts.addProfile("B").id; third = accounts.addProfile("C").id;
    accounts.select(first); accounts.setRotation(true);
  });
  try {
    await h.runner.send(h.thread.id, "hello");
    assert.deepEqual(h.seen.map((o) => o.account), [first, second]);
    assert.equal(h.accounts.coolingDown(second), true);
    assert.equal(h.accounts.identity(), third);
    assert.equal(h.store.thread(h.thread.id)!.status, "error");
  } finally { await h.runner.dispose(); }
});

for (const streamed of [false, true]) {
  test(`gateway key is redacted before ${streamed ? "split streaming" : "snapshot"} observations reach the transcript`, async () => {
    const { accounts } = pool(); const gateway = accounts.addGateway("G", KEY);
    const observed: unknown[] = [];
    const collected = collectSink();
    const spawnImpl = ((_bin: string, _args: string[], _options: SpawnOptions) => {
      const child = new FakeProcess();
      child.stdin.once("data", () => {
        if (streamed) {
          child.emitLine({ type: "stream_event", event: { type: "message_start", message: { id: "m" } } });
          child.emitLine({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } });
          for (const text of ["before " + KEY.slice(0, 12), KEY.slice(12) + " after"]) child.emitLine({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } });
          child.emitLine({ type: "stream_event", event: { type: "content_block_stop", index: 0 } });
        } else child.emitLine({ type: "assistant", message: { id: "m", content: [{ type: "text", text: `before ${KEY} after` }] } });
        child.emitLine({ type: "result", subtype: "success", result: "done" }); child.close(0);
      }); return child;
    }) as unknown as typeof spawn;
    await new AccountClaudeBackend(accounts, "claude", spawnImpl).runTurn("hi", { cwd: "/repo", mode: "chat", plan: false, model: "", account: gateway.id }, { ...collected.sink, observe(o) { observed.push(o); collected.sink.observe(o); } }, new AbortController().signal);
    assert.equal(JSON.stringify(observed).includes(KEY), false);
    const stamp = { schema: 1 as const, at: "2026-11-01T00:00:00Z", turn: { thread: "t", turn: "u", attempt: "a", backend: "claude" as const } };
    const events: ConversationEvent[] = [{ ...stamp, type: "attempt.start", id: "start", seq: 1 }, ...collected.observations.map((o, i) => ({ ...stamp, ...o, id: String(i), seq: i + 2 }))];
    const text = projectConversation(events).items.filter((i) => i.kind === "assistant").map((i) => i.text).join("");
    assert.equal(text, "before [redacted] after");
  });
}

test("a tool request containing the gateway key is denied without exposing or rewriting the action", async () => {
  const { accounts } = pool(); const gateway = accounts.addGateway("G", KEY);
  const proc = new FakeProcess(); const captured = collectSink(["yes"]);
  let deliveries = 0;
  const backend = new AccountClaudeBackend(accounts, "claude", (() => proc) as unknown as typeof spawn);
  const pending = backend.runTurn("hi", { cwd: "/repo", mode: "chat", plan: false, model: "", account: gateway.id }, {
    ...captured.sink, deliverRequest: async (_native, write) => { deliveries++; await write(); },
  }, new AbortController().signal);
  await proc.waitFor((line) => line.includes('"type":"user"'));
  proc.emitLine({ type: "control_request", request_id: "secret-action", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: `echo ${KEY}` } } });
  await proc.waitFor((line) => line.includes('"request_id":"secret-action"'));
  const response = proc.sent((msg) => msg.type === "control_response")[0]!;
  proc.emitLine({ type: "result", subtype: "success", result: "done" }); proc.close(0);
  await pending;
  assert.equal(response.response.response.behavior, "deny");
  assert.equal(captured.requests.length, 0, "the raw action must never reach approval storage or IPC");
  assert.equal(deliveries, 0, "a hidden denial has no human-request receipt to revalidate");
  assert.equal(JSON.stringify(captured.events).includes(KEY), false);
});

test("gateway redaction preserves an ordinary trailing key-prefix character", async () => {
  const { claudeSecretSink } = await import("../src/main/engine/backends/claude-secret-sink.js");
  const collected = collectSink(); const protectedSink = claudeSecretSink(collected.sink, KEY);
  const native = { runtime: "r", item: "m" };
  protectedSink.sink.observe({ type: "message.delta", native, text: "ordinary words" });
  protectedSink.sink.observe({ type: "message.done", native });
  protectedSink.finish();
  const text = collected.observations.filter((o) => o.type === "message.delta").map((o) => o.text).join("");
  assert.equal(text, "ordinary words");
});

test("gateway redaction omits altered native and source identities instead of renaming them", async () => {
  const { claudeSecretSink } = await import("../src/main/engine/backends/claude-secret-sink.js");
  const collected = collectSink(), protectedSink = claudeSecretSink(collected.sink, KEY);
  for (const identity of [{ native: { runtime: "r", item: KEY } }, { native: { runtime: "r", item: "public" }, source: KEY }]) {
    protectedSink.sink.observe({ type: "message.start", ...identity, phase: "final" });
    protectedSink.sink.observe({ type: "message.delta", ...identity, text: "unavailable identity" });
    protectedSink.sink.observe({ type: "message.done", ...identity });
  }
  const native = { runtime: "r", item: "[redacted]" };
  protectedSink.sink.observe({ type: "message.done", native, text: "real literal identity" }); protectedSink.finish();
  assert.deepEqual(collected.observations, [{ type: "message.done", native, text: "real literal identity" }]);
});

test("gateway credential questions are withdrawn before publication and write only their fixed refusal", async () => {
  const { claudeSecretSink } = await import("../src/main/engine/backends/claude-secret-sink.js");
  const collected = collectSink(); let questions = 0, brokerDeliveries = 0, writes = 0;
  const protectedSink = claudeSecretSink({ ...collected.sink, question: async () => { questions++; return { answers: { q: ["yes"] } }; }, deliverRequest: async (_native, write) => { brokerDeliveries++; await write(); } }, KEY);
  const native = { runtime: "r", request: "q" };
  const result = await protectedSink.sink.question!({ native, blocking: true, questions: [{ id: "q", header: "Choose", text: `Use ${KEY}?`, options: null, allowOther: true, secret: false }] });
  assert.deepEqual(result, { withdrawn: "ended" }); assert.equal(questions, 0);
  await protectedSink.sink.deliverRequest!(native, async () => { writes++; });
  assert.equal(writes, 1); assert.equal(brokerDeliveries, 0); assert.equal(JSON.stringify(collected).includes(KEY), false);
});

test("gateway terminal output suppresses a long incomplete credential prefix", async () => {
  const { claudeSecretSink } = await import("../src/main/engine/backends/claude-secret-sink.js");
  const collected = collectSink(), protectedSink = claudeSecretSink(collected.sink, KEY);
  protectedSink.sink.observe({ type: "message.delta", native: { runtime: "r", item: "m" }, text: `prefix ${KEY.slice(0, -1)}` }); protectedSink.finish();
  const text = collected.observations.filter(event => event.type === "message.delta").map(event => event.text).join("");
  assert.equal(text, "prefix [redacted]");
});

test("gateway redaction handles every key split independently for message and reasoning streams", async () => {
  const { claudeSecretSink } = await import("../src/main/engine/backends/claude-secret-sink.js");
  for (let split = 1; split < KEY.length; split++) {
    const collected = collectSink(); const protectedSink = claudeSecretSink(collected.sink, KEY);
    const message = { runtime: "r", item: "message" }, thinking = { runtime: "r", item: "reasoning" };
    protectedSink.sink.observe({ type: "message.delta", native: message, text: "hello " + KEY.slice(0, split) });
    protectedSink.sink.observe({ type: "reasoning.delta", native: thinking, representation: "provider-text", index: 0, text: "reason " + KEY.slice(0, split) });
    protectedSink.sink.observe({ type: "message.delta", native: message, text: KEY.slice(split) + " world" });
    protectedSink.sink.observe({ type: "reasoning.delta", native: thinking, representation: "provider-text", index: 0, text: KEY.slice(split) + " end" });
    protectedSink.finish();
    assert.equal(collected.observations.filter((o) => o.type === "message.delta").map((o) => o.text).join(""), "hello [redacted] world");
    assert.equal(collected.observations.filter((o) => o.type === "reasoning.delta").map((o) => o.text).join(""), "reason [redacted] end");
  }
});
