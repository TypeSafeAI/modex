import { parseRevision, type PrActivity, type PrActor, type PrCheck, type PrFile, type PrFileStatus, type PrRevision, type PrState } from "../../../shared/code-review.js";

/**
 * GitHub REST answers (API version 2022-11-28) mapped to the #320 contract. Everything here is
 * untrusted input: each field is checked for its type and bounded, and a shape that does not fit
 * reads as null rather than as a guess.
 */
type Json = Record<string, unknown>;

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/;
const OWNER = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const FILE_STATUS = new Set<PrFileStatus>(["added", "removed", "modified", "renamed", "copied", "changed", "unchanged"]);
/** GitHub shows a deleted account as `ghost`; an author is never missing from a row. */
const GHOST: PrActor = { login: "ghost", id: null, bot: false };

const object = (value: unknown): Json | null => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Json : null;
const count = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
const id = (value: unknown): string | null => typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? String(value) : null;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;
const time = (value: unknown): string | null => typeof value === "string" && ISO.test(value) && !Number.isNaN(Date.parse(value)) ? value : null;
/** An enum lookup that a key like `constructor` or `__proto__` can't satisfy. */
const pick = <T>(table: Record<string, T>, key: unknown): T | undefined => typeof key === "string" && Object.hasOwn(table, key) ? table[key] : undefined;
const text = (value: unknown, max: number): string => typeof value === "string" ? value.slice(0, max) : "";
const sha = (value: unknown): string | null => typeof value === "string" && SHA.test(value) ? value : null;

export function json(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    return undefined;
  }
}

export function actor(value: unknown): PrActor | null {
  const user = object(value);
  if (!user || typeof user.login !== "string" || !LOGIN.test(user.login)) return null;
  return { login: user.login, id: id(user.id), bot: user.type === "Bot" };
}

export interface Repository { id: string; owner: string; name: string; defaultBranch: string | null }

export function repository(value: unknown): Repository | null {
  const repo = object(value);
  const full = typeof repo?.full_name === "string" ? repo.full_name.split("/") : [];
  if (!repo || id(repo.id) === null || full.length !== 2 || !OWNER.test(full[0]!) || !NAME.test(full[1]!) || full[1] === "." || full[1] === "..") return null;
  return { id: id(repo.id)!, owner: full[0]!, name: full[1]!, defaultBranch: typeof repo.default_branch === "string" ? repo.default_branch : null };
}

/** The owner and name a search result's `repository_url` names: search answers carry no repository object. */
export function searchRepository(url: unknown): { owner: string; name: string } | null {
  const match = typeof url === "string" ? /^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)$/.exec(url) : null;
  return match && OWNER.test(match[1]!) && NAME.test(match[2]!) && match[2] !== "." && match[2] !== ".." ? { owner: match[1]!, name: match[2]! } : null;
}

function state(value: Json, mergedAt: unknown): PrState {
  return typeof mergedAt === "string" ? "merged" : value.state === "closed" ? "closed" : value.draft === true ? "draft" : "open";
}

export interface Pull {
  id: string;
  number: number;
  title: string;
  body: string;
  state: PrState;
  author: PrActor;
  createdAt: string;
  updatedAt: string;
  revision: PrRevision;
  base: Repository;
  headRef: string;
  headRepo: Repository | null;
  totals: { files: number; additions: number; deletions: number; commits: number };
  reviewers: PrActor[];
  comments: number;
}

export function pull(value: unknown): Pull | null {
  const pr = object(value), base = object(pr?.base), head = object(pr?.head);
  if (!pr || !base || !head || id(pr.id) === null || count(pr.number) === null) return null;
  const baseRepo = repository(base.repo);
  const revision = parseRevision({ baseRef: base.ref, baseSha: base.sha, headSha: head.sha });
  const createdAt = time(pr.created_at), updatedAt = time(pr.updated_at);
  const totals = { files: count(pr.changed_files), additions: count(pr.additions), deletions: count(pr.deletions), commits: count(pr.commits) };
  if (!baseRepo || !revision || !createdAt || !updatedAt || typeof pr.title !== "string" || typeof head.ref !== "string"
    || Object.values(totals).some((n) => n === null)) return null;
  const reviewers = Array.isArray(pr.requested_reviewers) ? pr.requested_reviewers.map(actor).filter((a): a is PrActor => a !== null) : [];
  return {
    id: id(pr.id)!, number: pr.number as number, title: text(pr.title, 1024), body: text(pr.body, 262_144), state: state(pr, pr.merged_at),
    author: actor(pr.user) ?? GHOST, createdAt, updatedAt, revision, base: baseRepo, headRef: text(head.ref, 255),
    headRepo: repository(head.repo), totals: totals as Pull["totals"], reviewers,
    comments: (count(pr.comments) ?? 0) + (count(pr.review_comments) ?? 0),
  };
}

export interface SearchRow { number: number; title: string; state: PrState; author: PrActor; updatedAt: string; repository: { owner: string; name: string } }

export function searchRow(value: unknown): SearchRow | null {
  const item = object(value), pr = object(item?.pull_request);
  const repo = searchRepository(item?.repository_url);
  const number = count(item?.number), updatedAt = time(item?.updated_at);
  if (!item || !pr || !repo || !number || !updatedAt || typeof item.title !== "string") return null;
  return { number, title: text(item.title, 1024), state: state(item, pr.merged_at), author: actor(item.user) ?? GHOST, updatedAt, repository: repo };
}

const VERDICTS: Record<string, "approved" | "changes-requested" | "commented" | "dismissed"> = {
  APPROVED: "approved", CHANGES_REQUESTED: "changes-requested", COMMENTED: "commented", DISMISSED: "dismissed",
};

/** One timeline page. A pending review is the reviewer's private draft and is never listed; anything malformed counts as dropped. */
export function timeline(items: unknown[]): { activity: PrActivity[]; dropped: number } {
  const activity: PrActivity[] = [];
  let dropped = 0;
  for (const value of items) {
    const item = object(value);
    const event = typeof item?.event === "string" ? item.event : null;
    if (!item || !event) { dropped++; continue; }
    if (event === "committed") {
      const commit = sha(item.sha), at = time(object(item.author)?.date) ?? time(object(item.committer)?.date);
      if (!commit || !at) { dropped++; continue; }
      activity.push({ kind: "commit", id: commit, at, sha: commit, headline: text(item.message, 4096).split("\n")[0]!.slice(0, 500), author: null });
    } else if (event === "reviewed") {
      // The timeline spells states in lower case, the reviews API in upper case.
      const reviewState = typeof item.state === "string" ? item.state.toUpperCase() : "";
      if (reviewState === "PENDING") continue;
      const verdict = pick(VERDICTS, reviewState);
      const reviewId = id(item.id), at = time(item.submitted_at), who = actor(item.user);
      if (!verdict || !reviewId || !at || !who) { dropped++; continue; }
      activity.push({ kind: "review", id: reviewId, at, actor: who, verdict, body: text(item.body, 262_144), commit: sha(item.commit_id) });
    } else if (event === "commented") {
      const commentId = id(item.id), at = time(item.created_at), who = actor(item.user);
      if (!commentId || !at || !who) { dropped++; continue; }
      activity.push({ kind: "comment", id: commentId, at, actor: who, body: text(item.body, 262_144) });
    } else {
      const at = time(item.created_at);
      // A cross-reference has no id of its own; the issue or PR that mentions this one does.
      const source = event === "cross-referenced" ? id(object(object(item.source)?.issue)?.id) : null;
      const eventId = id(item.id) ?? (typeof item.node_id === "string" && /^[A-Za-z0-9_=-]{1,100}$/.test(item.node_id) ? item.node_id : null)
        ?? (source && at ? `xref-${source}-${Math.floor(Date.parse(at) / 1000)}` : null);
      if (!eventId || !at || !/^[a-z_-]{1,64}$/.test(event)) { dropped++; continue; }
      activity.push({ kind: "event", id: eventId, at, actor: actor(item.actor), event });
    }
  }
  return { activity, dropped };
}

const RUN_STATUS: Record<string, PrCheck["status"]> = { queued: "queued", requested: "queued", waiting: "queued", pending: "queued", in_progress: "running", completed: "completed" };
const CONCLUSIONS: Record<string, NonNullable<PrCheck["conclusion"]>> = {
  success: "success", failure: "failure", neutral: "neutral", cancelled: "cancelled", skipped: "skipped", timed_out: "timed-out",
  action_required: "action-required", startup_failure: "startup-failure", stale: "stale",
};
const link = (value: unknown): string | null => typeof value === "string" && /^https:\/\//.test(value) && value.length <= 2048 ? value : null;

export function checkRun(value: unknown): PrCheck | null {
  const run = object(value);
  const runId = id(run?.id), head = sha(run?.head_sha);
  if (!run || !runId || !head || typeof run.name !== "string") return null;
  const conclusion = run.conclusion === null || run.conclusion === undefined ? null : pick(CONCLUSIONS, run.conclusion) ?? "unknown";
  return { id: runId, name: text(run.name, 512), source: "check-run", reporter: typeof object(run.app)?.slug === "string" ? text(object(run.app)!.slug, 128) : null,
    headSha: head, status: pick(RUN_STATUS, run.status) ?? "unknown", conclusion,
    startedAt: time(run.started_at), completedAt: time(run.completed_at), url: link(run.html_url) ?? link(run.details_url) };
}

/** A commit status on `headSha`. `error` is a failure; `pending` has not finished. */
export function commitStatus(value: unknown, headSha: string): PrCheck | null {
  const status = object(value);
  const statusId = id(status?.id);
  if (!status || !statusId || typeof status.context !== "string" || typeof status.state !== "string") return null;
  const done = status.state !== "pending";
  const conclusion = status.state === "success" ? "success" : status.state === "failure" || status.state === "error" ? "failure" : done ? "unknown" : null;
  return { id: statusId, name: text(status.context, 512), source: "status", reporter: actor(status.creator)?.login ?? null, headSha,
    status: done ? "completed" : "running", conclusion, startedAt: time(status.created_at), completedAt: done ? time(status.updated_at) : null, url: link(status.target_url) };
}

/**
 * A changed file. REST does not say why a patch is absent: with no changed lines it is a binary or
 * empty change (nothing textual to show, so covered); with changed lines it was too large.
 */
export function changedFile(value: unknown): PrFile | null {
  const file = object(value);
  const additions = count(file?.additions), deletions = count(file?.deletions), changes = count(file?.changes);
  if (!file || typeof file.filename !== "string" || file.filename.length === 0 || file.filename.includes("\u0000") || !FILE_STATUS.has(file.status as PrFileStatus)
    || additions === null || deletions === null || changes === null) return null;
  return { path: file.filename, previousPath: typeof file.previous_filename === "string" ? file.previous_filename : null, status: file.status as PrFileStatus,
    additions, deletions, patch: typeof file.patch === "string" ? { kind: "text", patch: file.patch } : { kind: "omitted", reason: changes === 0 ? "binary" : "too-large" } };
}

/** Whether a `Link` header names a next page. */
export function hasNext(header: string | undefined): boolean {
  return typeof header === "string" && /<[^>]+>;\s*rel="next"/.test(header);
}

/** Provider deployment + its latest status; a comment URL never enters this mapping. */
export function deployment(value: unknown, latest: unknown): Extract<PrActivity, { kind: "deployment" }> | null {
  const record = object(value), status = object(latest);
  const deploymentId = id(record?.id), commit = sha(record?.sha), at = time(record?.created_at);
  if (!record || !deploymentId || !commit || !at || typeof record.environment !== "string") return null;
  const state = status?.state;
  return { kind: "deployment", id: `deployment-${deploymentId}`, at, environment: text(record.environment, 255), commit,
    status: state === "success" ? "success" : state === "failure" || state === "error" ? "failure" : state === "inactive" ? "inactive" : state === "pending" || state === "queued" || state === "in_progress" ? "pending" : "unknown",
    url: link(status?.environment_url),
  };
}
