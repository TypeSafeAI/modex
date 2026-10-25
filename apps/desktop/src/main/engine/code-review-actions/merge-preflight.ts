import { sameKey, validateRequest, type PrKey, type PrRevision, type PrState } from "../../../shared/code-review.js";

/** Main-only and unwired: no read supplies these facts yet. A future adapter must fill them
 * from one fresh GitHub read immediately before the merge, never from cached UI state. */
export type MergeMethod = "merge" | "squash" | "rebase";
/** GitHub's `mergeable_state` values. */
export type MergeState = "clean" | "unstable" | "has_hooks" | "blocked" | "behind" | "dirty" | "draft" | "unknown";
/** `null` means the read didn't establish the value. Check counts and model findings are
 * deliberately absent: readiness comes from GitHub's own state, and extra fields are refused. */
export interface MergeFacts {
  key: PrKey; revision: PrRevision; state: PrState;
  mergeable: boolean | null; mergeState: MergeState | null;
  methods: Record<MergeMethod, boolean | null> | null; queue: "none" | "required" | null;
}
export type MergeUnavailable = "not-open" | "draft" | "conflicts" | "blocked" | "behind" | "unknown" | "no-methods" | "queue" | "policy-unreadable";
export type MergePreflight =
  | { kind: "offer"; key: PrKey; revision: PrRevision; expectedHeadSha: string; methods: MergeMethod[]; mergeState: MergeState }
  | { kind: "reconfirm"; reason: "scope-changed" | "head-changed" | "target-changed" }
  | { kind: "unavailable"; reason: MergeUnavailable; fallback: "open-in-github" };

const METHODS: MergeMethod[] = ["merge", "squash", "rebase"];
const STATES: MergeState[] = ["clean", "unstable", "has_hooks", "blocked", "behind", "dirty", "draft", "unknown"];
const unavailable = (reason: MergeUnavailable): MergePreflight => ({ kind: "unavailable", reason, fallback: "open-in-github" });
function shape(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));
}
function target(value: { key: PrKey; revision: PrRevision }): boolean {
  return validateRequest({ op: "checks", requestId: "merge", key: value.key, revision: value.revision }) !== null;
}
function facts(value: unknown): value is MergeFacts {
  if (!shape(value, ["key", "revision", "state", "mergeable", "mergeState", "methods", "queue"])) return false;
  const v = value as unknown as MergeFacts;
  return target(v) && ["open", "draft", "closed", "merged"].includes(v.state)
    && (v.mergeable === null || typeof v.mergeable === "boolean")
    && (v.mergeState === null || STATES.includes(v.mergeState))
    && (v.methods === null || (shape(v.methods, METHODS) && METHODS.every(m => v.methods![m] === null || typeof v.methods![m] === "boolean")))
    && (v.queue === null || v.queue === "none" || v.queue === "required");
}

/** Decides what Merge may offer for the revision the person reviewed. A changed scope, head or
 * target needs a new confirmation; it is never adapted to. Unknown or unreadable states stay
 * unavailable with GitHub as the fallback. GitHub still enforces its rules on the request, and
 * the expected head SHA is not an atomic lock on the base. */
export function mergePreflight(reviewed: { key: PrKey; revision: PrRevision }, input: unknown): MergePreflight {
  if (!shape(reviewed, ["key", "revision"]) || !target(reviewed as { key: PrKey; revision: PrRevision })) return unavailable("policy-unreadable");
  let f: MergeFacts;
  try { f = structuredClone(input) as MergeFacts; } catch { return unavailable("policy-unreadable"); }
  if (!facts(f)) return unavailable("policy-unreadable");
  if (!sameKey(f.key, reviewed.key)) return { kind: "reconfirm", reason: "scope-changed" };
  if (f.revision.headSha !== reviewed.revision.headSha) return { kind: "reconfirm", reason: "head-changed" };
  if (f.revision.baseSha !== reviewed.revision.baseSha || f.revision.baseRef !== reviewed.revision.baseRef) return { kind: "reconfirm", reason: "target-changed" };
  if (f.state === "closed" || f.state === "merged") return unavailable("not-open");
  if (f.state === "draft" || f.mergeState === "draft") return unavailable("draft");
  if (f.methods === null || f.queue === null) return unavailable("policy-unreadable");
  if (f.queue === "required") return unavailable("queue");
  const methods = METHODS.filter(m => f.methods![m] === true);
  if (!methods.length) return unavailable("no-methods");
  if (f.mergeable === false || f.mergeState === "dirty") return unavailable("conflicts");
  if (f.mergeable === null || f.mergeState === null || f.mergeState === "unknown") return unavailable("unknown");
  if (f.mergeState === "blocked") return unavailable("blocked");
  if (f.mergeState === "behind") return unavailable("behind");
  return { kind: "offer", key: f.key, revision: f.revision, expectedHeadSha: f.revision.headSha, methods, mergeState: f.mergeState };
}

/** The only way to a merge operation for `ReviewActions.prepare`: a method the offer contains. */
export function mergeOperation(preflight: MergePreflight, method: MergeMethod): { kind: "merge"; method: MergeMethod } | null {
  return preflight.kind === "offer" && METHODS.includes(method) && preflight.methods.includes(method) ? { kind: "merge", method } : null;
}
