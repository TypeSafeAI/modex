import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, type DecisionInput } from "../src/main/engine/routing/policy.js";
import type { Candidate } from "../src/main/engine/routing/catalog.js";
import { DEFAULT_ROUTING, type RoutingPolicy } from "../src/shared/types.js";
import type { Judgments } from "../src/main/engine/routing/judge.js";

const judgments = (over: Partial<Judgments> = {}): Judgments => ({
  task: "feature", taskConfidence: 0.9, taskProbabilities: {}, complexity: 2.5,
  complexityConfidence: 0.8, blastRadius: 0.2, wantsSpeed: 0, needsDeepReasoning: 0.2,
  dependsOnPriorTurns: 0, ...over,
});
const candidate = (backend: Candidate["backend"], model: string, efforts: string[], tier: Candidate["tier"] = 2): Candidate => ({
  backend, model, label: model, tier, efforts,
});
const input = (over: Partial<DecisionInput> = {}, policy: Partial<RoutingPolicy> = {}): DecisionInput => ({
  judgments: judgments(), source: "jev", policy: { ...DEFAULT_ROUTING, ...policy },
  current: { backend: "codex", model: "current", effort: "high", hasSession: false },
  ladders: {
    codex: [candidate("codex", "current", ["low", "medium", "high", "xhigh"], 2)],
    claude: [candidate("claude", "opus", ["low", "medium", "high", "xhigh"], 2)],
  }, fitOffset: 0, premiumExhausted: false, ...over,
});

test("an unsure judge uses the model default or medium when no effort was requested", () => {
  for (const backend of ["claude", "codex"] as const) {
    for (const defaultEffort of [undefined, "low", "max"]) {
      const selected = decide(input({
        current: { backend, model: "current", hasSession: true },
        ladders: { [backend]: [{ ...candidate(backend, "current", ["low", "medium", "high", "xhigh", "max"]), defaultEffort }] },
        judgments: judgments({ taskConfidence: 0.1 }),
      }));
      assert.equal(selected.pinned, true);
      assert.equal(selected.blocked, undefined);
      assert.equal(selected.effort, defaultEffort === "max" ? "xhigh" : defaultEffort ?? "medium");
      assert.ok(selected.reasons.some((r) => r.includes("No effort requested")));
      assert.ok(selected.reasons.every((r) => !r.includes("lowered to")));
    }
  }
});

test("an empty model resolves the CLI default on pinned turns and retains ceiling and budget checks", () => {
  const request = input({
    current: { backend: "codex", model: "", hasSession: true },
    ladders: { codex: [{ ...candidate("codex", "default", ["low", "medium", "high", "xhigh"], 2), isDefault: true, defaultEffort: "high" }] },
    judgments: judgments({ taskConfidence: 0.1 }),
  }, { max_effort: "medium" });
  const result = decide(request);
  assert.equal(result.blocked, undefined);
  assert.equal(result.model, "", "keep the CLI default selection and existing session");
  assert.equal(result.effort, "medium");
  const premium = decide({ ...request, premiumExhausted: true, ladders: { codex: [{ ...request.ladders.codex![0]!, tier: 3 }] } });
  assert.equal(premium.blocked, true);
  assert.equal(premium.tier, 3);
  const unknown = decide({ ...request, ladders: { codex: [{ ...request.ladders.codex![0]!, isDefault: false }] } });
  assert.equal(unknown.blocked, true, "do not guess a default when the CLI did not advertise one");
});

test("backend switching requires no live session even when Jev says context is independent", () => {
  const ladders = {
    codex: [candidate("codex", "current", ["low", "medium", "high", "xhigh"], 0)],
    claude: [candidate("claude", "opus", ["low", "medium", "high", "xhigh"], 3)],
  };
  const policy = { allow_backend_switch: true };
  const noSession = decide(input({
    current: { backend: "codex", model: "current", effort: "low", hasSession: false }, ladders,
    judgments: judgments({ complexity: 2.8, dependsOnPriorTurns: 0.1 }),
  }, policy));
  assert.equal(noSession.backend, "claude");

  const withSession = decide(input({
    current: { backend: "codex", model: "current", effort: "low", hasSession: true }, ladders,
    judgments: judgments({ complexity: 2.8, dependsOnPriorTurns: 0 }),
  }, policy));
  assert.equal(withSession.backend, "codex");
  assert.ok(withSession.reasons.some((reason) => /keep its session/.test(reason)));

  const highContinuityWithSession = decide(input({
    current: { backend: "codex", model: "current", effort: "low", hasSession: true }, ladders,
    judgments: judgments({ complexity: 2.8, dependsOnPriorTurns: 1 }),
  }, policy));
  assert.equal(highContinuityWithSession.backend, "codex", "the judge cannot grant session-discard authority at any continuity score");
});

test("an unavailable current backend only fails over with explicit consent and no session", () => {
  const ladders = {
    codex: [],
    claude: [candidate("claude", "opus", ["low", "medium", "high", "xhigh"], 3)],
  };
  const allowed = decide(input({
    current: { backend: "codex", model: "missing", effort: "low", hasSession: false }, ladders,
  }, { allow_backend_switch: true, allow_backends: ["claude"] }));
  assert.equal(allowed.backend, "claude");

  const sessionKept = decide(input({
    current: { backend: "codex", model: "missing", effort: "low", hasSession: true }, ladders,
  }, { allow_backend_switch: true, allow_backends: ["claude"] }));
  assert.equal(sessionKept.backend, "codex");
  assert.equal(sessionKept.blocked, true, "the policy cannot safely run the unavailable current route with unknown effort capability");
});

test("advanced allowed-backend restrictions govern switching; an empty allowlist stays on the current CLI", () => {
  const ladders = {
    codex: [candidate("codex", "small-codex", ["low"], 0)],
    claude: [candidate("claude", "large-claude", ["low", "high"], 3)],
  };
  const current = { backend: "codex" as const, model: "small-codex", effort: "low", hasSession: false };
  const request = { current, ladders, judgments: judgments({ complexity: 2.8 }) };
  const allowed = decide(input(request, { allow_backend_switch: true, allow_backends: ["claude"] }));
  assert.equal(allowed.backend, "claude");

  const excluded = decide(input(request, { allow_backend_switch: true, allow_backends: ["codex"] }));
  assert.equal(excluded.backend, "codex");

  const noneSelected = decide(input(request, { allow_backend_switch: true, allow_backends: [] }));
  assert.equal(noneSelected.backend, "codex");
});

test("the effort ceiling bounds the selected supported level instead of rounding above it", () => {
  const sparse = [candidate("codex", "sparse", ["low", "xhigh"], 2)];
  const selected = decide(input({
    current: { backend: "codex", model: "sparse", effort: "low", hasSession: false },
    ladders: { codex: sparse }, judgments: judgments({ complexity: 2.2, needsDeepReasoning: 0.2 }),
  }, { max_effort: "high" }));
  assert.equal(selected.effort, "low");
  assert.equal(selected.blocked, undefined);

  const noFit = decide(input({
    current: { backend: "codex", model: "high-only", effort: "low", hasSession: false },
    ladders: { codex: [candidate("codex", "high-only", ["high"], 2)] },
  }, { max_effort: "low" }));
  assert.equal(noFit.blocked, true);
  assert.equal(noFit.effort, undefined);
  assert.ok(noFit.reasons.some((reason) => /No supported reasoning effort/.test(reason)));
});

test("low-confidence pinned routes are capped or blocked, including unknown model capabilities", () => {
  const pinned = decide(input({
    current: { backend: "codex", model: "current", effort: "xhigh", hasSession: false },
    judgments: judgments({ taskConfidence: 0.2 }),
  }, { max_effort: "low" }));
  assert.equal(pinned.pinned, true);
  assert.equal(pinned.effort, "low");

  const unknown = decide(input({
    current: { backend: "codex", model: "default-model", hasSession: false },
    ladders: { codex: [candidate("codex", "default-model", [], 2)] },
    judgments: judgments({ taskConfidence: 0.2 }),
  }, { max_effort: "low" }));
  assert.equal(unknown.blocked, true);
  assert.equal(unknown.effort, undefined);
  assert.ok(unknown.reasons.some((reason) => /Cannot honor/.test(reason)));

  const unsupportedButBelowCap = decide(input({
    current: { backend: "codex", model: "high-only", effort: "low", hasSession: false },
    ladders: { codex: [candidate("codex", "high-only", ["high"], 2)] },
    judgments: judgments({ taskConfidence: 0.2 }),
  }, { max_effort: "low" }));
  assert.equal(unsupportedButBelowCap.blocked, true, "a stored low value is not proof that a high-only model will honor it");
  assert.equal(unsupportedButBelowCap.effort, undefined);

  const supportedAlternative = decide(input({
    current: { backend: "codex", model: "high-only", effort: "low", hasSession: false },
    ladders: { codex: [candidate("codex", "high-only", ["high"], 2)] },
    judgments: judgments({ taskConfidence: 0.2 }),
  }, { max_effort: "high" }));
  assert.equal(supportedAlternative.effort, "high", "choose an advertised supported effort when it remains under the ceiling");
  assert.equal(supportedAlternative.blocked, undefined);

  const unreported = decide(input({
    current: { backend: "codex", model: "unknown-list", effort: "low", hasSession: false },
    ladders: { codex: [candidate("codex", "unknown-list", [], 2)] },
    judgments: judgments({ taskConfidence: 0.2 }),
  }, { max_effort: "low" }));
  assert.equal(unreported.blocked, true, "an explicit value cannot establish support when the CLI reports no capabilities");
});

test("pinned routes also apply the premium effort ceiling", () => {
  const pinned = decide(input({
    current: { backend: "codex", model: "premium", effort: "xhigh", hasSession: false },
    ladders: { codex: [candidate("codex", "premium", ["high", "xhigh", "max"], 2)] },
    judgments: judgments({ taskConfidence: 0.1 }), premiumExhausted: true,
  }, { max_effort: "max" }));
  assert.equal(pinned.effort, "high");
  assert.ok(pinned.reasons.some((reason) => /premium-turn budget/.test(reason)));
});

test("missing model lists and premium budget cannot bypass the configured ceiling", () => {
  const missing = decide(input({
    current: { backend: "codex", model: "default-model", effort: "xhigh", hasSession: false },
    ladders: {}, judgments: judgments({ taskConfidence: 0.2 }),
  }, { max_effort: "low" }));
  assert.equal(missing.blocked, true);
  assert.equal(missing.effort, undefined);

  const premium = decide(input({
    current: { backend: "codex", model: "premium-only", effort: "low", hasSession: false },
    ladders: { codex: [candidate("codex", "premium-only", ["xhigh"], 2)] },
    premiumExhausted: true,
  }, { max_effort: "max" }));
  assert.equal(premium.blocked, true);
  assert.equal(premium.effort, undefined);
  assert.ok(premium.reasons.some((reason) => /premium-turn budget/.test(reason)));
});

test("a spent premium budget blocks top-tier models even when effort is below high", () => {
  const onlyTopTier = [candidate("codex", "top-only", ["low", "high"], 3)];
  const ordinary = decide(input({
    current: { backend: "codex", model: "top-only", effort: "low", hasSession: false },
    ladders: { codex: onlyTopTier }, premiumExhausted: true,
  }));
  assert.equal(ordinary.blocked, true, "the lowest available model is still top tier");
  assert.match(ordinary.reasons.at(-1)!, /premium-turn budget/);

  const pinned = decide(input({
    current: { backend: "codex", model: "top-only", effort: "low", hasSession: true },
    ladders: { codex: onlyTopTier }, premiumExhausted: true,
    judgments: judgments({ taskConfidence: 0.1 }),
  }));
  assert.equal(pinned.blocked, true, "low judge confidence cannot waive the spent budget");
  assert.match(pinned.reasons.at(-1)!, /premium-turn budget/);
});
