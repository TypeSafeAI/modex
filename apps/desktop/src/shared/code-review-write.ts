import { validateRequest, type LineAnchor, type PrKey, type PrRevision } from "./code-review.js";

/**
 * CR-7 (#326): what the renderer may ask main's `code-review:write` channel. It is a separate channel from
 * `code-review:read`, and nothing in it is authority: main resolves the account, the repository, the
 * pull request's head and the account's permission itself, immediately before preparing and again before
 * sending. Drafts stay local until an explicit submit of a preview main issued to this window.
 *
 * Pure and serializable. No credential, endpoint, URL or shell text crosses the bridge.
 */

export type WriteKind = "comment" | "review";
export type ReviewEvent = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
export type MergeMethod = "merge" | "squash" | "rebase";
export const MERGE_METHODS: readonly MergeMethod[] = ["merge", "squash", "rebase"];
export type WriteOperation = { kind: "comment" } | { kind: "review"; event: ReviewEvent } | { kind: "merge"; method: MergeMethod };
export interface WriteInline { anchor: LineAnchor; body: string }
export interface WriteDraft { kind: WriteKind; revision: PrRevision; version: number; body: string; comments: WriteInline[] }
/** A draft kept for an earlier head of the same PR. Only its body can be carried over; its line anchors are outdated. */
export interface EarlierDraft { kind: WriteKind; revision: PrRevision; version: number; bodyLength: number; comments: number }

export type IntentState = "prepared" | "dispatched" | "confirmed" | "rejected" | "unknown";
/** `abandoned`: the person stopped tracking an uncertain send. It may still have reached GitHub. */
export type IntentReason = "denied" | "failed" | "restart" | "cancelled" | "abandoned";
/** A receipt as the renderer sees it: no digest and nothing it could replay. */
export interface WriteReceipt { id: string; operation: WriteOperation; revision: PrRevision; state: IntentState; reason: IntentReason | null; remoteUrl: string | null }

/** What a preview shows before a consequential submit: the exact destination, account, action and revision. */
export interface WritePreview {
  intentId: string;
  account: { id: string; login: string };
  destination: { owner: string; repo: string; number: number; url: string };
  operation: WriteOperation;
  revision: PrRevision;
  body: string;
  comments: number;
}

/** Why Merge can't be offered, from GitHub's own state and settings. Each comes with Open on GitHub. */
export type MergeBlock = "not-open" | "draft" | "conflicts" | "blocked" | "behind" | "unknown" | "no-methods" | "queue" | "policy-unreadable";

/**
 * Main's answer to "may this account merge the reviewed head now?", from reads it made for this question.
 * An offer lists only the methods the repository allows. It is not a permit: preview and submit read again.
 */
export type MergeCheck =
  | { kind: "offer"; account: { id: string; login: string }; destination: WritePreview["destination"]; revision: PrRevision; methods: MergeMethod[]; unstable: boolean }
  | { kind: "unavailable"; reason: MergeBlock; detail: string; url: string };

/**
 * Local state for one PR and revision, for the signed-in account: no GitHub read beyond the account. Whether
 * this account may comment or review here is main's answer at preview and again at submit, never this one.
 */
export interface WriteStatus {
  account: { id: string; login: string };
  revision: PrRevision;
  drafts: Partial<Record<WriteKind, WriteDraft>>;
  earlier: EarlierDraft[];
  receipts: WriteReceipt[];
}

/** Why main did not do what was asked. Each is shown with its own fixed text: nothing GitHub or gh printed. */
export type WriteRefusal =
  | "disabled" | "no-cli" | "signed-out" | "account-changed" | "offline" | "timeout" | "rate-limited" | "not-found" | "failed"
  | "denied" | "locked" | "self-review" | "not-open" | "permission-unknown"
  | "head-changed" | "target-changed" | "anchor-outdated"
  | "draft-conflict" | "draft-empty" | "busy" | "no-preview" | "storage" | "merge-unavailable";

export type WriteResult<T> = { state: "ok"; value: T } | { state: "refused"; reason: WriteRefusal; detail: string };

export interface WriteReads {
  status: WriteStatus;
  save: WriteDraft;
  carry: WriteDraft;
  prepare: WritePreview;
  "merge-check": MergeCheck;
  "prepare-merge": WritePreview;
  submit: WriteReceipt;
  cancel: WriteReceipt;
  reconcile: WriteReceipt;
  abandon: WriteReceipt;
}

export type WriteRequest =
  | { op: "status"; requestId: string; key: PrKey; revision: PrRevision }
  | { op: "save"; requestId: string; key: PrKey; revision: PrRevision; kind: WriteKind; expectedVersion: number; body: string; comments: WriteInline[] }
  | { op: "carry"; requestId: string; key: PrKey; revision: PrRevision; kind: WriteKind; from: PrRevision }
  | { op: "prepare"; requestId: string; key: PrKey; revision: PrRevision; operation: Exclude<WriteOperation, { kind: "merge" }>; draftVersion: number }
  | { op: "merge-check"; requestId: string; key: PrKey; revision: PrRevision }
  | { op: "prepare-merge"; requestId: string; key: PrKey; revision: PrRevision; method: MergeMethod }
  | { [K in IntentOp]: { op: K; requestId: string; key: PrKey; intentId: string } }[IntentOp];
type IntentOp = "submit" | "cancel" | "reconcile" | "abandon";

export type WriteOp = WriteRequest["op"];
export interface WriteReply<K extends WriteOp = WriteOp> { requestId: string; op: K; key: PrKey; result: WriteResult<WriteReads[K]> }

export const WRITE_LIMITS = { body: 65_536, comments: 100 } as const;

const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{40}$/;
/** Markdown may hold tabs and newlines; other C0 controls and DEL are refused, as the draft store does. */
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

type Plain = Record<string, unknown>;
function plain(value: unknown): value is Plain {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
function exactly(value: Plain, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((k) => Object.hasOwn(value, k));
}
function target(key: unknown, revision: unknown): { key: PrKey; revision: PrRevision } | null {
  const checked = validateRequest({ op: "checks", requestId: "write", key, revision });
  return checked && checked.op === "checks" ? { key: checked.key, revision: checked.revision } : null;
}
function body(value: unknown, allowEmpty: boolean): string | null {
  if (typeof value !== "string" || value.length > WRITE_LIMITS.body || CONTROL.test(value) || LONE_SURROGATE.test(value)) return null;
  return allowEmpty || value.trim() ? value : null;
}
function anchor(value: unknown): LineAnchor | null {
  if (!plain(value) || !exactly(value, ["key", "revision", "commitSha", "path", "side", "start", "end"])) return null;
  const { commitSha, ...rest } = value;
  const checked = validateRequest({ op: "context", requestId: "anchor", ...rest });
  if (!checked || checked.op !== "context" || typeof commitSha !== "string" || !SHA.test(commitSha)) return null;
  return { key: checked.key, revision: checked.revision, commitSha, path: checked.path, side: checked.side, start: checked.start, end: checked.end };
}
export function parseOperation(value: unknown): WriteOperation | null {
  if (!plain(value)) return null;
  if (value.kind === "comment" && exactly(value, ["kind"])) return { kind: "comment" };
  if (value.kind === "review" && exactly(value, ["kind", "event"]) && (value.event === "COMMENT" || value.event === "APPROVE" || value.event === "REQUEST_CHANGES")) return { kind: "review", event: value.event };
  if (value.kind === "merge" && exactly(value, ["kind", "method"]) && MERGE_METHODS.includes(value.method as MergeMethod)) return { kind: "merge", method: value.method as MergeMethod };
  return null;
}

const FIELDS: Record<WriteOp, readonly string[]> = {
  status: ["key", "revision"],
  save: ["key", "revision", "kind", "expectedVersion", "body", "comments"],
  carry: ["key", "revision", "kind", "from"],
  prepare: ["key", "revision", "operation", "draftVersion"],
  "merge-check": ["key", "revision"],
  "prepare-merge": ["key", "revision", "method"],
  submit: ["key", "intentId"],
  cancel: ["key", "intentId"],
  reconcile: ["key", "intentId"],
  abandon: ["key", "intentId"],
};

/**
 * Main's check on everything the renderer sends: a known operation, exactly its fields, each bounded and
 * well formed. Returns a fresh copy built from the validated fields, or null. Passing it grants nothing.
 */
export function validateWrite(input: unknown): WriteRequest | null {
  if (!plain(input) || typeof input.op !== "string" || !Object.hasOwn(FIELDS, input.op)) return null;
  const op = input.op as WriteOp;
  if (!exactly(input, ["op", "requestId", ...FIELDS[op]]) || typeof input.requestId !== "string" || !REQUEST_ID.test(input.requestId)) return null;
  const requestId = input.requestId;
  if (op === "submit" || op === "cancel" || op === "reconcile" || op === "abandon") {
    const scoped = validateRequest({ op: "overview", requestId: "write", key: input.key });
    if (!scoped || scoped.op !== "overview" || typeof input.intentId !== "string" || !UUID.test(input.intentId)) return null;
    return { op, requestId, key: scoped.key, intentId: input.intentId };
  }
  const scope = target(input.key, input.revision);
  if (!scope) return null;
  const kind = input.kind;
  switch (op) {
    case "status":
    case "merge-check":
      return { op, requestId, ...scope };
    case "prepare-merge":
      return MERGE_METHODS.includes(input.method as MergeMethod) ? { op, requestId, ...scope, method: input.method as MergeMethod } : null;
    case "save": {
      const text = body(input.body, true);
      const version = input.expectedVersion;
      if ((kind !== "comment" && kind !== "review") || text === null || !Number.isSafeInteger(version) || (version as number) < 0) return null;
      if (!Array.isArray(input.comments) || input.comments.length > WRITE_LIMITS.comments || (kind === "comment" && input.comments.length)) return null;
      const comments: WriteInline[] = [];
      for (const raw of input.comments) {
        if (!plain(raw) || !exactly(raw, ["anchor", "body"])) return null;
        const a = anchor(raw.anchor), b = body(raw.body, false);
        if (!a || b === null) return null;
        comments.push({ anchor: a, body: b });
      }
      return { op, requestId, ...scope, kind, expectedVersion: version as number, body: text, comments };
    }
    case "carry": {
      const from = target(input.key, input.from);
      return (kind === "comment" || kind === "review") && from ? { op, requestId, ...scope, kind, from: from.revision } : null;
    }
    case "prepare": {
      const operation = parseOperation(input.operation);
      const version = input.draftVersion;
      // A merge has no draft: it is previewed with prepare-merge.
      return operation && operation.kind !== "merge" && Number.isSafeInteger(version) && (version as number) >= 1 ? { op, requestId, ...scope, operation, draftVersion: version as number } : null;
    }
  }
}

/** The hidden marker main appends to what it posts, so a read-back can tell its own comment or review from any other. */
export function intentMarker(id: string): string {
  return `<!-- modex-intent: ${id} -->`;
}

export const REFUSALS: Record<WriteRefusal, string> = {
  disabled: "GitHub writes are disabled in demos, tests and browser development.",
  "no-cli": "GitHub CLI (gh) was not found.",
  "signed-out": "Not signed in to GitHub CLI.",
  "account-changed": "GitHub CLI is now signed in to another account. Nothing was sent.",
  offline: "GitHub is unreachable. Check the network connection.",
  timeout: "GitHub took too long to answer.",
  "rate-limited": "GitHub's rate limit was reached. Try again after it resets.",
  "not-found": "GitHub has no such pull request, or this account can't see it.",
  failed: "GitHub's answer could not be read.",
  denied: "GitHub refused this. The account may lack permission, or the pull request doesn't allow it.",
  locked: "The conversation on this pull request is locked to collaborators.",
  "self-review": "You can't approve or request changes on your own pull request.",
  "not-open": "This pull request is closed or merged.",
  "permission-unknown": "Modex couldn't confirm this account's permission on the repository.",
  "head-changed": "The pull request has a newer head. Review the current changes, then preview again.",
  "target-changed": "The pull request's target branch changed. Preview again to confirm the new target.",
  "anchor-outdated": "A line comment points at lines that aren't in this revision's diff base. Remove it, or add it again on the current changes.",
  "draft-conflict": "This draft changed elsewhere. The newest version was kept.",
  "draft-empty": "Write something first.",
  busy: "An earlier send to this pull request isn't settled yet. Resolve it first.",
  "no-preview": "That preview is no longer valid. Preview again.",
  storage: "Modex couldn't save review actions on this Mac. Nothing was sent.",
  "merge-unavailable": "GitHub doesn't allow merging this pull request from here right now. Nothing was sent.",
};

export const MERGE_BLOCKS: Record<MergeBlock, string> = {
  "not-open": "This pull request is closed or merged.",
  draft: "This pull request is a draft. Mark it ready for review first.",
  conflicts: "This branch has conflicts with its target. Resolve them first.",
  blocked: "The target branch's rules block merging: required reviews or checks aren't satisfied.",
  behind: "This branch is behind its target, and the target requires it to be up to date.",
  unknown: "GitHub hasn't worked out whether this can merge yet. Check again in a moment.",
  "no-methods": "This repository allows none of the merge methods Modex offers.",
  queue: "The target branch merges through a merge queue. Use GitHub to add this pull request to it.",
  "policy-unreadable": "Modex couldn't read this repository's merge settings for your account.",
};

export const MERGE_LABELS: Record<MergeMethod, string> = { merge: "Create a merge commit", squash: "Squash and merge", rebase: "Rebase and merge" };
