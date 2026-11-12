import assert from "node:assert/strict";
import { test } from "node:test";
import { Store } from "../src/main/engine/store.js";
import { ThreadRunner } from "../src/main/engine/runner.js";
import { Router } from "../src/main/engine/routing/router.js";
import { ClaudeAccounts } from "../src/main/engine/claude-accounts.js";
import type { Backend, TurnOptions } from "../src/main/engine/backends/types.js";
import type { QuotaSnapshot } from "../src/main/engine/routing/quota.js";
import { gitRepo, tmpdir } from "./helpers.js";
import { local } from "./fakeproc.js";

const models = ["haiku", "sonnet", "opus", "fable"].map(id => ({ id, label: id, efforts: ["low", "medium", "high", "xhigh"], ...(id === "opus" ? { serviceTiers: ["fast"] } : {}) }));
const quota = (remainingPercent: number, model?: string): QuotaSnapshot => ({ at: Date.now(), windows: [{ key: model ?? "plan", remainingPercent, ...(model ? { model } : {}) }] });

async function fixture(hard = true) {
  const home = tmpdir(), store = new Store(home), project = store.addProject(gitRepo());
  const secrets = new Map<string, string>();
  const accounts = new ClaudeAccounts(home, { available: () => true, get: key => secrets.get(key) ?? null, set: (key, value) => { secrets.set(key, value); }, clear: key => { secrets.delete(key); } });
  const a = accounts.addProfile("A"), b = accounts.addProfile("B"), c = accounts.addProfile("C");
  accounts.select(a.id);
  const quotas = new Map<string, QuotaSnapshot>([[a.id, quota(80)], [b.id, quota(80)], [c.id, quota(80)]]);
  const turns: TurnOptions[] = [];
  let fail: "model" | "account" = "model";
  const backend: Backend = { id: "claude", identity: () => accounts.identity(), listModels: async () => models, quota: async account => quotas.get(account!), dispose: async () => {},
    runTurn: async (_text, opts, sink) => {
      turns.push(opts);
      if (opts.account === a.id && (fail === "account" || opts.model === "fable")) return { status: "failed", error: fail === "account" ? "usage limit reached" : "model_requires_usage_credits" };
      local(sink).assistant("done"); return { status: "completed" };
    } };
  const router = new Router({ home, policy: () => store.settings.routing, listModels: async () => ({ models }), quota: async (_backend, account) => quotas.get(account!),
    transport: async () => ({ answers: {
      task: { type: "choice", choice: hard ? "feature" : "small_edit", probabilities: {}, confidence: 0.99 },
      complexity: { type: "score", score: hard ? 3 : 0.1, probabilities: {}, confidence: 0.99 },
      blast_radius: { type: "score", score: 0, probabilities: {}, confidence: 0.99 },
      wants_speed: { type: "noul", noul: 0.1 }, needs_deep_reasoning: { type: "noul", noul: 0.1 },
    } }),
  });
  const runner = new ThreadRunner({ home, store, claudeAccounts: accounts, router, backends: { claude: backend }, emit: () => {} });
  const thread = await runner.createThread(project.id, { backend: "claude", model: "fable", auto: true });
  return { runner, store, router, accounts, quotas, turns, a, b, c, thread, project, failAccount: () => { fail = "account"; } };
}

for (const exhausted of [false, true]) test(`automatic model fallback cannot bypass ${exhausted ? "exhausted quota" : "the hard task capability floor"}`, async () => {
  const f = await fixture();
  if (exhausted) f.quotas.set(f.a.id, quota(0, "opus"));
  try {
    await f.runner.send(f.thread.id, "implement the feature");
    assert.deepEqual(f.turns.map(t => t.model), ["fable"]);
    assert.equal(f.store.thread(f.thread.id)?.model, "fable", "a rejected fallback must not be persisted");
  } finally { await f.runner.dispose(); }
});

test("an economical model fallback remains valid for a light task held on an expensive cache holder", async () => {
  const f = await fixture(false);
  f.store.updateThread(f.thread.id, { claudeAccount: f.a.id, sessionHandle: "warm", lastTurn: { model: "fable", at: new Date().toISOString(), fast: false, contextTokens: 100_000 } });
  f.quotas.set(f.a.id, quota(10, "opus"));
  try {
    await f.runner.send(f.thread.id, "fix a typo");
    assert.deepEqual(f.turns.map(t => t.model), ["fable", "opus"], JSON.stringify(f.runner.items(f.thread.id).filter(i => i.kind === "route" || i.kind === "notice")));
    assert.equal(f.turns[1]?.conserveCredits, true);
    assert.equal(f.turns[1]?.fast, false);
  } finally { await f.runner.dispose(); }
});

for (const remaining of [0, 10]) test(`account retry validates replacement account at ${remaining}% allowance`, async () => {
  const f = await fixture(); f.failAccount(); f.accounts.setRotation(true); f.quotas.set(f.b.id, quota(remaining));
  try {
    await f.runner.send(f.thread.id, "implement the feature");
    assert.equal(f.turns[0]?.account, f.a.id);
    if (remaining === 0) assert.deepEqual(f.turns.map(t => t.account), [f.a.id]);
    else {
      assert.equal(f.turns[1]?.account, f.b.id);
      assert.equal(f.turns[1]?.conserveCredits, true);
      assert.equal(f.turns[1]?.effort, "high");
      assert.equal(f.turns[1]?.fast, false);
    }
  } finally { await f.runner.dispose(); }
});

for (const mode of ["enabled", "disabled", "session"] as const) test(`proactive exhaustion respects ${mode} account rotation`, async () => {
  const f = await fixture(); f.failAccount(); f.accounts.setRotation(mode !== "disabled"); f.quotas.set(f.a.id, quota(0));
  if (mode === "session") f.store.updateThread(f.thread.id, { sessionHandle: "profile-session", claudeAccount: f.a.id });
  try {
    await f.runner.send(f.thread.id, "implement the feature");
    assert.deepEqual(f.turns.map(t => t.account), mode === "enabled" ? [f.b.id] : []);
  } finally { await f.runner.dispose(); }
});

test("proactive rotation skips multiple exhausted accounts using metadata without running them", async () => {
  const f = await fixture(); f.accounts.setRotation(true); f.quotas.set(f.a.id, quota(0)); f.quotas.set(f.b.id, quota(0));
  try {
    await f.runner.send(f.thread.id, "implement the feature");
    assert.deepEqual(f.turns.map(t => t.account), [f.c.id]);
  } finally { await f.runner.dispose(); }
});

test("a refused model's recent-credit quarantine is account-specific", async () => {
  const f = await fixture();
  f.runner.updateThread(f.thread.id, { auto: false });
  try {
    await f.runner.send(f.thread.id, "first account");
    f.accounts.select(f.b.id);
    const next = await f.runner.createThread(f.project.id, { backend: "claude", model: "fable", auto: false });
    await f.runner.send(next.id, "second account");
    assert.deepEqual(f.turns.map(t => [t.account, t.model]), [[f.a.id, "fable"], [f.a.id, "opus"], [f.b.id, "fable"]]);
  } finally { await f.runner.dispose(); }
});

test("a blocked quota/capability replacement does not teach a preference for larger models", async () => {
  const f = await fixture();
  try {
    await f.runner.send(f.thread.id, "implement the feature");
    assert.equal(f.router.fit.latest(f.thread.id)?.outcome, "failed");
    assert.equal(f.router.fit.snapshot().tasks.feature?.failures ?? 0, 0);
  } finally { await f.runner.dispose(); }
});

test("conservation avoids a separate paid coding turn just to name the conversation", async () => {
  const f = await fixture(); f.failAccount(); f.accounts.setRotation(true); f.quotas.set(f.b.id, quota(10));
  let titles = 0;
  f.runner.backend("claude").generateTitle = async () => { titles++; return "Generated title"; };
  try {
    await f.runner.send(f.thread.id, "implement the feature");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.turns.length, 2);
    assert.equal(titles, 0);
  } finally { await f.runner.dispose(); }
});

test("account replacement shares its admitted premium budget instead of charging twice", async () => {
  const f = await fixture(); f.failAccount(); f.accounts.setRotation(true);
  f.store.updateSettings({ routing: { ...f.store.settings.routing, premium_turns_per_day: 1 } });
  try {
    await f.runner.send(f.thread.id, "implement the feature");
    assert.deepEqual(f.turns.map(t => t.account), [f.a.id, f.b.id]);
    assert.equal(f.router.fit.premiumToday(), 1);
  } finally { await f.runner.dispose(); }
});

test("proactive cooldown uses the CLI quota reset time", async () => {
  const f = await fixture(); f.accounts.setRotation(true);
  const reset = Date.now() + 5 * 60_000;
  f.quotas.set(f.a.id, { at: Date.now(), windows: [{ key: "plan", remainingPercent: 0, resetsAt: reset }] });
  try {
    await f.runner.send(f.thread.id, "implement the feature");
    assert.equal(f.accounts.status().accounts.find(a => a.id === f.a.id)?.cooldownUntil, new Date(reset).toISOString());
  } finally { await f.runner.dispose(); }
});
