import type { ApprovalPolicy, ApprovalReceipt } from "../../../shared/types.js";
import type { ApprovalAction } from "../backends/types.js";

/**
 * A thread's standing answer to approvals, applied only where the rules gate would have left the
 * decision to a human (an explicit "Never" rule has already refused by then).
 *
 * - `ask`: nothing; the card appears.
 * - `always`: yes, unless the request wants more sandbox access, or we cannot tell what it wants
 *   (no structured action), or the rules gate sent it here (an Ask rule, or a destructive/escalation downgrade).
 * - `yolo`: yes to everything.
 */
export function policyAnswer(policy: ApprovalPolicy | undefined, action: ApprovalAction | undefined, gated?: ApprovalReceipt): "yes" | null {
  if (policy === "yolo") return "yes";
  if (policy !== "always") return null;
  if (!action || action.escalation) return null;
  // A rule that said "ask" or a safety downgrade is the user's own caution; only YOLO overrides it.
  if (gated && (gated.decision === "ask" || gated.downgraded === "destructive" || gated.downgraded === "escalation")) return null;
  return "yes";
}

export function policyReceipt(policy: ApprovalPolicy): ApprovalReceipt {
  return {
    source: "policy",
    ruleId: `policy:${policy}`,
    when: policy === "yolo" ? "YOLO: approve everything in this thread" : "Always allow in this thread",
    decision: "allow",
    via: "policy",
    ms: 0,
  };
}
