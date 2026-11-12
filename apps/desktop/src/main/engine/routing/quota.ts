import type { RoutingPolicy } from "../../../shared/types.js";

/** Account-bound metadata only. Provider credit units are not dollars or included allowance. */
export interface QuotaSnapshot {
  at: number;
  windows: { key: string; remainingPercent?: number; resetsAt?: number; model?: string; at?: number; state?: "low" | "exhausted" }[];
  credits?: { hasCredits?: boolean; unlimited?: boolean; balance?: number };
  blocked?: boolean;
  /** Explicit backend statement that included usage is unavailable; missing windows alone cannot prove this. */
  includedUnavailable?: boolean;
}
export interface QuotaState { state: "unknown" | "healthy" | "low" | "exhausted"; reason: string }
export const QUOTA_MAX_AGE_MS = 5 * 60_000;
const object = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const epoch = (v: unknown): number | undefined => finite(v) && v > 0 && v * 1000 <= 8.64e15 ? v * 1000 : undefined;
const fresh = (at: number, now: number) => finite(at) && now >= at && now - at <= QUOTA_MAX_AGE_MS;

export function quotaState(snapshot: QuotaSnapshot | undefined, policy: RoutingPolicy, model = "", now = Date.now()): QuotaState {
  const unknown = { state: "unknown", reason: "Remaining allowance and credits are unknown; no available balance was assumed." } as const;
  if (!snapshot || !fresh(snapshot.at, now)) return unknown;
  if (snapshot.blocked) return { state: "exhausted", reason: "The CLI reports a spend-control limit; this account is unavailable." };
  const windows = snapshot.windows.filter(w => (!w.model || model === w.model || model.startsWith(`claude-${w.model}-`))
    && fresh(w.at ?? snapshot.at, now) && (w.resetsAt === undefined || (finite(w.resetsAt) && w.resetsAt > now))
    && (w.state || (finite(w.remainingPercent) && w.remainingPercent >= 0 && w.remainingPercent <= 100)));
  const worst = [...windows].sort((a, b) => (a.state === "exhausted" ? 0 : a.remainingPercent ?? policy.low_quota_percent) - (b.state === "exhausted" ? 0 : b.remainingPercent ?? policy.low_quota_percent))[0];
  const c = snapshot.credits;
  const paid = c?.unlimited === true || (c?.hasCredits !== false && c?.balance !== undefined && c.balance > 0);
  if (worst) {
    const remaining = worst.state === "exhausted" ? 0 : worst.remainingPercent;
    const reset = worst.resetsAt === undefined ? "" : `; resets ${new Date(worst.resetsAt).toISOString()}`;
    const detail = remaining === undefined ? "The CLI warns that included allowance is low" : `${Math.round(remaining * 10) / 10}% included allowance remains`;
    if (remaining === 0) return { state: paid ? "low" : "exhausted", reason: `Included allowance is exhausted${reset}.${paid ? " Paid credits remain; conserving credits." : " No usable paid-credit balance is established."}` };
    return { state: worst.state === "low" || remaining! <= policy.low_quota_percent ? "low" : "healthy", reason: `${detail}${reset}.` };
  }
  if (c?.unlimited) return { state: "healthy", reason: "The CLI reports unlimited credits." };
  if (snapshot.includedUnavailable && (c?.hasCredits === false || c?.balance === 0)) return { state: "exhausted", reason: "The CLI reports included usage unavailable and no paid credits remain." };
  if (c?.balance !== undefined && finite(c.balance) && c.balance > 0) return { state: c.balance <= policy.low_credit_balance ? "low" : "healthy", reason: `${c.balance} provider credit units remain; included allowance is unknown.` };
  return unknown;
}

/** Codex app-server account/rateLimits/read. Never copies credentials or unrecognized payload text. */
export function codexQuota(value: unknown, at = Date.now()): QuotaSnapshot {
  const response = object(value), primary = object(response.rateLimits);
  const windows: QuotaSnapshot["windows"] = [];
  const buckets = [["account", primary], ...Object.entries(object(response.rateLimitsByLimitId)).map(([key, v]) => [key, object(v)] as const)] as const;
  for (const [key, bucket] of buckets) {
    // The single-bucket view is authoritative for general usage. Other buckets need an explicit model scope.
    const model = typeof bucket.normalModelSlug === "string" ? bucket.normalModelSlug : undefined;
    if (key !== "account" && !model) continue;
    for (const kind of ["primary", "secondary"]) {
      const w = object(bucket[kind]);
      if (!finite(w.usedPercent) || w.usedPercent < 0 || w.usedPercent > 100) continue;
      windows.push({ key: `${key}:${kind}`, remainingPercent: 100 - w.usedPercent, resetsAt: epoch(w.resetsAt), ...(model ? { model } : {}) });
    }
  }
  const raw = object(primary.credits);
  const balance = (typeof raw.balance === "string" && /^\d+(?:\.\d+)?$/.test(raw.balance.trim())) ? Number(raw.balance) : undefined;
  const credits = Object.keys(raw).length ? { hasCredits: typeof raw.hasCredits === "boolean" ? raw.hasCredits : undefined,
    unlimited: typeof raw.unlimited === "boolean" ? raw.unlimited : undefined, balance: finite(balance) && balance >= 0 ? balance : undefined } : undefined;
  return { at, windows, ...(response.ordinaryUsageAllowed === false ? { includedUnavailable: true } : {}), ...(credits ? { credits } : {}), ...(primary.spendControlReached === true ? { blocked: true } : {}) };
}

/** Claude stream-json rate_limit_event; utilization is a fraction, resetsAt is epoch seconds. */
export function claudeQuota(value: unknown, at = Date.now()): QuotaSnapshot {
  const info = object(value);
  const kind = typeof info.rateLimitType === "string" ? info.rateLimitType : "account";
  const model = /^(?:seven_day|five_hour)_(opus|sonnet|haiku|fable)$/.exec(kind)?.[1];
  if (!["account", "five_hour", "seven_day"].includes(kind) && !model) return { at, windows: [] };
  const remainingPercent = finite(info.utilization) && info.utilization >= 0 && info.utilization <= 1 ? 100 * (1 - info.utilization) : undefined;
  const state = info.status === "rejected" ? "exhausted" : info.status === "allowed_warning" ? "low" : undefined;
  return { at, windows: [{ key: kind, at, remainingPercent, resetsAt: epoch(info.resetsAt), ...(model ? { model } : {}), ...(state ? { state } : {}) }] };
}
