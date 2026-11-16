import type { ApprovalReceipt, ThreadItem } from "./types.js";

/** How the deciding rule was found to apply: "exact match" or "Jev 0.94". */
export function receiptVia(r: ApprovalReceipt): string {
  if (r.via === "policy") return "thread setting";
  return r.via === "match" ? "exact match" : r.p !== undefined ? `Jev ${r.p.toFixed(2)}` : "Jev";
}

/** True when the gate needed Jev but did not consult it. Older receipts recorded this as `downgraded: "jev-unavailable"`. */
export function jevNotConsulted(r: ApprovalReceipt): boolean {
  return r.jevNotConsulted === true || r.downgraded === "jev-unavailable";
}

/** The card's one line when a rule, or a safety check that overrode a rule, sent the approval to a human. */
export function askedBecause(r: ApprovalReceipt): string {
  const rule = `rule "${r.when}"`;
  const overrode = `; ${rule} would have allowed it`;
  const why = r.downgraded === "destructive" ? `looks destructive${r.destructive !== undefined ? ` (Jev ${r.destructive.toFixed(2)})` : ""}${overrode}`
    : r.downgraded === "escalation" ? `needs more sandbox access${overrode}`
    : r.downgraded === "compound" ? `the command chains several commands${overrode}`
    : r.downgraded === "incomplete" ? `Jev could not see the whole command${overrode}`
    : rule;
  return `Asked because: ${why}${jevNotConsulted(r) ? " · Jev not consulted" : ""}`;
}

export type AnsweredTone = "allowed" | "refused" | "warn" | "neutral";
export interface AnsweredApproval { text: string; tone: AnsweredTone; by: string | null }

/** A request that closed without anyone answering it says why, rather than "Denied". */
const WITHDRAWN = {
  native: "Withdrawn — the agent no longer needs an answer",
  stopped: "Not answered — the turn was stopped",
  ended: "Not answered — the turn ended first",
} as const;

/**
 * The receipt row for an approval a person answered, or that closed unanswered: its words, its tone, and
 * "by you" only when the answer is recorded as given in this window. Null while the request still waits.
 */
export function answeredApproval(item: Extract<ThreadItem, { kind: "approval" }>): AnsweredApproval | null {
  if (!item.answer) return null;
  if (item.delivery === "uncertain") return { text: "Delivery uncertain — not resent", tone: "warn", by: null };
  if (item.delivery === "sending") return { text: "Sending decision…", tone: "neutral", by: null };
  if (item.withdrawn) return { text: WITHDRAWN[item.withdrawn], tone: "neutral", by: null };
  const by = item.answeredBy === "desktop" ? "by you" : null;
  if (item.answer === "no") return { text: "Denied", tone: "refused", by };
  return { text: item.answer === "always" ? "Approved — always for this command" : "Approved", tone: "allowed", by };
}
