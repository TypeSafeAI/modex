import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { judgeHeuristically, judgmentsFrom, questionsFor, stateFor, TASKS, type Judgments } from "../src/main/engine/routing/judge.js";
import { decide, type DecisionInput } from "../src/main/engine/routing/policy.js";
import { ladder, pick, tierOf, type Candidate } from "../src/main/engine/routing/catalog.js";
import { Fit, OVERRIDE_STEP } from "../src/main/engine/routing/fit.js";
import { Router } from "../src/main/engine/routing/router.js";
import { httpTransport, JevError, resetKeyCache, resolveTypesafeKey, type JevResponse } from "../src/main/engine/routing/jev.js";
import { DEFAULT_ROUTING, type ModelInfo, type RoutingPolicy, type Thread } from "../src/shared/types.js";
import { tmpdir } from "./helpers.js";

const state = (text: string, recent: { role: "user" | "assistant" | "tool"; text: string }[] = []) => ({ request: text, thread: { backend: "codex" as const, model: "", mode: "agent" as const, plan: false, turns: recent.length }, recent, project: { name: "demo" } });

// ---------------------------------------------------------------- judge

test("heuristic judge: task kinds, complexity, risk, and speed from plain requests", () => {
  const j = (t: string, recent: { role: "user" | "assistant" | "tool"; text: string }[] = []) => judgeHeuristically(state(t, recent));
  assert.equal(j("Rename foo to bar in utils.ts").task, "small_edit");
  assert.ok(j("Rename foo to bar in utils.ts").complexity < 1.5);
  assert.equal(j("Why does the build fail on CI?").task, "quick_answer");
  assert.equal(j("Investigate the flaky test in runner.test.ts and find the root cause").task, "investigation");
  assert.equal(j("Implement a new settings page with routing options and add tests").task, "feature");
  assert.equal(j("Review this diff for security problems").task, "review");
  assert.equal(j("Rebase the branch and open a PR").task, "ops");
  assert.ok(j("delete the old migrations and force-push the cleanup").blastRadius >= 1.5, "destructive words raise blast radius");
  const quick = j("quick: bump the version");
  assert.ok(quick.wantsSpeed >= 0.7);
  assert.equal(quick.task, "small_edit");
  assert.ok(j("Make the cache concurrent-safe; be careful about the race on eviction").needsDeepReasoning >= 0.8);
  assert.equal(j("do it").task, "unclear");
  assert.equal(j("now do the same for the other file", [{ role: "user", text: "rename x" }]).dependsOnPriorTurns, 0.75);
  assert.equal(j("now do the same for the other file").dependsOnPriorTurns, 0, "no history → cannot depend on it");
});

test("question set: one request, closed task set, continuity only asked when there is history", () => {
  const none = questionsFor(state("x"));
  assert.deepEqual(Object.keys(none), ["task", "complexity", "blast_radius", "wants_speed", "needs_deep_reasoning"]);
  assert.equal(none.task!.type, "choice");
  assert.deepEqual(Object.keys((none.task as { criteria: Record<string, string> }).criteria), Object.keys(TASKS));
  assert.equal((none.complexity as { criteria: string[] }).criteria.length, 4);
  const some = questionsFor(state("again", [{ role: "user", text: "hi" }]));
  assert.ok("depends_on_prior_turns" in some);
});

test("stateFor digests the transcript without file contents and clips long text", () => {
  const items: Parameters<typeof stateFor>[0]["items"] = [
    { id: "1", kind: "user", text: "a".repeat(500), at: "" },
    { id: "2", kind: "tool", name: "Bash", title: "$ cat secrets.env", args: { command: "cat secrets.env" }, output: "TOKEN=abc", status: "done", at: "" },
    { id: "3", kind: "assistant", text: "done", at: "" },
  ];
  const s = stateFor({ text: "x".repeat(5000), backend: "claude", model: "opus", mode: "chat", plan: true, items, project: { name: "p", branch: "main" } });
  assert.equal(s.request.length, 4001);
  assert.equal(s.recent.length, 3);
  assert.equal(s.recent[0]!.text.length, 301);
  assert.equal(s.recent[1]!.text, "$ cat secrets.env", "tool titles only, never output");
  assert.equal(JSON.stringify(s).includes("TOKEN=abc"), false);
  assert.equal(s.thread.turns, 1);
});

test("judgmentsFrom reads Jev's answer shapes and rejects missing essentials", () => {
  const st = state("fix the crash", [{ role: "user", text: "earlier" }]);
  const j = judgmentsFrom({
    task: { type: "choice", choice: "bug_fix", probabilities: { bug_fix: 0.8, feature: 0.2, bogus: 1 }, confidence: 0.8 },
    complexity: { type: "score", score: 1.7, probabilities: { "1": 0.3, "2": 0.7 }, confidence: 0.7 },
    blast_radius: { type: "score", score: 0.4, probabilities: {}, confidence: 0.9 },
    wants_speed: { type: "noul", noul: 0.1 },
    needs_deep_reasoning: { type: "noul", noul: 0.65 },
    depends_on_prior_turns: { type: "noul", noul: 0.9 },
  }, st);
  assert.equal(j.task, "bug_fix");
  assert.equal(j.taskConfidence, 0.8);
  assert.deepEqual(Object.keys(j.taskProbabilities), ["bug_fix", "feature"], "unknown option ids are dropped");
  assert.equal(j.complexity, 1.7);
  assert.equal(j.dependsOnPriorTurns, 0.9);
  assert.throws(() => judgmentsFrom({ complexity: { type: "score", score: 1, probabilities: {}, confidence: 1 } }, st), /no usable task/);
  assert.throws(() => judgmentsFrom({ task: { type: "choice", choice: "nope", probabilities: {}, confidence: 1 } }, st), /no usable task/);
});

// ---------------------------------------------------------------- catalogue

const m = (id: string, extra: Partial<ModelInfo> = {}): ModelInfo => ({ id, label: id, ...extra });

test("catalogue: known families land on their tier, descriptions hint the rest, ladders sort", () => {
  assert.equal(tierOf(m("haiku")), 0);
  assert.equal(tierOf(m("claude-sonnet-5")), 1);
  assert.equal(tierOf(m("opus")), 2);
  assert.equal(tierOf(m("fable")), 3);
  assert.equal(tierOf(m("gpt-5.5")), 0);
  assert.equal(tierOf(m("gpt-5.6-codex")), 1);
  assert.equal(tierOf(m("gpt-6-astra")), 3);
  assert.equal(tierOf(m("gpt-7-nova", { description: "Our most capable model for complex work" })), 3);
  assert.equal(tierOf(m("gpt-7-zip", { description: "Fastest and cheapest for everyday tasks" })), 0);
  assert.equal(tierOf(m("whatever")), 2);
  const rungs = ladder("codex", [m("gpt-6-astra", { isDefault: true, serviceTiers: ["default", "fast"] }), m("gpt-5.5", { serviceTiers: ["fast"] }), m("gpt-6-luna")]);
  assert.deepEqual(rungs.map((c) => c.model), ["gpt-5.5", "gpt-6-luna", "gpt-6-astra"]);
  assert.equal(rungs[0]!.fastTier, "fast");
  assert.equal(pick(rungs, 3)!.model, "gpt-6-astra");
  assert.equal(pick(rungs, 2)!.model, "gpt-6-luna");
  assert.equal(pick(rungs, 1)!.model, "gpt-5.5", "highest rung at or below the target");
  assert.equal(pick(ladder("codex", [m("gpt-6-luna")]), 0)!.model, "gpt-6-luna", "nothing lower → the lowest rung");
  assert.equal(pick([], 1), undefined);
});

// ---------------------------------------------------------------- policy

const CODEX_EFFORTS = ["low", "medium", "high", "xhigh"];
const codexLadder = () => ladder("codex", [m("gpt-5.5", { efforts: CODEX_EFFORTS, serviceTiers: ["fast"] }), m("gpt-5.6-x", { efforts: CODEX_EFFORTS }), m("gpt-6-luna", { efforts: CODEX_EFFORTS }), m("gpt-6-astra", { efforts: CODEX_EFFORTS, isDefault: true })]);
const claudeLadder = () => ladder("claude", ["haiku", "sonnet", "opus", "fable"].map((id) => m(id, { efforts: ["low", "medium", "high", "xhigh", "max"] })));
const J = (over: Partial<Judgments> = {}): Judgments => ({ task: "small_edit", taskConfidence: 0.9, taskProbabilities: {}, complexity: 0.6, complexityConfidence: 0.8, blastRadius: 0.3, wantsSpeed: 0.1, needsDeepReasoning: 0.2, dependsOnPriorTurns: 0, ...over });
const D = (over: Partial<DecisionInput> = {}, policy: Partial<RoutingPolicy> = {}): DecisionInput => ({
  judgments: J(), source: "jev", policy: { ...DEFAULT_ROUTING, ...policy },
  current: { backend: "codex", model: "gpt-6-astra", effort: "high", hasSession: false },
  ladders: { codex: codexLadder(), claude: claudeLadder() }, fitOffset: 0, premiumExhausted: false, ...over,
});

test("policy: complexity sets the tier and effort; posture shifts it; every change leaves a reason", () => {
  const base = decide(D());
  assert.deepEqual([base.backend, base.model, base.effort, base.fast, base.pinned], ["codex", "gpt-5.6-x", "medium", false, false]);
  assert.match(base.reasons[0]!, /small edit · complexity 0\.6/);
  const eco = decide(D({}, { posture: "economy" }));
  assert.deepEqual([eco.model, eco.effort], ["gpt-5.5", "low"]);
  assert.ok(eco.reasons.some((r) => /economy/.test(r)));
  const q = decide(D({}, { posture: "quality" }));
  assert.equal(q.model, "gpt-6-luna");
  const feature = decide(D({ judgments: J({ task: "feature", complexity: 2.2, needsDeepReasoning: 0.9 }) }));
  assert.deepEqual([feature.model, feature.effort], ["gpt-6-astra", "xhigh"], "deep reasoning bumps a tier; max_effort caps at xhigh");
  assert.ok(feature.reasons.some((r) => /Effort capped at xhigh/.test(r)));
  const lifted = decide(D({ judgments: J({ task: "feature", complexity: 2.2, needsDeepReasoning: 0.9 }), current: { backend: "claude", model: "opus", hasSession: false } }, { max_effort: "max" }));
  assert.deepEqual([lifted.backend, lifted.model, lifted.effort], ["claude", "fable", "max"]);
  const risky = decide(D({ judgments: J({ complexity: 1.2, blastRadius: 1.8 }) }));
  assert.equal(risky.model, "gpt-6-luna", "hard-to-reverse work goes one tier up");
  const answer = decide(D({ judgments: J({ task: "quick_answer", complexity: 0.9 }) }));
  assert.deepEqual([answer.model, answer.effort], ["gpt-5.5", "low"]);
});

test("policy: fast mode needs a speed signal, a light task, and a model that offers it", () => {
  const fast = decide(D({ judgments: J({ complexity: 0.4, wantsSpeed: 0.9 }) }));
  assert.deepEqual([fast.model, fast.fast, fast.effort], ["gpt-5.5", true, "low"], "effort drops one but snaps to what the model lists");
  assert.equal(decide(D({ judgments: J({ complexity: 0.4, wantsSpeed: 0.9 }) }, { allow_fast: false })).fast, false);
  assert.equal(decide(D({ judgments: J({ complexity: 0.4, wantsSpeed: 0.9, needsDeepReasoning: 0.8 }) })).fast, false, "not when reasoning is needed");
  assert.equal(decide(D({ judgments: J({ complexity: 2.4, wantsSpeed: 0.9 }) })).fast, false, "not on big models");
  const claude = decide(D({ judgments: J({ complexity: 0.4, wantsSpeed: 0.9 }), current: { backend: "claude", model: "opus", hasSession: false } }));
  assert.deepEqual([claude.model, claude.fast], ["haiku", true]);
});

test("policy: an unsure Jev keeps the user's model; the heuristic's confidence is not gated", () => {
  const pinned = decide(D({ judgments: J({ taskConfidence: 0.4 }) }));
  assert.deepEqual([pinned.pinned, pinned.model, pinned.effort, pinned.fast], [true, "gpt-6-astra", "high", false]);
  assert.match(pinned.reasons[0]!, /unsure/);
  const heur = decide(D({ judgments: J({ taskConfidence: 0.4 }), source: "heuristic" }));
  assert.equal(heur.pinned, false);
  assert.match(heur.reasons[0]!, /built-in heuristic/);
});

test("policy: premium budget and learned offsets bound the tier", () => {
  const capped = decide(D({ judgments: J({ task: "refactor", complexity: 2.8, needsDeepReasoning: 0.9 }), premiumExhausted: true }));
  assert.deepEqual([capped.model, capped.effort], ["gpt-6-luna", "high"]);
  assert.ok(capped.reasons.some((r) => /premium-turn budget/.test(r)));
  const up = decide(D({ fitOffset: 1 }));
  assert.equal(up.model, "gpt-6-luna");
  assert.ok(up.reasons.some((r) => /past overrides/.test(r)));
  assert.equal(decide(D({ fitOffset: -1 })).model, "gpt-5.5");
});

test("policy: backend switching only when allowed, only without a session to lose, only when needed", () => {
  const stuck = decide(D({ judgments: J({ task: "feature", complexity: 2.6, needsDeepReasoning: 0.9 }), current: { backend: "claude", model: "haiku", hasSession: false }, ladders: { claude: ladder("claude", [m("haiku")]), codex: codexLadder() } }));
  assert.deepEqual([stuck.backend, stuck.model], ["claude", "haiku"], "off by default: stays even when the ladder cannot reach the tier");
  const moved = decide(D({ judgments: J({ task: "feature", complexity: 2.6, needsDeepReasoning: 0.9 }), current: { backend: "claude", model: "haiku", hasSession: false }, ladders: { claude: ladder("claude", [m("haiku")]), codex: codexLadder() } }, { allow_backend_switch: true }));
  assert.deepEqual([moved.backend, moved.model], ["codex", "gpt-6-astra"]);
  const kept = decide(D({ judgments: J({ task: "feature", complexity: 2.6, needsDeepReasoning: 0.9, dependsOnPriorTurns: 0.9 }), current: { backend: "claude", model: "haiku", hasSession: true }, ladders: { claude: ladder("claude", [m("haiku")]), codex: codexLadder() } }, { allow_backend_switch: true }));
  assert.equal(kept.backend, "claude");
  assert.ok(kept.reasons.some((r) => /keep its session/.test(r)));
  const able = decide(D({ judgments: J({ task: "feature", complexity: 2.6, needsDeepReasoning: 0.9 }), current: { backend: "claude", model: "haiku", hasSession: false } }, { allow_backend_switch: true }));
  assert.deepEqual([able.backend, able.model], ["claude", "fable"], "no switch when the current backend reaches the tier");
  const down = decide(D({ current: { backend: "claude", model: "opus", hasSession: false }, ladders: { claude: [], codex: codexLadder() } }, { allow_backend_switch: true }));
  assert.deepEqual([down.backend, down.model], ["codex", "gpt-5.6-x"], "an unavailable backend fails over");
  const none = decide(D({ ladders: {} }));
  assert.deepEqual([none.pinned, none.model], [true, "gpt-6-astra"]);
});

// ---------------------------------------------------------------- fit

test("fit: overrides move a task's offset in steps, failures nudge up, premium counts per day, and it persists", () => {
  const file = path.join(tmpdir("modex-fit-"), "routing-fit.json");
  let day = "2026-09-25";
  const fit = new Fit(file, () => day);
  const rec = { threadId: "t1", task: "small_edit" as const, source: "jev" as const, backend: "codex", model: "gpt-5.5", fast: false, tier: 0, confidence: 0.9, premium: false };
  fit.recordRoute(rec);
  assert.equal(fit.recordOverride("t1", 0), undefined, "same tier is not an override");
  assert.equal(fit.recordOverride("t1", 2)!.task, "small_edit");
  assert.equal(fit.recordOverride("t1", 3), undefined, "one override per route");
  assert.equal(fit.snapshot().tasks.small_edit!.overridesUp, 1);
  assert.ok(Math.abs(fit.snapshot().tasks.small_edit!.offset - OVERRIDE_STEP * 2) < 1e-9, "two tiers up counts double, capped there");
  assert.equal(fit.offsetFor("small_edit"), 0.5, "applied offsets round to half tiers");
  fit.recordRoute(rec);
  fit.recordOutcome("t1", "failed");
  assert.equal(fit.snapshot().tasks.small_edit!.failures, 1);
  fit.recordRoute(rec);
  fit.recordOutcome("t1", "completed");
  assert.equal(fit.snapshot().tasks.small_edit!.completions, 1);
  fit.recordRoute({ ...rec, premium: true });
  fit.recordRoute({ ...rec, premium: true });
  assert.equal(fit.premiumToday(), 2);
  day = "2026-09-26";
  assert.equal(fit.premiumToday(), 0, "a new day resets the premium count");
  const again = new Fit(file, () => day);
  assert.equal(again.snapshot().history.length, 5);
  assert.equal(again.snapshot().tasks.small_edit!.overridesUp, 1);
  fit.recordRoute({ ...rec, tier: 2 });
  fit.recordOverride("t1", 0);
  assert.equal(fit.snapshot().tasks.small_edit!.overridesDown, 1);
  fit.reset();
  assert.deepEqual(new Fit(file, () => day).snapshot().tasks, {});
});

// ---------------------------------------------------------------- router

const thread = (over: Partial<Thread> = {}): Thread => ({ id: "th1", projectId: "p", title: "t", createdAt: "", updatedAt: "", cwd: "/w", backend: "codex", mode: "agent", plan: false, model: "gpt-6-astra", effort: "high", status: "idle", auto: true, ...over });
const listModels = async (b: string) => ({ models: b === "codex" ? [m("gpt-5.5", { efforts: CODEX_EFFORTS, serviceTiers: ["fast"] }), m("gpt-5.6-x", { efforts: CODEX_EFFORTS }), m("gpt-6-astra", { efforts: CODEX_EFFORTS, isDefault: true })] : [] });
const jevAnswers = (task: string, complexity: number, over: Partial<JevResponse["answers"]> = {}): JevResponse => ({
  model: "jev-1.13.0",
  answers: {
    task: { type: "choice", choice: task, probabilities: { [task]: 0.86 }, confidence: 0.86 },
    complexity: { type: "score", score: complexity, probabilities: {}, confidence: 0.7 },
    blast_radius: { type: "score", score: 0.3, probabilities: {}, confidence: 0.9 },
    wants_speed: { type: "noul", noul: 0.1 },
    needs_deep_reasoning: { type: "noul", noul: 0.2 },
    ...over,
  },
});

test("model discovery failures and empty results retry on the next turn, with the real error in blocked receipts", async () => {
  for (const failure of ["reported", "thrown", "empty"] as const) {
    let calls = 0;
    const router = new Router({
      home: tmpdir("modex-discovery-retry-"), policy: () => DEFAULT_ROUTING, transport: null,
      listModels: async () => {
        if (++calls === 1) {
          if (failure === "thrown") throw new Error("app-server is restarting");
          return { models: [], error: failure === "reported" ? "app-server is restarting" : undefined };
        }
        return { models: [m("gpt-6-luna", { efforts: CODEX_EFFORTS, isDefault: true })] };
      },
    });
    const request = { thread: thread({ model: "" }), text: "review the repository", items: [], project: { name: "demo" } };
    const first = await router.route(request);
    assert.equal(first.item.blocked, true);
    if (failure !== "empty") assert.match(first.decision.reasons.at(-1)!, /app-server is restarting/);
    const second = await router.route(request);
    assert.equal(second.decision.blocked, undefined);
    assert.equal(calls, 2, "discovery must retry without waiting a minute");
    await router.route(request);
    assert.equal(calls, 2, "successful non-empty lists remain cached");
  }
});

test("a manual model repair after a blocked turn never teaches an older successful route", async () => {
  const home = tmpdir("modex-blocked-override-");
  let policy: RoutingPolicy = { ...DEFAULT_ROUTING, max_effort: "high" };
  const router = new Router({ home, policy: () => policy, transport: null,
    listModels: async () => ({ models: [m("gpt-6-astra", { efforts: ["high"], isDefault: true }), m("gpt-5.5", { efforts: ["high"] })] }),
  });
  const request = { thread: thread(), text: "design a complex architecture", items: [], project: { name: "demo" } };
  const previous = await router.route(request);
  assert.equal(previous.decision.tier, 3);
  router.noteOutcome("th1", "completed");
  const before = router.fit.snapshot();
  policy = { ...policy, max_effort: "low" };
  const stopped = await router.route(request);
  assert.equal(stopped.decision.blocked, true);
  assert.equal(await router.noteOverride(thread(), "gpt-5.5"), undefined);
  assert.deepEqual(router.fit.snapshot(), before);
  policy = { ...policy, max_effort: "high" };
  await router.route(request);
  assert.deepEqual(await router.noteOverride(thread(), "gpt-5.5"), { task: previous.judgments.task, from: 3, to: 0 }, "a later safe route resumes normal learning");
});

test("router: Jev judgments become a receipt item, the fit records the route, and status reports live", async () => {
  const home = tmpdir("modex-home-");
  const sent: unknown[] = [];
  const router = new Router({ home, policy: () => DEFAULT_ROUTING, listModels, transport: async (req) => { sent.push(req); return jevAnswers("small_edit", 0.6); } });
  const r = await router.route({ thread: thread(), text: "rename a to b", items: [], project: { name: "demo" } });
  assert.equal(r.source, "jev");
  assert.deepEqual([r.item.kind, r.item.backend, r.item.model, r.item.effort, r.item.fast, r.item.task, r.item.confidence, r.item.pinned], ["route", "codex", "gpt-5.6-x", "medium", false, "small_edit", 0.86, false]);
  assert.equal((sent[0] as { model: string }).model, "jev-latest");
  assert.equal(typeof (sent[0] as { questions: Record<string, unknown> }).questions.task, "object");
  assert.equal(fs.existsSync(path.join(home, "app", "routing-fit.json")), true);
  const s = await router.status();
  assert.deepEqual([s.live, s.keySource, s.fit.routes, s.fit.premiumToday], [true, "env", 1, 0]);
  // premium turns count against the daily budget and cap the next pick
  const budget = new Router({ home, policy: () => ({ ...DEFAULT_ROUTING, premium_turns_per_day: 1 }), listModels, transport: async () => jevAnswers("feature", 2.6, { needs_deep_reasoning: { type: "noul", noul: 0.9 } }) });
  const a = await budget.route({ thread: thread(), text: "big feature", items: [], project: { name: "demo" } });
  assert.deepEqual([a.item.model, a.item.effort], ["gpt-6-astra", "xhigh"]);
  const b = await budget.route({ thread: thread(), text: "another big feature", items: [], project: { name: "demo" } });
  assert.deepEqual([b.item.model, b.item.effort], ["gpt-5.6-x", "high"]);
  assert.ok(b.item.reasons.some((x) => /budget/.test(x)));
  // a hand-picked model teaches the fit
  const learned = await budget.noteOverride(thread(), "gpt-6-astra");
  assert.deepEqual(learned, { task: "feature", from: 1, to: 3 });
  assert.equal((await budget.status()).fit.tasks.feature!.overridesUp, 1);
});

test("pinned premium Auto routes count toward the daily limit and block a second top-tier turn", async () => {
  const home = tmpdir("modex-pinned-premium-");
  const router = new Router({
    home,
    policy: () => ({ ...DEFAULT_ROUTING, premium_turns_per_day: 1 }),
    listModels: async () => ({ models: [m("gpt-6-astra", { efforts: CODEX_EFFORTS })] }),
    transport: async () => jevAnswers("feature", 2.8, {
      task: { type: "choice", choice: "feature", probabilities: { feature: 0.1 }, confidence: 0.1 },
    }),
  });
  const request = { thread: thread(), text: "large feature", items: [], project: { name: "demo" } };
  const first = await router.route(request);
  assert.equal(first.decision.pinned, true);
  assert.equal(first.decision.blocked, undefined);
  assert.equal((await router.status()).fit.premiumToday, 1);

  const second = await router.route(request);
  assert.equal(second.decision.blocked, true);
  assert.equal((await router.status()).fit.premiumToday, 1, "a blocked route does not consume another turn");
});

test("router: Jev failing or absent falls back to the heuristic and says so in the receipt", async () => {
  const home = tmpdir("modex-home-");
  const failing = new Router({ home, policy: () => DEFAULT_ROUTING, listModels, transport: async () => { throw new JevError("TypeSafe is overloaded.", "overloaded", 529); } });
  const r = await failing.route({ thread: thread(), text: "quick: bump the version", items: [], project: { name: "demo" } });
  assert.equal(r.source, "heuristic");
  assert.match(r.item.reasons[0]!, /Jev unavailable — TypeSafe is overloaded\. \(overloaded\)/);
  assert.deepEqual([r.item.model, r.item.fast], ["gpt-5.5", true]);
  // A rejected key or an empty credit balance turns Jev off for the session instead of retrying every turn.
  let calls = 0;
  const broke = new Router({ home, policy: () => DEFAULT_ROUTING, listModels, transport: async () => { calls++; throw new JevError("The TypeSafe organization has no API credits.", "billing", 402); } });
  const first = await broke.route({ thread: thread(), text: "hi", items: [], project: { name: "demo" } });
  assert.match(first.item.reasons[0]!, /no API credits\. \(billing\)/);
  const second = await broke.route({ thread: thread(), text: "hi again", items: [], project: { name: "demo" } });
  assert.equal(calls, 1);
  assert.match(second.item.reasons[0]!, /Jev is off for this session — The TypeSafe organization has no API credits\./);
  const bs = await broke.status();
  assert.equal(bs.live, false);
  assert.match(bs.detail!, /credits/);
  const offline = new Router({ home, policy: () => DEFAULT_ROUTING, listModels, transport: null });
  const o = await offline.route({ thread: thread(), text: "why is this slow?", items: [], project: { name: "demo" } });
  assert.match(o.item.reasons[0]!, /No TypeSafe API key/);
  assert.equal((await offline.status()).live, false);
  assert.match((await offline.status()).detail!, /No TypeSafe API key found/);
  // an aborted turn (user pressed Stop while judging) propagates the signal to the transport
  const ac = new AbortController();
  const aborting = new Router({ home, policy: () => DEFAULT_ROUTING, listModels, transport: async (_req, signal) => { ac.abort(); assert.equal(signal?.aborted, true); throw new JevError("timed out", "timeout"); } });
  const x = await aborting.route({ thread: thread(), text: "hi", items: [], project: { name: "demo" } }, ac.signal);
  assert.equal(x.source, "heuristic");
});

// ---------------------------------------------------------------- jev client

test("jev client: key resolution never hits the login shell when disabled; the HTTP transport maps errors", async () => {
  resetKeyCache();
  assert.deepEqual(await resolveTypesafeKey({ TYPESAFE_API_KEY: " k1 " }), { key: "k1", source: "env" });
  assert.deepEqual(await resolveTypesafeKey({ MODEX_NO_LOGIN_PATH: "1" }), { key: null, source: "none" });
  const calls: { url: string; init: RequestInit }[] = [];
  const ok = httpTransport("secret", { fetchImpl: (async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response(JSON.stringify(jevAnswers("ops", 1)), { status: 200 }); }) as unknown as typeof fetch });
  const res = await ok({ state: { request: "x" }, model: "jev-latest", questions: {} });
  assert.equal((res.answers.task as { choice: string }).choice, "ops");
  assert.equal(calls[0]!.url, "https://api.typesafe.ai/v1/systemone");
  assert.equal((calls[0]!.init.headers as Record<string, string>).Authorization, "Bearer secret");
  assert.equal(JSON.parse(calls[0]!.init.body as string).model, "jev-latest");
  const unauthorized = httpTransport("bad", { fetchImpl: (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch });
  await assert.rejects(unauthorized({ state: "s", model: "jev-latest", questions: {} }), (e: JevError) => e.code === "auth");
  const garbage = httpTransport("k", { fetchImpl: (async () => new Response("not json", { status: 200 })) as unknown as typeof fetch });
  await assert.rejects(garbage({ state: "s", model: "jev-latest", questions: {} }), (e: JevError) => e.code === "bad_response");
  const slow = httpTransport("k", { timeoutMs: 5, fetchImpl: ((_u: string, init: RequestInit) => new Promise((_r, reject) => init.signal!.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))))) as unknown as typeof fetch });
  await assert.rejects(slow({ state: "s", model: "jev-latest", questions: {} }), (e: JevError) => e.code === "timeout");
});

// ---------------------------------------------------------------- key chain, CLI transport, secrets

test("key chain: Modex keychain beats env beats jev config beats login shell; op:// refs expand in memory", async () => {
  const { resolveTypesafeKey, isSecretRef, readJevConfigKey, jevConfigPath } = await import("../src/main/engine/routing/jev.js");
  const cfgDir = tmpdir("jev-cfg-");
  const cfg = path.join(cfgDir, "config.json");
  fs.writeFileSync(cfg, JSON.stringify({ apiKey: "sk-from-jev-config" }));
  const refs: string[] = [];
  const readRef = async (ref: string) => { refs.push(ref); if (ref.includes("locked")) throw new Error("1Password is locked; unlock it and retry."); return `resolved-${ref.split("/").pop()}`; };
  const base = { env: { MODEX_NO_LOGIN_PATH: "1" } as NodeJS.ProcessEnv, jevConfigPath: cfg, readRef, loginShell: async () => null };
  assert.deepEqual(await resolveTypesafeKey({ ...base, stored: () => "sk-modex" }), { key: "sk-modex", source: "modex" });
  assert.deepEqual(await resolveTypesafeKey({ ...base, env: { TYPESAFE_API_KEY: "sk-env" } }), { key: "sk-env", source: "env" });
  assert.deepEqual(await resolveTypesafeKey({ ...base, env: { JEV_API_KEY: "sk-alt" } }), { key: "sk-alt", source: "env" });
  assert.deepEqual(await resolveTypesafeKey(base), { key: "sk-from-jev-config", source: "jev-config" });
  assert.deepEqual(await resolveTypesafeKey({ ...base, jevConfigPath: path.join(cfgDir, "missing.json"), loginShell: async () => "sk-shell" }), { key: "sk-shell", source: "login-shell" });
  assert.deepEqual(await resolveTypesafeKey({ ...base, jevConfigPath: path.join(cfgDir, "missing.json") }), { key: null, source: "none" });
  const viaRef = await resolveTypesafeKey({ ...base, stored: () => "op://Development/Jev API Key/password" });
  assert.deepEqual(viaRef, { key: "resolved-password", source: "modex", ref: "op://Development/Jev API Key/password" });
  const locked = await resolveTypesafeKey({ ...base, stored: () => "op://locked/x/y" });
  assert.deepEqual([locked.key, locked.source, locked.ref], [null, "modex", "op://locked/x/y"]);
  assert.match(locked.problem!, /1Password is locked/);
  assert.deepEqual(refs, ["op://Development/Jev API Key/password", "op://locked/x/y"]);
  assert.equal(isSecretRef(" op://a/b/c"), true);
  assert.equal(isSecretRef("sk-x"), false);
  assert.equal(readJevConfigKey(path.join(cfgDir, "nope.json")), null);
  fs.writeFileSync(cfg, "not json");
  assert.equal(readJevConfigKey(cfg), null);
  assert.equal(jevConfigPath({ JEV_CONFIG: "/x/c.json" }), "/x/c.json");
  assert.ok(jevConfigPath({}).endsWith(path.join(".config", "jev", "config.json")));
  // The old positional form still works.
  assert.deepEqual(await resolveTypesafeKey({ TYPESAFE_API_KEY: "sk-old", MODEX_NO_LOGIN_PATH: "1" } as NodeJS.ProcessEnv), { key: "sk-old", source: "env" });
});

test("jev CLI transport: runs `jev run - --raw` with the key in the child env only, and maps its exit codes", async () => {
  const { cliTransport, cliError } = await import("../src/main/engine/routing/jev.js");
  const { FakeProcess, fakeSpawn } = await import("./fakeproc.js");
  const proc = new FakeProcess();
  const { spawn, calls } = fakeSpawn(proc);
  const envs: NodeJS.ProcessEnv[] = [];
  const spawnImpl = ((file: string, args: string[], opts: { env?: NodeJS.ProcessEnv }) => { envs.push(opts.env ?? {}); return spawn(file, args, opts); }) as unknown as typeof spawn;
  const t = cliTransport("/usr/local/bin/jev", { apiKey: "sk-secret", env: { PATH: "/bin" }, spawnImpl: spawnImpl as never, timeoutMs: 2000 });
  const pending = t({ model: "jev-latest", state: "s", questions: {} });
  await proc.waitFor((l) => l.includes('"model":"jev-latest"'));
  assert.deepEqual(calls[0]!.args, ["run", "-", "--raw", "--compact", "--attempts", "1"]);
  assert.equal(calls[0]!.file, "/usr/local/bin/jev");
  assert.deepEqual([envs[0]!.TYPESAFE_API_KEY, envs[0]!.JEV_OUTPUT, envs[0]!.JEV_TIMEOUT_MS, envs[0]!.PATH], ["sk-secret", "json", "2000", "/bin"]);
  proc.emitLine(jevAnswers("ops", 1));
  proc.close(0);
  const res = await pending;
  assert.equal((res.answers.task as { choice: string }).choice, "ops");
  // Errors: the CLI's JSON error object, its plain-text form, and a bare exit 3.
  assert.deepEqual([cliError('{"error":{"code":"billing","message":"No credits.","status":402,"exit":1}}', 1).code, cliError('{"error":{"code":"billing","message":"No credits.","status":402,"exit":1}}', 1).message], ["billing", "No credits."]);
  assert.equal(cliError("error: TypeSafe rejected the API key. (HTTP 401)", 3).code, "auth");
  assert.equal(cliError("error: No API key. Run `jev doctor`.", 3).code, "auth");
  assert.equal(cliError("boom", 1).code, "unknown");
  const pretty = cliError(JSON.stringify({ error: { code: "auth", message: "Cannot authenticate with the server.", status: 401, exit: 3 } }, null, 2), 3);
  assert.deepEqual([pretty.code, pretty.status, pretty.message], ["auth", 401, "Cannot authenticate with the server."], "pretty-printed JSON across lines still parses");
  assert.equal(cliError('{"error":{"code":"usage","message":"bad flag","status":null,"exit":1}}', 1).code, "validation");
  const failing = new FakeProcess();
  const t2 = cliTransport("jev", { spawnImpl: fakeSpawn(failing).spawn as never });
  const p2 = t2({ model: "jev-latest", state: "s", questions: {} });
  await failing.waitFor((l) => l.includes("jev-latest"));
  failing.stderr.write('{"error":{"code":"billing","message":"Your organization has no credits.","status":402,"exit":1}}\n');
  failing.close(1);
  await assert.rejects(p2, (e: JevError) => e.code === "billing" && e.status === 402);
  const slow = new FakeProcess();
  const t3 = cliTransport("jev", { spawnImpl: fakeSpawn(slow).spawn as never, timeoutMs: 20 });
  await assert.rejects(t3({ model: "jev-latest", state: "s", questions: {} }), (e: JevError) => e.code === "timeout" && slow.killed);
  const aborted = new FakeProcess();
  const ac = new AbortController();
  const t4 = cliTransport("jev", { spawnImpl: fakeSpawn(aborted).spawn as never });
  const p4 = t4({ model: "jev-latest", state: "s", questions: {} }, ac.signal);
  ac.abort();
  await assert.rejects(p4, (e: JevError) => e.code === "timeout" && aborted.killed);
});

test("router: prefers the jev CLI when found, stores a hand-entered key in the keychain, and pings through the transport", async () => {
  const { SecretStore, testCipher } = await import("../src/main/engine/secrets.js");
  const { FakeProcess, fakeSpawn } = await import("./fakeproc.js");
  const home = tmpdir("modex-home-");
  const secrets = new SecretStore(home, testCipher);
  const procs: InstanceType<typeof FakeProcess>[] = [];
  const spawnImpl = ((file: string, args: string[], opts: unknown) => { const p = new FakeProcess(); procs.push(p); setTimeout(() => { p.emitLine(jevAnswers("small_edit", 0.5, { reachable: { type: "noul", noul: 0.9 } })); p.close(0); }, 5); return fakeSpawn(p).spawn(file, args, opts as never); }) as unknown as SpawnLikeT;
  let policy = { ...DEFAULT_ROUTING };
  const router = new Router({ home, policy: () => policy, listModels, secrets, env: { MODEX_NO_LOGIN_PATH: "1" }, keyResolver: { jevConfigPath: path.join(home, "no-config.json"), loginShell: async () => null }, detectCli: async (bin) => (bin === "jev" ? { bin: "/opt/bin/jev", version: "0.2.0" } : null), spawnImpl });
  // No key anywhere, but the CLI is installed: the CLI resolves its own key.
  let st = await router.status();
  assert.deepEqual([st.live, st.keySource, st.keyLast4, st.transport, st.secrets.present, st.secrets.backend], [true, "none", null, { kind: "cli", bin: "/opt/bin/jev", version: "0.2.0" }, false, "test cipher (not secure)"]);
  const ping = await router.test();
  assert.deepEqual([ping.ok, ping.transport], [true, "cli"]);
  assert.match(ping.message, /jev CLI 0\.2\.0/);
  assert.equal(procs.length, 1);
  // A key typed into Settings goes to the keychain, is reported masked, and rides along in the CLI's env.
  st = await router.setKey("sk-typed-into-modex-7777");
  assert.deepEqual([st.keySource, st.keyLast4, st.secrets.present, st.transport.kind], ["modex", "7777", true, "cli"]);
  assert.equal(fs.readFileSync(path.join(home, "app", "secrets.json"), "utf8").includes("sk-typed"), false);
  const r = await router.route({ thread: thread({ backend: "codex" }), text: "rename a to b", items: [], project: { name: "demo" } });
  assert.equal(r.source, "jev");
  assert.equal(procs.length, 2);
  // Policy says HTTPS only: the CLI is ignored and the stored key feeds the HTTP transport.
  policy = { ...DEFAULT_ROUTING, jev_transport: "http" };
  router.reset();
  st = await router.status();
  assert.deepEqual([st.transport.kind, st.keySource], ["http", "modex"]);
  // Clearing the key with HTTPS-only policy leaves nothing to judge with.
  st = await router.clearKey();
  assert.deepEqual([st.live, st.transport.kind, st.keySource], [false, "none", "none"]);
  assert.match(st.detail!, /No TypeSafe API key found/);
  assert.deepEqual((await router.test()).ok, false);
  // A locked 1Password reference is reported as the problem, not silently ignored.
  await router.setKey("op://Vault/Jev/password");
  const lockedRouter = new Router({ home, policy: () => ({ ...DEFAULT_ROUTING, jev_transport: "http" }), listModels, secrets, env: { MODEX_NO_LOGIN_PATH: "1" }, keyResolver: { jevConfigPath: path.join(home, "no-config.json"), loginShell: async () => null, readRef: async () => { throw new Error("1Password is locked; unlock it and retry."); } } });
  const ls = await lockedRouter.status();
  assert.deepEqual([ls.live, ls.keySource, ls.keyRef], [false, "modex", "op://Vault/Jev/password"]);
  assert.match(ls.detail!, /1Password is locked/);
  // A rejected key disables Jev for the session; a successful test or a new key re-enables it.
  const rejecting = new Router({ home, policy: () => DEFAULT_ROUTING, listModels, transport: async () => { throw new JevError("TypeSafe rejected the API key.", "auth", 401); } });
  await rejecting.route({ thread: thread(), text: "x", items: [], project: { name: "demo" } });
  assert.equal((await rejecting.status()).live, false);
  rejecting.reset();
  assert.equal((await rejecting.status()).live, true);
});

test("routing status retains only explicit test health and records its effective model and transport", async () => {
  const home = tmpdir("modex-test-health-");
  const { SecretStore, testCipher } = await import("../src/main/engine/secrets.js");
  let calls = 0;
  const router = new Router({
    home,
    policy: () => ({ ...DEFAULT_ROUTING, jev_transport: "http", jev_model: "jev-test-model" }),
    listModels,
    secrets: new SecretStore(home, testCipher),
    transport: async () => { calls++; return { answers: { reachable: { type: "noul", noul: 0.9 } } }; },
  });
  const before = await router.status();
  assert.equal(before.lastTest, undefined);
  assert.equal(calls, 0, "opening/refreshing status never pings the provider");
  const result = await router.test();
  assert.deepEqual([result.ok, result.tested, result.current], [true, { executable: null, model: "jev-test-model" }, true]);
  const after = await router.status();
  assert.deepEqual([after.lastTest?.ok, after.lastTest?.tested], [true, result.tested]);
  assert.equal(typeof after.lastTest?.at, "number");
  assert.equal(calls, 1, "only the explicit test sends a provider request");
  router.reset();
  assert.equal((await router.status()).lastTest, undefined, "a configuration reset invalidates prior health");
});

test("routing status retains explicit test failures and reset prevents an in-flight old result from becoming current", async () => {
  const home = tmpdir("modex-test-health-reset-");
  const { SecretStore, testCipher } = await import("../src/main/engine/secrets.js");
  let release!: (response: JevResponse) => void;
  const router = new Router({
    home,
    policy: () => ({ ...DEFAULT_ROUTING, jev_transport: "http" }),
    listModels,
    secrets: new SecretStore(home, testCipher),
    transport: async () => new Promise<JevResponse>((resolve) => { release = resolve; }),
  });
  const pending = router.test();
  await new Promise<void>((resolve) => setImmediate(resolve));
  router.reset();
  release({ answers: { reachable: { type: "noul", noul: 0.1 } } });
  const stale = await pending;
  assert.equal(stale.current, false);
  assert.equal((await router.status()).lastTest, undefined);

  for (const [code, expectedLive] of [["network", true], ["auth", false], ["billing", false]] as const) {
    const failureHome = `${home}-${code}`;
    const failing = new Router({
      home: failureHome,
      policy: () => ({ ...DEFAULT_ROUTING, jev_transport: "http" }),
      listModels,
      secrets: new SecretStore(failureHome, testCipher),
      transport: async () => { throw new JevError(`fake ${code} failure`, code, code === "billing" ? 402 : code === "auth" ? 401 : undefined); },
    });
    const failed = await failing.test();
    assert.deepEqual([failed.ok, failed.code], [false, code]);
    const status = await failing.status();
    assert.deepEqual([status.lastTest?.message, status.live], [`fake ${code} failure`, expectedLive]);
  }
  const malformedHome = `${home}-malformed`;
  const malformed = new Router({
    home: malformedHome,
    policy: () => ({ ...DEFAULT_ROUTING, jev_transport: "http" }),
    listModels,
    secrets: new SecretStore(malformedHome, testCipher),
    transport: async () => ({ answers: {} } as JevResponse),
  });
  const invalidResponse = await malformed.test();
  assert.deepEqual([invalidResponse.ok, invalidResponse.code, (await malformed.status()).lastTest?.ok], [false, "bad_response", false]);
});

test("replacing the key while a judge test is in flight invalidates that old result", async () => {
  const home = tmpdir("modex-test-health-key-change-");
  const { SecretStore, testCipher } = await import("../src/main/engine/secrets.js");
  let release!: (response: JevResponse) => void;
  const router = new Router({
    home,
    policy: () => ({ ...DEFAULT_ROUTING, jev_transport: "http" }),
    listModels,
    secrets: new SecretStore(home, testCipher),
    transport: async () => new Promise<JevResponse>((resolve) => { release = resolve; }),
  });

  const pending = router.test();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await router.setKey("fake-test-key-do-not-use");
  release({ answers: { reachable: { type: "noul", noul: 0.95 } } });

  const stale = await pending;
  assert.deepEqual([stale.ok, stale.current], [true, false]);
  const status = await router.status();
  assert.equal(status.lastTest, undefined, "the old key's result cannot verify the replacement key");
  assert.equal(status.live, true, "the newly resolved fake setup stays available");
});

test("router: enforces CLI-only, prefers CLI in Auto, and skips CLI for HTTPS", async () => {
  const home = tmpdir("modex-transport-policy-");
  const base = { home, listModels, env: { MODEX_NO_LOGIN_PATH: "1" }, keyResolver: { jevConfigPath: path.join(home, "no-config.json"), loginShell: async () => null } };
  const keyEnv = { TYPESAFE_API_KEY: "sk-fake-offline-key", MODEX_NO_LOGIN_PATH: "1" };
  let cliChecks: string[] = [];
  const detectCli = async (bin: string) => { cliChecks.push(bin); return null; };

  // An explicit CLI choice never switches to HTTPS, even when a key exists.
  let policy: RoutingPolicy = { ...DEFAULT_ROUTING, jev_transport: "cli", jev_bin: "/custom/jev" };
  let router = new Router({ ...base, policy: () => policy, env: keyEnv, detectCli });
  let status = await router.status();
  assert.deepEqual(status.transport, { kind: "none" });
  assert.match(status.detail!, /CLI-only transport is selected/);
  assert.match(status.detail!, /\/custom\/jev/);
  assert.equal((await router.test()).transport, "none");
  const noCliRoute = await router.route({ thread: thread(), text: "rename a to b", items: [], project: { name: "demo" } });
  assert.equal(noCliRoute.source, "heuristic");
  assert.match(noCliRoute.item.reasons[0]!, /built-in heuristic/);
  assert.deepEqual(cliChecks, ["/custom/jev"]);
  const noKeyNoCli = new Router({ ...base, policy: () => policy, detectCli: async () => null });
  assert.match((await noKeyNoCli.status()).detail!, /CLI-only transport is selected/);

  // Auto keeps preferring the CLI, but falls back to HTTPS only when the key is available.
  policy = { ...DEFAULT_ROUTING, jev_transport: "auto" };
  cliChecks = [];
  router = new Router({ ...base, policy: () => policy, env: keyEnv, detectCli: async (bin) => { cliChecks.push(bin); return { bin: "/usr/bin/jev", version: "1.0" }; } });
  status = await router.status();
  assert.deepEqual(status.transport, { kind: "cli", bin: "/usr/bin/jev", version: "1.0" });
  assert.deepEqual(cliChecks, ["jev"]);

  cliChecks = [];
  router = new Router({ ...base, policy: () => ({ ...DEFAULT_ROUTING, jev_transport: "auto" }), env: keyEnv, detectCli });
  status = await router.status();
  assert.deepEqual(status.transport, { kind: "http" });
  assert.deepEqual(cliChecks, ["jev"]);

  // HTTPS skips CLI detection and is unavailable without a resolved key.
  cliChecks = [];
  router = new Router({ ...base, policy: () => ({ ...DEFAULT_ROUTING, jev_transport: "http" }), env: keyEnv, detectCli });
  status = await router.status();
  assert.deepEqual(status.transport, { kind: "http" });
  assert.deepEqual(cliChecks, []);
  router = new Router({ ...base, policy: () => ({ ...DEFAULT_ROUTING, jev_transport: "http" }), detectCli });
  status = await router.status();
  assert.deepEqual(status.transport, { kind: "none" });
  assert.match(status.detail!, /No TypeSafe API key found/);
  assert.deepEqual(cliChecks, []);
});

test("router: reset switches transport and executable without letting an old setup replace the new one", async () => {
  const home = tmpdir("modex-transport-reset-");
  let policy: RoutingPolicy = { ...DEFAULT_ROUTING, jev_transport: "cli", jev_bin: "jev-old" };
  let resolveOld!: (value: { bin: string; version: string } | null) => void;
  const router = new Router({
    home,
    policy: () => policy,
    listModels,
    env: { TYPESAFE_API_KEY: "sk-fake-offline-key", MODEX_NO_LOGIN_PATH: "1" },
    keyResolver: { jevConfigPath: path.join(home, "no-config.json"), loginShell: async () => null },
    detectCli: (bin) => bin === "jev-old" ? new Promise((resolve) => { resolveOld = resolve; }) : Promise.resolve({ bin: bin === "jev-new" ? "/custom/jev-new" : bin, version: bin === "jev-new" ? "2.0" : "3.0" }),
  });
  const oldStatus = router.status();
  policy = { ...DEFAULT_ROUTING, jev_transport: "cli", jev_bin: "jev-new" };
  router.reset();
  const fresh = await router.status();
  assert.deepEqual(fresh.transport, { kind: "cli", bin: "/custom/jev-new", version: "2.0" });
  resolveOld({ bin: "/custom/jev-old", version: "1.0" });
  assert.deepEqual((await oldStatus).transport, { kind: "cli", bin: "/custom/jev-old", version: "1.0" });
  assert.deepEqual((await router.status()).transport, { kind: "cli", bin: "/custom/jev-new", version: "2.0" });

  // A settings save can switch CLI → HTTP and replace the executable without restarting Modex.
  policy = { ...DEFAULT_ROUTING, jev_transport: "http" };
  router.reset();
  assert.deepEqual((await router.status()).transport, { kind: "http" });
  policy = { ...DEFAULT_ROUTING, jev_transport: "cli", jev_bin: "/another/jev" };
  router.reset();
  assert.deepEqual((await router.status()).transport, { kind: "cli", bin: "/another/jev", version: "3.0" });
});
type SpawnLikeT = import("../src/main/engine/routing/jev.js").SpawnLike;
