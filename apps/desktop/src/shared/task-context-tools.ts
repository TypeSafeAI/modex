import type { ContextTarget } from "./task-context-evidence.js";

export const TASK_CONTEXT_TOOLS = ["propose_refs"] as const;
export interface TaskContextConnection { url: string; instructions: string }
export type TaskContextCapability = { state: "available" } | { state: "unavailable"; reason: "unsupported-adapter" | "local-execution-unqualified" | "configuration-not-bound" };
export interface TaskContextProposal {
  receiptId: string; leaseId: string; requestId: string | number; at: string;
  refs: { target: ContextTarget; role: "file" | "test" | "note" }[];
}
export interface TaskContextProposalResult { receiptId: string; refIds: string[]; accepted: number }
