import { test } from "node:test";
import assert from "node:assert/strict";
import { Router } from "../src/main/engine/routing/router.js";
import { Fit } from "../src/main/engine/routing/fit.js";
import { Store } from "../src/main/engine/store.js";
import { CREDIT_SKIP_MS, ThreadRunner } from "../src/main/engine/runner.js";
import { isApiErrorReply } from "../src/main/engine/backends/claude.js";
import type { Backend, TurnOptions, TurnResult, TurnSink } from "../src/main/engine/backends/types.js";
import { classifyFailure, creditFallbackModel, describeFailure, isModelOutOfCredits, modelFamilyName } from "../src/shared/failures.js";
import { gitRepo, tmpdir } from "./helpers.js";
import { local } from "./fakeproc.js";

// Claude Code 2.1.300's own words, from a real refused Fable turn on 2026-10-15.
const REFUSAL = "You're out of usage credits. Switch to another model, or manage usage credits at https://claude.ai/settings/usage?from=cc_cli_limit_message, to continue.";

test("a usage-credit refusal is classified as rate limited with its own summary, not unknown", () => {
  assert.equal(classifyFailure(REFUSAL), "rate_limited");
  assert.equal(isModelOutOfCredits(REFUSAL), true);
  assert.equal(isModelOutOfCredits("429 Too Many Requests"), false);
  const failure = describeFailure({ backend: "claude", message: REFUSAL });
  assert.equal(failure.summary, "Claude Code is out of usage credits for this model.");
  assert.equal(failure.fix?.kind, "models");
});

test("only Fable has a credit fallback, and it is Opus", () => {
  assert.equal(creditFallbackModel("claude", "fable"), "opus");
  assert.equal(creditFallbackModel("claude", "claude-fable-5-1"), "opus");
  assert.equal(creditFallbackModel("claude", "opus"), undefined);
  assert.equal(creditFallbackModel("codex", "fable"), undefined);
  assert.deepEqual(["fable", "claude-opus-5-5", "opus"].map(modelFamilyName), ["Fable", "Opus", "Opus"]);
});

test("the CLI's synthetic refusal reply is recognised; real replies and other synthetic notes are not", () => {
  const synthetic = (text: string, error?: string) => ({ type: "assistant", message: { model: "<synthetic>", content: [{ type: "text", text }] }, ...(error ? { error } : {}) });
  assert.equal(isApiErrorReply(synthetic(REFUSAL)), true);
  assert.equal(isApiErrorReply(synthetic("API Error: 500", "server_error")), true);
  assert.equal(isApiErrorReply(synthetic("No response requested.")), false);
  assert.equal(isApiErrorReply({ type: "assistant", message: { model: "claude-fable-5-1", content: [{ type: "text", text: REFUSAL }] } }), false);
  assert.equal(isApiErrorReply({ ...synthetic(REFUSAL), parent_tool_use_id: "toolu_1" }), false);
});

type Step = (sink: TurnSink) => TurnResult;
const claudeBackend = (steps: Step[], seen: TurnOptions[]): Backend => ({
  id: "claude",
  listModels: async () => [{ id: "fable", label: "Fable", isDefault: true, efforts: ["low", "medium", "high"], defaultEffort: "medium" }, { id: "opus", label: "Opus", efforts: ["low", "medium", "high"], defaultEffort: "medium" }],
  dispose: async () => {},
  async runTurn(_text, opts, sink) {
    seen.push(opts);
    sink.session("claude-session");
    return (steps.shift() ?? (() => ({ status: "completed" })))(sink);
  },
});
const refused: Step = () => ({ status: "failed", error: REFUSAL, detail: { resultSubtype: "success" } });
const replies: Step = (sink) => { local(sink).assistant("done"); return { status: "completed" }; };

async function harness(steps: Step[], settings: { model_fallback?: boolean } = {}) {
  const home = tmpdir("modex-credit-");
  const store = new Store(home);
  if (settings.model_fallback !== undefined) store.updateSettings({ model_fallback: settings.model_fallback });
  const project = store.addProject(gitRepo());
  const seen: TurnOptions[] = [];
  const backend = claudeBackend(steps, seen);
  const router = new Router({ home, policy: () => store.settings.routing,
    listModels: async () => ({ models: await backend.listModels() }), transport: null });
  const runner = new ThreadRunner({ home, store, emit: () => {}, router, backends: { claude: backend } });
  const thread = await runner.createThread(project.id, { backend: "claude", model: "fable" });
  return { store, runner, seen, thread };
}

test("a Fable credit refusal reruns the turn on Opus, says so, and leaves no failure card", async () => {
  const { store, runner, seen, thread } = await harness([refused, replies]);
  try {
    await runner.send(thread.id, "hello");
    assert.deepEqual(seen.map((o) => o.model), ["fable", "opus"]);
    assert.equal(seen[1]!.resume, "claude-session", "the fallback continues the same Claude session");
    const t = store.thread(thread.id)!;
    assert.equal(t.model, "opus");
    assert.equal(t.status, "idle");
    const items = runner.items(thread.id);
    assert.ok(!items.some((i) => i.kind === "notice" && i.failure), "no failure card");
    const notice = items.find((i) => i.kind === "notice" && i.level === "warn");
    assert.match(notice?.kind === "notice" ? notice.text : "", /^Fable is out of usage credits, so this turn moved to Opus\./);
    assert.equal(t.lastTurn?.model, "opus", "the record names the model that ran");
  } finally { await runner.dispose(); }
});

test("after a refusal, later Fable turns start on Opus for an hour without asking Fable again", async () => {
  const { store, runner, seen, thread } = await harness([refused, replies, replies]);
  try {
    await runner.send(thread.id, "first");
    runner.updateThread(thread.id, { model: "fable" });
    await runner.send(thread.id, "second");
    assert.deepEqual(seen.map((o) => o.model), ["fable", "opus", "opus"]);
    assert.ok(runner.items(thread.id).some((i) => i.kind === "notice" && /within the last hour/.test(i.text)));
    assert.equal(store.thread(thread.id)!.model, "opus");
    assert.equal(CREDIT_SKIP_MS, 3_600_000);
  } finally { await runner.dispose(); }
});

test("with the fallback off, the refusal keeps its failure card and the thread stays on Fable", async () => {
  const { store, runner, seen, thread } = await harness([refused], { model_fallback: false });
  try {
    await runner.send(thread.id, "hello");
    assert.deepEqual(seen.map((o) => o.model), ["fable"]);
    assert.equal(store.thread(thread.id)!.model, "fable");
    const card = runner.items(thread.id).find((i) => i.kind === "notice" && i.failure);
    assert.equal(card?.kind === "notice" ? card.failure?.code : undefined, "rate_limited");
  } finally { await runner.dispose(); }
});

test("a refusal after work started is not rerun, so nothing runs twice", async () => {
  const toolThenRefused: Step = (sink) => { local(sink).toolStart({ id: "t1", name: "Bash", title: "$ ls", args: {} }); return { status: "failed", error: REFUSAL }; };
  const { runner, seen, thread } = await harness([toolThenRefused]);
  try {
    await runner.send(thread.id, "hello");
    assert.deepEqual(seen.map((o) => o.model), ["fable"]);
  } finally { await runner.dispose(); }
});

test("when Opus fails too, the card says the fallback was tried", async () => {
  const { runner, thread } = await harness([refused, () => ({ status: "failed", error: "API Error: 500 Internal Server Error" })]);
  try {
    await runner.send(thread.id, "hello");
    const card = runner.items(thread.id).find((i) => i.kind === "notice" && i.failure);
    assert.deepEqual(card?.kind === "notice" ? card.failure?.recovery : undefined, ["Fable was out of usage credits; retried on Opus."]);
  } finally { await runner.dispose(); }
});

for (const cached of [false, true]) test(`an empty fallback reply produces a retry card (cached=${cached})`, async () => {
  const empty: Step = () => ({ status: "completed" });
  const h = await harness(cached ? [refused, replies, empty] : [refused, empty]);
  try {
    if (cached) { await h.runner.send(h.thread.id, "prime"); h.runner.updateThread(h.thread.id, { model: "fable" }); }
    await h.runner.send(h.thread.id, "answer me");
    assert.equal(h.runner.status(h.thread.id), "error");
    assert.ok(h.runner.items(h.thread.id).some(i => i.kind === "notice" && i.failure && /without replying/.test(i.text)));
  } finally { await h.runner.dispose(); }
});

test("Auto attributes fallback outcome to Opus without teaching a user override", async () => {
  const h = await harness([refused, replies]);
  try {
    const router = h.runner.router;
    h.store.updateSettings({ routing: { ...h.store.settings.routing, posture: "quality", allow_fast: false, max_effort: "high" } });
    h.runner.updateThread(h.thread.id, { auto: true });
    await h.runner.send(h.thread.id, "design a complex architecture");
    assert.deepEqual(h.seen.map(o => o.model), ["fable", "opus"]);
    const fit = new Fit(router.fit.file);
    const record = fit.latest(h.thread.id)!;
    assert.equal(record.model, "opus");
    assert.equal(record.tier, 2);
    assert.equal(record.premium, false);
    assert.equal(record.outcome, "completed");
    assert.equal(fit.premiumToday(), 0);
    assert.equal(fit.recordOverride(h.thread.id, 2), undefined);
    assert.equal(fit.snapshot().tasks[record.task]?.overridesDown, 0);
  } finally { await h.runner.dispose(); }
});

test("an aborted credit refusal never starts the fallback", async () => {
  let stop = () => {};
  const h = await harness([() => { stop(); return { status: "failed", error: REFUSAL }; }]);
  stop = () => h.runner.stop(h.thread.id);
  try {
    await h.runner.send(h.thread.id, "cancel me");
    assert.deepEqual(h.seen.map(o => o.model), ["fable"]);
    assert.equal(h.store.thread(h.thread.id)?.model, "fable");
  } finally { await h.runner.dispose(); }
});

test("the credit cooldown expires and allows Fable again", async t => {
  const h = await harness([refused, replies, replies]);
  try {
    await h.runner.send(h.thread.id, "first");
    h.runner.updateThread(h.thread.id, { model: "fable" });
    const future = Date.now() + CREDIT_SKIP_MS + 1;
    t.mock.method(Date, "now", () => future);
    await h.runner.send(h.thread.id, "after cooldown");
    assert.deepEqual(h.seen.map(o => o.model), ["fable", "opus", "fable"]);
  } finally { await h.runner.dispose(); }
});

test("a pending credit refusal falls back while unrelated owner removal holds admission", async () => {
  const h = await harness([refused, replies]);
  const backend = h.runner.backend("claude"), run = backend.runTurn.bind(backend);
  let entered!: () => void, finish!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { finish = resolve; });
  backend.runTurn = async (...args) => { entered(); await gate; return run(...args); };
  const turn = h.runner.send(h.thread.id, "answer during removal");
  let release: (() => void) | undefined;
  try {
    await ready;
    release = h.runner.holdForOwnerRemoval();
    finish(); await turn;
    assert.deepEqual(h.seen.map(o => o.model), ["fable", "opus"]);
    assert.equal(h.runner.status(h.thread.id), "idle");
    assert.ok(h.runner.items(h.thread.id).some(i => i.kind === "assistant" && i.text === "done"));
  } finally { finish(); release?.(); await turn; await h.runner.dispose(); }
});
