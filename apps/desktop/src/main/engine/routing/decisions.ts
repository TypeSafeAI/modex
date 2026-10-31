import fs from "node:fs";
import path from "node:path";
import type { RoutingPolicy, RoutingStatus, RoutingTest } from "../../../shared/types.js";
import { SecretStore, noCipher } from "../secrets.js";
import { APPROVAL_QUESTION_SET_VERSION } from "../approvals/gate.js";
import { cliTransport, DEFAULT_JEV_MODEL, detectJevCli, httpTransport, JevError, resolveTypesafeKey, type CliInfo, type JevAnswer, type JevErrorCode, type JevTransport, type KeyResolverOptions, type ResolvedKey, type SpawnLike } from "./jev.js";
import { FOLLOW_UP_QUESTION_SET_VERSION } from "./followup.js";
import { QUESTION_SET_VERSION } from "./judge.js";

/**
 * The shared decision service (Routines Phase 0, docs/specs/2026-10-11-modex-routines-spec.md).
 * Every typed question Modex puts to Jev goes through here: Auto routing, follow-up suggestions and
 * approval rules. It owns the Jev connection (key, transport, and the session-wide switch-off after
 * an auth or billing rejection), names each versioned question set, and stores a receipt for each
 * judgment. Each caller keeps its own questions and its own answer to a failure.
 *
 * Jev answers typed questions only. Nothing here runs a turn, and a receipt never holds the state
 * sent to Jev: no request text, digest or file content.
 */
export const QUESTION_SETS = {
  routing: QUESTION_SET_VERSION,
  follow_up: FOLLOW_UP_QUESTION_SET_VERSION,
  approval: APPROVAL_QUESTION_SET_VERSION,
} as const;
export type QuestionSet = keyof typeof QUESTION_SETS;

export type ReceiptAnswer =
  | { type: "choice"; choice: string; confidence?: number }
  | { type: "score"; score: number; confidence?: number }
  | { type: "noul"; noul: number };

/** One judgment as `app/decisions.jsonl` records it. */
export interface DecisionReceipt {
  at: string;
  set: QuestionSet;
  version: number;
  model: string;
  transport: "cli" | "http";
  threadId?: string;
  /** Asked by Settings' Try it, not by a turn. */
  preview?: true;
  ms: number;
  /** Jev's typed answers by question id; absent when the request failed. */
  answers?: Record<string, ReceiptAnswer>;
  error?: { message: string; code?: JevErrorCode };
}

/** A connection for one question set. Every request through `transport` leaves a receipt. */
export type Connection =
  | { transport: JevTransport; model: string }
  | { transport: null; model: string; disabled?: string; unavailable?: string };

export interface DecisionsOptions {
  home: string;
  policy: () => RoutingPolicy;
  /**
   * undefined → resolve the key lazily (Modex keychain → env → jev config → login shell) and pick
   * the jev CLI or HTTPS per policy; null → never call Jev (offline / tests); a function → injected.
   */
  transport?: JevTransport | null;
  env?: NodeJS.ProcessEnv;
  /** Transport timeout. */
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

/** Past this size the receipt log starts over, keeping the previous file as `decisions.1.jsonl`. */
export const RECEIPT_LOG_BYTES = 4 * 1024 * 1024;

/** Appends receipts as JSON lines. A failed write is logged once and never changes a decision. */
export class ReceiptLog {
  private warned = false;
  constructor(readonly file: string, private readonly maxBytes = RECEIPT_LOG_BYTES) {}

  write(receipt: DecisionReceipt): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      if ((fs.statSync(this.file, { throwIfNoEntry: false })?.size ?? 0) >= this.maxBytes) fs.renameSync(this.file, this.file.replace(/\.jsonl$/, ".1.jsonl"));
      fs.appendFileSync(this.file, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
    } catch (error) {
      if (!this.warned) console.error("[modex] decision receipts could not be written:", error);
      this.warned = true;
    }
  }

  /** The newest receipts first, from the current file. */
  read(limit = 100): DecisionReceipt[] {
    let text = "";
    try { text = fs.readFileSync(this.file, "utf8"); } catch { return []; }
    return text.split("\n").filter(Boolean).slice(-limit).reverse().flatMap((line) => {
      try { return [JSON.parse(line) as DecisionReceipt]; } catch { return []; }
    });
  }
}

const unit = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? Math.round(value * 1000) / 1000 : undefined;

function receiptAnswers(answers: Record<string, JevAnswer | undefined> | undefined): Record<string, ReceiptAnswer> {
  const out: Record<string, ReceiptAnswer> = {};
  for (const [id, answer] of Object.entries(answers ?? {})) {
    if (answer?.type === "choice" && typeof answer.choice === "string") out[id] = { type: "choice", choice: answer.choice, ...(unit(answer.confidence) !== undefined ? { confidence: unit(answer.confidence) } : {}) };
    else if (answer?.type === "score" && unit(answer.score) !== undefined) out[id] = { type: "score", score: unit(answer.score)!, ...(unit(answer.confidence) !== undefined ? { confidence: unit(answer.confidence) } : {}) };
    else if (answer?.type === "noul" && unit(answer.noul) !== undefined) out[id] = { type: "noul", noul: unit(answer.noul)! };
  }
  return out;
}

export class Decisions {
  readonly secrets: SecretStore;
  readonly receipts: ReceiptLog;
  private setupPromise: Promise<Setup> | null = null;
  /** Invalidates session-level results from setup/provider work started with old settings. */
  private setupGeneration = 0;
  /** Set after an auth or billing rejection: retrying every turn would only add latency. */
  private jevDisabled: string | null = null;
  /** The last explicit Settings test. Status reads this without making a provider request. */
  private lastTest: RoutingStatus["lastTest"];
  /** Main's local-only rule (#380): threads no question may be asked about. */
  private localOnly: (threadId: string) => boolean = () => false;

  constructor(private readonly o: DecisionsOptions) {
    this.secrets = o.secrets ?? new SecretStore(o.home, noCipher);
    this.receipts = new ReceiptLog(path.join(o.home, "app", "decisions.jsonl"));
  }

  /** A question about a thread this names gets no connection: no key is resolved and nothing is sent. */
  guardThreads(localOnly: (threadId: string) => boolean): void {
    this.localOnly = localOnly;
  }

  /** Forget the resolved key/transport and any session-level rejection (after a key or policy change). */
  reset(): void {
    this.setupGeneration++;
    this.setupPromise = null;
    this.jevDisabled = null;
    this.lastTest = undefined;
  }

  private model(): string {
    return this.o.policy().jev_model || DEFAULT_JEV_MODEL;
  }

  private disableOn(err: unknown, generation: number): void {
    if (generation === this.setupGeneration && err instanceof JevError && (err.code === "auth" || err.code === "billing")) {
      this.jevDisabled = `Jev is off for this session — ${err.message} Fix the key or credits and restart Modex.`;
    }
  }

  private setup(): Promise<Setup> {
    if (this.o.transport === null) return Promise.resolve({ transport: null, kind: "none", key: { key: null, source: "none" }, cli: null, unavailableReason: "No Jev API key found and no jev CLI on PATH." });
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
    return { transport: null, kind: "none", key, cli, unavailableReason: key.problem ?? "No Jev API key found — Modex keychain, TYPESAFE_API_KEY, ~/.config/jev/config.json, and your login shell are all empty." };
  }

  /**
   * The Jev connection for one question set, or why there is none: switched off for this session
   * after an auth or billing rejection (`disabled`), or not set up (`unavailable`). An auth or billing
   * rejection seen through any set switches Jev off for every set.
   */
  async connect(set: QuestionSet, context: { threadId?: string; preview?: boolean } = {}): Promise<Connection> {
    const generation = this.setupGeneration;
    const model = this.model();
    if (context.threadId && this.localOnly(context.threadId)) return { transport: null, model, unavailable: "Jev is never asked about a local thread." };
    const s = await this.setup();
    if (this.jevDisabled) return { transport: null, model, disabled: this.jevDisabled };
    if (!s.transport) return { transport: null, model, unavailable: (s.unavailableReason ?? s.key.problem ?? "No Jev transport available") };
    const transport = s.transport;
    const kind: DecisionReceipt["transport"] = s.kind === "cli" ? "cli" : "http";
    return {
      model,
      transport: async (req, signal) => {
        const started = Date.now();
        const base = { at: new Date(started).toISOString(), set, version: QUESTION_SETS[set], model: req.model, transport: kind, ...(context.threadId ? { threadId: context.threadId } : {}), ...(context.preview ? { preview: true as const } : {}) };
        try {
          const response = await transport(req, signal);
          this.receipts.write({ ...base, ms: Date.now() - started, answers: receiptAnswers(response.answers) });
          return response;
        } catch (err) {
          this.disableOn(err, generation);
          this.receipts.write({ ...base, ms: Date.now() - started, error: err instanceof JevError ? { message: err.message, code: err.code } : { message: (err as Error)?.message ?? String(err) } });
          throw err;
        }
      },
    };
  }

  /** Stores a hand-entered key (or op:// reference) in the OS keychain and re-resolves. */
  setKey(value: string): void {
    this.secrets.set("typesafe_api_key", value);
    this.reset();
  }

  clearKey(): void {
    this.secrets.clear("typesafe_api_key");
    this.reset();
  }

  /** One tiny request through the active transport: proves key, credits, and connectivity without spending a real turn. */
  async test(): Promise<RoutingTest> {
    const started = Date.now();
    const generation = this.setupGeneration;
    const model = this.model();
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

  /** The connection half of Settings' routing status. */
  async status(): Promise<Omit<RoutingStatus, "questionSetVersion" | "fit">> {
    const s = await this.setup();
    const sec = this.secrets.describe("typesafe_api_key");
    return {
      live: Boolean(s.transport) && !this.jevDisabled,
      keySource: s.key.source,
      keyLast4: s.key.key && s.key.key !== "injected" ? s.key.key.slice(-4) : null,
      keyRef: s.key.ref ?? null,
      detail: this.jevDisabled ?? s.unavailableReason ?? s.key.problem,
      transport: s.kind === "cli" && s.cli ? { kind: "cli", bin: s.cli.bin, version: s.cli.version } : { kind: s.kind },
      secrets: { backend: this.secrets.backend, available: this.secrets.available(), present: sec.present, savedAt: sec.savedAt },
      model: this.model(),
      lastTest: this.lastTest,
    };
  }
}
