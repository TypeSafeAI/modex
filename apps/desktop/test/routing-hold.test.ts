import { test } from "node:test";
import assert from "node:assert/strict";
import { CACHE_LIFETIME_MS, decide, EFFORT_CLEARS_CACHE, FAST_CLEARS_CACHE, SMALL_CONTEXT_TOKENS, warmth, type DecisionInput } from "../src/main/engine/routing/policy.js";
import { ladder } from "../src/main/engine/routing/catalog.js";
import type { Judgments } from "../src/main/engine/routing/judge.js";
import { DEFAULT_ROUTING, type LastTurn, type ModelInfo, type RoutingPolicy } from "../src/shared/types.js";

const m = (id: string, extra: Partial<ModelInfo> = {}): ModelInfo => ({ id, label: id, efforts: ["low", "medium", "high", "xhigh", "max"], ...extra });
const claude = () => ladder("claude", ["haiku", "sonnet", "opus", "fable"].map((id) => m(id)));
const J = (over: Partial<Judgments> = {}): Judgments => ({ task: "small_edit", taskConfidence: 0.9, taskProbabilities: {}, complexity: 0.6, complexityConfidence: 0.8, blastRadius: 0.3, wantsSpeed: 0.1, needsDeepReasoning: 0.2, dependsOnPriorTurns: 0, ...over });
const last = (over: Partial<LastTurn> = {}): LastTurn => ({ at: "2026-10-12T00:00:00.000Z", model: "opus", effort: "high", fast: false, contextTokens: 150_000, ...over });
const D = (over: Partial<DecisionInput> = {}, policy: Partial<RoutingPolicy> = {}): DecisionInput => ({
  judgments: J(), source: "jev", policy: { ...DEFAULT_ROUTING, ...policy },
  current: { backend: "claude", model: "opus", effort: "high", hasSession: true },
  ladders: { claude: claude() }, fitOffset: 0, premiumExhausted: false,
  cache: { lastTurn: last(), idleMs: 4 * 60_000 }, ...over,
});
/** Runs `fn` with the cache-clearing constants for Claude set as given, then restores them. */
const withClears = (effort: boolean, fast: boolean, fn: () => void) => {
  const saved = [EFFORT_CLEARS_CACHE.claude, FAST_CLEARS_CACHE.claude];
  EFFORT_CLEARS_CACHE.claude = effort;
  FAST_CLEARS_CACHE.claude = fast;
  try { fn(); } finally { [EFFORT_CLEARS_CACHE.claude, FAST_CLEARS_CACHE.claude] = saved as [boolean, boolean]; }
};

test("warmth: none without cache info, a session, or on mock; unknown without a record; cold when idle or built for another model; small below the floor", () => {
  assert.equal(warmth(D({ cache: undefined })), "none");
  assert.equal(warmth(D({ current: { backend: "claude", model: "opus", effort: "high", hasSession: false } })), "none");
  assert.equal(warmth(D({ current: { backend: "mock", model: "opus", hasSession: true } })), "none");
  assert.equal(warmth(D({ cache: { idleMs: undefined } })), "unknown");
  assert.equal(warmth(D({ cache: { lastTurn: last({ model: "sonnet" }), idleMs: 0 } })), "cold");
  assert.equal(warmth(D({ cache: { lastTurn: last(), idleMs: CACHE_LIFETIME_MS.claude } })), "cold");
  assert.equal(warmth(D({ cache: { lastTurn: last({ contextTokens: SMALL_CONTEXT_TOKENS - 1 }), idleMs: 0 } })), "small");
  assert.equal(warmth(D({ cache: { lastTurn: last({ contextTokens: undefined }), idleMs: 0 } })), "warm");
  assert.equal(warmth(D()), "warm");
});

test("a warm thread never moves down, and the receipt names the cache it keeps", () => {
  const d = decide(D());
  assert.deepEqual([d.model, d.effort, d.fast, d.held, d.pinned, d.warmth], ["opus", "high", false, true, false, "warm"]);
  assert.equal(d.reasons.at(-1), "Kept opus: ~150k tokens cached, last turn 4 min ago. Switching would re-read the history uncached.");
  const sizeless = decide(D({ cache: { lastTurn: last({ contextTokens: undefined }), idleMs: 4 * 60_000 } }));
  assert.equal(sizeless.reasons.at(-1), "Kept opus: cache still warm, last turn 4 min ago. Switching would re-read the history uncached.");
});

test("a warm thread keeps its model over another model of the same tier", () => {
  const rungs = ladder("claude", [m("haiku"), m("sonnet"), m("opus", { isDefault: true }), m("claude-opus-5"), m("fable")]);
  const d = decide(D({ judgments: J({ task: "feature", complexity: 2 }), current: { backend: "claude", model: "claude-opus-5", effort: "high", hasSession: true }, ladders: { claude: rungs }, cache: { lastTurn: last({ model: "claude-opus-5" }), idleMs: 60_000 } }));
  assert.deepEqual([d.model, d.held], ["claude-opus-5", true]);
});

test("a warm thread moves up only on a two-tier jump or a self-contained deep-reasoning request", () => {
  const sonnet = { current: { backend: "claude" as const, model: "sonnet", effort: "medium", hasSession: true }, cache: { lastTurn: last({ model: "sonnet", effort: "medium" }), idleMs: 60_000 } };
  const one = decide(D({ ...sonnet, judgments: J({ task: "feature", complexity: 2 }) }));
  assert.deepEqual([one.model, one.held], ["sonnet", true], "one tier up is held");
  const haiku = { current: { backend: "claude" as const, model: "haiku", effort: "low", hasSession: true }, cache: { lastTurn: last({ model: "haiku", effort: "low" }), idleMs: 60_000 } };
  const two = decide(D({ ...haiku, judgments: J({ task: "feature", complexity: 2 }) }));
  assert.deepEqual([two.model, two.held, two.warmth], ["opus", undefined, "warm"]);
  assert.equal(two.reasons.at(-1), "Moved up to opus despite the warm cache: 2 tiers above haiku.");
  const deep = decide(D({ ...sonnet, judgments: J({ task: "feature", complexity: 1.4, needsDeepReasoning: 0.9 }) }));
  assert.deepEqual([deep.model, deep.held], ["opus", undefined]);
  assert.equal(deep.reasons.at(-1), "Moved up to opus despite the warm cache: the request needs deep reasoning and stands on its own.");
  const leaning = decide(D({ ...sonnet, judgments: J({ task: "feature", complexity: 1.4, needsDeepReasoning: 0.9, dependsOnPriorTurns: 0.8 }) }));
  assert.deepEqual([leaning.model, leaning.held], ["sonnet", true], "a request that builds on earlier turns needs the full jump");
});

test("on the same model, effort and fast mode are held only where changing them clears the cache", () => {
  const input = D({ judgments: J({ task: "feature", complexity: 2 }), current: { backend: "claude", model: "opus", effort: "medium", hasSession: true }, cache: { lastTurn: last({ effort: "medium", fast: true }), idleMs: 4 * 60_000 } });
  withClears(true, true, () => {
    const d = decide(input);
    assert.deepEqual([d.model, d.effort, d.fast, d.held], ["opus", "medium", true, true]);
    assert.equal(d.reasons.at(-1), "Kept opus at medium effort in fast mode: ~150k tokens cached, last turn 4 min ago. Changing effort would re-read the history uncached.");
  });
  withClears(false, false, () => {
    const d = decide(input);
    assert.deepEqual([d.model, d.effort, d.fast, d.held], ["opus", "high", false, undefined]);
  });
});

test("a held route keeps the last turn's fast mode only while fast mode is allowed", () => {
  assert.equal(decide(D({ cache: { lastTurn: last({ fast: true }), idleMs: 0 } })).fast, true);
  assert.equal(decide(D({ cache: { lastTurn: last({ fast: true }), idleMs: 0 } }, { allow_fast: false })).fast, false);
});

test("limits win over the cache: a top-tier model over the premium budget is not held", () => {
  const d = decide(D({ current: { backend: "claude", model: "fable", effort: "high", hasSession: true }, cache: { lastTurn: last({ model: "fable" }), idleMs: 0 }, premiumExhausted: true }));
  assert.deepEqual([d.model, d.held, d.warmth], ["sonnet", undefined, "warm"]);
});

test("cold, small and unknown threads say why; without cache info the choice is today's", () => {
  const idle = decide(D({ cache: { lastTurn: last(), idleMs: CACHE_LIFETIME_MS.claude + 12 * 60_000 } }));
  assert.deepEqual([idle.model, idle.held, idle.warmth], ["sonnet", undefined, "cold"]);
  assert.equal(idle.reasons.at(-1), "Idle 72 min, cache likely expired, so free choice.");
  const other = decide(D({ cache: { lastTurn: last({ model: "sonnet" }), idleMs: 0 } }));
  assert.equal(other.reasons.at(-1), "The cache was built for another model, so free choice.");
  const small = decide(D({ cache: { lastTurn: last({ contextTokens: 12_000 }), idleMs: 0 } }));
  assert.deepEqual([small.model, small.warmth], ["sonnet", "small"]);
  assert.equal(small.reasons.at(-1), "Only ~12k tokens of context, so switching is cheap.");
  const unknown = decide(D({ cache: { idleMs: undefined } }));
  assert.deepEqual([unknown.model, unknown.held, unknown.warmth], ["opus", true, "unknown"]);
  assert.equal(unknown.reasons.at(-1), "Kept opus: no cache record for this thread yet.");
  const today = decide(D({ cache: undefined }));
  assert.deepEqual([today.model, today.held, today.warmth], ["sonnet", undefined, undefined]);
});

test("without a cache record, fast mode on the same model stays as Auto chose it", () => {
  withClears(false, true, () => {
    const d = decide(D({ judgments: J({ complexity: 0.4, wantsSpeed: 0.9 }), current: { backend: "claude", model: "haiku", effort: "low", hasSession: true }, cache: { idleMs: undefined } }));
    assert.deepEqual([d.model, d.fast, d.held, d.warmth], ["haiku", true, undefined, "unknown"]);
  });
});
