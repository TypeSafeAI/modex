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
