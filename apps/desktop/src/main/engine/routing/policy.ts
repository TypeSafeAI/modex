import type { BackendId, EffortLevel, RoutingPolicy } from "../../../shared/types.js";
import type { Candidate, Tier } from "./catalog.js";
import { pick } from "./catalog.js";
import type { JudgeSource, Judgments } from "./judge.js";

/**
 * Deterministic policy: judgments in, one concrete route out. No I/O, no model call.
 * Every step that changes the outcome appends a human-readable reason so the UI can answer
 * "why this model?" and the user can see what to tune.
 */
export const EFFORTS: EffortLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

export interface DecisionInput {
  judgments: Judgments;
  source: JudgeSource;
  policy: RoutingPolicy;
  current: { backend: BackendId; model: string; effort?: string; hasSession: boolean };
  ladders: Partial<Record<BackendId, Candidate[]>>;
  /** Learned per-task tier offset (see fit.ts). */
  fitOffset: number;
  premiumExhausted: boolean;
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
  const base: EffortLevel[] = ["low", "medium", "high", "xhigh"];
  let e = effortIndex(base[candidate.tier]!)!;
  if (j.needsDeepReasoning >= 0.7) e += 1;
  if (j.wantsSpeed >= 0.7 && j.needsDeepReasoning < 0.5) { e -= 1; reasons.push("You asked for speed → lower reasoning effort."); }
  const cap = effortCeiling(input, reasons);
  if (cap === undefined) return blocked(input, reasons, "The configured reasoning-effort ceiling is unknown; the route was stopped.");
  if (e > cap) { e = cap; reasons.push(`Effort capped at ${EFFORTS[cap]} by your limit.`); }
  const wanted = EFFORTS[Math.max(0, Math.min(EFFORTS.length - 1, e))]!;
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

  return { backend, model: candidate.model, effort, fast, tier: candidate.tier, pinned: false, reasons };
}
