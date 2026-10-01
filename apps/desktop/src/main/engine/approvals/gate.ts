import type { ApprovalAnswer, ApprovalGateConfig, ApprovalReceipt, ApprovalRule, Mode, RuleDecision } from "../../../shared/types.js";
import type { ApprovalAction } from "../backends/types.js";
import { JevError, type JevQuestion, type JevTransport } from "../routing/jev.js";
import { digestAction } from "./digest.js";

/**
 * The approval gate: answers an approval from the user's plain-language rules before it reaches a
 * human, or leaves it to the human. It never widens permissions (an allow is a one-off "yes") and
 * fails closed: no rule, no key, an error, a timeout, or a malformed answer all mean "ask".
 *
 * 1. Gate off, no action, or no enabled rule for this project → ask.
 * 2. Rules with a `match` ("<tool>: <glob>") are checked deterministically; a hit applies with p = 1.
 * 3. Rules without one go to Jev (one request, one noul per rule, plus `destructive`), capped at
 *    MAX_JEV_RULES. A rule applies when its noul ≥ threshold.
 * 4. Applying rules combine as never > ask > allow; nothing applies → ask.
 * 5. Safety downgrades no rule can override: allow on something Jev finds destructive (≥ 0.5) or on a
 *    sandbox/permission escalation → ask.
 * 6. Jev unavailable → only the deterministic result counts, and the receipt says so.
 * 7. Aborted while deciding → the approval is answered "no".
 */

export const MAX_JEV_RULES = 12;
export const DESTRUCTIVE_THRESHOLD = 0.5;

export const DESTRUCTIVE_QUESTION: JevQuestion = {
  type: "noul",
  // Adapted from BLAST_RADIUS_LEVELS[2] in routing/judge.ts, narrowed to a single pending action.
  instructions: "The action could delete data, rewrite git history, push or publish, spend money, or affect systems outside the repository.",
};

export function ruleQuestion(rule: ApprovalRule): JevQuestion {
  return {
    type: "noul",
    instructions: `The pending action clearly falls under: 'When the agent wants to ${rule.when}'. Answer true only if it plainly does, not if it merely might.`,
  };
}

export interface GateContext {
  rules: ApprovalRule[];
  config: ApprovalGateConfig;
  /** The thread's project: `root` scopes rules, `name`/`branch` go into the digest. */
  project: { root: string; name: string; branch?: string | null };
  mode: Mode;
  /** null → no Jev; only rules with a `match` can apply. */
  transport: JevTransport | null;
  model: string;
}

export interface GateDecision {
  decision: RuleDecision;
  /** The rule that decided (the highest-precedence one that applied). */
  rule?: ApprovalRule;
  source: "match" | "jev" | "none";
  /** Probability the deciding rule applied (1 for a match). */
  p?: number;
  ms: number;
  /** Jev's `destructive` probability, when it was asked. */
  destructive?: number;
  /** Why a rule's allow became an ask, or that Jev could not be consulted. */
  downgraded?: "destructive" | "escalation" | "jev-unavailable";
  /** Why Jev could not be consulted, when it could not. */
  jevError?: string;
  /** The turn stopped while the gate was deciding: the approval is answered "no". */
  aborted?: boolean;
}

/** The answer the gate gives the backend, or null when a human must answer. Never "always". */
export function answerFor(d: GateDecision): ApprovalAnswer | null {
  if (d.aborted) return "no";
  if (d.decision === "allow") return "yes";
  if (d.decision === "never") return "no";
  return null;
}

/** The transcript receipt for a decision that a rule made or shaped; undefined when no rule was involved. */
export function receiptFor(d: GateDecision): ApprovalReceipt | undefined {
  if (!d.rule || d.source === "none") return undefined;
  return {
    source: "rule",
    ruleId: d.rule.id,
    when: d.rule.when,
    decision: d.decision,
    via: d.source,
    ...(d.p !== undefined ? { p: round(d.p) } : {}),
    ms: d.ms,
    ...(d.downgraded ? { downgraded: d.downgraded } : {}),
  };
}

const round = (p: number) => Math.round(p * 100) / 100;

/** Enabled rules for this project: rules without a project apply everywhere. */
export function rulesFor(rules: ApprovalRule[], projectRoot: string): ApprovalRule[] {
  return rules.filter((r) => r.enabled && (!r.project || r.project === projectRoot));
}

/** True when the gate would consider this approval at all; the runner keeps today's path otherwise. */
export function gateApplies(action: ApprovalAction | undefined, rules: ApprovalRule[], config: ApprovalGateConfig, projectRoot: string): boolean {
  return Boolean(config.enabled && action && rulesFor(rules, projectRoot).length);
}

/**
 * `<tool>: <glob>`, compared against the action's tool (exactly) and title (glob, case-sensitive,
 * `*` is the only wildcard). For command titles shown as "$ cmd", the glob may omit the "$ ".
 */
export function matchesRule(match: string, action: Pick<ApprovalAction, "tool" | "title">): boolean {
  const i = match.indexOf(":");
  if (i <= 0) return false;
  const tool = match.slice(0, i).trim();
  const glob = match.slice(i + 1).trim();
  if (!tool || !glob || tool !== action.tool) return false;
  const re = new RegExp(`^${glob.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "s");
  const candidates = [action.title];
  if (action.title.startsWith("$ ")) candidates.push(action.title.slice(2));
  return candidates.some((c) => re.test(c));
}

/** Rules sent to Jev: project-scoped first, then newest (later in the list), at most MAX_JEV_RULES. */
export function jevRules(rules: ApprovalRule[]): ApprovalRule[] {
  return rules
    .map((rule, index) => ({ rule, index }))
    .sort((a, b) => Number(Boolean(b.rule.project)) - Number(Boolean(a.rule.project)) || b.index - a.index)
    .slice(0, MAX_JEV_RULES)
    .map((x) => x.rule);
}

const RANK: Record<RuleDecision, number> = { allow: 0, ask: 1, never: 2 };

interface Hit {
  rule: ApprovalRule;
  via: "match" | "jev";
  p: number;
}

function combine(hits: Hit[]): Hit | undefined {
  let best: Hit | undefined;
  for (const h of hits) {
    if (!best) best = h;
    else if (RANK[h.rule.decision] > RANK[best.rule.decision]) best = h;
    else if (RANK[h.rule.decision] === RANK[best.rule.decision] && (h.via === "match" && best.via !== "match" || h.via === best.via && h.p > best.p)) best = h;
  }
  return best;
}

class Aborted extends Error {}

/** Runs the transport with the gate's own timeout, honouring the turn's abort signal. */
async function ask(transport: JevTransport, req: Parameters<JevTransport>[0], timeoutMs: number, signal?: AbortSignal) {
  const ac = new AbortController();
  let rejectAbort!: (err: Error) => void;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const onAbort = () => { ac.abort(); rejectAbort(new Aborted()); };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { ac.abort(); reject(new JevError("Jev did not answer in time.", "timeout")); }, timeoutMs);
  });
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([transport(req, ac.signal), timeout, aborted]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

const noulOf = (a: unknown): number | null => {
  const x = a as { type?: unknown; noul?: unknown } | undefined;
  return x && x.type === "noul" && typeof x.noul === "number" && Number.isFinite(x.noul) && x.noul >= 0 && x.noul <= 1 ? x.noul : null;
};

export async function decide(action: ApprovalAction | undefined, ctx: GateContext, signal?: AbortSignal, now: () => number = Date.now): Promise<GateDecision> {
  const started = now();
  const ms = () => Math.max(0, now() - started);
  if (signal?.aborted) return { decision: "ask", source: "none", ms: 0, aborted: true };
  const rules = ctx.config.enabled && action ? rulesFor(ctx.rules, ctx.project.root) : [];
  if (!action || !rules.length) return { decision: "ask", source: "none", ms: ms() };

  // Deterministic pass.
  const hits: Hit[] = rules.filter((r) => r.match && matchesRule(r.match, action)).map((rule) => ({ rule, via: "match" as const, p: 1 }));

  // Jev pass: rules without a match, plus the destructive check. Also asked when the matches alone would allow,
  // so the destructive downgrade can apply to an exact-match allow too.
  const unmatched = jevRules(rules.filter((r) => !r.match));
  const wouldAllow = combine(hits)?.rule.decision === "allow";
  let destructive: number | undefined;
  let jevError: string | undefined;
  if (ctx.transport && (unmatched.length || wouldAllow)) {
    const questions: Record<string, JevQuestion> = { destructive: DESTRUCTIVE_QUESTION };
    unmatched.forEach((r, n) => { questions[`rule_${n}`] = ruleQuestion(r); });
    const state = digestAction(action, { project: { name: ctx.project.name, branch: ctx.project.branch }, mode: ctx.mode });
    try {
      const res = await ask(ctx.transport, { state, model: ctx.model, questions }, ctx.config.timeout_ms, signal);
      const answers = res?.answers ?? {};
      const d = noulOf(answers.destructive);
      const ps = unmatched.map((_, n) => noulOf(answers[`rule_${n}`]));
      if (d === null || ps.some((p) => p === null)) throw new JevError("Jev returned an answer the gate could not read.", "bad_response");
      destructive = d;
      unmatched.forEach((rule, n) => { if (ps[n]! >= ctx.config.threshold) hits.push({ rule, via: "jev", p: ps[n]! }); });
    } catch (err) {
      if (err instanceof Aborted || signal?.aborted) return { decision: "ask", source: "none", ms: ms(), aborted: true };
      jevError = err instanceof JevError ? `${err.message} (${err.code})` : (err as Error).message;
    }
  }
  if (signal?.aborted) return { decision: "ask", source: "none", ms: ms(), aborted: true };

  const best = combine(hits);
  const base = { ms: ms(), ...(destructive !== undefined ? { destructive } : {}), ...(jevError ? { jevError, downgraded: "jev-unavailable" as const } : {}) };
  if (!best) return { decision: "ask", source: "none", ...base };
  const decided: GateDecision = { decision: best.rule.decision, rule: best.rule, source: best.via, p: best.p, ...base };
  if (decided.decision === "allow") {
    if (action.escalation) return { ...decided, decision: "ask", downgraded: "escalation" };
    if (destructive !== undefined && destructive >= DESTRUCTIVE_THRESHOLD) return { ...decided, decision: "ask", downgraded: "destructive" };
  }
  return decided;
}
