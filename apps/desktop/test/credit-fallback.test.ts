import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/main/engine/store.js";
import { CREDIT_SKIP_MS, ThreadRunner } from "../src/main/engine/runner.js";
import { isApiErrorReply } from "../src/main/engine/backends/claude.js";
import type { Backend, TurnOptions, TurnResult, TurnSink } from "../src/main/engine/backends/types.js";
import { classifyFailure, creditFallbackModel, describeFailure, isModelOutOfCredits, modelFamilyName } from "../src/shared/failures.js";
import { gitRepo, tmpdir } from "./helpers.js";

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
  listModels: async () => [{ id: "fable", label: "Fable", isDefault: true }, { id: "opus", label: "Opus" }],
  dispose: async () => {},
  async runTurn(_text, opts, sink) {
    seen.push(opts);
    sink.session("claude-session");
    return (steps.shift() ?? (() => ({ status: "completed" })))(sink);
  },
});
const refused: Step = () => ({ status: "failed", error: REFUSAL, detail: { resultSubtype: "success" } });
const replies: Step = (sink) => { sink.assistant("done"); return { status: "completed" }; };

async function harness(steps: Step[], settings: { model_fallback?: boolean } = {}) {
  const home = tmpdir("modex-credit-");
  const store = new Store(home);
  if (settings.model_fallback !== undefined) store.updateSettings({ model_fallback: settings.model_fallback });
  const project = store.addProject(gitRepo());
  const seen: TurnOptions[] = [];
  const runner = new ThreadRunner({ home, store, emit: () => {}, backends: { claude: claudeBackend(steps, seen) } });
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
  const toolThenRefused: Step = (sink) => { sink.toolStart({ id: "t1", name: "Bash", title: "$ ls", args: {} }); return { status: "failed", error: REFUSAL }; };
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
