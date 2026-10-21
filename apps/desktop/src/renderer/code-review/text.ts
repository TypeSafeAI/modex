import type { PrState, ReadResult, Unavailable } from "../../shared/code-review.js";

/** Why a read came back empty-handed, as a person reads it. Every reason has its own sentence. */
export const REASONS: Record<Unavailable, string> = {
  "signed-out": "GitHub CLI isn't signed in to this account. Run `gh auth login`, then retry.",
  "no-cli": "GitHub CLI (gh) isn't installed, so Modex can't read pull requests.",
  denied: "This account can't see it.",
  "not-found": "It wasn't found, or this account can't see it.",
  offline: "GitHub couldn't be reached.",
  "rate-limited": "GitHub's rate limit was reached.",
  timeout: "GitHub took too long to answer.",
  invalid: "Modex couldn't ask for that.",
  "head-changed": "The pull request changed while it was loading.",
  failed: "Pull requests couldn't be read.",
};

/** The reason, then main's own detail when it adds one. */
export function unavailableText(result: Extract<ReadResult<unknown>, { state: "unavailable" }>): string {
  const reason = REASONS[result.reason];
  return result.detail && result.detail !== reason ? `${reason} ${result.detail}` : reason;
}

/** Why part of a collection is missing: a reason, or the provider's cap. */
export function shortfallText(reason: Unavailable | "capped" | "head-changed"): string {
  return reason === "capped" ? "GitHub stops listing here." : REASONS[reason];
}

/** "now", "4m", "5h", "3d", then a date: the inbox's compact age. */
export function age(at: string, now: number): string {
  const then = Date.parse(at);
  if (!Number.isFinite(then)) return "";
  const minutes = Math.max(0, Math.floor((now - then) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}h`;
  if (minutes < 60 * 24 * 30) return `${Math.floor(minutes / (60 * 24))}d`;
  return new Date(then).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

const count = new Intl.NumberFormat("en-US");
/** "+8,912" and "−47", with a true minus sign. */
export const additions = (n: number) => `+${count.format(n)}`;
export const deletions = (n: number) => `−${count.format(n)}`;

export const STATE_LABELS: Record<PrState, string> = { open: "Open", draft: "Draft", closed: "Closed", merged: "Merged" };
