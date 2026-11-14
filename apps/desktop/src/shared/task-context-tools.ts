import type { ContextTarget } from "./task-context-evidence.js";

export const TASK_CONTEXT_TOOLS = ["propose_refs"] as const;
export interface TaskContextConnection { url: string; instructions: string }
export type TaskContextCapability = { state: "available" } | { state: "unavailable"; reason: "unsupported-adapter" | "local-execution-unqualified" | "configuration-not-bound" };
/** Adapter connection setup, not proof of model use, inspection, or supported native qualification. */
export function isTaskContextCapability(value: unknown): value is TaskContextCapability {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>, keys = Object.keys(v);
  if (!Object.hasOwn(v, "state")) return false;
  return v.state === "available" ? keys.length === 1 : v.state === "unavailable" && keys.length === 2 && Object.hasOwn(v, "reason")
    && ["unsupported-adapter", "local-execution-unqualified", "configuration-not-bound"].includes(v.reason as string);
}
export interface TaskContextProposal {
  receiptId: string; leaseId: string; requestId: string | number; at: string;
  refs: { target: ContextTarget; role: "file" | "test" | "note" }[];
}
export interface TaskContextProposalResult { receiptId: string; refIds: string[]; accepted: number }
