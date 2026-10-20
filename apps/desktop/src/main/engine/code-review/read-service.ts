import {
  parsePrLocator, sameRevision, scopeOf, validateRequest,
  type CodeReviewAccount, type CodeReviewConnection, type CodeReviewReply, type CodeReviewRequest, type Coverage, type Inbox, type InboxGroup,
  type PrActivity, type PrCheck, type PrContext, type PrFiles, type PrKey, type PrOverview, type PrRevision, type PrSummary, type ReadResult, type ResolvedPr, type Unavailable,
} from "../../../shared/code-review.js";
import { ghHostsStamp, ghTransport, type GhAnswer, type GhCall, type GhTransport } from "./gh.js";
import { changedFile, checkRun, commitStatus, hasNext, json, pull, repository, searchRow, timeline, type Pull, type Repository } from "./github.js";

/**
 * Main's Code Review reads (#321): narrow GETs through the person's `gh` login, each bound to the
 * account gh is signed in to, the repository's stable id, the PR number and, where it matters, the
 * revision. Replies carry their request's scope; a reply read under an account gh has since left is
 * refused here, before the renderer could show it. Nothing is written, checked out or sent to a model.
 */
export interface CodeReviewOptions {
  /** Off in demos, E2E and browser development, like the sidebar's PR status. */
  enabled?: boolean;
  transport?: GhTransport;
  now?: () => number;
  /** How long a checked identity is trusted before gh is asked again (a 304 when nothing changed). */
  identityTtlMs?: number;
  /** gh processes at once. */
  concurrency?: number;
  /** A fingerprint of gh's login state that changes when the account may have; null where none can be read. */
  identityStamp?: () => string | null;
}

type Read = Exclude<CodeReviewRequest, { op: "cancel" }>;
type Accept = GhCall["accept"];

const JSON_TYPE: Accept = "application/vnd.github+json";
const RAW: Accept = "application/vnd.github.raw";
const KB = 1024, MB = 1024 * KB;
const TIMEOUT_MS = 15_000, LONG_TIMEOUT_MS = 30_000;
const INBOX_PAGE = 30, PAGE = 100;
/** GitHub's own limits: search serves 1,000 results, the files list 3,000 files. */
const SEARCH_CAP = 1000, FILES_CAP = 3000;
const TIMELINE_PAGES = 100, CHECK_PAGES = 10;
/** Search allows 30 requests a minute; main keeps under it rather than spend the person's budget. */
const SEARCH_PER_MINUTE = 30;
const ETAG = /^(?:W\/)?"[\x21\x23-\x7e]{1,200}"$/;

/** Shown as is. None quotes GitHub or gh: their text can name accounts, organizations or tokens. */
const DETAIL = {
  disabled: "GitHub reads are disabled in demos, tests and browser development.",
  noCli: "GitHub CLI (gh) was not found.",
  signedOut: "Not signed in to GitHub CLI.",
  otherAccount: "GitHub CLI is now signed in to another account.",
  offline: "GitHub is unreachable. Check the network connection.",
  timeout: "GitHub took too long to answer.",
  rateLimited: "GitHub's rate limit was reached. Modex reads again after it resets.",
  denied: "This account can't see that repository.",
  sso: "This organization requires single sign-on. Authorize GitHub CLI for it on GitHub, then retry.",
  notFound: "GitHub has no such pull request, or this account can't see it.",
  unknownKey: "Open this pull request from the inbox or its link again.",
  badLink: "That isn't a github.com pull request link.",
  invalid: "Modex can't read that.",
  page: "That page is past what GitHub serves.",
  unknownRevision: "That revision isn't one this pull request has had.",
  headChanged: "The pull request has a newer head. Read it again to see the current changes.",
  signInChanged: "GitHub CLI's sign-in changed while this was read. Read it again.",
  tooLarge: "The answer is too large to show.",
  binary: "This file isn't text.",
  notFile: "That path isn't a file at this revision.",
  cancelled: "Cancelled.",
  failed: "GitHub's answer could not be read.",
  stack: "Stack reads arrive with #323.",
} as const;

class ReadFailure extends Error {
  constructor(readonly reason: Unavailable, readonly detail: string, readonly retryAfter?: string, readonly cancelled = false) {
    super(reason);
  }
}

/** The PR's base repository id is not the key's: the name now belongs to another repository. */
class Moved extends ReadFailure {}

/** Reads that may fall back to their last good answer, labelled stale. Visibility changes never do. */
const KEEPS = new Set<Unavailable>(["offline", "timeout", "rate-limited", "head-changed", "failed"]);
/** Failures to check the account that say nothing about who is signed in. */
const TRANSIENT = new Set<Unavailable>(["offline", "timeout", "rate-limited", "failed"]);

class Lru<K, V> {
  private readonly map = new Map<K, V>();
  private used = 0;
  constructor(private readonly max: number, private readonly budget = Infinity, private readonly size: (value: V) => number = () => 0) {}
  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value !== undefined) { this.map.delete(key); this.map.set(key, value); }
    return value;
  }
  set(key: K, value: V): void {
    const old = this.map.get(key);
    if (old !== undefined) { this.map.delete(key); this.used -= this.size(old); }
    if (this.size(value) > this.budget) return;
    this.map.set(key, value);
    this.used += this.size(value);
    while (this.map.size > this.max || this.used > this.budget) {
      const [oldest, evicted] = this.map.entries().next().value!;
      this.map.delete(oldest);
      this.used -= this.size(evicted);
    }
  }
  delete(key: K): void {
    const old = this.map.get(key);
    if (old === undefined) return;
    this.map.delete(key);
    this.used -= this.size(old);
  }
  clear(): void {
    this.map.clear();
    this.used = 0;
  }
}

/** At most `max` gh processes; a released slot passes straight to the next waiter. */
class Slots {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  constructor(private readonly max: number) {}
  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active < this.max) this.active++;
    else await new Promise<void>((resolve) => this.waiting.push(resolve));
    try {
      return await work();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}

/** `stamp`: gh's login state the account was confirmed under when the read began. */
interface Context { account: string; generation: number; stamp: string | null; signal: AbortSignal }
interface Fetched { body: Buffer; headers: Record<string, string> }

const enc = encodeURIComponent;
const repoPath = (repo: { owner: string; name: string }) => `repos/${enc(repo.owner)}/${enc(repo.name)}`;
const prId = (repoId: string, number: number) => `${repoId}#${number}`;

export class CodeReviewService {
  private readonly enabled: boolean;
  private readonly transport: GhTransport;
  private readonly now: () => number;
  private readonly ttl: number;
  private readonly slots: Slots;
  private readonly stamp: () => string | null;
  /** `stamp` is gh's login state when the account was read: a different one means it may have changed since. */
  private identity: { account: CodeReviewAccount; checkedAt: number; etag: string | null; stamp: string | null } | null = null;
  private identityRead: Promise<void> | null = null;
  private lastStamp: string | null = null;
  /** Bumped whenever the account changes or goes away; everything read under an older one is dropped. */
  private generation = 0;
  /** Each read in flight, with the generation it reads under once it has one. */
  private readonly inflight = new Map<string, { controller: AbortController; generation: number | null }>();
  private readonly blocked = new Map<"core" | "search", number>();
  private searches: number[] = [];
  private readonly cache = new Lru<string, Fetched & { etag: string }>(512, 32 * MB, (entry) => entry.body.length + 256);
  private readonly repos = new Lru<string, Repository>(2048);
  private readonly names = new Lru<string, string>(2048);
  private readonly hints = new Lru<string, boolean>(4096);
  private readonly revisions = new Lru<string, PrRevision[]>(1024);
  private readonly kept = new Lru<string, { value: unknown; fetchedAt: string; coverage?: Coverage }>(256, 32 * MB, (entry) => size(entry.value));

  constructor(options: CodeReviewOptions = {}) {
    this.enabled = options.enabled ?? true;
    this.transport = options.transport ?? ghTransport();
    this.now = options.now ?? Date.now;
    this.ttl = options.identityTtlMs ?? 30_000;
    this.slots = new Slots(options.concurrency ?? 4);
    this.stamp = options.identityStamp ?? ghHostsStamp;
  }

  /** The `code-review:read` handler. A payload that fails `validateRequest` rejects before anything runs. */
  async read(input: unknown): Promise<CodeReviewReply | null> {
    const request = validateRequest(input);
    if (!request) throw new Error("Invalid Code Review request.");
    if (request.op === "cancel") {
      this.inflight.get(request.requestId)?.controller.abort();
      return null;
    }
    // A second request under a live id has no reply of its own to give: the renderer reuses no id.
    if (this.inflight.has(request.requestId)) throw new Error("A Code Review request with that id is already in flight.");
    const entry = { controller: new AbortController(), generation: null as number | null };
    this.inflight.set(request.requestId, entry);
    try {
      return await this.answer(request, entry);
    } finally {
      if (this.inflight.get(request.requestId) === entry) this.inflight.delete(request.requestId);
    }
  }

  private async answer(request: Read, entry: { controller: AbortController; generation: number | null }): Promise<CodeReviewReply> {
    if (request.op === "connection") {
      const connection = await this.connection();
      return this.reply(request, connection.state === "connected" ? connection.account.id : null, { state: "ready", value: connection, fetchedAt: this.at() });
    }
    let account: CodeReviewAccount;
    try {
      account = await this.who(false);
    } catch (error) {
      const failure = this.failure(error);
      // Offline, slow or limited while checking the account: the last known one still names what may be shown
      // as stale, unless gh's login is seen to have changed since it was confirmed.
      const known = this.identity?.account;
      if (known && TRANSIENT.has(failure.reason) && this.enabled && this.stamp() === this.identity!.stamp) {
        if ("key" in request && request.key.account !== known.id) return this.reply(request, known.id, this.unavailable(new ReadFailure("signed-out", DETAIL.otherAccount)));
        return this.reply(request, known.id, this.fallback(request, known.id, failure));
      }
      return this.reply(request, null, this.unavailable(failure));
    }
    if ("key" in request && request.key.account !== account.id) return this.reply(request, account.id, this.unavailable(new ReadFailure("signed-out", DETAIL.otherAccount)));
    const context: Context = { account: account.id, generation: this.generation, stamp: this.identity!.stamp, signal: entry.controller.signal };
    entry.generation = context.generation;
    try {
      const result = await this.run(context, request);
      // Made as the account it is stamped with? gh can switch under a read that is already running.
      const doubt = await this.confirm(context);
      if (doubt) return this.reply(request, account.id, this.unavailable(doubt));
      this.keep(request, result);
      return this.reply(request, account.id, result);
    } catch (error) {
      if (context.generation !== this.generation) return this.reply(request, account.id, this.unavailable(this.gone()));
      const result = this.fallback(request, account.id, this.failure(error));
      if (result.state === "stale") {
        const doubt = await this.confirm(context);
        if (doubt) return this.reply(request, account.id, this.unavailable(doubt));
      }
      return this.reply(request, account.id, result);
    }
  }

  private gone(): ReadFailure {
    return new ReadFailure("signed-out", this.identity ? DETAIL.otherAccount : DETAIL.signedOut);
  }

  /** Kept only once confirmed: the last good answer of a read, and an inbox's groups, for `stale` later. */
  private keep(request: Exclude<Read, { op: "connection" }>, result: ReadResult<unknown>): void {
    const store = (key: string, value: ReadResult<unknown>) => {
      if (value.state === "ready" || value.state === "partial") this.kept.set(key, { value: value.value, fetchedAt: value.fetchedAt, ...(value.coverage ? { coverage: value.coverage } : {}) });
    };
    if (request.op !== "inbox") return store(keptKey(request), result);
    if (result.state !== "ready") return;
    for (const [group, value] of Object.entries((result.value as Inbox).groups)) {
      store(keptKey({ op: "inbox-page", requestId: "", group: group as InboxGroup, query: request.query, cursor: "p1" }), value);
    }
  }

  /** The last good answer for this read, labelled stale, when the failure allows one; otherwise unavailable. */
  private fallback(request: Exclude<Read, { op: "connection" }>, account: string, failure: ReadFailure): ReadResult<unknown> {
    if (request.op === "inbox") {
      const groups = Object.fromEntries((["authored", "review-requested"] as const).map((group) =>
        [group, this.keptResult(keptKey({ op: "inbox-page", requestId: "", group, query: request.query, cursor: "p1" }), failure)]));
      return { state: "ready", fetchedAt: this.at(), value: { account, query: request.query, groups } };
    }
    return this.keptResult(keptKey(request), failure);
  }

  private keptResult(key: string, failure: ReadFailure): ReadResult<unknown> {
    const kept = KEEPS.has(failure.reason) && !failure.cancelled ? this.kept.get(key) : undefined;
    return kept ? { state: "stale", value: kept.value, fetchedAt: kept.fetchedAt, reason: failure.reason, ...(kept.coverage ? { coverage: kept.coverage } : {}) }
      : this.unavailable(failure);
  }

  /**
   * Null when the read was made as the account it is stamped with; otherwise why its answer can't be given.
   *
   * - gh's hosts file unchanged since the read began: confirmed, for free.
   * - It changed during the read: part of the read may have run as another account, even if gh is back on
   *   this one now. The answer is refused (and the account checked again for the next read).
   * - No hosts file to watch: main asks gh, which answers an unchanged account with a free 304. A check
   *   that fails proves nothing, so it fails the read. A switch away and back within one read can't be
   *   seen this way.
   */
  private async confirm(context: Context): Promise<ReadFailure | null> {
    if (context.generation !== this.generation) return this.gone();
    const stamp = this.stamp();
    if (stamp !== null && stamp === context.stamp) return null;
    if (stamp !== null && context.stamp !== null) {
      await this.who(true).catch(() => undefined);
      return context.generation !== this.generation ? this.gone() : new ReadFailure("failed", DETAIL.signInChanged);
    }
    try {
      await this.who(true);
    } catch (error) {
      return context.generation !== this.generation ? this.gone() : this.failure(error);
    }
    return context.generation === this.generation && this.identity?.account.id === context.account ? null : this.gone();
  }

  private run(context: Context, request: Exclude<Read, { op: "connection" }>): Promise<ReadResult<unknown>> {
    switch (request.op) {
      case "inbox": return this.inbox(context, request.query);
      case "inbox-page": return this.group(context, request.group, request.query, page(request.cursor, Math.ceil(SEARCH_CAP / INBOX_PAGE)));
      case "resolve": return this.resolve(context, request.input);
      case "overview": return this.overview(context, request.key);
      case "activity": return this.activity(context, request.key, request.cursor);
      case "checks": return this.checks(context, request.key, request.revision);
      case "stack": throw new ReadFailure("failed", DETAIL.stack);
      case "files": return this.files(context, request.key, request.revision, request.cursor);
      case "context": return this.context(context, request);
    }
  }

  private reply(request: Read, account: string | null, result: ReadResult<unknown>): CodeReviewReply {
    return { requestId: request.requestId, op: request.op, scope: scopeOf(request, account), result } as CodeReviewReply;
  }

  private at(): string {
    return new Date(this.now()).toISOString();
  }

  private unavailable(failure: ReadFailure): ReadResult<never> {
    return { state: "unavailable", reason: failure.reason, fetchedAt: this.at(), detail: failure.detail, ...(failure.retryAfter ? { retryAfter: failure.retryAfter } : {}) };
  }

  /** Anything that is not one of this file's failures reads as `failed`: an exception's text never reaches the renderer. */
  private failure(error: unknown): ReadFailure {
    return error instanceof ReadFailure ? error : new ReadFailure("failed", DETAIL.failed);
  }

  // --- Identity -------------------------------------------------------------------------------

  private async connection(): Promise<CodeReviewConnection> {
    try {
      return { state: "connected", account: await this.who(true) };
    } catch (error) {
      const failure = this.failure(error);
      return failure.reason === "no-cli" ? { state: "no-cli", detail: failure.detail }
        : failure.reason === "signed-out" ? { state: "signed-out", detail: failure.detail }
        : { state: "unavailable", detail: failure.detail };
    }
  }

  /**
   * The account gh is signed in to. A checked one is trusted until the TTL runs out or gh's login state
   * changes; a forced check never joins one that started before it.
   */
  private async who(force: boolean): Promise<CodeReviewAccount> {
    if (!this.enabled) throw new ReadFailure("failed", DETAIL.disabled);
    const stamp = this.stamp();
    if (!force && this.identity && this.now() - this.identity.checkedAt < this.ttl && (stamp === null || stamp === this.identity.stamp)) return this.identity.account;
    if (force && this.identityRead) await this.identityRead.catch(() => undefined);
    this.identityRead ??= this.readIdentity(stamp).finally(() => { this.identityRead = null; });
    await this.identityRead;
    if (!this.identity) throw new ReadFailure("signed-out", DETAIL.signedOut);
    return this.identity.account;
  }

  /** Shared by every read waiting on it, so one person's cancel never aborts another's check. */
  private async readIdentity(stamp: string | null): Promise<void> {
    // A changed login may be another account: limits GitHub set for the last one are not this one's.
    if (stamp !== this.lastStamp) {
      this.blocked.clear();
      this.searches = [];
      this.lastStamp = stamp;
    }
    this.admit("core");
    const known = this.identity;
    const answer = await this.slots.run(() => this.transport({ endpoint: "user", accept: JSON_TYPE, etag: known?.etag ?? null, maxBytes: 256 * KB,
      timeoutMs: TIMEOUT_MS, signal: new AbortController().signal }));
    if (answer.kind !== "http") {
      if (answer.kind === "no-cli" || answer.kind === "signed-out") this.forget();
      throw this.transportFailure(answer.kind);
    }
    this.observe("core", answer);
    if (answer.status === 304 && known && this.identity === known) {
      known.checkedAt = this.now();
      known.stamp = stamp;
      return;
    }
    if (answer.status === 200) {
      const user = json(answer.body) as { id?: unknown; login?: unknown } | undefined;
      const id = typeof user?.id === "number" && Number.isSafeInteger(user.id) && user.id > 0 ? String(user.id) : null;
      const login = typeof user?.login === "string" && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(user.login) ? user.login : null;
      if (!id || !login) throw new ReadFailure("failed", DETAIL.failed);
      if (this.identity?.account.id !== id) this.switchAccount();
      const etag = answer.headers.etag;
      this.identity = { account: { host: "github.com", id, login }, checkedAt: this.now(), etag: etag && ETAG.test(etag) ? etag : null, stamp };
      return;
    }
    if (answer.status === 401) this.forget();
    throw this.httpFailure(answer, "core");
  }

  private forget(): void {
    if (this.identity === null) return;
    this.identity = null;
    this.switchAccount();
  }

  /**
   * A different account, or none: what the old one could see is no longer anyone's to show. Reads
   * already running under it stop; one still waiting to learn the account goes on under the new one.
   */
  private switchAccount(): void {
    this.generation++;
    for (const entry of this.inflight.values()) if (entry.generation !== null) entry.controller.abort();
    for (const store of [this.cache, this.repos, this.names, this.hints, this.revisions, this.kept]) store.clear();
    this.blocked.clear();
    this.searches = [];
  }

  // --- Transport ------------------------------------------------------------------------------

  private admit(resource: "core" | "search"): void {
    const now = this.now();
    const until = this.blocked.get(resource) ?? 0;
    if (until > now) throw new ReadFailure("rate-limited", DETAIL.rateLimited, new Date(until).toISOString());
    if (resource === "search") {
      this.searches = this.searches.filter((at) => now - at < 60_000);
      if (this.searches.length >= SEARCH_PER_MINUTE) throw new ReadFailure("rate-limited", DETAIL.rateLimited, new Date(this.searches[0]! + 60_000).toISOString());
      this.searches.push(now);
    }
  }

  /** A budget GitHub says is spent blocks that resource until it resets, so nothing more is spent on refusals. */
  private observe(resource: "core" | "search", answer: Extract<GhAnswer, { kind: "http" }>): void {
    const wait = Number(answer.headers["retry-after"]);
    if ((answer.status === 403 || answer.status === 429) && Number.isFinite(wait) && wait > 0) {
      this.blocked.set(resource, this.now() + Math.min(wait, 3600) * 1000);
    } else if (answer.headers["x-ratelimit-remaining"] === "0") {
      const reset = Number(answer.headers["x-ratelimit-reset"]) * 1000;
      if (Number.isFinite(reset) && reset > this.now()) this.blocked.set(resource, Math.min(reset, this.now() + 3600_000));
    } else if (answer.status === 429) {
      // Too many requests, with no word on how long to wait: GitHub's guidance is at least a minute.
      this.blocked.set(resource, this.now() + 60_000);
    }
  }

  private async get(context: Context, endpoint: string, options: { accept?: Accept; maxBytes?: number; timeoutMs?: number } = {}): Promise<Fetched> {
    const accept = options.accept ?? JSON_TYPE;
    const resource = endpoint.startsWith("search/") ? "search" : "core";
    this.admit(resource);
    const key = `${accept}\u0000${endpoint}`;
    const cached = this.cache.get(key);
    // A read cancelled while it waited for a slot never starts gh.
    const answer = await this.slots.run(() => context.signal.aborted ? Promise.resolve<GhAnswer>({ kind: "cancelled" })
      : this.transport({ endpoint, accept, etag: cached?.etag ?? null, maxBytes: options.maxBytes ?? MB, timeoutMs: options.timeoutMs ?? TIMEOUT_MS, signal: context.signal }));
    if (answer.kind !== "http") {
      if ((answer.kind === "no-cli" || answer.kind === "signed-out") && context.generation === this.generation) this.forget();
      throw this.transportFailure(answer.kind);
    }
    this.observe(resource, answer);
    if (answer.status === 304 && cached) return cached;
    if (answer.status >= 200 && answer.status < 300) {
      const etag = answer.headers.etag;
      if (etag && ETAG.test(etag) && context.generation === this.generation) this.cache.set(key, { etag, body: answer.body, headers: answer.headers });
      return { body: answer.body, headers: answer.headers };
    }
    if (answer.status === 401 && context.generation === this.generation) this.forget();
    throw this.httpFailure(answer, resource);
  }

  private transportFailure(kind: Exclude<GhAnswer["kind"], "http">): ReadFailure {
    switch (kind) {
      case "no-cli": return new ReadFailure("no-cli", DETAIL.noCli);
      case "signed-out": return new ReadFailure("signed-out", DETAIL.signedOut);
      case "offline": return new ReadFailure("offline", DETAIL.offline);
      case "timeout": return new ReadFailure("timeout", DETAIL.timeout);
      case "cancelled": return new ReadFailure("failed", DETAIL.cancelled, undefined, true);
      case "too-large": return new ReadFailure("failed", DETAIL.tooLarge);
      case "failed": return new ReadFailure("failed", DETAIL.failed);
    }
  }

  private httpFailure(answer: Extract<GhAnswer, { kind: "http" }>, resource: "core" | "search"): ReadFailure {
    const until = this.blocked.get(resource) ?? 0;
    const limited = until > this.now();
    if (answer.status === 401) return new ReadFailure("signed-out", DETAIL.signedOut);
    if (answer.status === 429 || (answer.status === 403 && limited)) return new ReadFailure("rate-limited", DETAIL.rateLimited, new Date(Math.max(until, this.now() + 60_000)).toISOString());
    if (answer.status === 403) {
      if (answer.headers["x-github-sso"]) return new ReadFailure("denied", DETAIL.sso);
      // A secondary limit without a Retry-After: GitHub asks for at least a minute's pause.
      const message = (json(answer.body) as { message?: unknown } | undefined)?.message;
      if (typeof message === "string" && /rate limit/i.test(message)) {
        this.blocked.set(resource, this.now() + 60_000);
        return new ReadFailure("rate-limited", DETAIL.rateLimited, new Date(this.now() + 60_000).toISOString());
      }
      return new ReadFailure("denied", DETAIL.denied);
    }
    if (answer.status === 404 || answer.status === 410) return new ReadFailure("not-found", DETAIL.notFound);
    if (answer.status === 422) return new ReadFailure("invalid", DETAIL.invalid);
    return new ReadFailure("failed", DETAIL.failed);
  }

  // --- Repositories and PRs --------------------------------------------------------------------

  private remember(context: Context, repo: Repository): void {
    if (context.generation !== this.generation) return;
    this.repos.set(repo.id, repo);
    this.names.set(`${repo.owner}/${repo.name}`.toLowerCase(), repo.id);
  }

  private async repoByName(context: Context, owner: string, name: string): Promise<Repository> {
    const known = this.names.get(`${owner}/${name}`.toLowerCase());
    const repo = known ? this.repos.get(known) : undefined;
    if (repo) return repo;
    const found = repository(json((await this.get(context, `repos/${enc(owner)}/${enc(name)}`)).body));
    if (!found) throw new ReadFailure("failed", DETAIL.failed);
    this.remember(context, found);
    return found;
  }

  /** Main maps a stable id to a name only from its own reads (#320): it never takes a name from the renderer. */
  private repoFor(key: PrKey): Repository {
    const repo = this.repos.get(key.repoId);
    if (!repo) throw new ReadFailure("not-found", DETAIL.unknownKey);
    return repo;
  }

  private async pull(context: Context, repoId: string, number: number): Promise<Pull> {
    const repo = this.repoFor({ account: context.account, host: "github.com", repoId, number });
    const found = pull(json((await this.get(context, `${repoPath(repo)}/pulls/${number}`, { maxBytes: 4 * MB })).body));
    if (!found) throw new ReadFailure("failed", DETAIL.failed);
    // The name may now belong to another repository (deleted and recreated, or transferred): not this key,
    // and the name no longer leads to the id main had for it.
    if (found.base.id !== repoId || found.number !== number) {
      if (context.generation === this.generation) {
        this.names.delete(`${repo.owner}/${repo.name}`.toLowerCase());
        this.repos.delete(repoId);
      }
      throw new Moved("not-found", DETAIL.notFound);
    }
    if (context.generation === this.generation) {
      this.remember(context, found.base);
      if (found.base.defaultBranch !== null) this.hints.set(prId(repoId, number), found.revision.baseRef !== found.base.defaultBranch);
      const seen = (this.revisions.get(prId(repoId, number)) ?? []).filter((r) => !sameRevision(r, found.revision));
      this.revisions.set(prId(repoId, number), [...seen, found.revision].slice(-16));
    }
    return found;
  }

  private async resolve(context: Context, input: string): Promise<ReadResult<ResolvedPr>> {
    const locator = parsePrLocator(input);
    if (!locator) throw new ReadFailure("invalid", DETAIL.badLink);
    let repo = await this.repoByName(context, locator.owner, locator.repo);
    try {
      await this.pull(context, repo.id, locator.number);
    } catch (error) {
      if (!(error instanceof Moved)) throw error;
      // The name main knew now leads elsewhere: read it again for the repository it names today.
      repo = await this.repoByName(context, locator.owner, locator.repo);
      await this.pull(context, repo.id, locator.number);
    }
    const current = this.repos.get(repo.id) ?? repo;
    return { state: "ready", fetchedAt: this.at(), value: {
      locator: { host: "github.com", owner: current.owner, repo: current.name, number: locator.number },
      key: { account: context.account, host: "github.com", repoId: repo.id, number: locator.number },
    } };
  }

  private async overview(context: Context, key: PrKey): Promise<ReadResult<PrOverview>> {
    const pr = await this.pull(context, key.repoId, key.number);
    return { state: "ready", fetchedAt: this.at(), value: {
      key, locator: { host: "github.com", owner: pr.base.owner, repo: pr.base.name, number: key.number }, revision: pr.revision,
      title: pr.title, body: pr.body, state: pr.state, author: pr.author, createdAt: pr.createdAt, updatedAt: pr.updatedAt, headRef: pr.headRef,
      headRepo: pr.headRepo && pr.headRepo.id !== pr.base.id ? `${pr.headRepo.owner}/${pr.headRepo.name}` : null,
      totals: pr.totals, reviewers: pr.reviewers, comments: pr.comments,
    } };
  }

  // --- Inbox ----------------------------------------------------------------------------------

  /** Each group is its own search and its own result: one failing leaves the other usable. */
  private async inbox(context: Context, query: string): Promise<ReadResult<Inbox>> {
    const groups = await Promise.all((["authored", "review-requested"] as const).map(async (group) => {
      const request = { op: "inbox-page" as const, requestId: "", group, query, cursor: "p1" };
      try {
        return await this.group(context, group, query, 1);
      } catch (error) {
        const failure = this.failure(error);
        const kept = KEEPS.has(failure.reason) && !failure.cancelled ? this.kept.get(keptKey(request)) : undefined;
        return kept ? { state: "stale", value: kept.value as PrSummary[], fetchedAt: kept.fetchedAt, reason: failure.reason, ...(kept.coverage ? { coverage: kept.coverage } : {}) } as ReadResult<PrSummary[]>
          : this.unavailable(failure);
      }
    }));
    return { state: "ready", fetchedAt: this.at(), value: { account: context.account, query, groups: { authored: groups[0]!, "review-requested": groups[1]! } } };
  }

  private async group(context: Context, group: InboxGroup, query: string, number: number): Promise<Exclude<ReadResult<PrSummary[]>, { state: "unavailable" | "stale" }>> {
    const q = ["is:pr", "is:open", "archived:false", group === "authored" ? "author:@me" : "review-requested:@me", query.trim()].filter(Boolean).join(" ");
    const params = new URLSearchParams({ q, sort: "updated", order: "desc", per_page: String(INBOX_PAGE), page: String(number) });
    const answer = json((await this.get(context, `search/issues?${params}`, { maxBytes: 4 * MB })).body) as { total_count?: unknown; incomplete_results?: unknown; items?: unknown } | undefined;
    const total = typeof answer?.total_count === "number" && Number.isSafeInteger(answer.total_count) && answer.total_count >= 0 ? answer.total_count : null;
    if (total === null || !Array.isArray(answer!.items)) throw new ReadFailure("failed", DETAIL.failed);
    const rows = answer!.items.map(searchRow);
    // Search names a repository only by URL; its stable id comes from main's own read of it. Every lookup
    // settles before any failure is raised, so none is left rejecting with no one listening.
    const names = [...new Set(rows.flatMap((row) => row ? [`${row.repository.owner}/${row.repository.name}`] : []))];
    const settled = await Promise.allSettled(names.map((name) => this.repoByName(context, name.split("/")[0]!, name.split("/")[1]!)));
    const repos = new Map<string, Repository | null>();
    settled.forEach((result, i) => {
      if (result.status === "fulfilled") repos.set(names[i]!.toLowerCase(), result.value);
      else if (["not-found", "denied"].includes(this.failure(result.reason).reason)) repos.set(names[i]!.toLowerCase(), null);
    });
    const failed = settled.find((result, i) => result.status === "rejected" && !repos.has(names[i]!.toLowerCase()));
    if (failed) throw (failed as PromiseRejectedResult).reason;
    const summaries: PrSummary[] = [];
    let malformed = 0, hidden = 0;
    for (const row of rows) {
      if (!row) { malformed++; continue; }
      const repo = repos.get(`${row.repository.owner}/${row.repository.name}`.toLowerCase());
      if (!repo) { hidden++; continue; }
      const key: PrKey = { account: context.account, host: "github.com", repoId: repo.id, number: row.number };
      summaries.push({ key, locator: { host: "github.com", owner: repo.owner, repo: repo.name, number: row.number }, title: row.title, state: row.state,
        author: row.author, updatedAt: row.updatedAt, stackHint: this.hints.get(prId(repo.id, row.number)) ?? null });
    }
    const reachable = Math.min(total, SEARCH_CAP);
    const loaded = (number - 1) * INBOX_PAGE + answer!.items.length;
    const next = loaded < reachable && answer!.items.length === INBOX_PAGE && number < Math.ceil(SEARCH_CAP / INBOX_PAGE) ? `p${number + 1}` : null;
    const capped = total > SEARCH_CAP;
    const incomplete = answer!.incomplete_results === true;
    // Search pages are offsets: a row updated between pages can shift to another, so only a single page
    // can prove the whole list arrived. The renderer dedupes later pages by key and compares with `total`.
    const coverage: Coverage = { loaded, total, complete: number === 1 && next === null && !capped && !incomplete && malformed + hidden === 0, next,
      ...(capped ? { cap: SEARCH_CAP } : {}) };
    const fetchedAt = this.at();
    // `incomplete_results` means GitHub's search timed out on its side and served what it had.
    if (incomplete) return { state: "partial", value: summaries, fetchedAt, reason: "timeout", coverage };
    if (malformed) return { state: "partial", value: summaries, fetchedAt, reason: "failed", coverage };
    if (hidden) return { state: "partial", value: summaries, fetchedAt, reason: "denied", coverage };
    if (capped && next === null) return { state: "partial", value: summaries, fetchedAt, reason: "capped", coverage };
    return { state: "ready", value: summaries, fetchedAt, coverage };
  }

  // --- Activity, checks, files, context ------------------------------------------------------

  private async activity(context: Context, key: PrKey, cursor: string | null): Promise<ReadResult<PrActivity[]>> {
    const number = page(cursor, TIMELINE_PAGES);
    const pr = number === 1 ? await this.pull(context, key.repoId, key.number) : null;
    const fetched = await this.get(context, `${repoPath(this.repoFor(key))}/issues/${key.number}/timeline?per_page=${PAGE}&page=${number}`, { maxBytes: 8 * MB });
    const items = json(fetched.body);
    if (!Array.isArray(items)) throw new ReadFailure("failed", DETAIL.failed);
    const { activity, dropped } = timeline(items);
    if (pr) activity.unshift({ kind: "opened", id: `pr-${pr.id}`, at: pr.createdAt, actor: pr.author });
    const more = hasNext(fetched.headers.link);
    const next = more && number < TIMELINE_PAGES ? `p${number + 1}` : null;
    // `loaded` counts the provider's items, so pages line up: the opening is main's, a pending review is skipped.
    const coverage: Coverage = { loaded: (number - 1) * PAGE + items.length, total: null, complete: !more && dropped === 0, next, ...(more && !next ? { cap: TIMELINE_PAGES * PAGE } : {}) };
    const fetchedAt = this.at();
    if (dropped) return { state: "partial", value: activity, fetchedAt, reason: "failed", coverage };
    if (more && !next) return { state: "partial", value: activity, fetchedAt, reason: "capped", coverage };
    return { state: "ready", value: activity, fetchedAt, coverage };
  }

  /** Every page of a check list, up to CHECK_PAGES. `limited`: main stopped at its own page limit, not at GitHub's last page. */
  private async pages<T>(context: Context, endpoint: string, list: string, map: (item: unknown) => T | null): Promise<{ items: T[]; total: number; complete: boolean; limited: boolean }> {
    const items: T[] = [];
    let total = 0;
    for (let number = 1; number <= CHECK_PAGES; number++) {
      const fetched = await this.get(context, `${endpoint}?per_page=${PAGE}&page=${number}`, { maxBytes: 4 * MB });
      const answer = json(fetched.body) as Record<string, unknown> | undefined;
      const values = answer?.[list];
      if (typeof answer?.total_count !== "number" || !Array.isArray(values)) throw new ReadFailure("failed", DETAIL.failed);
      total = answer.total_count;
      for (const value of values) {
        const item = map(value);
        if (item === null) throw new ReadFailure("failed", DETAIL.failed);
        items.push(item);
      }
      if (!hasNext(fetched.headers.link)) return { items, total, complete: items.length >= total, limited: false };
    }
    return { items, total, complete: false, limited: true };
  }

  /** Checks for the asked head, bracketed by reads of the PR. A head it has moved past is stale evidence, never current success. */
  private async checks(context: Context, key: PrKey, revision: PrRevision): Promise<ReadResult<PrCheck[]>> {
    const before = await this.pull(context, key.repoId, key.number);
    const base = `${repoPath(this.repoFor(key))}/commits/${revision.headSha}`;
    const runs = await this.pages(context, `${base}/check-runs`, "check_runs", checkRun);
    const statuses = await this.pages(context, `${base}/status`, "statuses", (value) => commitStatus(value, revision.headSha));
    const value = [...runs.items.filter((run) => run.headSha === revision.headSha), ...statuses.items];
    const after = await this.pull(context, key.repoId, key.number);
    const coverage: Coverage = { loaded: value.length, total: runs.total + statuses.total, complete: runs.complete && statuses.complete, next: null };
    const fetchedAt = this.at();
    if (before.revision.headSha !== revision.headSha || after.revision.headSha !== revision.headSha) return { state: "stale", value, fetchedAt, reason: "head-changed", coverage };
    if (runs.limited || statuses.limited) return { state: "partial", value, fetchedAt, reason: "capped", coverage: { ...coverage, cap: CHECK_PAGES * PAGE } };
    if (!coverage.complete) return { state: "partial", value, fetchedAt, reason: "failed", coverage };
    return { state: "ready", value, fetchedAt, coverage };
  }

  /** One page of files, bracketed by reads of the PR: a head that moves before or during the page labels it. */
  private async files(context: Context, key: PrKey, revision: PrRevision, cursor: string | null): Promise<ReadResult<PrFiles>> {
    const number = page(cursor, FILES_CAP / PAGE);
    const before = await this.pull(context, key.repoId, key.number);
    if (!sameRevision(before.revision, revision)) throw new ReadFailure("head-changed", DETAIL.headChanged);
    const listed = json((await this.get(context, `${repoPath(this.repoFor(key))}/pulls/${key.number}/files?per_page=${PAGE}&page=${number}`,
      { maxBytes: 24 * MB, timeoutMs: LONG_TIMEOUT_MS })).body);
    if (!Array.isArray(listed)) throw new ReadFailure("failed", DETAIL.failed);
    const files = listed.map(changedFile);
    if (files.some((file) => file === null)) throw new ReadFailure("failed", DETAIL.failed);
    const after = await this.pull(context, key.repoId, key.number);
    const total = before.totals.files;
    const loaded = (number - 1) * PAGE + files.length;
    const reachable = Math.min(total, FILES_CAP);
    const next = loaded < reachable && files.length === PAGE ? `p${number + 1}` : null;
    // A short page before the PR's own count: GitHub served fewer files than it says there are.
    const short = next === null && loaded < reachable;
    const capped = total > FILES_CAP;
    const coverage: Coverage = { loaded, total, complete: next === null && !capped && !short, next, ...(capped ? { cap: FILES_CAP } : {}) };
    const value: PrFiles = { revision, files: files as PrFiles["files"] };
    const fetchedAt = this.at();
    if (!sameRevision(after.revision, revision)) return { state: "stale", value, fetchedAt, reason: "head-changed", coverage };
    if (short) return { state: "partial", value, fetchedAt, reason: "failed", coverage };
    if (capped && next === null) return { state: "partial", value, fetchedAt, reason: "capped", coverage };
    return { state: "ready", value, fetchedAt, coverage };
  }

  /** Lines of one side, at a revision main has seen this PR have. The file is sliced here; the renderer gets only the lines. */
  private async context(context: Context, request: Extract<Read, { op: "context" }>): Promise<ReadResult<PrContext>> {
    const { key, revision, side, path, start, end } = request;
    const repo = this.repoFor(key);
    if (!(this.revisions.get(prId(key.repoId, key.number)) ?? []).some((seen) => sameRevision(seen, revision))) throw new ReadFailure("invalid", DETAIL.unknownRevision);
    const ref = side === "base" ? revision.baseSha : revision.headSha;
    const fetched = await this.get(context, `${repoPath(repo)}/contents/${path.split("/").map(enc).join("/")}?ref=${ref}`,
      { accept: RAW, maxBytes: 10 * MB, timeoutMs: LONG_TIMEOUT_MS });
    // A directory answers with a JSON listing even when the raw file was asked for.
    if (/^application\/json\b/i.test(fetched.headers["content-type"] ?? "")) throw new ReadFailure("not-found", DETAIL.notFile);
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(fetched.body);
    } catch {
      throw new ReadFailure("failed", DETAIL.binary);
    }
    if (content.includes("\u0000")) throw new ReadFailure("failed", DETAIL.binary);
    const lines = content.split("\n").map((line) => line.replace(/\r$/, ""));
    if (lines.at(-1) === "") lines.pop();
    return { state: "ready", fetchedAt: this.at(), value: { revision, side, path, start, lines: lines.slice(start - 1, end), total: lines.length } };
  }
}

/** Page numbers main issues as cursors: `p2` and up, within what the provider serves. */
function page(cursor: string | null, max: number): number {
  if (cursor === null) return 1;
  const match = /^p([1-9][0-9]{0,3})$/.exec(cursor);
  const number = match ? Number(match[1]) : 0;
  if (number < 1 || number > max) throw new ReadFailure("invalid", DETAIL.page);
  return number;
}

/** Roughly what a kept answer holds in memory: patches and lines dominate. */
function size(value: unknown): number {
  const files = (value as Partial<PrFiles> | null)?.files;
  if (Array.isArray(files)) return files.reduce((sum, file) => sum + file.path.length + (file.patch.kind === "text" ? file.patch.patch.length : 0) + 64, 0);
  const lines = (value as Partial<PrContext> | null)?.lines;
  if (Array.isArray(lines)) return lines.reduce((sum, line) => sum + line.length + 16, 0);
  if (Array.isArray(value)) return value.reduce((sum: number, item) => sum + (typeof item?.body === "string" ? item.body.length : 0) + 256, 0);
  return 4 * KB + (typeof (value as { body?: unknown } | null)?.body === "string" ? (value as { body: string }).body.length : 0);
}

/** What a read was for, without its id: the key its last good answer is kept under. */
function keptKey(request: Exclude<Read, { op: "connection" }>): string {
  const { requestId: _, ...rest } = request;
  return JSON.stringify(rest);
}
