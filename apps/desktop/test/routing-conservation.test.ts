import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_ROUTING, type Thread } from "../src/shared/types.js";
import { ladder } from "../src/main/engine/routing/catalog.js";
import { decide, type DecisionInput } from "../src/main/engine/routing/policy.js";
import type { QuotaSnapshot } from "../src/main/engine/routing/quota.js";
import { Router } from "../src/main/engine/routing/router.js";
import { tmpdir } from "./helpers.js";

const models = ["gpt-5.5", "gpt-5.6", "gpt-6-sol", "gpt-6-astra"].map(id => ({ id, label: id, efforts: ["low", "medium", "high", "xhigh"], serviceTiers: ["fast"] }));
const q = (remainingPercent: number): QuotaSnapshot => ({ at: Date.now(), windows: [{ key: "plan", remainingPercent }] });
const input = (over: Partial<DecisionInput> = {}): DecisionInput => ({
  judgments: { task: "small_edit", taskConfidence: 0.9, taskProbabilities: {}, complexity: 0.8, complexityConfidence: 0.9, blastRadius: 0.1, wantsSpeed: 0.9, needsDeepReasoning: 0.1, dependsOnPriorTurns: 0 },
  source: "jev", policy: { ...DEFAULT_ROUTING }, current: { backend: "codex", model: "gpt-6-astra", effort: "xhigh", hasSession: false },
  ladders: { codex: ladder("codex", models), claude: ladder("claude", [{ id: "sonnet", label: "Sonnet", efforts: ["low", "medium", "high"] }]) },
  fitOffset: 0, premiumExhausted: false, ...over,
});

test("low balances automatically conserve light work, disable paid fast mode and explain why", () => {
  const i = input({ quotas: { codex: q(15) } }); i.judgments.wantsSpeed = 0.6;
  const d = decide(i);
  assert.equal(d.model, "gpt-5.5");
  assert.equal(d.fast, false);
  assert.ok(d.reasons.some(r => /conserv/i.test(r)));
  assert.ok(d.reasons.some(r => /15%/.test(r)));
  i.policy.conserve_credits = false;
  assert.equal(decide(i).model, "gpt-5.6");
});

test("conservation retains capability for complex and risky work and enforces effort ceilings", () => {
  for (const signal of [{ complexity: 2.5, needsDeepReasoning: 0.9 }, { complexity: 1.5, blastRadius: 1.8 }]) {
    const i = input({ quotas: { codex: q(10) } }); Object.assign(i.judgments, signal);
    const d = decide(i);
    assert.equal(d.model, "gpt-6-astra");
    assert.equal(d.effort, "high");
    i.policy.max_effort = "medium";
    assert.equal(decide(i).effort, "medium");
  }
});

test("warm caches retain context but cannot retain fast mode while conserving", () => {
  const i = input({ quotas: { codex: q(10) }, current: { backend: "codex", model: "gpt-6-astra", effort: "xhigh", hasSession: true },
    cache: { lastTurn: { model: "gpt-6-astra", fast: true, contextTokens: 100_000, at: new Date().toISOString() }, idleMs: 1000 } });
  const d = decide(i);
  assert.equal(d.model, "gpt-6-astra");
  assert.equal(d.held, true);
  assert.equal(d.fast, false);
  assert.equal(d.effort, "low");
});

test("exhaustion excludes candidates even with conservation disabled or a low-confidence pin", () => {
  const i = input({ quotas: { codex: q(0) } });
  assert.equal(decide(i).blocked, true);
  i.policy.conserve_credits = false;
  assert.equal(decide(i).blocked, true);
  i.judgments.taskConfidence = 0.1;
  assert.equal(decide(i).blocked, true);
});

test("fresh threads may select a healthy allowed alternative but never discard an existing session", () => {
  const i = input({ quotas: { codex: q(0), claude: q(80) } });
  i.policy.allow_backend_switch = true;
  const moved = decide(i);
  assert.equal(moved.backend, "claude");
  assert.equal(moved.blocked, undefined);
  i.current.hasSession = true;
  assert.equal(decide(i).blocked, true);
  assert.equal(decide(i).backend, "codex");
});

test("unknown usage cannot establish a healthier alternate; a fresh healthy alternate can", () => {
  const i = input({ quotas: { codex: q(10) } }); i.policy.allow_backend_switch = true;
  assert.equal(decide(i).backend, "codex");
  i.quotas!.claude = q(80);
  assert.equal(decide(i).backend, "claude");
  i.policy.allow_backends = ["codex"];
  assert.equal(decide(i).backend, "codex");
});

test("an exhausted model-specific bucket can select another model without a backend switch", () => {
  const i = input({ quotas: { codex: { at: Date.now(), windows: [{ key: "model", model: "gpt-6-astra", remainingPercent: 0 }] } } });
  i.judgments.wantsSpeed = 0.1;
  const d = decide(i);
  assert.notEqual(d.model, "gpt-6-astra");
  assert.equal(d.blocked, undefined);
});

test("Router reads balances and catalogues for captured accounts and never caches across accounts", async () => {
  const reads: string[] = [], lists: string[] = [];
  const router = new Router({ home: tmpdir(), policy: () => DEFAULT_ROUTING, transport: null,
    listModels: async (_backend, account) => { lists.push(account!); return { models }; },
    quota: async (_backend, account) => { reads.push(account!); return q(account === "a" ? 10 : 90); },
  });
  const thread: Thread = { id: "thread", projectId: "p", title: "t", createdAt: "", updatedAt: "", cwd: "/w", backend: "codex", mode: "agent", plan: false, model: "gpt-6-astra", status: "idle", auto: true };
  for (const account of ["a", "b", "a"]) await router.route({ thread, text: "fix a typo", items: [], project: { name: "p" }, accounts: { codex: account } });
  assert.deepEqual(reads, ["a", "b", "a"]);
  assert.deepEqual(lists, ["a", "b"]);
});

test("Router telemetry errors are visible and cannot invent a healthy balance", async () => {
  const router = new Router({ home: tmpdir(), policy: () => DEFAULT_ROUTING, transport: null,
    listModels: async () => ({ models }), quota: async () => { throw new Error("unsupported"); } });
  const thread = { id: "t", backend: "codex", model: "gpt-6-astra", mode: "agent", plan: false } as Thread;
  const r = await router.route({ thread, text: "fix typo", items: [], project: { name: "p" } });
  assert.equal(r.decision.blocked, undefined);
  assert.ok(r.item.reasons.some(r => /unknown/i.test(r)));
});

test("exhausted premium capacity cannot silently downgrade a hard task below its capability target", () => {
  const i = input({ quotas: { codex: { at: Date.now(), windows: [{ key: "model", model: "gpt-6-astra", remainingPercent: 0 }] } } });
  Object.assign(i.judgments, { complexity: 3, needsDeepReasoning: 0.9 });
  assert.equal(decide(i).blocked, true);
});

test("an exhausted backend cannot switch to an alternative whose quota is unknown", () => {
  const i = input({ quotas: { codex: q(0) } }); i.policy.allow_backend_switch = true;
  assert.equal(decide(i).blocked, true);
});

test("the selected model's low bucket activates conservation even when the previous model has no low reading", () => {
  const i = input({ quotas: { codex: { at: Date.now(), windows: [{ key: "model", model: "gpt-5.6", remainingPercent: 10 }] } } });
  Object.assign(i.judgments, { complexity: 1, wantsSpeed: 0.6 });
  assert.equal(decide(i).conserving, true);
  assert.equal(decide(i).fast, false);
});

test("non-light work retains quality posture and learned capability increases during conservation", () => {
  for (const preference of ["quality", "learned"] as const) {
    const i = input({ quotas: { codex: q(10) } }); Object.assign(i.judgments, { complexity: 1.6, wantsSpeed: 0.1 });
    if (preference === "quality") i.policy.posture = "quality";
    else i.fitOffset = 1;
    assert.equal(decide(i).model, "gpt-6-astra");
    assert.equal(decide(i).effort, "high");
  }
});

test("an unrelated exhausted bucket cannot block an otherwise valid warm-cache route", () => {
  const i = input({ current: { backend: "codex", model: "gpt-6-sol", effort: "xhigh", hasSession: true },
    cache: { lastTurn: { model: "gpt-6-sol", fast: false, contextTokens: 100_000, at: new Date().toISOString() }, idleMs: 1000 } });
  Object.assign(i.judgments, { complexity: 3, needsDeepReasoning: 0.1, dependsOnPriorTurns: 0.9, wantsSpeed: 0.1 });
  const baseline = decide(i); assert.equal(baseline.model, "gpt-6-sol");
  i.quotas = { codex: { at: Date.now(), windows: [{ key: "unrelated", model: "gpt-5.5", remainingPercent: 0 }] } };
  const d = decide(i);
  assert.equal(d.blocked, undefined);
  assert.equal(d.model, baseline.model);
  assert.equal(d.effort, baseline.effort);
});

test("an unrelated exhausted source bucket cannot change an already permitted capability switch", () => {
  const i = input({ ladders: { codex: ladder("codex", models.filter(m => m.id !== "gpt-6-astra")), claude: ladder("claude", [{ id: "fable", label: "Fable", efforts: ["high", "xhigh"] }]) } });
  i.policy.allow_backend_switch = true;
  Object.assign(i.judgments, { complexity: 3, wantsSpeed: 0.1 });
  assert.equal(decide(i).backend, "claude");
  i.quotas = { codex: { at: Date.now(), windows: [{ key: "unrelated", model: "gpt-5.5", remainingPercent: 0 }] } };
  assert.equal(decide(i).blocked, undefined);
  assert.equal(decide(i).backend, "claude");
});

test("an exhausted alternative cannot force a hard task onto an insufficient source model", () => {
  const i = input({ ladders: { codex: ladder("codex", models.filter(m => m.id !== "gpt-6-astra")), claude: ladder("claude", [{ id: "fable", label: "Fable", efforts: ["high", "xhigh"] }]) }, quotas: { claude: q(0) } });
  i.policy.allow_backend_switch = true;
  Object.assign(i.judgments, { complexity: 3, wantsSpeed: 0.1 });
  assert.equal(decide(i).blocked, true);
});

test("an exhausted expensive cache holder can move to a suitable cheap model for a light task", () => {
  const i = input({ current: { backend: "codex", model: "gpt-6-astra", hasSession: true },
    cache: { lastTurn: { model: "gpt-6-astra", fast: false, contextTokens: 100_000, at: new Date().toISOString() }, idleMs: 1000 },
    quotas: { codex: { at: Date.now(), windows: [{ key: "model", model: "gpt-6-astra", remainingPercent: 0 }] } } });
  Object.assign(i.judgments, { complexity: 0.1, wantsSpeed: 0.1 });
  const d = decide(i);
  assert.equal(d.blocked, undefined);
  assert.equal(d.model, "gpt-5.5");
});
