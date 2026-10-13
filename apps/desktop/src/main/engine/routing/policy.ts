import type { BackendId, EffortLevel, LastTurn, RoutingPolicy } from "../../../shared/types.js";
import type { Candidate, Tier } from "./catalog.js";
import { pick } from "./catalog.js";
import type { JudgeSource, Judgments } from "./judge.js";

/**
 * Deterministic policy: judgments in, one concrete route out. No I/O, no model call.
 * Every step that changes the outcome appends a human-readable reason so the UI can answer
 * "why this model?" and the user can see what to tune.
 */
export const EFFORTS: EffortLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

/** How long a backend's prompt cache is assumed to survive an idle thread. Claude Code writes 1-hour entries. */
export const CACHE_LIFETIME_MS: Record<BackendId, number> = { claude: 60 * 60_000, codex: 60 * 60_000, mock: 0 };
/** Below this many context tokens a switch re-reads too little to matter. */
export const SMALL_CONTEXT_TOKENS = 20_000;
/** A warm thread moves up only to a model at least this many tiers higher... */
export const UPGRADE_TIERS = 2;
/** ...or when Jev is this confident the request needs deep reasoning... */
export const DEEP_REASONING_UPGRADE = 0.85;
/** ...and the request does not lean on earlier turns this strongly. */
export const PRIOR_TURNS_DEPENDENT = 0.7;
/**
 * Whether changing effort or fast mode alone clears the backend's cached history. Measured on
 * 2026-10-12 (claude 2.1.296, codex-cli 0.162.1): an effort change kept the whole cache on both.
 * Fast mode could not be measured (Claude's fast-mode setting did not apply; Codex's default model
 * has no fast tier), so it stays assumed to clear.
 */
export const EFFORT_CLEARS_CACHE: Record<BackendId, boolean> = { claude: false, codex: false, mock: false };
export const FAST_CLEARS_CACHE: Record<BackendId, boolean> = { claude: true, codex: true, mock: false };

/** How likely a switch is to discard a warm prompt cache on this thread. */
export type Warmth = "none" | "unknown" | "cold" | "small" | "warm";

export interface DecisionInput {
  judgments: Judgments;
  source: JudgeSource;
  policy: RoutingPolicy;
  current: { backend: BackendId; model: string; effort?: string; hasSession: boolean };
  ladders: Partial<Record<BackendId, Candidate[]>>;
  /** Learned per-task tier offset (see fit.ts). */
  fitOffset: number;
  premiumExhausted: boolean;
  /**
   * What the thread's prompt cache was built with, and how long ago. The router always passes it;
   * a caller that omits it gets a fresh choice every turn.
   */
  cache?: { lastTurn?: LastTurn; idleMs?: number };
}

export interface Decision {
  backend: BackendId;
  model: string;
  effort?: string;
  fast: boolean;
  tier: Tier;
  /** True when the judge was too unsure and the thread's own model was kept. */
  pinned: boolean;
  /** The request must not run because an effort or premium budget limit cannot be guaranteed. */
  blocked?: true;
  /** True when a warm prompt cache kept the thread's model, effort or fast mode. */
  held?: true;
  /** The cache warmth the hold step saw; absent when no cache information was passed. */
  warmth?: Warmth;
  reasons: string[];
}

const clampTier = (n: number): Tier => Math.max(0, Math.min(3, Math.round(n))) as Tier;

function effortIndex(e: string | undefined): number | undefined {
  const i = EFFORTS.indexOf(e as EffortLevel);
  return i < 0 ? undefined : i;
}

function currentCandidate(input: DecisionInput): Candidate | undefined {
  return (input.ladders[input.current.backend] ?? []).find((c) => input.current.model ? c.model === input.current.model : c.isDefault);
}

/** How likely a switch is to discard a warm prompt cache on this thread. */
export function warmth(input: DecisionInput): Warmth {
  const { current, cache } = input;
  if (!cache || !current.hasSession || current.backend === "mock") return "none";
  const last = cache.lastTurn;
  if (!last) return "unknown";
  if (last.model !== current.model) return "cold";
  if (cache.idleMs !== undefined && cache.idleMs >= CACHE_LIFETIME_MS[current.backend]) return "cold";
  if (last.contextTokens !== undefined && last.contextTokens < SMALL_CONTEXT_TOKENS) return "small";
  return "warm";
}

function effortCeiling(input: DecisionInput, reasons: string[]): number | undefined {
  const configured = effortIndex(input.policy.max_effort);
  if (configured === undefined) return undefined;
  const high = effortIndex("high")!;
  if (input.premiumExhausted && configured > high) {
    reasons.push("Daily premium-turn budget used up → capped at high reasoning effort.");
    return high;
  }
  return configured;
}

/** The effort a request needs on a model of `tier`, before the ceiling: tier sets the base, deep reasoning bumps, a speed signal drops. */
function requestEffort(j: Judgments, tier: Tier): number {
  const base: EffortLevel[] = ["low", "medium", "high", "xhigh"];
  let e = effortIndex(base[tier]!)!;
  if (j.needsDeepReasoning >= 0.7) e += 1;
  if (j.wantsSpeed >= 0.7 && j.needsDeepReasoning < 0.5) e -= 1;
  return Math.max(0, Math.min(EFFORTS.length - 1, e));
}

/** Nearest known supported effort to the request that stays at or below the active ceiling. */
function fitEffort(candidate: Candidate, wanted: EffortLevel, cap: EffortLevel): EffortLevel | undefined {
  const desired = effortIndex(wanted)!;
  const limit = effortIndex(cap)!;
  const supported = candidate.efforts
    .map((effort) => ({ effort, index: effortIndex(effort) }))
    .filter((entry): entry is { effort: string; index: number } => entry.index !== undefined && entry.index <= limit)
    .sort((a, b) => (Math.abs(a.index - desired) + (a.index > desired ? 0.5 : 0)) - (Math.abs(b.index - desired) + (b.index > desired ? 0.5 : 0)));
  return supported[0]?.effort as EffortLevel | undefined;
}

function blocked(input: DecisionInput, reasons: string[], detail: string): Decision {
  return {
    backend: input.current.backend, model: input.current.model, effort: undefined, fast: false,
    tier: currentCandidate(input)?.tier ?? 2,
    pinned: true, blocked: true, reasons: [...reasons, detail],
  };
}

function pinnedEffort(input: DecisionInput, candidate: Candidate | undefined, cap: number | undefined): EffortLevel | null | undefined {
  // The offline scripted backend has no reasoning-effort setting or hidden provider default.
  if (input.current.backend === "mock") return null;
  if (cap === undefined) return undefined;
  const requested = effortIndex(input.current.effort);
  // A persisted effort is only safe when the live catalogue confirms that the current model
  // accepts it. Otherwise the CLI may ignore the setting and use an unknown, higher default.
  // The same rule applies when the effort list itself is absent: Auto cannot prove the ceiling.
  if (!candidate || candidate.efforts.length === 0) return undefined;
  if (requested !== undefined && requested <= cap && candidate.efforts.includes(input.current.effort!)) {
    return input.current.effort as EffortLevel;
  }
  const target = EFFORTS[Math.min(requested ?? effortIndex(candidate.defaultEffort) ?? effortIndex("medium")!, cap)]!;
  return fitEffort(candidate, target, EFFORTS[cap]!);
}

function keepCurrent(input: DecisionInput, candidate: Candidate | undefined, reasons: string[]): Decision {
  if (input.premiumExhausted && candidate?.tier === 3) return blocked(input, reasons, "The daily premium-turn budget is spent and the current model is top tier; the route was stopped.");
  const effort = pinnedEffort(input, candidate, effortCeiling(input, reasons));
  if (effort === undefined) return blocked(input, reasons, `Cannot honor the ${input.policy.max_effort} reasoning-effort ceiling for the current model because its supported efforts are unavailable or exceed the ceiling; the route was stopped.`);
  if (effort && effort !== input.current.effort) {
    reasons.push(input.current.effort
      ? `Adjusted current effort to the supported ${effort} level within the ${input.policy.max_effort} ceiling.`
      : `No effort requested; using ${effort} within the ${input.policy.max_effort} ceiling.`);
  }
  return { backend: input.current.backend, model: input.current.model, effort: effort ?? undefined, fast: false, tier: candidate?.tier ?? 2, pinned: true, reasons };
}

const kTokens = (n: number): string => `~${Math.max(1, Math.round(n / 1000))}k`;
const minutes = (ms: number | undefined): string => `${Math.max(0, Math.round((ms ?? 0) / 60_000))} min`;

function heldFast(input: DecisionInput, current: Candidate): boolean {
  return Boolean(input.cache?.lastTurn?.fast) && input.policy.allow_fast && Boolean(current.fastTier || current.backend === "claude");
}

/**
 * keepCurrent's route marked as held, or undefined when a limit stops the current route. With an
 * `effort`, that effort replaces the current one, so keepCurrent's notes about it do not apply.
 */
function heldRoute(input: DecisionInput, current: Candidate, reasons: string[], effort?: EffortLevel): Decision | undefined {
  const notes: string[] = [];
  const kept = keepCurrent(input, current, notes);
  if (kept.blocked) return undefined;
  if (!effort) reasons.push(...notes);
  return { ...kept, effort: effort ?? kept.effort, reasons, fast: heldFast(input, current), pinned: false, held: true };
}

/**
 * Effort for a kept model when changing effort leaves the cache intact: the cache decides the
 * model, the request decides the effort. The kept model runs at the effort the pick would have
 * had, so a model kept below the pick thinks harder and one kept above it does not overspend.
 * `from` is what the kept model would have used as the pick. A held turn does not reuse the
 * thread's last effort, so a raise does not carry into later held turns.
 */
function heldEffort(input: DecisionInput, current: Candidate, free: Decision): { effort: EffortLevel; from?: EffortLevel } | undefined {
  const cap = effortCeiling(input, []);
  if (cap === undefined) return undefined;
  const at = (tier: Tier) => fitEffort(current, EFFORTS[Math.min(requestEffort(input.judgments, tier), cap)]!, EFFORTS[cap]!);
  const effort = at(free.tier);
  if (!effort) return undefined;
  const own = at(current.tier);
  return own && own !== effort ? { effort, from: own } : { effort };
}

/**
 * Keeps a warm thread on the model its prompt cache was built with. A switch re-reads the whole
 * history uncached and drops the previous model's thinking, so a warm thread moves only up, and
 * only on a big jump. Limits still win: a model that is gone or over budget is not held.
 */
function hold(input: DecisionInput, free: Decision, current: Candidate | undefined, reasons: string[]): Decision {
  const w = warmth(input);
  if (w === "none") return free;
  const last = input.cache?.lastTurn;
  if (w === "cold") {
    reasons.push(last && last.model !== input.current.model ? "The cache was built for another model, so free choice." : `Idle ${minutes(input.cache?.idleMs)}, cache likely expired, so free choice.`);
    return { ...free, warmth: w };
  }
  if (w === "small") {
    reasons.push(`Only ${kTokens(last!.contextTokens!)} tokens of context, so switching is cheap.`);
    return { ...free, warmth: w };
  }
  if (!current || (input.premiumExhausted && current.tier === 3)) return { ...free, warmth: w };
  const state = w === "unknown" ? "no cache record for this thread yet" : `${last!.contextTokens !== undefined ? `${kTokens(last!.contextTokens)} tokens cached` : "cache still warm"}, last turn ${minutes(input.cache?.idleMs)} ago`;
  const tail = (change: string) => (w === "unknown" ? "" : ` ${change} would re-read the history uncached.`);
  if (free.model === current.model) {
    const effort = EFFORT_CLEARS_CACHE[current.backend] ? heldRoute(input, current, [])?.effort ?? free.effort : free.effort;
    // Without a record there is no fast-mode state to keep.
    const fast = FAST_CLEARS_CACHE[current.backend] && last ? heldFast(input, current) : free.fast;
    if (effort === free.effort && fast === free.fast) return { ...free, warmth: w };
    reasons.push(`Kept ${current.label} at ${effort ?? "its default"} effort${fast ? " in fast mode" : ""}: ${state}.${tail(effort !== free.effort ? "Changing effort" : "Changing fast mode")}`);
    return { ...free, effort, fast, held: true, warmth: w };
  }
  const to = (input.ladders[free.backend] ?? []).find((c) => c.model === free.model)?.label ?? free.model;
  if (free.tier > current.tier) {
    const j = input.judgments;
    if (free.tier - current.tier >= UPGRADE_TIERS) {
      reasons.push(`Moved up to ${to} despite the warm cache: ${free.tier - current.tier} tiers above ${current.label}.`);
      return { ...free, warmth: w };
    }
    if (j.needsDeepReasoning >= DEEP_REASONING_UPGRADE && j.dependsOnPriorTurns < PRIOR_TURNS_DEPENDENT) {
      reasons.push(`Moved up to ${to} despite the warm cache: the request needs deep reasoning and stands on its own.`);
      return { ...free, warmth: w };
    }
  }
  const effort = EFFORT_CLEARS_CACHE[current.backend] ? undefined : heldEffort(input, current, free);
  const kept = heldRoute(input, current, reasons, effort?.effort);
  if (!kept) return { ...free, warmth: w };
  reasons.push(`Kept ${current.label}: ${state}.${tail("Switching")}`);
  if (effort?.from) {
    reasons.push(free.tier > current.tier
      ? `Raised effort from ${effort.from} to ${effort.effort} to make up for staying below ${to}; an effort change keeps the cache.`
      : `Lowered effort from ${effort.from} to ${effort.effort}, the effort ${to} would have used; an effort change keeps the cache.`);
  }
  return { ...kept, warmth: w };
}

export function decide(input: DecisionInput): Decision {
  const { judgments: j, policy, current } = input;
  const reasons: string[] = [];
  const currentLadder = input.ladders[current.backend] ?? [];
  const candidateNow = currentCandidate(input);
  const label = (c: Candidate | undefined) => (c ? c.label : current.model || "the CLI default");

  // 1. Confidence gate: a calibrated judge that is unsure keeps whatever the user last chose.
  if (input.source === "jev" && j.taskConfidence < policy.min_confidence) {
    reasons.push(`Jev was unsure what kind of task this is (${j.taskConfidence.toFixed(2)} < ${policy.min_confidence}); kept ${label(candidateNow)}.`);
    return keepCurrent(input, candidateNow, reasons);
  }

  // 2. Target tier from complexity, nudged by reasoning need, risk, posture, and what the user taught us.
  let tier = j.complexity;
  reasons.push(`${j.task.replace(/_/g, " ")} · complexity ${j.complexity.toFixed(1)}/3${input.source === "heuristic" ? " (built-in heuristic, no Jev key)" : ""}.`);
  if (j.needsDeepReasoning >= 0.7) { tier += 1; reasons.push("Needs careful reasoning → one tier up."); }
  if (j.blastRadius >= 1.5) { tier += 1; reasons.push("Wide or hard-to-reverse effect → one tier up for care."); }
  if (j.task === "quick_answer" && j.complexity < 1.2) { tier = Math.min(tier, 0.4); reasons.push("A quick answer → smallest model."); }
  else if (j.wantsSpeed >= 0.7 && j.needsDeepReasoning < 0.5 && j.complexity < 1.2) { tier = Math.min(tier, 0.4); reasons.push("You asked for speed on a light task → smallest model."); }
  if (policy.posture === "economy") { tier -= 1; reasons.push("Posture: economy → one tier down."); }
  else if (policy.posture === "quality") { tier += 1; reasons.push("Posture: quality → one tier up."); }
  if (input.fitOffset) { tier += input.fitOffset; reasons.push(`Your past overrides for ${j.task.replace(/_/g, " ")} → ${input.fitOffset > 0 ? "+" : ""}${input.fitOffset.toFixed(1)} tier.`); }
  let target = clampTier(tier);
  if (input.premiumExhausted && target === 3) { target = 2; reasons.push("Daily premium-turn budget used up → capped at tier 2."); }

  // 3. Backend: stay put unless switching is allowed and it would not throw away the CLI session.
  let backend = current.backend;
  const canSwitch = policy.allow_backend_switch && !current.hasSession;
  if (canSwitch) {
    const options = (policy.allow_backends.length ? policy.allow_backends : [current.backend]).filter((b) => (input.ladders[b]?.length ?? 0) > 0);
    const reach = (b: BackendId) => Math.max(...(input.ladders[b] ?? []).map((c) => c.tier), -1);
    const currentReach = reach(current.backend);
    const better = options.find((b) => b !== current.backend && reach(b) >= target && currentReach < target);
    if (better) { backend = better; reasons.push(`${current.backend} lists no tier-${target} model; switched to ${better}.`); }
    else if (!currentLadder.length) {
      const any = options[0];
      if (any) { backend = any; reasons.push(`${current.backend} is unavailable; switched to ${any}.`); }
    }
  } else if (policy.allow_backend_switch && current.hasSession) reasons.push("This turn continues the conversation, so the backend stays to keep its session.");

  // 4. Model at the target tier on that backend.
  const rungs = input.ladders[backend] ?? [];
  const candidate = pick(rungs, target);
  if (!candidate) {
    reasons.push("No model list available; kept the current model.");
    return keepCurrent(input, candidateNow, reasons);
  }
  if (input.premiumExhausted && candidate.tier === 3) return blocked(input, reasons, `The daily premium-turn budget is spent and ${candidate.label} is top tier; the route was stopped.`);
  if (candidate.tier < target) reasons.push(`No tier-${target} model on ${backend}; using the highest available (${candidate.label}).`);

  // 5. Effort: tier sets the base; deep reasoning bumps, a speed signal drops, policy caps.
  let e = requestEffort(j, candidate.tier);
  if (j.wantsSpeed >= 0.7 && j.needsDeepReasoning < 0.5) reasons.push("You asked for speed → lower reasoning effort.");
  const cap = effortCeiling(input, reasons);
  if (cap === undefined) return blocked(input, reasons, "The configured reasoning-effort ceiling is unknown; the route was stopped.");
  if (e > cap) { e = cap; reasons.push(`Effort capped at ${EFFORTS[cap]} by your limit.`); }
  const wanted = EFFORTS[e]!;
  const effort = fitEffort(candidate, wanted, EFFORTS[cap]!);
  if (!effort && candidate.backend !== "mock") {
    const detail = candidate.efforts.length
      ? `No supported reasoning effort for ${candidate.label} is at or below the ${EFFORTS[cap]} ceiling; the route was stopped.`
      : `Supported reasoning efforts for ${candidate.label} are unknown, so the ${EFFORTS[cap]} ceiling cannot be guaranteed; the route was stopped.`;
    return blocked(input, reasons, detail);
  }

  // 6. Fast mode: only when the user signals speed, the task is not reasoning-heavy, and the model offers it.
  const fast = policy.allow_fast && j.wantsSpeed >= 0.6 && j.needsDeepReasoning < 0.5 && candidate.tier <= 1 && Boolean(candidate.fastTier || backend === "claude");
  if (fast) reasons.push("Fast mode: quick turnaround requested and the task is light.");

  // 7. Hold: a warm prompt cache keeps the thread where it is unless the jump is worth a rebuild.
  return hold(input, { backend, model: candidate.model, effort, fast, tier: candidate.tier, pinned: false, reasons }, candidateNow, reasons);
}
