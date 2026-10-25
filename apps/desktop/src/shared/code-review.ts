/**
 * Code Review (docs/design/code-review.md): the read contract for remote GitHub pull requests, shared
 * by main, which owns the GitHub CLI and every request, and the renderer. A PR is named by a locator,
 * read under a key (the account that can see it and the repository's stable id) and pinned to a
 * revision. Every read says whether it is ready, partial, stale or unavailable, so an unavailable list
 * never reads as empty and a pending check never reads as passing.
 *
 * Pure and serializable. Remote paths and patches are data to display: nothing here reads, writes or
 * resolves a path in a local checkout, and nothing here grants a write.
 */

export const CODE_REVIEW_SCHEMA = 1 as const;

/** Hosts pull requests are read from. A host is never taken from a pasted link as an endpoint. */
export type PrHost = "github.com";

/** What a person names: owner, repository and number on a supported host. Naming a PR grants nothing. */
export interface PrLocator { host: PrHost; owner: string; repo: string; number: number }

/**
 * What a read is for: the signed-in account, the repository's stable id (it survives renames and
 * transfers; a name does not) and the number. `account` is the provider's user id as text, never a
 * login name or a credential.
 */
export interface PrKey { account: string; host: PrHost; repoId: string; number: number }

/** The commits a diff, a check result or a review finding is about. */
export interface PrRevision { baseRef: string; baseSha: string; headSha: string }

export interface CodeReviewAccount { host: PrHost; id: string; login: string }

/** Whether main can read on someone's behalf. `detail` is shown as is: it never holds a token. */
export type CodeReviewConnection =
  | { state: "connected"; account: CodeReviewAccount }
  | { state: "signed-out" | "no-cli" | "unavailable"; detail: string };

/**
 * How much of a collection a read holds. `total` is the provider's count, null when it gives none;
 * `next` is the cursor for the rest; `cap` is the provider limit that cut the collection short.
 */
export interface Coverage { loaded: number; total: number | null; complete: boolean; next: string | null; cap?: number }

/** Why nothing could be read. `head-changed`: the PR moved past the revision asked about, and no earlier read of it is kept. */
export type Unavailable = "signed-out" | "no-cli" | "denied" | "not-found" | "offline" | "rate-limited" | "timeout" | "invalid" | "head-changed" | "failed";

/**
 * `ready`: the read succeeded; `coverage`, when present, says how much it holds (a first page is ready
 * and incomplete). `partial`: the read stopped part-way, or the provider capped it; `value` is what
 * arrived. `stale`: `value` is an earlier read, kept because this one failed or the head moved.
 * `unavailable`: nothing to show. `fetchedAt` is when main finished the read.
 */
export type ReadResult<T> =
  | { state: "ready"; value: T; fetchedAt: string; coverage?: Coverage }
  | { state: "partial"; value: T; fetchedAt: string; reason: Unavailable | "capped"; coverage: Coverage }
  | { state: "stale"; value: T; fetchedAt: string; reason: Unavailable | "head-changed"; coverage?: Coverage }
  | { state: "unavailable"; reason: Unavailable; fetchedAt: string; retryAfter?: string; detail?: string };

export type PrState = "open" | "draft" | "closed" | "merged";

/** Avatars are not fetched: a person is shown by login. */
export interface PrActor { login: string; id: string | null; bot: boolean }

/**
 * One inbox row. `stackHint` is inferred (the base is not the repository's default branch), not a stack.
 * A search result names no base, so it is null until main has read the PR itself.
 */
export interface PrSummary {
  key: PrKey;
  locator: PrLocator;
  title: string;
  state: PrState;
  author: PrActor;
  updatedAt: string;
  stackHint: boolean | null;
}

export type InboxGroup = "authored" | "review-requested";

/** Each group is read separately, so one failing search leaves the other usable. */
export interface Inbox { account: string; query: string; groups: Record<InboxGroup, ReadResult<PrSummary[]>> }

export interface ResolvedPr { locator: PrLocator; key: PrKey }

/** The PR at the top of R1. `body` is the author's Markdown, untrusted: it renders through the inert Markdown view. */
export interface PrOverview {
  key: PrKey;
  locator: PrLocator;
  revision: PrRevision;
  title: string;
  body: string;
  state: PrState;
  author: PrActor;
  createdAt: string;
  updatedAt: string;
  headRef: string;
  /** `owner/name` of a fork the head comes from; null for the same repository or a deleted fork. */
  headRepo: string | null;
  totals: { files: number; additions: number; deletions: number; commits: number };
  reviewers: PrActor[];
  comments: number;
}

/**
 * The activity timeline, one item per provider object with its own stable id. Commits are listed one
 * by one; grouping a run of them ("3 commits") is presentation. A `deployment` comes from the
 * provider's deployment records; a preview link inside a bot's comment is only a comment.
 */
export type PrActivity =
  | { kind: "commit"; id: string; at: string; sha: string; headline: string; author: PrActor | null }
  | { kind: "opened"; id: string; at: string; actor: PrActor }
  | { kind: "comment"; id: string; at: string; actor: PrActor; /** Untrusted Markdown, like `PrOverview.body`. */ body: string }
  | { kind: "review"; id: string; at: string; actor: PrActor; verdict: "approved" | "changes-requested" | "commented" | "dismissed"; body: string; commit: string | null }
  | { kind: "event"; id: string; at: string; actor: PrActor | null; event: string }
  | { kind: "deployment"; id: string; at: string; environment: string; status: "success" | "pending" | "failure" | "inactive" | "unknown"; url: string | null; commit: string };

/**
 * One check run or commit status, for the commit it ran on. A result for another head is not evidence
 * for the current one, and none of this is merge permission.
 */
export interface PrCheck {
  id: string;
  name: string;
  source: "check-run" | "status";
  /** What reported it: the app's slug for a check run, the status's creator for a commit status. Two reporters can use one name. */
  reporter: string | null;
  headSha: string;
  status: "queued" | "running" | "completed" | "unknown";
  conclusion: "success" | "failure" | "neutral" | "cancelled" | "skipped" | "timed-out" | "action-required" | "startup-failure" | "stale" | "unknown" | null;
  startedAt: string | null;
  completedAt: string | null;
  /** The provider's details page. Untrusted: opened only through `safeHref`, on a click. */
  url: string | null;
}

/**
 * A numbered stack. `explicit` comes from documented stack metadata; `inferred` from base branches
 * and may be wrong. A member's `title` is null when the account cannot see it.
 */
export interface PrStack {
  source: "explicit" | "inferred";
  members: { locator: PrLocator; title: string | null; state: PrState | null }[];
  /** Index of the PR being viewed in `members`. */
  position: number;
}

export type PrFileStatus = "added" | "removed" | "modified" | "renamed" | "copied" | "changed" | "unchanged";

/** A file's patch, or why there is none. `binary` is not missing coverage; `too-large` and `provider` are. */
export type PatchState = { kind: "text"; patch: string } | { kind: "omitted"; reason: "binary" | "too-large" | "provider" };

/** A changed file at a revision. Paths are the repository's, relative, and never resolved locally. */
export interface PrFile {
  path: string;
  previousPath: string | null;
  status: PrFileStatus;
  additions: number;
  deletions: number;
  patch: PatchState;
}

export interface PrFiles { revision: PrRevision; diffBaseSha: string; files: PrFile[] }

/** Lines of one side of a file at a revision, for expanding context; `total` is the file's line count when known. */
export interface PrContext { revision: PrRevision; commitSha: string; side: "base" | "head"; path: string; start: number; lines: string[]; total: number | null }

/** A selected line range at one revision. `commitSha` is the commit its line numbers count in:
 * the head for `head`, the proven diff base (`PrFiles.diffBaseSha`) for `base`. */
export interface LineAnchor { key: PrKey; revision: PrRevision; commitSha: string; path: string; side: "base" | "head"; start: number; end: number }

/** What each read returns, by operation. */
export interface CodeReviewReads {
  connection: CodeReviewConnection;
  inbox: Inbox;
  "inbox-page": PrSummary[];
  resolve: ResolvedPr;
  overview: PrOverview;
  activity: PrActivity[];
  checks: PrCheck[];
  stack: PrStack;
  files: PrFiles;
  context: PrContext;
}

/**
 * What the renderer may ask main: plain data only. Cancellation names a request id; no AbortSignal,
 * URL, endpoint, shell text or local path crosses the bridge.
 */
export type CodeReviewRequest =
  | { op: "connection"; requestId: string }
  | { op: "inbox"; requestId: string; query: string }
  | { op: "inbox-page"; requestId: string; group: InboxGroup; query: string; cursor: string }
  | { op: "resolve"; requestId: string; input: string }
  | { op: "overview"; requestId: string; key: PrKey }
  | { op: "activity"; requestId: string; key: PrKey; cursor: string | null }
  | { op: "checks"; requestId: string; key: PrKey; revision: PrRevision }
  | { op: "stack"; requestId: string; key: PrKey }
  | { op: "files"; requestId: string; key: PrKey; revision: PrRevision; cursor: string | null }
  | { op: "context"; requestId: string; key: PrKey; revision: PrRevision; side: "base" | "head"; path: string; start: number; end: number }
  | { op: "cancel"; requestId: string };

export type CodeReviewOp = CodeReviewRequest["op"];

/** What a reply was read under. A view applies a reply only when this matches what it asked. */
export interface ReplyScope { account: string | null; key: PrKey | null; revision: PrRevision | null }

export interface CodeReviewReply<K extends keyof CodeReviewReads = keyof CodeReviewReads> {
  requestId: string;
  op: K;
  scope: ReplyScope;
  result: ReadResult<CodeReviewReads[K]>;
}

export const CODE_REVIEW_FEATURES = ["read", "review", "ask", "instructions", "comment", "submit-review", "request-reviewers", "edit", "state", "merge"] as const;
export type CodeReviewFeature = (typeof CODE_REVIEW_FEATURES)[number];

/** `owner` names the issue that would make an unavailable feature work; null when the person can fix it (install or sign in to `gh`). */
export type Capability = { available: true } | { available: false; reason: string; owner: string | null };
export type Capabilities = Record<CodeReviewFeature, Capability>;

export const LIMITS = { requestId: 64, query: 256, input: 2048, path: 4096, ref: 255, cursor: 512, contextLines: 500, line: 10_000_000 } as const;
const MAX_PR = 2_147_483_647;

const OWNER = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const REPO = /^[A-Za-z0-9_.-]{1,100}$/;
const NUMBER = /^[1-9][0-9]{0,9}$/;
const ACCOUNT_ID = /^[1-9][0-9]{0,19}$/;
const REPO_ID = /^[A-Za-z0-9_=-]{1,100}$/;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;
const CURSOR = /^[A-Za-z0-9_=+/-]{1,512}$/;
/** C0, DEL and C1 controls, and the line and paragraph separators. */
const CONTROL = /[\p{Cc}\u2028\u2029]/u;
/** A lone surrogate: not text, and `encodeURIComponent` throws on it. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
/** Invisible format characters (bidi overrides, zero-width joiners) that make a path read as another. */
const FORMAT = /\p{Cf}/u;

function locatorFrom(owner: string, repo: string, number: string): PrLocator | null {
  if (!OWNER.test(owner) || !REPO.test(repo) || repo === "." || repo === ".." || !NUMBER.test(number)) return null;
  const n = Number(number);
  return n <= MAX_PR ? { host: "github.com", owner, repo, number: n } : null;
}

/**
 * A pull request link, `github.com/owner/repo/pull/N` with or without a scheme, or `owner/repo#N`.
 * The link is parsed as a URL and must then name github.com with no credentials and the scheme's
 * default port; a dot segment anywhere names nothing. Spellings the URL parser normalizes to that
 * (`:443`, an empty `user:@`) are accepted: the link is only read for its parts, never fetched.
 */
export function parsePrLocator(input: string): PrLocator | null {
  const text = input.trim();
  if (!text || text.length > LIMITS.input || /\s/.test(text)) return null;
  const short = /^([^/#]+)\/([^/#]+)#([^/#]+)$/.exec(text);
  if (short) return locatorFrom(short[1]!, short[2]!, short[3]!);
  if (/\/\.\.?(?:[/?#]|$)|%2e/i.test(text)) return null;
  let url: URL;
  try { url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`); } catch { return null; }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || url.port) return null;
  if (url.hostname !== "github.com" && url.hostname !== "www.github.com") return null;
  const [owner, repo, kind, number] = url.pathname.split("/").slice(1);
  if (kind !== "pull" || owner === undefined || repo === undefined || number === undefined) return null;
  return locatorFrom(owner, repo, number);
}

/** The PR's page on GitHub, built from validated parts, for Copy link and Open in GitHub. */
export function canonicalPrUrl(locator: PrLocator): string {
  return `https://${locator.host}/${locator.owner}/${locator.repo}/pull/${locator.number}`;
}

/** A map key for per-PR view state. Validated keys hold no `/`, so it is unambiguous. */
export function prKeyId(key: PrKey): string {
  return `${key.host}/${key.account}/${key.repoId}/${key.number}`;
}

export function sameKey(a: PrKey | null, b: PrKey | null): boolean {
  if (a === null || b === null) return a === b;
  return a.account === b.account && a.host === b.host && a.repoId === b.repoId && a.number === b.number;
}

export function sameRevision(a: PrRevision | null, b: PrRevision | null): boolean {
  if (a === null || b === null) return a === b;
  return a.baseRef === b.baseRef && a.baseSha === b.baseSha && a.headSha === b.headSha;
}

/**
 * What a request is read under: its own key and revision, null where the operation takes none, and the
 * account (the key's when it has one). Main stamps each reply with the scope of the request it
 * answers, and the renderer keeps the scope of what it asked, so the two agree by construction. An
 * overview's revision is in its value, not its scope: the request named none.
 */
export function scopeOf(request: CodeReviewRequest, account: string | null): ReplyScope {
  const key = "key" in request ? request.key : null;
  const revision = "revision" in request ? request.revision : null;
  return { account: key ? key.account : account, key, revision };
}

/**
 * A reply is applied only to the request that asked for it: same id, same operation, and the same
 * account, PR and revision. `connection` is the exception: it is what tells the renderer the account,
 * so it matches by id and operation alone.
 */
export function acceptsReply(asked: { requestId: string; op: CodeReviewOp; scope: ReplyScope }, reply: { requestId: string; op: CodeReviewOp; scope: ReplyScope }): boolean {
  if (asked.requestId !== reply.requestId || asked.op !== reply.op) return false;
  if (asked.op === "connection") return true;
  return asked.scope.account !== null && asked.scope.account === reply.scope.account
    && sameKey(asked.scope.key, reply.scope.key) && sameRevision(asked.scope.revision, reply.scope.revision);
}

/** One inbox group, carrying the inbox's own state down: an unavailable inbox has unavailable groups, a stale one stale groups. */
export function inboxGroup(result: ReadResult<Inbox>, group: InboxGroup): ReadResult<PrSummary[]> {
  if (result.state === "unavailable") return result;
  const inner = result.value.groups[group];
  if (result.state === "stale" && (inner.state === "ready" || inner.state === "partial")) {
    return { state: "stale", value: inner.value, fetchedAt: inner.fetchedAt, reason: result.reason, ...(inner.coverage && { coverage: inner.coverage }) };
  }
  return inner;
}

function whole(result: ReadResult<unknown>): boolean {
  return result.state === "ready" && (result.coverage?.complete ?? true);
}

/** Empty only when a complete, successful read found nothing. Unavailable, partial or stale is not empty. */
export function isEmpty(result: ReadResult<readonly unknown[]>): boolean {
  return whole(result) && result.state === "ready" && result.value.length === 0;
}

/**
 * The count to show: the provider's total when it gives one, else what arrived, inexact unless
 * complete. A stale read's count is from then, so it is never exact. Null when unknown.
 */
export function knownCount(result: ReadResult<readonly unknown[]>): { count: number; exact: boolean } | null {
  if (result.state === "unavailable") return null;
  const total = result.coverage?.total;
  if (typeof total === "number") return { count: total, exact: result.state !== "stale" };
  return { count: result.value.length, exact: whole(result) };
}

/**
 * An inbox group's pages as one list, deduplicated by key in arrival order. Search pages are offsets, so
 * a row updated between pages can repeat or be skipped: the list is complete only when every page was
 * read in full, the last has no next page, and the distinct rows reach the provider's total.
 */
export function mergePages(pages: readonly ReadResult<PrSummary[]>[]): { rows: PrSummary[]; total: number | null; complete: boolean } {
  const seen = new Set<string>();
  const rows: PrSummary[] = [];
  for (const page of pages) {
    if (page.state === "unavailable") continue;
    for (const row of page.value) {
      const id = prKeyId(row.key);
      if (!seen.has(id)) { seen.add(id); rows.push(row); }
    }
  }
  const last = pages.at(-1);
  const total = last && last.state !== "unavailable" && typeof last.coverage?.total === "number" ? last.coverage.total : null;
  const read = pages.length > 0 && pages.every((page) => page.state === "ready");
  const ended = last?.state === "ready" && (last.coverage?.next ?? null) === null && last.coverage?.cap === undefined;
  return { rows, total, complete: read && ended && total !== null && rows.length >= total };
}

export type CheckVerdict = "passing" | "failing" | "pending" | "incomplete" | "none" | "unknown";

export interface ChecksSummary {
  verdict: CheckVerdict;
  passed: number;
  failed: number;
  pending: number;
  cancelled: number;
  neutral: number;
  skipped: number;
  unknown: number;
  /** Results for another head: shown as old, never counted for this one. */
  stale: number;
  /** Older runs of a check that ran again on the same head: replaced by the newest, never counted. */
  superseded: number;
}

const FAILED = new Set<PrCheck["conclusion"]>(["failure", "timed-out", "action-required", "startup-failure"]);

/**
 * Whether `a` is a later run than `b`. Run ids grow with creation. Without numeric ids, `startedAt`
 * decides, and a run that has not started yet (a queued re-run) is the latest.
 */
function later(a: PrCheck, b: PrCheck): boolean {
  if (/^\d+$/.test(a.id) && /^\d+$/.test(b.id)) return BigInt(a.id) > BigInt(b.id);
  if (a.startedAt === null || b.startedAt === null) return a.startedAt === null && b.startedAt !== null;
  return a.startedAt > b.startedAt;
}

/**
 * The newest run of each check per head and reporter: a re-run replaces the run it repeats, as
 * GitHub's own merge state does, and a same-named check from another reporter stays separate.
 */
function newestRuns(checks: PrCheck[]): PrCheck[] {
  const newest = new Map<string, PrCheck>();
  for (const check of checks) {
    const id = `${check.source}\u0000${check.reporter ?? ""}\u0000${check.headSha}\u0000${check.name}`;
    const seen = newest.get(id);
    if (!seen || later(check, seen)) newest.set(id, check);
  }
  return [...newest.values()];
}

/**
 * Checks for one revision. `passing` needs a complete, fresh read with every current check finished as
 * success, neutral or skipped; anything cancelled, unknown, unread or only on an old head is
 * `incomplete`. Only the newest run of a re-run check counts. Describes evidence; it is never merge
 * permission.
 */
export function summarizeChecks(result: ReadResult<PrCheck[]>, revision: PrRevision): ChecksSummary {
  const summary: ChecksSummary = { verdict: "unknown", passed: 0, failed: 0, pending: 0, cancelled: 0, neutral: 0, skipped: 0, unknown: 0, stale: 0, superseded: 0 };
  if (result.state === "unavailable") return summary;
  const runs = newestRuns(result.value);
  summary.superseded = result.value.length - runs.length;
  for (const check of runs) {
    if (check.headSha !== revision.headSha) summary.stale++;
    else if (check.status === "queued" || check.status === "running") summary.pending++;
    else if (check.status !== "completed") summary.unknown++;
    else if (check.conclusion === "success") summary.passed++;
    else if (check.conclusion === "neutral") summary.neutral++;
    else if (check.conclusion === "skipped") summary.skipped++;
    else if (check.conclusion === "cancelled") summary.cancelled++;
    else if (FAILED.has(check.conclusion)) summary.failed++;
    else summary.unknown++;
  }
  const current = runs.length - summary.stale;
  summary.verdict = summary.failed ? "failing"
    : summary.pending ? "pending"
    : summary.cancelled || summary.unknown || !whole(result) ? "incomplete"
    : current === 0 ? (summary.stale ? "incomplete" : "none")
    : "passing";
  return summary;
}

export interface DiffCoverage { files: number; total: number | null; complete: boolean; binary: number; missing: number }

/** How much of a PR's diff a read shows. `complete` needs every file and every textual patch, for a fresh read. Null when unread. */
export function diffCoverage(result: ReadResult<PrFiles>): DiffCoverage | null {
  if (result.state === "unavailable") return null;
  const files = result.value.files.length;
  let binary = 0;
  let missing = 0;
  for (const file of result.value.files) {
    if (file.patch.kind !== "omitted") continue;
    if (file.patch.reason === "binary") binary++;
    else missing++;
  }
  const total = result.coverage?.total ?? (whole(result) ? files : null);
  return { files, total, complete: whole(result) && missing === 0, binary, missing };
}

/** GitHub writes (#326) need the same connection reads do; main then checks each PR's permission itself. */
const WRITES = new Set<CodeReviewFeature>(["comment", "submit-review", "merge", "edit", "request-reviewers", "state"]);

const OWNERS: Record<Exclude<CodeReviewFeature, "read" | "comment" | "submit-review" | "merge" | "edit" | "request-reviewers" | "state">, { owner: string; reason: string }> = {
  review: { owner: "#325", reason: "Reviewing with an agent isn't available yet." },
  ask: { owner: "#325", reason: "Asking about a pull request isn't available yet." },
  instructions: { owner: "#325", reason: "Review instructions aren't available yet." },
};

/**
 * What the workspace may offer. Reads and every GitHub write (#326) follow the connection; whether a given PR
 * accepts them is main's answer for that PR (`code-review:write`). Review with an agent and its questions and
 * instructions stay unavailable until #325 lands.
 */
export function capabilities(connection: CodeReviewConnection): Capabilities {
  const read: Capability = connection.state === "connected" ? { available: true }
    : connection.state === "no-cli" ? { available: false, reason: "Install GitHub CLI (gh) to read pull requests.", owner: null }
    : connection.state === "signed-out" ? { available: false, reason: "Sign in to GitHub CLI (gh auth login) to read pull requests.", owner: null }
    : { available: false, reason: connection.detail, owner: null };
  const rest = Object.fromEntries(Object.entries(OWNERS).map(([feature, { owner, reason }]) => [feature, { available: false, reason, owner }]));
  return { read, ...Object.fromEntries([...WRITES].map((feature) => [feature, read])), ...rest } as Capabilities;
}

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

function text(value: unknown, max: number, allowEmpty: boolean): string | null {
  if (typeof value !== "string" || value.length > max || (!allowEmpty && value.length === 0)) return null;
  return CONTROL.test(value) || LONE_SURROGATE.test(value) ? null : value;
}

function cursor(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" && CURSOR.test(value) ? value : undefined;
}

function prKey(value: unknown): PrKey | null {
  if (!plain(value) || !exactly(value, ["account", "host", "repoId", "number"])) return null;
  const { account, host, repoId, number } = value;
  if (typeof account !== "string" || !ACCOUNT_ID.test(account) || host !== "github.com") return null;
  if (typeof repoId !== "string" || !REPO_ID.test(repoId)) return null;
  if (typeof number !== "number" || !Number.isInteger(number) || number < 1 || number > MAX_PR) return null;
  return { account, host, repoId, number };
}

/** A branch name as git allows it, minus anything that could read as a range or a path escape. */
function refName(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > LIMITS.ref) return null;
  if (/[\u0000-\u0020\u007f~^:?*[\\]/.test(value) || FORMAT.test(value) || LONE_SURROGATE.test(value)) return null;
  if (value.includes("..") || value.includes("@{") || value.includes("//")) return null;
  if (value === "@" || value.startsWith("/") || value.startsWith("-") || value.endsWith("/") || value.endsWith(".") || value.endsWith(".lock")) return null;
  return value.split("/").every((segment) => !segment.startsWith(".")) ? value : null;
}

/** A revision rebuilt from its validated fields, or null: main checks GitHub's answers with the rule requests go through. */
export function parseRevision(value: unknown): PrRevision | null {
  return revision(value);
}

function revision(value: unknown): PrRevision | null {
  if (!plain(value) || !exactly(value, ["baseRef", "baseSha", "headSha"])) return null;
  const baseRef = refName(value.baseRef);
  const { baseSha, headSha } = value;
  if (baseRef === null || typeof baseSha !== "string" || !SHA.test(baseSha) || typeof headSha !== "string" || !SHA.test(headSha)) return null;
  return { baseRef, baseSha, headSha };
}

/**
 * A repository path: relative, no empty, `.` or `..` segment, no control or invisible format character.
 * `\\`, `%`, `?` and `#` are allowed, since real files have them: main encodes every segment before it
 * goes into an endpoint (#321).
 */
function remotePath(value: unknown): string | null {
  const path = text(value, LIMITS.path, false);
  if (path === null || FORMAT.test(path)) return null;
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..") ? path : null;
}

function line(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= LIMITS.line ? value : null;
}

const FIELDS: Record<CodeReviewOp, readonly string[]> = {
  connection: [],
  inbox: ["query"],
  "inbox-page": ["group", "query", "cursor"],
  resolve: ["input"],
  overview: ["key"],
  activity: ["key", "cursor"],
  checks: ["key", "revision"],
  stack: ["key"],
  files: ["key", "revision", "cursor"],
  context: ["key", "revision", "side", "path", "start", "end"],
  cancel: [],
};

/**
 * Main's check on everything the renderer sends: a known operation, exactly its fields, each bounded
 * and well formed. Returns a fresh copy built from the validated fields, or null.
 */
export function validateRequest(input: unknown): CodeReviewRequest | null {
  if (!plain(input) || typeof input.op !== "string" || !Object.hasOwn(FIELDS, input.op)) return null;
  const op = input.op as CodeReviewOp;
  if (!exactly(input, ["op", "requestId", ...FIELDS[op]])) return null;
  const requestId = input.requestId;
  if (typeof requestId !== "string" || !REQUEST_ID.test(requestId)) return null;
  switch (op) {
    case "connection":
    case "cancel":
      return { op, requestId };
    case "inbox": {
      const query = text(input.query, LIMITS.query, true);
      return query === null ? null : { op, requestId, query };
    }
    case "inbox-page": {
      const query = text(input.query, LIMITS.query, true);
      const next = cursor(input.cursor);
      const group = input.group;
      if (query === null || typeof next !== "string" || (group !== "authored" && group !== "review-requested")) return null;
      return { op, requestId, group, query, cursor: next };
    }
    case "resolve": {
      const value = text(input.input, LIMITS.input, false);
      return value === null ? null : { op, requestId, input: value };
    }
    case "overview":
    case "stack": {
      const key = prKey(input.key);
      return key && { op, requestId, key };
    }
    case "activity": {
      const key = prKey(input.key);
      const next = cursor(input.cursor);
      return key && next !== undefined ? { op, requestId, key, cursor: next } : null;
    }
    case "checks": {
      const key = prKey(input.key);
      const rev = revision(input.revision);
      return key && rev ? { op, requestId, key, revision: rev } : null;
    }
    case "files": {
      const key = prKey(input.key);
      const rev = revision(input.revision);
      const next = cursor(input.cursor);
      return key && rev && next !== undefined ? { op, requestId, key, revision: rev, cursor: next } : null;
    }
    case "context": {
      const key = prKey(input.key);
      const rev = revision(input.revision);
      const path = remotePath(input.path);
      const start = line(input.start);
      const end = line(input.end);
      const side = input.side;
      if (!key || !rev || path === null || start === null || end === null || (side !== "base" && side !== "head")) return null;
      if (end < start || end - start + 1 > LIMITS.contextLines) return null;
      return { op, requestId, key, revision: rev, side, path, start, end };
    }
  }
}
