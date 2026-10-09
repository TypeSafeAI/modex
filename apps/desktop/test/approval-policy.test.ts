import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/main/engine/store.js";
import { ThreadRunner } from "../src/main/engine/runner.js";
import { Router } from "../src/main/engine/routing/router.js";
import { policyAnswer, policyReceipt } from "../src/main/engine/approvals/policy.js";
import type { Backend, TurnSink } from "../src/main/engine/backends/types.js";
import type { ThreadEvent, ThreadItem } from "../src/shared/types.js";
import { gitRepo, tmpdir } from "./helpers.js";

const bash = { backend: "claude" as const, tool: "Bash", title: "$ make", input: { command: "make" } };
const escalating = { backend: "codex" as const, tool: "permissions", title: "network access", escalation: true };

test("policy: ask never answers; always answers unless it cannot tell or the request escalates; yolo answers everything", () => {
  assert.equal(policyAnswer(undefined, bash), null);
  assert.equal(policyAnswer("ask", bash), null);
  assert.equal(policyAnswer("always", bash), "yes");
  assert.equal(policyAnswer("always", undefined), null, "no structured action: a human decides");
  assert.equal(policyAnswer("always", escalating), null);
  const gated = (decision: "ask" | "allow", downgraded?: "destructive") => ({ ...policyReceipt("always"), source: "rule" as const, via: "match" as const, decision, ...(downgraded ? { downgraded } : {}) });
  assert.equal(policyAnswer("always", bash, gated("ask", "destructive")), null, "the gate's destructive downgrade stands");
  assert.equal(policyAnswer("always", bash, gated("ask")), null, "an Ask rule is respected");
  assert.equal(policyAnswer("yolo", bash, gated("ask", "destructive")), "yes");
  assert.equal(policyAnswer("always", bash, { ...gated("allow"), downgraded: "jev-unavailable" }), "yes", "an unreachable judge is not a reason to ask");
  assert.equal(policyAnswer("yolo", escalating), "yes");
  assert.equal(policyAnswer("yolo", undefined), "yes");
  assert.deepEqual([policyReceipt("always").via, policyReceipt("yolo").ruleId], ["policy", "policy:yolo"]);
});

function setup() {
  const home = tmpdir("modex-home-");
  const store = new Store(home);
  store.updateSettings({ default_backend: "mock" });
  const events: ThreadEvent[] = [];
  const router = new Router({ home, policy: () => store.settings.routing, listModels: async () => ({ models: [] }), transport: null });
  const answers: string[] = [];
  const backend: Backend = { id: "mock", listModels: async () => [], dispose: async () => {}, async runTurn(_t, _o, sink: TurnSink) {
    for (const action of [bash, escalating]) answers.push(await sink.approval({ question: `Allow ${action.title}?`, canAlways: true, action }));
    sink.assistant("done");
    return { status: "completed" };
  } };
  const runner = new ThreadRunner({ home, store, router, emit: (e) => events.push(e), backends: { mock: backend } });
  return { store, runner, answers, events, project: store.addProject(gitRepo()) };
}
const cards = (items: ThreadItem[]) => items.filter((i): i is Extract<ThreadItem, { kind: "approval" }> => i.kind === "approval");
const until = async <T>(fn: () => T | undefined): Promise<T> => { for (let i = 0; i < 200; i++) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 10)); } throw new Error("timed out"); };

test("a thread on Always allow approves ordinary requests with a receipt and still asks about an escalation", async () => {
  const s = setup();
  const thread = await s.runner.createThread(s.project.id);
  s.runner.updateThread(thread.id, { approvals: "always", title: "x" });
  const done = s.runner.send(thread.id, "go");
  const waiting = await until(() => cards(s.runner.items(thread.id)).find((c) => !c.answer));
  assert.equal(s.runner.status(thread.id), "waiting");
  assert.match(waiting.question, /network access/);
  s.runner.answer(thread.id, waiting.id, "no");
  await done;
  assert.deepEqual(s.answers, ["yes", "no"]);
  const auto = cards(s.runner.items(thread.id))[0]!;
  assert.deepEqual([auto.answer, auto.decidedBy?.source, auto.decidedBy?.ruleId, auto.title], ["yes", "policy", "policy:always", "$ make"]);
});

test("a thread on YOLO never waits, and switching to YOLO clears an approval that is already waiting", async () => {
  const s = setup();
  const thread = await s.runner.createThread(s.project.id);
  s.runner.updateThread(thread.id, { title: "x" });
  const done = s.runner.send(thread.id, "go");
  const waiting = await until(() => cards(s.runner.items(thread.id)).find((c) => !c.answer));
  s.runner.updateThread(thread.id, { approvals: "yolo" });
  await done;
  assert.equal(s.answers[0], "yes");
  assert.deepEqual(s.answers, ["yes", "yes"], "the second request, an escalation, is covered by YOLO");
  assert.equal(cards(s.runner.items(thread.id)).find((c) => c.id === waiting.id)?.answer, "yes");
  assert.equal(s.store.thread(thread.id)?.approvals, "yolo");
  s.runner.updateThread(thread.id, { approvals: "bogus" as never });
  assert.equal(s.store.thread(thread.id)?.approvals, "yolo", "an unknown policy is ignored");
});

test("an explicit Never rule still refuses on a YOLO thread", async () => {
  const s = setup();
  s.store.updateSettings({ approval_gate: { enabled: true, threshold: 0.8, timeout_ms: 1000 }, approval_rules: [{ id: "n", when: "run make", decision: "never", match: "Bash: make*", enabled: true }] });
  const thread = await s.runner.createThread(s.project.id);
  s.runner.updateThread(thread.id, { approvals: "yolo", title: "x" });
  await s.runner.send(thread.id, "go");
  assert.deepEqual(s.answers, ["no", "yes"]);
  assert.equal(cards(s.runner.items(thread.id))[0]!.decidedBy?.decision, "never");
});

