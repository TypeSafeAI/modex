import type { ApprovalReceipt } from "./types.js";

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
