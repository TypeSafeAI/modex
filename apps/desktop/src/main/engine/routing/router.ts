import path from "node:path";
import type { BackendId, FollowUp, ModelInfo, RoutingPolicy, RoutingStatus, RoutingTest, Thread, ThreadItem } from "../../../shared/types.js";
import { SecretStore, noCipher } from "../secrets.js";
import { ladder, tierOf, type Candidate } from "./catalog.js";
import { Fit } from "./fit.js";
import { cliTransport, DEFAULT_JEV_MODEL, detectJevCli, httpTransport, JevError, resolveTypesafeKey, type CliInfo, type JevTransport, type KeyResolverOptions, type ResolvedKey, type SpawnLike } from "./jev.js";
import { judgeHeuristically, judgeWithJev, stateFor, QUESTION_SET_VERSION, type JudgeSource, type Judgments } from "./judge.js";
import { decide, type Decision } from "./policy.js";
import { fallbackFollowUp, FOLLOW_UP_QUESTION, FOLLOW_UPS, followUpState } from "./followup.js";

export interface RouterOptions {
  home: string;
  policy: () => RoutingPolicy;
  listModels: (backend: BackendId) => Promise<{ models: ModelInfo[]; error?: string }>;
  /**
   * undefined → resolve the key lazily (Modex keychain → env → jev config → login shell) and
   * pick the jev CLI or HTTPS per policy; null → never call Jev (offline / tests);
   * a function → injected transport.
   */
  transport?: JevTransport | null;
  env?: NodeJS.ProcessEnv;
  /** Judge timeout; the heuristic takes over past it. */
  timeoutMs?: number;
  /** Modex's encrypted store for a hand-entered key. Defaults to one that cannot store. */
  secrets?: SecretStore;
  /** Test seams: key-resolution hooks, CLI detection, and process spawning. */
  keyResolver?: Pick<KeyResolverOptions, "readRef" | "loginShell" | "jevConfigPath">;
  detectCli?: (bin: string) => Promise<CliInfo | null>;
  spawnImpl?: SpawnLike;
}

interface Setup {
  transport: JevTransport | null;
  kind: "cli" | "http" | "none";
  key: ResolvedKey;
  cli: CliInfo | null;
  unavailableReason?: string;
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

/** Ties the judge, catalogue, policy, and fit together for the ThreadRunner. */
export class Router {
  readonly fit: Fit;
  readonly secrets: SecretStore;
  private setupPromise: Promise<Setup> | null = null;
  /** Invalidates session-level results from setup/provider work started with old settings. */
  private setupGeneration = 0;
  private readonly ladders = new Map<BackendId, { at: number; rungs: Candidate[] }>();
  private readonly blockedThreads = new Set<string>();
  /** Set after an auth or billing rejection: retrying every turn would only add latency. */
  private jevDisabled: string | null = null;
  /** The last explicit Settings test. Status reads this without making a provider request. */
  private lastTest: RoutingStatus["lastTest"];

  constructor(private readonly o: RouterOptions) {
    this.fit = new Fit(path.join(o.home, "app", "routing-fit.json"));
    this.secrets = o.secrets ?? new SecretStore(o.home, noCipher);
  }

  /** Forget the resolved key/transport and any session-level rejection (after a key or policy change). */
  reset(): void {
    this.setupGeneration++;
    this.setupPromise = null;
    this.jevDisabled = null;
    this.lastTest = undefined;
  }

  private disableOn(err: unknown, generation: number): void {
    if (generation === this.setupGeneration && err instanceof JevError && (err.code === "auth" || err.code === "billing")) {
      this.jevDisabled = `Jev is off for this session — ${err.message} Fix the key or credits and restart Modex.`;
    }
  }

  private setup(): Promise<Setup> {
    if (this.o.transport === null) return Promise.resolve({ transport: null, kind: "none", key: { key: null, source: "none" }, cli: null, unavailableReason: "No TypeSafe API key found and no jev CLI on PATH." });
    if (this.o.transport) return Promise.resolve({ transport: this.o.transport, kind: "http", key: { key: "injected", source: "env" }, cli: null });
    return (this.setupPromise ??= this.buildSetup());
  }

  private async buildSetup(): Promise<Setup> {
    const env = this.o.env ?? process.env;
    const policy = this.o.policy();
    const timeoutMs = this.o.timeoutMs ?? 8000;
    const [key, cli] = await Promise.all([
      resolveTypesafeKey({ env, stored: () => this.secrets.get("typesafe_api_key"), ...this.o.keyResolver }),
      policy.jev_transport === "http" ? Promise.resolve(null) : (this.o.detectCli ?? ((bin: string) => detectJevCli(bin, env)))(policy.jev_bin || "jev"),
    ]);
    // CLI-only must honor the explicit preference; only Auto mode may fall back to HTTPS.
    if (policy.jev_transport !== "http" && cli) return { transport: cliTransport(cli.bin, { apiKey: key.key, env, timeoutMs, spawnImpl: this.o.spawnImpl }), kind: "cli", key, cli };
    if (policy.jev_transport === "cli") {
      const bin = policy.jev_bin || "jev";
      return { transport: null, kind: "none", key, cli, unavailableReason: `Jev CLI-only transport is selected, but “${bin}” was not found or could not be run. Install or repair the Jev CLI, or choose Auto or HTTPS transport.` };
    }
    if (key.key) return { transport: httpTransport(key.key, { timeoutMs }), kind: "http", key, cli };
    return { transport: null, kind: "none", key, cli, unavailableReason: key.problem ?? "No TypeSafe API key found — Modex keychain, TYPESAFE_API_KEY, ~/.config/jev/config.json, and your login shell are all empty." };
  }

  /**
   * The same resolved Jev transport Auto routing uses, for other typed judgments (the approval gate),
   * or null when there is none or Jev was switched off for this session. An auth or billing rejection
   * seen through it switches Jev off here too, so the key path and its failure state stay single.
   */
  async jev(): Promise<{ transport: JevTransport | null; model: string }> {
    const generation = this.setupGeneration;
    const model = this.o.policy().jev_model || DEFAULT_JEV_MODEL;
    const { transport } = await this.setup();
    if (!transport || this.jevDisabled) return { transport: null, model };
    return {
      model,
      transport: async (req, signal) => {
        try {
          return await transport(req, signal);
        } catch (err) {
          this.disableOn(err, generation);
          throw err;
        }
      },
    };
  }

  /** Stores a hand-entered key (or op:// reference) in the OS keychain and re-resolves. */
  async setKey(value: string): Promise<RoutingStatus> {
    this.secrets.set("typesafe_api_key", value);
    this.reset();
    return this.status();
  }

  async clearKey(): Promise<RoutingStatus> {
    this.secrets.clear("typesafe_api_key");
    this.reset();
    return this.status();
  }

  /** One tiny request through the active transport: proves key, credits, and connectivity without spending a real turn. */
  async test(): Promise<RoutingTest> {
    const started = Date.now();
    const generation = this.setupGeneration;
    const model = this.o.policy().jev_model || DEFAULT_JEV_MODEL;
    const s = await this.setup();
    const policy = this.o.policy();
    const tested = { executable: s.kind === "cli" ? s.cli?.bin ?? null : policy.jev_transport === "http" ? null : policy.jev_bin || "jev", model };
    if (!s.transport) return this.recordTest({ ok: false, message: s.unavailableReason ?? s.key.problem ?? "Jev is unavailable with the current transport settings.", transport: "none", tested, current: generation === this.setupGeneration, ms: Date.now() - started }, generation);
    try {
      const res = await s.transport({ model, state: "ping", questions: { reachable: { type: "noul", instructions: "This state is the single word 'ping'." } } });
      const a = res.answers.reachable;
      if (!a || a.type !== "noul" || !Number.isFinite(a.noul) || a.noul < 0 || a.noul > 1) throw new JevError("Jev returned no valid reachable answer.", "bad_response");
      if (generation === this.setupGeneration) this.jevDisabled = null;
      return this.recordTest({ ok: true, message: `Jev answered via ${s.kind === "cli" ? `the jev CLI ${s.cli?.version ?? ""}`.trim() : "HTTPS"} (${res.usage?.input_tokens ?? "?"} input tokens${a && a.type === "noul" ? `, p=${a.noul.toFixed(2)}` : ""}).`, transport: s.kind, tested, current: generation === this.setupGeneration, ms: Date.now() - started }, generation);
    } catch (err) {
      const e = err instanceof JevError ? err : new JevError((err as Error).message, "unknown");
      this.disableOn(e, generation);
      return this.recordTest({ ok: false, message: e.message, code: e.code, status: e.status, transport: s.kind, tested, current: generation === this.setupGeneration, ms: Date.now() - started }, generation);
    }
  }

  private recordTest(result: RoutingTest, generation: number): RoutingTest {
    if (generation === this.setupGeneration && result.current !== false) {
      const { current: _current, ...test } = result;
      this.lastTest = { ...test, at: Date.now() };
    }
    return result;
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
    const s = await this.setup();
    const detail = this.jevDisabled ?? s.unavailableReason ?? s.key.problem;
    const fit = this.fit.snapshot();
    const tasks: RoutingStatus["fit"]["tasks"] = {};
    for (const [k, v] of Object.entries(fit.tasks)) if (v) tasks[k] = { offset: Math.round(v.offset * 100) / 100, samples: v.samples, overridesUp: v.overridesUp, overridesDown: v.overridesDown, failures: v.failures };
    const sec = this.secrets.describe("typesafe_api_key");
    return {
      live: Boolean(s.transport) && !this.jevDisabled,
      keySource: s.key.source,
      keyLast4: s.key.key && s.key.key !== "injected" ? s.key.key.slice(-4) : null,
      keyRef: s.key.ref ?? null,
      detail,
      transport: s.kind === "cli" && s.cli ? { kind: "cli", bin: s.cli.bin, version: s.cli.version } : { kind: s.kind },
      secrets: { backend: this.secrets.backend, available: this.secrets.available(), present: sec.present, savedAt: sec.savedAt },
      model: this.o.policy().jev_model || DEFAULT_JEV_MODEL,
      lastTest: this.lastTest,
      questionSetVersion: QUESTION_SET_VERSION,
      fit: { tasks, premiumToday: this.fit.premiumToday(), routes: fit.history.length },
    };
  }

  async route(input: RouteInput, signal?: AbortSignal): Promise<RouteReceipt> {
    const started = Date.now();
    const generation = this.setupGeneration;
    const policy = this.o.policy();
    const { thread } = input;
    // Until a new safe route succeeds, an override must not teach an older turn's preference.
    this.blockedThreads.add(thread.id);
    const state = stateFor({ text: input.text, backend: thread.backend, model: thread.model, mode: thread.mode, plan: thread.plan, items: input.items, project: input.project });

    let judgments: Judgments;
    let source: JudgeSource = "heuristic";
    let fallback: string | undefined;
    const setup = await this.setup();
    const { transport } = setup;
    if (this.jevDisabled) {
      fallback = `${this.jevDisabled} Used the built-in heuristic.`;
      judgments = judgeHeuristically(state);
    } else if (transport) {
      try {
        judgments = await judgeWithJev(state, transport, policy.jev_model || DEFAULT_JEV_MODEL, signal);
        source = "jev";
      } catch (err) {
        const why = err instanceof JevError ? `${err.message} (${err.code})` : (err as Error).message;
        this.disableOn(err, generation);
        fallback = `Jev unavailable — ${why}; used the built-in heuristic.`;
        judgments = judgeHeuristically(state);
      }
    } else {
      const why = (setup.unavailableReason ?? setup.key.problem ?? "No Jev transport available").replace(/[.!;]+$/, "");
      fallback = `${why}; used the built-in heuristic.`;
      judgments = judgeHeuristically(state);
    }

    const backends = new Set<BackendId>([thread.backend, ...(policy.allow_backend_switch ? policy.allow_backends : [])]);
    const ladders: Partial<Record<BackendId, Candidate[]>> = {};
    const discoveryErrors: string[] = [];
    await Promise.all([...backends].map(async (b) => {
      try { ladders[b] = await this.ladderFor(b); }
      catch (err) { ladders[b] = []; discoveryErrors.push((err as Error).message); }
    }));

    const premiumExhausted = policy.premium_turns_per_day != null && this.fit.premiumToday() >= policy.premium_turns_per_day;
    const decision = decide({
      judgments, source, policy, ladders, premiumExhausted,
      current: { backend: thread.backend, model: thread.model, effort: thread.effort, hasSession: Boolean(thread.sessionHandle) },
      fitOffset: this.fit.offsetFor(judgments.task),
    });
    const premium = decision.tier === 3 || decision.effort === "xhigh" || decision.effort === "max";
    decision.reasons.unshift(...discoveryErrors);
    if (decision.blocked && discoveryErrors.length) {
      decision.reasons[decision.reasons.length - 1] += ` ${discoveryErrors.join(" ")} Retry Auto to refresh the model list.`;
    }
    if (!decision.blocked) {
      this.blockedThreads.delete(thread.id);
      try {
        this.fit.recordRoute({ threadId: thread.id, task: judgments.task, source, backend: decision.backend, model: decision.model, effort: decision.effort, fast: decision.fast, tier: decision.tier, confidence: judgments.taskConfidence, premium });
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
      reasons: fallback ? [fallback, ...decision.reasons] : decision.reasons,
      durationMs: Date.now() - started,
      at: new Date().toISOString(),
    };
    return { item, judgments, decision, source, questionSetVersion: QUESTION_SET_VERSION };
  }

  noteOutcome(threadId: string, outcome: "completed" | "failed" | "interrupted"): void {
    try { this.fit.recordOutcome(threadId, outcome); } catch { /* Learning persistence cannot change a coding turn's outcome. */ }
  }

  /**
   * After a completed turn: which of the fixed follow-up prompts fits next, or null when none does.
   * Jev sees only typed completion facts (never assistant text, tool arguments or output) and only on
   * Auto threads; everything else, and every failure, falls back to the heuristic pick.
   */
  async followUp(input: RouteInput, signal?: AbortSignal): Promise<FollowUp | null> {
    if (signal?.aborted) return null;
    const state = followUpState(input);
    const generation = this.setupGeneration;
    if (!state) return null;
    const fallback: FollowUp = { text: FOLLOW_UPS[fallbackFollowUp(state)], source: "heuristic" };
    if (!input.thread.auto) return fallback;
    try {
      const { transport } = await this.setup();
      if (signal?.aborted) return null;
      if (transport && !this.jevDisabled) {
        const response = await transport({ state, model: this.o.policy().jev_model || DEFAULT_JEV_MODEL, questions: { follow_up: FOLLOW_UP_QUESTION } }, signal);
        if (signal?.aborted) return null;
        const answer = response.answers.follow_up;
        if (answer?.type === "choice" && Number.isFinite(answer.confidence) && answer.confidence >= this.o.policy().min_confidence) {
          if (answer.choice === "none") return null;
          if (Object.hasOwn(FOLLOW_UPS, answer.choice)) return { text: FOLLOW_UPS[answer.choice as keyof typeof FOLLOW_UPS], source: "jev" };
        }
      }
    } catch (err) {
      this.disableOn(err, generation);
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
