import path from "node:path";
import type { BackendId, FollowUp, ModelInfo, RoutingPolicy, RoutingStatus, RoutingTest, Thread, ThreadItem } from "../../../shared/types.js";
import type { SecretStore } from "../secrets.js";
import { ladder, tierOf, type Candidate } from "./catalog.js";
import { Decisions, type DecisionsOptions } from "./decisions.js";
import { Fit } from "./fit.js";
import { JevError } from "./jev.js";
import { judgeHeuristically, judgeWithJev, stateFor, QUESTION_SET_VERSION, type JudgeSource, type Judgments } from "./judge.js";
import { decide, type Decision } from "./policy.js";
import { fallbackFollowUp, FOLLOW_UP_QUESTION, FOLLOW_UPS, followUpState } from "./followup.js";
import type { TurnUsage } from "../backends/types.js";

/** The Jev options (transport, key, timeout, test seams) build the shared decision service. */
export interface RouterOptions extends Omit<DecisionsOptions, "home" | "policy"> {
  home: string;
  policy: () => RoutingPolicy;
  listModels: (backend: BackendId) => Promise<{ models: ModelInfo[]; error?: string }>;
}

export interface RouteInput {
  thread: Thread;
  text: string;
  items: ThreadItem[];
  project: { name: string; branch?: string | null; changedFiles?: number };
}

export interface RouteReceipt {
  item: Extract<ThreadItem, { kind: "route" }>;
  judgments: Judgments;
  decision: Decision;
  source: JudgeSource;
  questionSetVersion: number;
}

/**
 * Ties the judge, catalogue, policy, and fit together for the ThreadRunner. Every question to Jev,
 * including the approval gate's, goes through `decisions`, the shared decision service.
 */
export class Router {
  readonly fit: Fit;
  readonly decisions: Decisions;
  private readonly ladders = new Map<BackendId, { at: number; rungs: Candidate[] }>();
  private readonly blockedThreads = new Set<string>();

  constructor(private readonly o: RouterOptions) {
    this.fit = new Fit(path.join(o.home, "app", "routing-fit.json"));
    const { listModels: _listModels, ...decisions } = o;
    this.decisions = new Decisions(decisions);
  }

  get secrets(): SecretStore { return this.decisions.secrets; }

  /** Forget the resolved key/transport and any session-level rejection (after a key or policy change). */
  reset(): void {
    this.decisions.reset();
  }

  /** Stores a hand-entered key (or op:// reference) in the OS keychain and re-resolves. */
  async setKey(value: string): Promise<RoutingStatus> {
    this.decisions.setKey(value);
    return this.status();
  }

  async clearKey(): Promise<RoutingStatus> {
    this.decisions.clearKey();
    return this.status();
  }

  /** One tiny request through the active transport: proves key, credits, and connectivity without spending a real turn. */
  test(): Promise<RoutingTest> {
    return this.decisions.test();
  }

  /** Model ladders are cached for a minute; the CLIs' lists rarely change mid-session. */
  private async ladderFor(backend: BackendId): Promise<Candidate[]> {
    const hit = this.ladders.get(backend);
    if (hit && Date.now() - hit.at < 60_000) return hit.rungs;
    const r = await this.o.listModels(backend);
    const rungs = ladder(backend, r.models);
    if (r.error) throw new Error(`${backend} model discovery failed: ${r.error}`);
    if (rungs.length) this.ladders.set(backend, { at: Date.now(), rungs });
    else this.ladders.delete(backend);
    return rungs;
  }

  /** Tier of a model the user picked by hand, for the override signal. */
  async tierOfModel(backend: BackendId, model: string): Promise<number | undefined> {
    const rungs = await this.ladderFor(backend);
    const c = rungs.find((x) => model ? x.model === model : x.isDefault);
    return c ? c.tier : model ? tierOf({ id: model, label: model }) : undefined;
  }

  async status(): Promise<RoutingStatus> {
    const connection = await this.decisions.status();
    const fit = this.fit.snapshot();
    const tasks: RoutingStatus["fit"]["tasks"] = {};
    for (const [k, v] of Object.entries(fit.tasks)) if (v) tasks[k] = { offset: Math.round(v.offset * 100) / 100, samples: v.samples, overridesUp: v.overridesUp, overridesDown: v.overridesDown, failures: v.failures };
    return {
      ...connection,
      questionSetVersion: QUESTION_SET_VERSION,
      fit: { tasks, premiumToday: this.fit.premiumToday(), routes: fit.history.length },
    };
  }

  async route(input: RouteInput, signal?: AbortSignal): Promise<RouteReceipt> {
    const started = Date.now();
    const policy = this.o.policy();
    const { thread } = input;
    // Until a new safe route succeeds, an override must not teach an older turn's preference.
    this.blockedThreads.add(thread.id);
    const state = stateFor({ text: input.text, backend: thread.backend, model: thread.model, mode: thread.mode, plan: thread.plan, items: input.items, project: input.project });

    let judgments: Judgments;
    let source: JudgeSource = "heuristic";
    let fallback: string | undefined;
    const jev = await this.decisions.connect("routing", { threadId: thread.id });
    if (jev.transport) {
      try {
        judgments = await judgeWithJev(state, jev.transport, jev.model, signal);
        source = "jev";
      } catch (err) {
        const why = err instanceof JevError ? `${err.message} (${err.code})` : (err as Error).message;
        fallback = `Jev unavailable — ${why}; used the built-in heuristic.`;
        judgments = judgeHeuristically(state);
      }
    } else if (jev.disabled) {
      fallback = `${jev.disabled} Used the built-in heuristic.`;
      judgments = judgeHeuristically(state);
    } else {
      fallback = `${(jev.unavailable ?? "No Jev transport available").replace(/[.!;]+$/, "")}; used the built-in heuristic.`;
      judgments = judgeHeuristically(state);
    }

    const backends = new Set<BackendId>([thread.backend, ...(policy.allow_backend_switch ? policy.allow_backends : [])]);
    const ladders: Partial<Record<BackendId, Candidate[]>> = {};
    const discoveryErrors: string[] = [];
    await Promise.all([...backends].map(async (b) => {
      try { ladders[b] = await this.ladderFor(b); }
      catch (err) { ladders[b] = []; discoveryErrors.push((err as Error).message); }
    }));

    const last = thread.lastTurn;
    const lastAt = last ? Date.parse(last.at) : Number.NaN;
    const idleMs = Number.isFinite(lastAt) ? Math.max(0, Date.now() - lastAt) : undefined;
    const premiumExhausted = policy.premium_turns_per_day != null && this.fit.premiumToday() >= policy.premium_turns_per_day;
    const decision = decide({
      judgments, source, policy, ladders, premiumExhausted,
      current: { backend: thread.backend, model: thread.model, effort: thread.effort, hasSession: Boolean(thread.sessionHandle) },
      fitOffset: this.fit.offsetFor(judgments.task),
      cache: { lastTurn: last, idleMs },
    });
    const premium = decision.tier === 3 || decision.effort === "xhigh" || decision.effort === "max";
    decision.reasons.unshift(...discoveryErrors);
    if (decision.blocked && discoveryErrors.length) {
      decision.reasons[decision.reasons.length - 1] += ` ${discoveryErrors.join(" ")} Retry Auto to refresh the model list.`;
    }
    if (!decision.blocked) {
      this.blockedThreads.delete(thread.id);
      try {
        this.fit.recordRoute({ threadId: thread.id, task: judgments.task, source, backend: decision.backend, model: decision.model, effort: decision.effort, fast: decision.fast, tier: decision.tier, confidence: judgments.taskConfidence, premium,
          ...(idleMs !== undefined ? { idleMs } : {}), ...(last?.contextTokens !== undefined ? { contextTokens: last.contextTokens } : {}),
          ...(decision.warmth ? { warmth: decision.warmth } : {}), ...(decision.held ? { held: true } : {}),
        });
      } catch (err) {
        decision.reasons.push(`Could not save routing learning (${(err as Error).message}); this session retains its premium count and the safe route will run.`);
      }
    }

    const item: RouteReceipt["item"] = {
      id: `route-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      kind: "route",
      backend: decision.backend,
      model: decision.model,
      effort: decision.effort,
      fast: decision.fast,
      source,
      task: judgments.task,
      confidence: Math.round(judgments.taskConfidence * 100) / 100,
      complexity: Math.round(judgments.complexity * 10) / 10,
      pinned: decision.pinned,
      blocked: decision.blocked,
      ...(decision.held ? { held: true as const } : {}),
      reasons: fallback ? [fallback, ...decision.reasons] : decision.reasons,
      durationMs: Date.now() - started,
      at: new Date().toISOString(),
    };
    return { item, judgments, decision, source, questionSetVersion: QUESTION_SET_VERSION };
  }

  /** A provider-selected fallback changes what ran, never the user's learned preference. */
  noteFallback(thread: Thread, fast: boolean): void {
    const tier = tierOf({ id: thread.model, label: thread.model });
    const premium = tier === 3 || thread.effort === "xhigh" || thread.effort === "max";
    try {
      this.fit.recordFallback(thread.id, { backend: thread.backend, model: thread.model, effort: thread.effort, fast, tier, premium });
    } catch { /* Learning persistence must not prevent a safe provider fallback. */ }
  }

  noteOutcome(threadId: string, outcome: "completed" | "failed" | "interrupted", usage?: TurnUsage): void {
    try { this.fit.recordOutcome(threadId, outcome, usage); } catch { /* Learning persistence cannot change a coding turn's outcome. */ }
  }

  /**
   * After a completed turn: which of the fixed follow-up prompts fits next, or null when none does.
   * Jev sees only typed completion facts (never assistant text, tool arguments or output) and only on
   * Auto threads; everything else, and every failure, falls back to the heuristic pick.
   */
  async followUp(input: RouteInput, signal?: AbortSignal): Promise<FollowUp | null> {
    if (signal?.aborted) return null;
    const state = followUpState(input);
    if (!state) return null;
    const fallback: FollowUp = { text: FOLLOW_UPS[fallbackFollowUp(state)], source: "heuristic" };
    if (!input.thread.auto) return fallback;
    try {
      const { transport, model } = await this.decisions.connect("follow_up", { threadId: input.thread.id });
      if (signal?.aborted) return null;
      if (transport) {
        const response = await transport({ state, model, questions: { follow_up: FOLLOW_UP_QUESTION } }, signal);
        if (signal?.aborted) return null;
        const answer = response.answers.follow_up;
        if (answer?.type === "choice" && Number.isFinite(answer.confidence) && answer.confidence >= this.o.policy().min_confidence) {
          if (answer.choice === "none") return null;
          if (Object.hasOwn(FOLLOW_UPS, answer.choice)) return { text: FOLLOW_UPS[answer.choice as keyof typeof FOLLOW_UPS], source: "jev" };
        }
      }
    } catch {
      /* The decision service switched Jev off on an auth or billing rejection; the heuristic answers. */
    }
    return signal?.aborted ? null : fallback;
  }

  /** The user picked a model by hand on an Auto thread. Returns what the fit learned, for a notice. */
  async noteOverride(thread: Thread, model: string): Promise<{ task: string; from: number; to: number } | undefined> {
    if (this.blockedThreads.has(thread.id)) return undefined;
    const previous = this.fit.latest(thread.id);
    const to = await this.tierOfModel(thread.backend, model);
    if (to === undefined) return undefined;
    if (this.blockedThreads.has(thread.id) || this.fit.latest(thread.id) !== previous) return undefined;
    const r = this.fit.recordOverride(thread.id, to);
    return r ? { task: r.task, from: r.tier, to } : undefined;
  }
}
