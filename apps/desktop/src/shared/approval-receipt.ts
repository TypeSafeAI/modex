import type { ApprovalReceipt } from "./types.js";

/** How the deciding rule was found to apply: "exact match" or "Jev 0.94". */
export function receiptVia(r: ApprovalReceipt): string {
  return r.via === "match" ? "exact match" : r.p !== undefined ? `Jev ${r.p.toFixed(2)}` : "Jev";
}

/** The card's one line when a rule, or a safety check that overrode a rule, sent the approval to a human. */
export function askedBecause(r: ApprovalReceipt): string {
  const rule = `rule "${r.when}"`;
  const why = r.downgraded === "destructive" ? `looks destructive${r.destructive !== undefined ? ` (Jev ${r.destructive.toFixed(2)})` : ""}; ${rule} would have allowed it`
    : r.downgraded === "escalation" ? `needs more sandbox access; ${rule} would have allowed it`
    : rule;
  return `Asked because: ${why}${r.downgraded === "jev-unavailable" ? " · Jev unavailable" : ""}`;
}
