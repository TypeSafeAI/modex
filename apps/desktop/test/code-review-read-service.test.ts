import { test } from "node:test";
import assert from "node:assert/strict";
import { ghArgs, type GhAnswer, type GhCall } from "../src/main/engine/code-review/gh.js";
import { CodeReviewService } from "../src/main/engine/code-review/read-service.js";
import { acceptsReply, diffCoverage, mergePages, scopeOf, summarizeChecks, type Inbox, type CodeReviewReply, type CodeReviewRequest, type PrKey, type PrRevision, type PrSummary, type ReadResult } from "../src/shared/code-review.js";

/**
 * CR-2 (#321): the main-owned read service over a synthetic GitHub. The world below is made up (two
 * accounts, two repositories that both have a #73); its JSON follows GitHub's REST shapes as read
 * live on 2026-10-20: search results carry `repository_url` but no `repository`, a 304 has no body,
 * and rate limits answer 403 with `x-ratelimit-remaining: 0`.
 */
const sha = (c: string) => c.repeat(40);
const ADA = { id: 1001, login: "ada-fixture", type: "User" };
const KIT = { id: 2002, login: "kit-fixture", type: "User" };
const BOT = { id: 3003, login: "preview-bot[bot]", type: "Bot" };
const LENDING = { id: 7301, full_name: "example-org/lending", name: "lending", owner: { login: "example-org" }, default_branch: "main" };
const FIELD = { id: 7302, full_name: "example-org/field-guide", name: "field-guide", owner: { login: "example-org" }, default_branch: "main" };
type Repo = typeof LENDING;

function pull(repo: Repo, number: number, patch: { title?: string; base?: string; baseSha?: string; head?: string; files?: number; user?: typeof ADA; draft?: boolean } = {}) {
  return { id: repo.id * 1000 + number, number, title: patch.title ?? `Fixture change ${number} in ${repo.name}`, body: "Synthetic **body**.", state: "open",
    draft: patch.draft ?? false, merged_at: null, user: patch.user ?? ADA, created_at: "2026-10-18T10:00:00Z", updated_at: "2026-10-19T09:00:00Z",
    base: { ref: patch.base ?? "main", sha: patch.baseSha ?? sha("b"), repo }, head: { ref: `topic-${number}`, sha: patch.head ?? sha("c"), repo },
    changed_files: patch.files ?? 3, additions: 12, deletions: 4, commits: 2, comments: 1, review_comments: 2, requested_reviewers: [KIT] };
}

class FakeGitHub {
  private signedIn: typeof ADA | null = ADA;
  private writes = 1;
  /** gh's hosts.yml as main sees it: rewritten whenever the signed-in user changes. Null: a layout main cannot watch. */
  stampless = false;
  get stamp(): string | null {
    return this.stampless ? null : `hosts-${this.writes}`;
  }
  get user(): typeof ADA | null {
    return this.signedIn;
  }
  /** `gh auth switch`, `login` or `logout`, outside Modex. */
  set user(value: typeof ADA | null) {
    this.signedIn = value;
    this.writes++;
  }
  /** A token that changes without gh's hosts file changing, e.g. `GH_TOKEN` set for gh alone. */
  silently(value: typeof ADA | null): void {
    this.signedIn = value;
  }
  cli: "ok" | "missing" | "signed-out" | "offline" = "ok";
  repos = new Map<string, Repo>([[LENDING.full_name, LENDING], [FIELD.full_name, FIELD]]);
  pulls = new Map<string, ReturnType<typeof pull>>([
    ["7301#73", pull(LENDING, 73, { title: "Lend a hold to another branch" })],
    ["7302#73", pull(FIELD, 73, { title: "Move the field notes index", user: KIT, head: sha("d") })],
    ["7301#74", pull(LENDING, 74, { base: "topic-73", baseSha: sha("c"), head: sha("e") })],
  ]);
  timeline = new Map<string, unknown[]>();
  files = new Map<string, unknown[]>();
  checkRuns = new Map<string, unknown[]>();
  statuses = new Map<string, unknown[]>();
  contents = new Map<string, string>();
  search: Record<"authored" | "review-requested", { total?: number; incomplete?: boolean; items: { repo: Repo; number: number }[] }> = {
    authored: { items: [{ repo: LENDING, number: 73 }, { repo: LENDING, number: 74 }] },
    "review-requested": { items: [{ repo: FIELD, number: 73 }] },
  };
  /** Answers to force for an endpoint, by pattern. */
  overrides: { pattern: RegExp; answer: GhAnswer | (() => GhAnswer) }[] = [];
  /** Endpoints to hold until released. */
  gates: { pattern: RegExp; open: Promise<void> }[] = [];
  calls: GhCall[] = [];
  /** Answer even an aborted call, as gh can when it finishes just as main gives up on it. */
  ignoreAbort = false;
  inFlight = 0;
  peak = 0;

  hold(pattern: RegExp): () => void {
    let release!: () => void;
    this.gates.push({ pattern, open: new Promise<void>((resolve) => { release = resolve; }) });
    return () => release();
  }

  transport = async (call: GhCall): Promise<GhAnswer> => {
    ghArgs(call); // every call is one main may make
    this.calls.push(call);
    this.inFlight++;
    this.peak = Math.max(this.peak, this.inFlight);
    try {
      for (const gate of this.gates.filter((g) => g.pattern.test(call.endpoint))) await gate.open;
      if (call.signal.aborted && !this.ignoreAbort) return { kind: "cancelled" };
      if (this.cli !== "ok") return { kind: this.cli === "missing" ? "no-cli" : this.cli };
      const forced = this.overrides.find((o) => o.pattern.test(call.endpoint));
      if (forced) return typeof forced.answer === "function" ? forced.answer() : forced.answer;
      return this.route(call);
    } finally {
      this.inFlight--;
    }
  };

  private json(call: GhCall, value: unknown, headers: Record<string, string> = {}): GhAnswer {
    const body = JSON.stringify(value);
    let hash = 2166136261;
    for (let i = 0; i < body.length; i++) hash = Math.imul(hash ^ body.charCodeAt(i), 16777619) >>> 0;
    const etag = `W/"${hash.toString(16)}"`;
    if (call.etag === etag) return { kind: "http", status: 304, headers: { "x-ratelimit-remaining": "4000" }, body: Buffer.alloc(0) };
    return { kind: "http", status: 200, headers: { "content-type": "application/json; charset=utf-8", etag, "x-ratelimit-remaining": "4000", ...headers }, body: Buffer.from(body) };
  }

  private missing(): GhAnswer {
    return { kind: "http", status: 404, headers: {}, body: Buffer.from('{"message":"Not Found ghp_fakeSecretThatMustNotEscape"}') };
  }

  private page<T>(items: T[], query: URLSearchParams, path: string): { slice: T[]; link: Record<string, string> } {
    const per = Number(query.get("per_page")), page = Number(query.get("page") ?? "1");
    const slice = items.slice((page - 1) * per, page * per);
    return { slice, link: page * per < items.length ? { link: `<https://api.github.com/${path}?page=${page + 1}>; rel="next"` } : {} };
  }

  private route(call: GhCall): GhAnswer {
    const [path, search = ""] = call.endpoint.split("?");
    const query = new URLSearchParams(search);
    if (path === "user") return this.user ? this.json(call, this.user) : { kind: "http", status: 401, headers: {}, body: Buffer.from('{"message":"Bad credentials"}') };
    if (path === "search/issues") {
      const q = query.get("q")!;
      const group = q.includes("review-requested:@me") ? "review-requested" : "authored";
      const { items, total, incomplete } = this.search[group];
      const rows = items.map(({ repo, number }) => {
        const p = this.pulls.get(`${repo.id}#${number}`)!;
        return { id: p.id, number, title: p.title, state: "open", draft: p.draft, user: p.user, updated_at: p.updated_at,
          repository_url: `https://api.github.com/repos/${repo.full_name}`, pull_request: { merged_at: null, url: "https://api.github.com/x" } };
      });
      const { slice, link } = this.page(rows, query, path);
      return this.json(call, { total_count: total ?? rows.length, incomplete_results: incomplete ?? false, items: slice }, link);
    }
    const parts = path!.split("/").map(decodeURIComponent);
    const repo = this.repos.get(`${parts[1]}/${parts[2]}`);
    if (!repo) return this.missing();
    if (parts[3] === "deployments") return this.json(call, []);
    if (parts.length === 3) return this.json(call, repo);
    if (parts[3] === "pulls" && parts.length === 4) {
      const all = [...this.pulls.values()].filter(p => p.base.repo.id === repo.id);
      const { slice, link } = this.page(all, query, path!);
      return this.json(call, slice, link);
    }
    const id = `${repo.id}#${parts[4]}`;
    if (parts[3] === "pulls" && parts.length === 5) return this.pulls.has(id) ? this.json(call, this.pulls.get(id)) : this.missing();
    if (parts[3] === "pulls" && parts[5] === "files") {
      const { slice, link } = this.page(this.files.get(id) ?? [], query, path!);
      return this.json(call, slice, link);
    }
    if (parts[3] === "issues" && parts[5] === "timeline") {
      const { slice, link } = this.page(this.timeline.get(id) ?? [], query, path!);
      return this.json(call, slice, link);
    }
    if (parts[3] === "commits" && parts[5] === "check-runs") {
      const all = this.checkRuns.get(parts[4]!) ?? [];
      const { slice, link } = this.page(all, query, path!);
      return this.json(call, { total_count: all.length, check_runs: slice }, link);
    }
    if (parts[3] === "commits" && parts[5] === "status") {
      const all = this.statuses.get(parts[4]!) ?? [];
      const { slice, link } = this.page(all, query, path!);
      return this.json(call, { state: "pending", sha: parts[4], total_count: all.length, statuses: slice }, link);
    }
    if (parts[3] === "contents") {
      const file = this.contents.get(`${repo.id}@${query.get("ref")}:${parts.slice(4).join("/")}`);
      if (file === undefined) return this.missing();
      if (file === "<dir>") return this.json(call, [{ name: "a", type: "file" }]);
      return { kind: "http", status: 200, headers: { "content-type": "application/vnd.github.raw" }, body: Buffer.from(file) };
    }
    return this.missing();
  }
}

/** Wait until the fake has seen a call, rather than for a fixed time a loaded machine may not keep. */
async function until(seen: () => boolean): Promise<void> {
  for (let i = 0; i < 2000 && !seen(); i++) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(seen(), "the read reached GitHub");
}

/** A request without its id, operation by operation (`Omit` over the union would merge them). */
type Ask = CodeReviewRequest extends infer R ? R extends CodeReviewRequest ? Omit<R, "requestId"> & { requestId?: string } : never : never;

let ids = 0;
const rid = () => `r${++ids}`;
const keyOf = (repo: Repo, number: number, account = ADA): PrKey => ({ account: String(account.id), host: "github.com", repoId: String(repo.id), number });
const revisionOf = (p: ReturnType<typeof pull>): PrRevision => ({ baseRef: p.base.ref, baseSha: p.base.sha, headSha: p.head.sha });

function setup(options: { ttl?: number; concurrency?: number; enabled?: boolean } = {}) {
  const github = new FakeGitHub();
  let clock = Date.parse("2026-10-20T12:00:00Z");
  const service = new CodeReviewService({ transport: github.transport, now: () => clock, identityTtlMs: options.ttl ?? 30_000,
    concurrency: options.concurrency ?? 4, enabled: options.enabled ?? true, identityStamp: () => github.stamp });
  const read = async (request: Ask) =>
    (await service.read({ requestId: rid(), ...request })) as CodeReviewReply;
  /** Learn the repositories the way the renderer does: through the inbox and links. */
  const prime = async () => {
    await read({ op: "connection" });
    await read({ op: "inbox", query: "" });
  };
  return { github, service, read, prime, tick: (ms: number) => { clock += ms; } };
}

function value<T>(reply: CodeReviewReply | null): T {
  assert.ok(reply, "a reply");
  assert.ok(reply.result.state === "ready" || reply.result.state === "partial" || reply.result.state === "stale", JSON.stringify(reply.result));
  return (reply.result as unknown as { value: T }).value;
}

function reason(reply: CodeReviewReply | null): string {
  assert.ok(reply && reply.result.state === "unavailable", JSON.stringify(reply?.result));
  return reply.result.reason;
}

test("connection names the gh account, and says why when there is none", async () => {
  const { github, read } = setup();
  assert.deepEqual(value(await read({ op: "connection" })), { state: "connected", account: { host: "github.com", id: "1001", login: "ada-fixture" } });
  const cases = [["missing", "no-cli"], ["signed-out", "signed-out"], ["offline", "unavailable"]] as const;
  for (const [cli, state] of cases) {
    github.cli = cli;
    const connection = value<{ state: string; detail?: string }>(await read({ op: "connection" }));
    assert.equal(connection.state, state, cli);
    assert.ok(connection.detail && !/ghp_|token/i.test(connection.detail), connection.detail);
  }
  github.cli = "ok";
  github.user = null; // a revoked token answers 401
  assert.equal(value<{ state: string }>(await read({ op: "connection" })).state, "signed-out");
});

test("demos, tests and browser development never call gh", async () => {
  const { github, read } = setup({ enabled: false });
  const connection = value<{ state: string; detail: string }>(await read({ op: "connection" }));
  assert.equal(connection.state, "unavailable");
  assert.match(connection.detail, /disabled/);
  assert.equal(reason(await read({ op: "overview", key: keyOf(LENDING, 73) })), "failed");
  assert.equal(github.calls.length, 0);
});

test("AC1: inbox, link, overview, files and checks through narrow GET reads, each keyed by account and stable repository id", async () => {
  const { github, read } = setup();
  const p73 = github.pulls.get("7301#73")!;
  github.files.set("7301#73", Array.from({ length: 3 }, (_, i) => ({ sha: sha("f"), filename: `src/loans/part-${i}.ts`, status: "modified", additions: 4, deletions: 1, changes: 5,
    patch: "@@ -1,2 +1,2 @@\n-old\n+new\n same" })));
  github.checkRuns.set(p73.head.sha, [{ id: 501, name: "unit", status: "completed", conclusion: "success", head_sha: p73.head.sha, started_at: "2026-10-19T09:01:00Z",
    completed_at: "2026-10-19T09:05:00Z", html_url: "https://github.com/example-org/lending/runs/501", app: { slug: "github-actions" } }]);
  github.statuses.set(p73.head.sha, [{ id: 601, context: "preview", state: "success", created_at: "2026-10-19T09:02:00Z", updated_at: "2026-10-19T09:03:00Z",
    target_url: "https://preview.example.invalid/73", creator: BOT }]);

  await read({ op: "connection" });
  const inbox = value<{ account: string; groups: Record<string, { state: string; value: { key: PrKey; locator: { owner: string; repo: string }; stackHint: boolean | null }[] }> }>(
    await read({ op: "inbox", query: "" }));
  assert.equal(inbox.account, "1001");
  const authored = inbox.groups.authored!, requested = inbox.groups["review-requested"]!;
  assert.equal(authored.state, "ready");
  assert.deepEqual(authored.value.map((row) => row.key), [keyOf(LENDING, 73), keyOf(LENDING, 74)]);
  assert.deepEqual(requested.value.map((row) => row.key), [keyOf(FIELD, 73)]);
  assert.deepEqual(authored.value[0]!.locator, { host: "github.com", owner: "example-org", repo: "lending", number: 73 });
  assert.equal(authored.value[0]!.stackHint, null, "search results name no base branch");

  const resolved = value<{ key: PrKey }>(await read({ op: "resolve", input: "https://github.com/Example-Org/Lending/pull/74/files#diff" }));
  assert.deepEqual(resolved, { locator: { host: "github.com", owner: "example-org", repo: "lending", number: 74 }, key: keyOf(LENDING, 74) });

  const overview = value<{ revision: PrRevision; title: string; totals: unknown; reviewers: { login: string }[]; headRepo: string | null }>(
    await read({ op: "overview", key: keyOf(LENDING, 73) }));
  assert.deepEqual(overview.revision, revisionOf(p73));
  assert.equal(overview.title, "Lend a hold to another branch");
  assert.deepEqual(overview.totals, { files: 3, additions: 12, deletions: 4, commits: 2 });
  assert.deepEqual(overview.reviewers.map((r) => r.login), ["kit-fixture"]);
  assert.equal(overview.headRepo, null);

  const files = await read({ op: "files", key: keyOf(LENDING, 73), revision: overview.revision, cursor: null });
  assert.equal(files.result.state, "ready");
  assert.deepEqual(diffCoverage(files.result as never), { files: 3, total: 3, complete: true, binary: 0, missing: 0 });

  const checks = await read({ op: "checks", key: keyOf(LENDING, 73), revision: overview.revision });
  const list = value<{ name: string; source: string; reporter: string | null; status: string; conclusion: string | null }[]>(checks);
  assert.deepEqual(list.map((c) => [c.name, c.source, c.reporter, c.status, c.conclusion]),
    [["unit", "check-run", "github-actions", "completed", "success"], ["preview", "status", "preview-bot[bot]", "completed", "success"]]);
  assert.equal(summarizeChecks(checks.result as never, overview.revision).verdict, "passing");

  // Inbox rows learned a stack hint once main read the PR itself.
  await read({ op: "overview", key: keyOf(LENDING, 74) });
  const again = value<{ groups: Record<string, { value: { stackHint: boolean | null }[] }> }>(await read({ op: "inbox", query: "" }));
  assert.deepEqual(again.groups.authored!.value.map((row) => row.stackHint), [false, true]);

  for (const call of github.calls) {
    assert.match(call.endpoint, /^(user|search\/issues\?|repos\/example-org\/(lending|field-guide)(\/|$))/);
    assert.ok(!/[{}]/.test(call.endpoint));
  }
  const searches = github.calls.filter((c) => c.endpoint.startsWith("search/")).map((c) => new URLSearchParams(c.endpoint.split("?")[1]).get("q"));
  assert.deepEqual(searches.slice(0, 2).sort(), ["is:pr is:open archived:false author:@me", "is:pr is:open archived:false review-requested:@me"]);
});

test("the search text is the person's own, encoded, and a link must name github.com", async () => {
  const { github, read } = setup();
  await read({ op: "connection" });
  await read({ op: "inbox", query: "holds & queue {owner} #2" });
  const searches = github.calls.filter((c) => c.endpoint.startsWith("search/"));
  assert.equal(new URLSearchParams(searches[0]!.endpoint.split("?")[1]).get("q"), "is:pr is:open archived:false author:@me holds & queue {owner} #2");
  for (const c of searches) {
    assert.doesNotMatch(c.endpoint, /[ {}#]/, "nothing gh could read as a placeholder");
    assert.equal(new URLSearchParams(c.endpoint.split("?")[1]).getAll("q").length, 1, "the text cannot add a parameter");
  }
  const before = github.calls.length;
  for (const input of ["https://github.example.invalid/example-org/lending/pull/73", "https://user:pw@github.com/example-org/lending/pull/73", "lending#73", "../../graphql"]) {
    assert.equal(reason(await read({ op: "resolve", input })), "invalid", input);
  }
  assert.equal(github.calls.length, before, "a malformed link costs no request");
});

test("AC2: two repositories with the same PR number never answer for each other, even out of order", async () => {
  const { github, read, prime } = setup();
  await prime();
  const releaseLending = github.hold(/^repos\/example-org\/lending\/pulls\/73$/);
  const lendingAsk = { requestId: rid(), op: "overview" as const, key: keyOf(LENDING, 73) };
  const fieldAsk = { requestId: rid(), op: "overview" as const, key: keyOf(FIELD, 73) };
  const lending = read(lendingAsk), field = read(fieldAsk);
  const fieldReply = await field; // answers first
  releaseLending();
  const lendingReply = await lending;
  assert.equal(value<{ title: string }>(fieldReply).title, "Move the field notes index");
  assert.equal(value<{ title: string }>(lendingReply).title, "Lend a hold to another branch");
  const asked = (request: typeof lendingAsk) => ({ requestId: request.requestId, op: request.op, scope: scopeOf(request, "1001") });
  assert.equal(acceptsReply(asked(fieldAsk), fieldReply), true);
  assert.equal(acceptsReply(asked(fieldAsk), lendingReply), false);
  assert.equal(acceptsReply(asked(lendingAsk), fieldReply), false);
});

test("AC2: a read that was asked under one account never answers after gh switches to another", async () => {
  const { github, read, prime, tick } = setup();
  await prime();
  const release = github.hold(/^repos\/example-org\/lending\/pulls\/73$/);
  const slow = read({ op: "overview", key: keyOf(LENDING, 73) });
  await until(() => github.calls.some((c) => c.endpoint === "repos/example-org/lending/pulls/73"));
  github.user = KIT; // `gh auth switch` outside Modex
  const connection = value<{ state: string; account: { id: string } }>(await read({ op: "connection" }));
  assert.equal(connection.account.id, "2002");
  release();
  const late = await slow;
  assert.equal(reason(late), "signed-out");
  assert.ok(!JSON.stringify(late).includes("Lend a hold"), "nothing read under the old account");

  // gh can finish just as the switch lands: a full answer under the old account is refused too.
  const releaseAgain = github.hold(/^repos\/example-org\/lending\/pulls\/73$/);
  github.user = ADA;
  await read({ op: "connection" });
  await read({ op: "inbox", query: "" }); // the switch back forgot every name; learn them again
  const slowAgain = read({ op: "overview", key: keyOf(LENDING, 73) });
  await until(() => github.calls.filter((c) => c.endpoint === "repos/example-org/lending/pulls/73").length === 2);
  github.ignoreAbort = true;
  github.user = KIT;
  await read({ op: "connection" });
  releaseAgain();
  const finished = await slowAgain;
  github.ignoreAbort = false;
  assert.equal(reason(finished), "signed-out");
  assert.ok(!JSON.stringify(finished).includes("Lend a hold"));

  // A key for the old account is refused before any request; the identity is re-checked once its TTL runs out.
  const before = github.calls.length;
  assert.equal(reason(await read({ op: "overview", key: keyOf(LENDING, 73) })), "signed-out");
  assert.equal(github.calls.length, before);
  github.user = ADA;
  tick(31_000);
  assert.equal(reason(await read({ op: "overview", key: keyOf(LENDING, 73) })), "not-found", "the switch forgot what the other account had learned");
  const userChecks = github.calls.slice(before).filter((c) => c.endpoint === "user");
  assert.equal(userChecks.length, 1);
});

test("AC3: revoked, inaccessible, rate-limited, timed-out and partial reads say so, with nothing gh printed", async () => {
  const { github, read, prime, tick } = setup();
  await prime();
  const key = keyOf(LENDING, 73);

  github.overrides = [{ pattern: /pulls\/73$/, answer: { kind: "http", status: 403, headers: { "x-github-sso": "required; url=https://github.com/orgs/example-org/sso" }, body: Buffer.from("{}") } }];
  const sso = await read({ op: "overview", key });
  assert.equal(reason(sso), "denied");
  assert.match(sso.result.state === "unavailable" ? sso.result.detail ?? "" : "", /single sign-on/);
  github.overrides = [{ pattern: /pulls\/73$/, answer: { kind: "http", status: 403, headers: {}, body: Buffer.from('{"message":"Resource not accessible"}') } }];
  const denied = await read({ op: "overview", key });
  assert.equal(reason(denied), "denied");
  assert.doesNotMatch(denied.result.state === "unavailable" ? denied.result.detail ?? "" : "", /single sign-on/);
  github.overrides = [{ pattern: /pulls\/73$/, answer: { kind: "timeout" } }];
  assert.equal(reason(await read({ op: "overview", key: keyOf(FIELD, 73) })), "timeout");
  github.overrides = [{ pattern: /pulls\/73$/, answer: { kind: "too-large" } }];
  assert.equal(reason(await read({ op: "overview", key: keyOf(FIELD, 73) })), "failed");

  // Rate limited: the reply says until when, and main stops asking until then.
  const reset = Math.floor(Date.parse("2026-10-20T12:10:00Z") / 1000);
  github.overrides = [{ pattern: /^repos\//, answer: { kind: "http", status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) },
    body: Buffer.from('{"message":"API rate limit exceeded for user ID 1001. ghp_fakeSecretThatMustNotEscape"}') } }];
  const limited = await read({ op: "overview", key: keyOf(FIELD, 73) });
  assert.equal(reason(limited), "rate-limited");
  assert.equal(limited.result.state === "unavailable" && limited.result.retryAfter, "2026-10-20T12:10:00.000Z");
  const before = github.calls.length;
  assert.equal(reason(await read({ op: "files", key: keyOf(FIELD, 73), revision: revisionOf(github.pulls.get("7302#73")!), cursor: null })), "rate-limited");
  assert.equal(github.calls.length, before, "no request while the limit holds");
  github.overrides = [];
  tick(11 * 60_000);
  assert.equal(value<{ title: string }>(await read({ op: "overview", key: keyOf(FIELD, 73) })).title, "Move the field notes index");

  // Secondary limits name a wait instead of a reset.
  github.overrides = [{ pattern: /^search\//, answer: { kind: "http", status: 429, headers: { "retry-after": "60" }, body: Buffer.from("{}") } }];
  const inbox = value<{ groups: Record<string, { state: string; reason?: string }> }>(await read({ op: "inbox", query: "nothing seen" }));
  assert.deepEqual(Object.values(inbox.groups).map((g) => [g.state, g.reason]), [["unavailable", "rate-limited"], ["unavailable", "rate-limited"]]);
  github.overrides = [];

  // Revoked mid-session: a 401 drops the identity and what it could see, so the next read asks gh who is
  // signed in even though the hosts file and the TTL say nothing changed.
  github.overrides = [{ pattern: /pulls\/73$/, answer: { kind: "http", status: 401, headers: {}, body: Buffer.from('{"message":"Bad credentials"}') } }];
  tick(11 * 60_000);
  assert.equal(reason(await read({ op: "overview", key })), "signed-out");
  github.overrides = [];
  const afterRevoke = github.calls.length;
  assert.equal(reason(await read({ op: "overview", key })), "not-found");
  assert.deepEqual(github.calls.slice(afterRevoke).map((c) => c.endpoint), ["user"]);
  github.user = null;
  assert.equal(reason(await read({ op: "overview", key })), "signed-out");
  assert.equal(github.calls.at(-1)!.endpoint, "user");

  for (const reply of [limited]) assert.doesNotMatch(JSON.stringify(reply), /ghp_|API rate limit exceeded for user/);
});

test("AC3: a search that timed out on GitHub's side is partial, and a capped one says where it stops", async () => {
  const { github, read } = setup();
  await read({ op: "connection" });
  github.search.authored = { incomplete: true, items: [{ repo: LENDING, number: 73 }] };
  github.search["review-requested"] = { total: 1500, items: Array.from({ length: 30 }, () => ({ repo: FIELD, number: 73 })) };
  const inbox = value<{ groups: Record<string, { state: string; reason?: string; coverage?: { loaded: number; total: number | null; complete: boolean; next: string | null; cap?: number } }> }>(
    await read({ op: "inbox", query: "" }));
  assert.equal(inbox.groups.authored!.state, "partial");
  assert.equal(inbox.groups.authored!.reason, "timeout");
  assert.deepEqual(inbox.groups["review-requested"]!.coverage, { loaded: 30, total: 1500, complete: false, next: "p2", cap: 1000 });
  const page = await read({ op: "inbox-page", group: "review-requested", query: "", cursor: "p34" });
  assert.equal(page.result.state, "partial");
  assert.equal(page.result.state === "partial" && page.result.reason, "capped");
  assert.equal(reason(await read({ op: "inbox-page", group: "review-requested", query: "", cursor: "p35" })), "invalid", "past GitHub's 1,000 results");
  assert.equal(reason(await read({ op: "inbox-page", group: "authored", query: "", cursor: "cGFnZTI" })), "invalid", "only cursors main issued");
});

test("AC3: an offline refresh keeps the last good read as stale, and a switch of account drops it", async () => {
  const { github, read, prime, tick } = setup();
  await prime();
  const key = keyOf(LENDING, 73);
  value(await read({ op: "overview", key }));
  github.cli = "offline";
  const stale = await read({ op: "overview", key });
  assert.equal(stale.result.state, "stale");
  assert.equal(stale.result.state === "stale" && stale.result.reason, "offline");
  github.cli = "ok";
  github.user = KIT;
  tick(31_000);
  await read({ op: "connection" });
  github.user = ADA;
  await read({ op: "connection" });
  github.cli = "offline";
  assert.equal(reason(await read({ op: "overview", key })), "not-found", "what was read before the switch is gone");
});

test("AC3: patches GitHub left out are missing coverage, files past 3,000 are capped", async () => {
  const { github, read, prime } = setup();
  await prime();
  const p = github.pulls.get("7301#73")!;
  p.changed_files = 3412;
  github.files.set("7301#73", Array.from({ length: 3000 }, (_, i) => i === 0 ? { filename: "assets/cover.png", status: "added", additions: 0, deletions: 0, changes: 0 }
    : i === 1 ? { filename: "data/catalog.json", status: "modified", additions: 9000, deletions: 3, changes: 9003 }
      : { filename: `src/f${i}.ts`, status: "added", additions: 1, deletions: 0, changes: 1, patch: "@@ -0,0 +1 @@\n+x" }));
  const first = await read({ op: "files", key: keyOf(LENDING, 73), revision: revisionOf(p), cursor: null });
  assert.equal(first.result.state, "ready");
  const firstFiles = value<{ files: { path: string; patch: unknown }[] }>(first).files;
  assert.deepEqual(firstFiles.slice(0, 2).map((f) => f.patch), [{ kind: "omitted", reason: "binary" }, { kind: "omitted", reason: "too-large" }]);
  assert.deepEqual(first.result.state === "ready" && first.result.coverage, { loaded: 100, total: 3412, complete: false, next: "p2", cap: 3000 });
  const last = await read({ op: "files", key: keyOf(LENDING, 73), revision: revisionOf(p), cursor: "p30" });
  assert.equal(last.result.state, "partial");
  assert.deepEqual(last.result.state === "partial" && [last.result.reason, last.result.coverage], ["capped", { loaded: 3000, total: 3412, complete: false, next: null, cap: 3000 }]);
});

test("AC4: a head that moved is never presented as the revision that was asked for", async () => {
  const { github, read, prime } = setup();
  await prime();
  const key = keyOf(LENDING, 73);
  const p = github.pulls.get("7301#73")!;
  const asked = revisionOf(p);
  github.files.set("7301#73", [{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 1, changes: 2, patch: "@@ -1 +1 @@\n-a\n+b" }]);
  github.checkRuns.set(asked.headSha, [{ id: 9, name: "unit", status: "completed", conclusion: "success", head_sha: asked.headSha, started_at: null, completed_at: null, html_url: null, app: { slug: "ci" } }]);

  value(await read({ op: "files", key, revision: asked, cursor: null }));
  p.head = { ...p.head, sha: sha("9") }; // a push
  const files = await read({ op: "files", key, revision: asked, cursor: null });
  assert.equal(files.result.state, "stale");
  assert.equal(files.result.state === "stale" && files.result.reason, "head-changed");
  assert.equal(reason(await read({ op: "files", key, revision: asked, cursor: "p2" })), "head-changed", "no earlier read of that page to show");
  const checks = await read({ op: "checks", key, revision: asked });
  assert.equal(checks.result.state, "stale");
  assert.equal(summarizeChecks(checks.result as never, asked).verdict, "incomplete");

  // The head moving while a page is read labels that page too.
  const fresh = revisionOf(p);
  const filesCalls = () => github.calls.filter((c) => c.endpoint.includes("pulls/73/files")).length;
  const seen = filesCalls();
  const release = github.hold(/pulls\/73\/files/);
  const during = read({ op: "files", key, revision: fresh, cursor: null });
  await until(() => filesCalls() > seen);
  p.head = { ...p.head, sha: sha("8") };
  release();
  const moved = await during;
  assert.equal(moved.result.state === "stale" && moved.result.reason, "head-changed");
});

test("context lines come from the asked side of a revision main has seen, with every path segment encoded", async () => {
  const { github, read, prime } = setup();
  await prime();
  const key = keyOf(LENDING, 73);
  const p = github.pulls.get("7301#73")!;
  const revision = revisionOf(p);
  const path = "docs/holds & queues/50% #1?.md";
  github.contents.set(`7301@${revision.headSha}:${path}`, "one\ntwo\nthree\nfour\n");
  github.contents.set(`7301@${revision.baseSha}:${path}`, "base one\nbase two\n");
  github.contents.set(`7301@${revision.headSha}:assets/logo.png`, "\u0000PNG");
  github.contents.set(`7301@${revision.headSha}:docs`, "<dir>");
  await read({ op: "overview", key });
  assert.deepEqual(value(await read({ op: "context", key, revision, side: "head", path, start: 2, end: 3 })),
    { revision, side: "head", path, start: 2, lines: ["two", "three"], total: 4 });
  assert.deepEqual(value<{ lines: string[] }>(await read({ op: "context", key, revision, side: "base", path, start: 1, end: 9 })).lines, ["base one", "base two"]);
  const call = github.calls.filter((c) => c.endpoint.includes("/contents/")).at(-1)!;
  assert.equal(call.endpoint, `repos/example-org/lending/contents/docs/holds%20%26%20queues/50%25%20%231%3F.md?ref=${revision.baseSha}`);
  assert.equal(call.accept, "application/vnd.github.raw");
  assert.equal(reason(await read({ op: "context", key, revision, side: "head", path: "assets/logo.png", start: 1, end: 2 })), "failed");
  assert.equal(reason(await read({ op: "context", key, revision, side: "head", path: "docs", start: 1, end: 2 })), "not-found");
  const before = github.calls.length;
  assert.equal(reason(await read({ op: "context", key, revision: { ...revision, headSha: sha("7") }, side: "head", path, start: 1, end: 2 })), "invalid");
  assert.equal(github.calls.length, before, "a revision this PR never had costs no request");
});

test("activity lists the opening, commits, comments, reviews and events, one item per provider id", async () => {
  const { github, read, prime } = setup();
  await prime();
  github.timeline.set("7301#73", [
    { event: "committed", sha: sha("1"), message: "Add the hold mover\n\nLonger text.", author: { name: "Ada", date: "2026-10-18T10:05:00Z" } },
    { event: "commented", id: 11, user: BOT, created_at: "2026-10-18T10:06:00Z", body: "<table><tr><td>preview</td></tr></table>" },
    { event: "reviewed", id: 12, user: KIT, submitted_at: "2026-10-18T11:00:00Z", state: "CHANGES_REQUESTED", body: "One thing.", commit_id: sha("1") },
    { event: "reviewed", id: 13, user: KIT, submitted_at: null, state: "PENDING", body: "", commit_id: sha("1") },
    { event: "labeled", id: 14, actor: ADA, created_at: "2026-10-18T11:30:00Z", label: { name: "loans" } },
    { event: "head_ref_force_pushed", id: 15, actor: null, created_at: "2026-10-18T12:00:00Z" },
    // GitHub gives a cross-reference no id of its own (seen live on 2026-10-20); its source issue has one.
    { event: "cross-referenced", actor: KIT, created_at: "2026-10-18T12:30:00Z", source: { type: "issue", issue: { id: 88001, number: 12 } } },
    { event: "deployed", id: 16, actor: BOT, created_at: "2026-10-18T12:40:00Z", commit_id: sha("1") },
    // The timeline spells review states in lower case (seen live), the reviews API in upper case.
    { event: "reviewed", id: 17, user: BOT, submitted_at: "2026-10-18T12:50:00Z", state: "commented", body: null, commit_id: sha("1") },
  ]);
  const activity = await read({ op: "activity", key: keyOf(LENDING, 73), cursor: null });
  const items = value<{ kind: string; id: string }[]>(activity);
  assert.deepEqual(items.map((i) => [i.kind, i.id]), [["opened", "pr-7301073"], ["commit", sha("1")], ["comment", "11"], ["review", "12"], ["event", "14"], ["event", "15"],
    ["event", "xref-88001-1792326600"], ["event", "16"], ["review", "17"]]);
  assert.deepEqual([(items[8] as { verdict?: string }).verdict, (items[8] as { body?: string }).body], ["commented", ""]);
  assert.equal((items[6] as unknown as { event: string }).event, "cross-referenced");
  assert.deepEqual(items[3], { kind: "review", id: "12", at: "2026-10-18T11:00:00Z", actor: { login: "kit-fixture", id: "2002", bot: false }, verdict: "changes-requested", body: "One thing.", commit: sha("1") });
  assert.deepEqual(items[2], { kind: "comment", id: "11", at: "2026-10-18T10:06:00Z", actor: { login: "preview-bot[bot]", id: "3003", bot: true }, body: "<table><tr><td>preview</td></tr></table>" });
  assert.deepEqual(activity.result.state === "ready" && activity.result.coverage, { loaded: 9, total: null, complete: true, next: null });
});

test("stack reads use inferred branch relationships instead of a placeholder", async () => {
  const { read, prime } = setup();
  await prime();
  const stack = value<import("../src/shared/code-review.js").PrStack>(await read({ op: "stack", key: keyOf(LENDING, 73) }));
  assert.equal(stack.source, "inferred");
  assert.deepEqual(stack.members.map(m => m.locator.number), [73, 74]);
});

test("requests are checked before anything runs; cancel stops a read and answers null", async () => {
  const { github, service, read, prime } = setup();
  for (const bad of [null, "connection", { op: "connection" }, { op: "connection", requestId: "x", extra: 1 }, { op: "graphql", requestId: "x" },
    { op: "overview", requestId: "x", key: { ...keyOf(LENDING, 73), repoId: "../x" } }]) {
    await assert.rejects(service.read(bad), /Invalid Code Review request/, JSON.stringify(bad));
  }
  assert.equal(github.calls.length, 0);
  await prime();
  value(await read({ op: "overview", key: keyOf(LENDING, 73) })); // a last good answer exists, and a cancel still never shows it
  const release = github.hold(/pulls\/73$/);
  const slow = read({ requestId: "slow-1", op: "overview", key: keyOf(LENDING, 73) });
  await assert.rejects(service.read({ requestId: "slow-1", op: "overview", key: keyOf(LENDING, 73) }), /already in flight/, "a second request with that id has no reply of its own");
  assert.equal(await service.read({ op: "cancel", requestId: "slow-1" }), null);
  release();
  assert.equal(reason(await slow), "failed");
});

test("repeat reads are conditional, concurrent reads are bounded, and the cache is per account", async () => {
  const { github, read, prime } = setup({ concurrency: 2 });
  await prime();
  const key = keyOf(LENDING, 73);
  await read({ op: "overview", key });
  const before = github.calls.length;
  value(await read({ op: "overview", key }));
  const repeat = github.calls.slice(before).filter((c) => c.endpoint.endsWith("pulls/73"));
  assert.equal(repeat.length, 1);
  assert.match(repeat[0]!.etag ?? "", /^W\/"/, "asked with the ETag it holds, which GitHub answers 304 for free");

  github.peak = 0;
  const release = github.hold(/pulls\/7[34]$/);
  const reads = [keyOf(LENDING, 73), keyOf(LENDING, 74), keyOf(FIELD, 73), keyOf(LENDING, 73), keyOf(FIELD, 73)].map((k) => read({ op: "overview", key: k }));
  await until(() => github.inFlight >= 2);
  for (let i = 0; i < 50; i++) await new Promise((resolve) => setImmediate(resolve));
  release();
  await Promise.all(reads);
  assert.ok(github.peak <= 2, `peak ${github.peak}`);
});

test("a name that now belongs to another repository never answers for the key's repository", async () => {
  const { github, read, prime } = setup();
  await prime();
  const reborn = { ...LENDING, id: 9999 }; // deleted and recreated under the same name
  github.pulls.set("7301#73", pull(reborn, 73, { title: "A different repository's #73" }));
  const reply = await read({ op: "overview", key: keyOf(LENDING, 73) });
  assert.equal(reason(reply), "not-found");
  assert.ok(!JSON.stringify(reply).includes("different repository"));
});

test("AC2 (review finding 1): a gh switch inside the identity window, with no connection read, never answers as the old account", async () => {
  const { github, read, prime, tick } = setup();
  await prime();
  const release = github.hold(/^repos\/example-org\/lending\/pulls\/73$/);
  const slow = read({ op: "overview", key: keyOf(LENDING, 73) });
  await until(() => github.calls.some((c) => c.endpoint === "repos/example-org/lending/pulls/73"));
  github.ignoreAbort = true; // gh finishes the read as the new account
  github.user = KIT;
  release();
  const late = await slow;
  github.ignoreAbort = false;
  assert.equal(reason(late), "signed-out");
  assert.ok(!JSON.stringify(late).includes("Lend a hold"));

  // Five seconds later, still inside the window: the inbox is read and stamped as the account gh now uses.
  tick(5_000);
  const askedAsAda = { requestId: rid(), op: "inbox" as const, query: "" };
  const inbox = (await read(askedAsAda)) as CodeReviewReply;
  assert.equal(inbox.scope.account, "2002");
  assert.equal(acceptsReply({ requestId: askedAsAda.requestId, op: "inbox", scope: scopeOf(askedAsAda, "1001") }, inbox), false);
  assert.ok(value<{ groups: Record<string, { state: string }> }>(inbox).groups.authored!.state !== "unavailable", "the read that noticed the switch still answers");
  const before = github.calls.length;
  assert.equal(reason(await read({ op: "overview", key: keyOf(LENDING, 73) })), "signed-out");
  assert.equal(github.calls.length, before);
});

test("AC2: where gh's hosts file can't be watched, each answer is confirmed against the signed-in account", async () => {
  const { github, read, prime } = setup();
  github.stampless = true;
  await prime();
  const userCalls = () => github.calls.filter((c) => c.endpoint === "user").length;
  const before = userCalls();
  value(await read({ op: "overview", key: keyOf(LENDING, 73) }));
  assert.equal(userCalls(), before + 1, "one conditional check, which GitHub answers with a free 304");
  const release = github.hold(/^repos\/example-org\/lending\/pulls\/73$/);
  const slow = read({ op: "overview", key: keyOf(LENDING, 73) });
  await until(() => github.inFlight > 0);
  github.ignoreAbort = true;
  github.user = KIT;
  release();
  assert.equal(reason(await slow), "signed-out");
});

test("AC3 (review finding 2): a refresh that can't check the account still shows the last good answer as stale", async () => {
  const { github, read, prime, tick } = setup();
  await prime();
  const key = keyOf(LENDING, 73);
  value(await read({ op: "overview", key }));
  github.cli = "offline";
  tick(31_000);
  const overview = await read({ op: "overview", key });
  assert.equal(overview.result.state === "stale" && overview.result.reason, "offline");
  const asked = { requestId: rid(), op: "inbox" as const, query: "" };
  const inbox = (await read(asked)) as CodeReviewReply;
  assert.equal(inbox.scope.account, "1001");
  assert.equal(acceptsReply({ requestId: asked.requestId, op: "inbox", scope: scopeOf(asked, "1001") }, inbox), true);
  const groups = value<{ groups: Record<string, { state: string; reason?: string }> }>(inbox).groups;
  assert.deepEqual(Object.values(groups).map((g) => [g.state, g.reason]), [["stale", "offline"], ["stale", "offline"]]);
});

test("AC3 (review finding 3): repository lookups that fail together leave no unhandled rejection", async () => {
  const { github, read } = setup();
  github.search.authored = { items: [{ repo: LENDING, number: 73 }, { repo: FIELD, number: 73 }] };
  await read({ op: "connection" });
  github.overrides = [{ pattern: /^repos\/example-org\/(lending|field-guide)$/, answer: { kind: "timeout" } }];
  const unhandled: unknown[] = [];
  const listen = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", listen);
  try {
    const inbox = value<{ groups: Record<string, { state: string; reason?: string }> }>(await read({ op: "inbox", query: "" }));
    assert.deepEqual([inbox.groups.authored!.state, inbox.groups.authored!.reason], ["unavailable", "timeout"]);
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", listen);
  }
});

test("AC3 (review finding 5): coverage is complete only when every row arrived", async () => {
  const { github, read, prime } = setup();
  await prime();
  const p = github.pulls.get("7301#73")!;
  p.changed_files = 150;
  github.files.set("7301#73", Array.from({ length: 140 }, (_, i) => ({ filename: `src/f${i}.ts`, status: "added", additions: 1, deletions: 0, changes: 1, patch: "@@ -0,0 +1 @@\n+x" })));
  const second = await read({ op: "files", key: keyOf(LENDING, 73), revision: revisionOf(p), cursor: "p2" });
  assert.equal(second.result.state, "partial");
  assert.deepEqual(second.result.state === "partial" && second.result.coverage, { loaded: 140, total: 150, complete: false, next: null });
  // Search pages are offsets: a row updated between pages can shift. A later page never claims the whole list.
  github.search.authored = { items: Array.from({ length: 31 }, () => ({ repo: LENDING, number: 73 })) };
  const page2 = await read({ op: "inbox-page", group: "authored", query: "", cursor: "p2" });
  assert.equal(page2.result.state === "ready" && page2.result.coverage?.complete, false);
});

test("AC4 (review finding 6): a head that moves while checks are read labels them stale", async () => {
  const { github, read, prime } = setup();
  await prime();
  const key = keyOf(LENDING, 73);
  const p = github.pulls.get("7301#73")!;
  const asked = revisionOf(p);
  github.checkRuns.set(asked.headSha, [{ id: 9, name: "unit", status: "completed", conclusion: "success", head_sha: asked.headSha, started_at: null, completed_at: null, html_url: null, app: { slug: "ci" } }]);
  const release = github.hold(/check-runs/);
  const during = read({ op: "checks", key, revision: asked });
  await until(() => github.calls.some((c) => c.endpoint.includes("check-runs")));
  p.head = { ...p.head, sha: sha("6") };
  release();
  const checks = await during;
  assert.equal(checks.result.state === "stale" && checks.result.reason, "head-changed");
  assert.notEqual(summarizeChecks(checks.result as never, asked).verdict, "passing");
});

test("review nits: hostile enum values, loose timestamps, a 429 without Retry-After, limits across accounts, a recreated repository", async () => {
  const { github, read, prime, tick } = setup();
  await prime();
  const key = keyOf(LENDING, 73);
  const p = github.pulls.get("7301#73")!;
  github.checkRuns.set(p.head.sha, [{ id: 9, name: "unit", status: "constructor", conclusion: "__proto__", head_sha: p.head.sha, started_at: "1", completed_at: null, html_url: null, app: { slug: "ci" } }]);
  const checks = await read({ op: "checks", key, revision: revisionOf(p) });
  structuredClone(checks); // it must be able to cross IPC
  assert.deepEqual(value<{ status: string; conclusion: string; startedAt: string | null }[]>(checks).map((c) => [c.status, c.conclusion, c.startedAt]), [["unknown", "unknown", null]]);

  github.overrides = [{ pattern: /pulls\/73$/, answer: { kind: "http", status: 429, headers: {}, body: Buffer.from("{}") } }];
  assert.equal(reason(await read({ op: "overview", key: keyOf(FIELD, 73) })), "rate-limited");
  github.overrides = [];
  const before = github.calls.length;
  assert.equal(reason(await read({ op: "overview", key: keyOf(FIELD, 73) })), "rate-limited");
  assert.equal(github.calls.length, before, "a 429 holds requests for a minute even without Retry-After");
  // Limits belong to an account: a switch starts clean.
  github.user = KIT;
  assert.equal(value<{ state: string }>(await read({ op: "connection" })).state, "connected");
  github.user = ADA;
  tick(61_000);
  await read({ op: "connection" });

  // A repository deleted and recreated under its name: a link to it resolves to the new one.
  await read({ op: "resolve", input: "example-org/lending#73" });
  const reborn = { ...LENDING, id: 9999 };
  github.repos.set(LENDING.full_name, reborn);
  github.pulls.set("9999#73", pull(reborn, 73));
  github.pulls.delete("7301#73");
  github.pulls.set("7301#73", pull(reborn, 73));
  const resolved = value<{ key: PrKey }>(await read({ op: "resolve", input: "example-org/lending#73" }));
  assert.equal(resolved.key.repoId, "9999");
});

test("AC2: a switch is noticed before a read starts, and the read that noticed it still answers", async () => {
  const { github, read, prime } = setup();
  await prime();
  github.user = KIT;
  const before = github.calls.length;
  assert.equal(reason(await read({ op: "overview", key: keyOf(LENDING, 73) })), "signed-out");
  assert.deepEqual(github.calls.slice(before).map((c) => c.endpoint), ["user"], "nothing read as the new account under the old one's key");
  github.user = ADA;
  const inbox = await read({ op: "inbox", query: "" });
  assert.equal(inbox.scope.account, "1001");
  assert.deepEqual(Object.values(value<{ groups: Record<string, { state: string }> }>(inbox).groups).map((g) => g.state), ["ready", "ready"]);
});

test("AC2: a switch gh's hosts file doesn't show is caught once the identity TTL runs out", async () => {
  const { github, read, prime, tick } = setup();
  await prime();
  github.silently(KIT);
  tick(31_000);
  assert.equal(reason(await read({ op: "overview", key: keyOf(LENDING, 73) })), "signed-out");
});

test("AC2 (re-review A): a switch away and back within one read answers no data and keeps none", async () => {
  const { github, read, prime, tick } = setup();
  await prime();
  github.pulls.get("7301#74")!.title = "KIT PRIVATE: acquisition plan";
  github.search.authored = { items: [{ repo: LENDING, number: 74 }] };
  const release = github.hold(/^search\//);
  const inbox = read({ op: "inbox", query: "" });
  await until(() => github.inFlight >= 2);
  github.user = KIT; // the search runs as Kit
  github.user = ADA; // and gh is back on Ada before the check
  release();
  const reply = await inbox;
  assert.equal(reason(reply), "failed");
  assert.match(reply.result.state === "unavailable" ? reply.result.detail ?? "" : "", /sign-in changed/);
  assert.ok(!JSON.stringify(reply).includes("KIT PRIVATE"));
  github.cli = "offline";
  tick(31_000);
  assert.ok(!JSON.stringify(await read({ op: "inbox", query: "" })).includes("KIT PRIVATE"), "nothing from that read was kept");
});

test("AC2 (re-review B): a confirming check that fails never passes a read", async () => {
  for (const stampless of [false, true]) {
    const { github, read, prime } = setup();
    github.stampless = stampless;
    await prime();
    github.pulls.get("7301#74")!.title = "KIT PRIVATE: acquisition plan";
    github.search.authored = { items: [{ repo: LENDING, number: 74 }] };
    const release = github.hold(/^search\//);
    const inbox = read({ op: "inbox", query: "" });
    await until(() => github.inFlight >= 2);
    github.user = KIT;
    github.overrides = [{ pattern: /^user$/, answer: { kind: "offline" } }];
    release();
    const reply = await inbox;
    assert.ok(reply.result.state === "unavailable", `${stampless ? "no hosts file" : "hosts file"}: ${JSON.stringify(reply.result)}`);
    assert.ok(!JSON.stringify(reply).includes("KIT PRIVATE"));
    github.overrides = [];
  }
});

test("AC3 (re-review C): once gh's login is seen to change, an offline read shows nothing the old account read", async () => {
  const { github, read, prime, tick } = setup();
  await prime();
  value(await read({ op: "overview", key: keyOf(LENDING, 73) }));
  github.user = KIT;
  github.cli = "offline";
  tick(31_000);
  assert.equal(reason(await read({ op: "overview", key: keyOf(LENDING, 73) })), "offline");
  const inbox = await read({ op: "inbox", query: "" });
  assert.equal(reason(inbox), "offline");
});

test("AC3 (re-review 5): inbox pages merge by key, and only distinct rows reaching the total make the list complete", async () => {
  const { github, read, prime } = setup();
  await prime();
  // 31 PRs; one updated between the pages, so #129 repeats and #130 is never served.
  const repo = LENDING;
  for (let n = 100; n <= 130; n++) github.pulls.set(`7301#${n}`, pull(repo, n));
  github.search.authored = { items: Array.from({ length: 30 }, (_, i) => ({ repo, number: 100 + i })) };
  const first = (await read({ op: "inbox-page", group: "authored", query: "", cursor: "p1" })).result as ReadResult<PrSummary[]>;
  github.search.authored = { total: 31, items: [...Array.from({ length: 30 }, (_, i) => ({ repo, number: 100 + i })), { repo, number: 129 }] };
  const second = (await read({ op: "inbox-page", group: "authored", query: "", cursor: "p2" })).result as ReadResult<PrSummary[]>;
  const merged = mergePages([first, second]);
  assert.deepEqual([merged.rows.length, merged.total, merged.complete], [30, 31, false]);
  assert.equal(new Set(merged.rows.map((row) => row.key.number)).size, 30);
  github.search.authored = { items: [{ repo, number: 100 }] };
  const single = (await read({ op: "inbox-page", group: "authored", query: "", cursor: "p1" })).result as ReadResult<PrSummary[]>;
  assert.deepEqual([mergePages([single]).rows.length, mergePages([single]).complete], [1, true]);
  assert.equal(mergePages([single, { state: "unavailable", reason: "offline", fetchedAt: "2026-10-20T12:00:00Z" }]).complete, false);
});

test("AC2: with no hosts file to watch, a failed read under an unnoticed switch shows none of the old account's kept answers", async () => {
  const { github, read, prime } = setup();
  github.stampless = true;
  await prime();
  value(await read({ op: "overview", key: keyOf(LENDING, 73) }));
  github.user = KIT; // unseen: there is no hosts file to watch
  github.overrides = [{ pattern: /pulls\/73$/, answer: { kind: "offline" } }];
  const reply = await read({ op: "overview", key: keyOf(LENDING, 73) });
  assert.equal(reason(reply), "signed-out", "the check before showing a kept answer finds Kit");
  assert.ok(!JSON.stringify(reply).includes("Lend a hold"));
});

for (const status of [403, 404, 410]) {
  test(`visibility loss ${status} invalidates related PR reads before later offline fallback`, async () => {
    const { github, read, prime } = setup();
    await prime();
    const key = keyOf(LENDING, 73);
    const revision = revisionOf(github.pulls.get("7301#73")!);
    github.contents.set(`7301@${revision.headSha}:a.txt`, "private content\n");
    const reads: Ask[] = [
      { op: "overview", key },
      { op: "resolve", input: `https://github.com/${LENDING.full_name}/pull/73` },
      { op: "context", key, revision, side: "head", path: "a.txt", start: 1, end: 1 },
      { op: "activity", key, cursor: null },
      { op: "checks", key, revision },
      { op: "files", key, revision, cursor: null },
    ];
    for (const request of reads) value(await read(request));
    value(await read({ op: "overview", key: keyOf(FIELD, 73) }));
    github.overrides = [{ pattern: new RegExp(`repos/${LENDING.full_name}/pulls/73$`), answer: { kind: "http", status, headers: {}, body: Buffer.from("{}") } }];
    assert.equal((await read({ op: "overview", key })).result.state, "unavailable");
    github.cli = "offline";
    for (const request of reads) assert.equal((await read(request)).result.state, "unavailable", request.op);
    assert.equal((await read({ op: "overview", key: keyOf(FIELD, 73) })).result.state, "stale", "unrelated repository retains its offline fallback");
    const inbox = value<Inbox>(await read({ op: "inbox", query: "" }));
    assert.equal(inbox.groups.authored.state, "unavailable");
    assert.equal(inbox.groups["review-requested"].state, "stale");
  });
}

test("an in-flight context read cannot restore content after the PR becomes inaccessible", async () => {
  const { github, read, prime } = setup();
  await prime();
  const key = keyOf(LENDING, 73);
  value(await read({ op: "overview", key }));
  const revision = revisionOf(github.pulls.get("7301#73")!);
  github.contents.set(`7301@${revision.headSha}:a.txt`, "private content\n");
  const request: Ask = { op: "context", key, revision, side: "head", path: "a.txt", start: 1, end: 1 };
  const release = github.hold(/contents/);
  const pending = read(request);
  await until(() => github.calls.some((call) => call.endpoint.includes("contents/")));
  github.overrides = [{ pattern: /pulls\/73$/, answer: { kind: "http", status: 403, headers: {}, body: Buffer.from("{}") } }];
  assert.equal((await read({ op: "overview", key })).result.state, "unavailable");
  release();
  assert.equal((await pending).result.state, "unavailable");
  github.cli = "offline";
  assert.equal((await read(request)).result.state, "unavailable");
});

test("rate limits preserve offline fallback while SSO denial revokes it", async () => {
  for (const headers of [{ "retry-after": "60" }, { "x-github-sso": "required" }] as Record<string, string>[]) {
    const { github, read, prime } = setup();
    await prime();
    const request: Ask = { op: "overview", key: keyOf(LENDING, 73) };
    value(await read(request));
    github.overrides = [{ pattern: /pulls\/73$/, answer: { kind: "http", status: 403, headers, body: Buffer.from("{}") } }];
    const expected = "retry-after" in headers ? "stale" : "unavailable";
    assert.equal((await read(request)).result.state, expected);
    github.cli = "offline";
    assert.equal((await read(request)).result.state, expected);
  }
});

test("visibility review: an overlapping inbox cannot restore a denied PR", async () => {
  const { github, read, prime } = setup(); await prime();
  github.calls = [];
  const release = github.hold(/search\/issues/);
  const pending = read({ op: "inbox", query: "" });
  await until(() => github.calls.some(call => call.endpoint.startsWith("search/")));
  github.overrides = [{ pattern: /pulls\/73$/, answer: { kind: "http", status: 403, headers: {}, body: Buffer.from("{}") } }];
  assert.equal((await read({ op: "overview", key: keyOf(LENDING, 73) })).result.state, "unavailable");
  release();
  const reply = await pending;
  assert.ok(!JSON.stringify(reply).includes("Lend a hold"));
  github.cli = "offline";
  assert.ok(!JSON.stringify(await read({ op: "inbox", query: "" })).includes("Lend a hold"));
});

for (const status of [403, 404]) test(`visibility review: contents ${status} invalidates sibling slices but preserves other files`, async () => {
  const { github, read, prime } = setup(); await prime();
  const key = keyOf(LENDING, 73);
  value(await read({ op: "overview", key }));
  const revision = revisionOf(github.pulls.get("7301#73")!);
  github.contents.set(`7301@${revision.headSha}:a.txt`, "private one\nprivate two\n");
  github.contents.set(`7301@${revision.headSha}:b.txt`, "other\n");
  const first: Ask = { op: "context", key, revision, side: "head", path: "a.txt", start: 1, end: 1 };
  const second: Ask = { ...first, start: 2, end: 2 };
  const other: Ask = { ...first, path: "b.txt" };
  value(await read(first)); value(await read(second)); value(await read(other));
  github.overrides = [{ pattern: /contents\/a.txt/, answer: { kind: "http", status, headers: {}, body: Buffer.from("{}") } }];
  assert.equal((await read(first)).result.state, "unavailable");
  github.cli = "offline";
  assert.equal((await read(second)).result.state, "unavailable");
  assert.equal((await read(other)).result.state, "stale");
});

test("visibility review: denial during account confirmation prevents publication", async () => {
  const { github, read, prime } = setup(); github.stampless = true; await prime();
  const key = keyOf(LENDING, 73);
  value(await read({ op: "overview", key }));
  const revision = revisionOf(github.pulls.get("7301#73")!);
  github.contents.set(`7301@${revision.headSha}:a.txt`, "private one\n");
  const request: Ask = { op: "context", key, revision, side: "head", path: "a.txt", start: 1, end: 1 };
  github.calls = [];
  const release = github.hold(/^user$/);
  const pending = read(request);
  await until(() => github.calls.some(call => call.endpoint === "user"));
  github.overrides = [{ pattern: /pulls\/73$/, answer: { kind: "http", status: 403, headers: {}, body: Buffer.from("{}") } }];
  assert.equal((await read({ op: "overview", key })).result.state, "unavailable");
  release();
  assert.equal((await pending).result.state, "unavailable");
});

test("visibility review: a denied repository lookup preserves partial and independent inbox groups", async () => {
  const { github, read } = setup();
  github.overrides = [{ pattern: /repos\/example-org\/lending$/, answer: { kind: "http", status: 403, headers: {}, body: Buffer.from("{}") } }];
  const inbox = value<Inbox>(await read({ op: "inbox", query: "" }));
  assert.equal(inbox.groups.authored.state, "partial");
  assert.equal(inbox.groups["review-requested"].state, "ready");
  assert.ok(JSON.stringify(inbox.groups["review-requested"]).includes("Move the field notes"));
});

test("visibility review: a denied lookup in one inbox group removes the same repo from both", async () => {
  const { github, read } = setup();
  github.search["review-requested"].items = [{ repo: LENDING, number: 73 }, { repo: FIELD, number: 73 }];
  let lookups = 0;
  github.overrides = [{ pattern: /repos\/example-org\/lending$/, answer: () => ++lookups === 1
    ? { kind: "http", status: 200, headers: {}, body: Buffer.from(JSON.stringify(LENDING)) }
    : { kind: "http", status: 403, headers: {}, body: Buffer.from("{}") } }];
  const inbox = value<Inbox>(await read({ op: "inbox", query: "" }));
  assert.equal(lookups, 2, "both concurrent groups queried the uncached repository");
  assert.equal(inbox.groups.authored.state, "partial");
  assert.equal(inbox.groups["review-requested"].state, "partial");
  assert.ok(!JSON.stringify(inbox).includes('"repoId":"7301"'));
  assert.ok(JSON.stringify(inbox).includes("Move the field notes"));
  const refreshed = value<Inbox>(await read({ op: "inbox", query: "" }));
  assert.ok(!JSON.stringify(refreshed).includes('"repoId":"7301"'), "a fresh inbox still cannot reuse denied repository metadata");
});

test("CR-4 stack uses same-repository base/head relationships and refuses branching or cycles", async () => {
  const { github, prime, read } = setup();
  await prime();
  const answer = (rows: unknown[]) => ({ kind: "http" as const, status: 200, headers: {}, body: Buffer.from(JSON.stringify(rows)) });
  const p73 = github.pulls.get("7301#73")!;
  const p74 = github.pulls.get("7301#74")!;
  github.overrides.push({ pattern: /\/pulls\?state=open/, answer: answer([p73, p74]) });
  const stack = value<import("../src/shared/code-review.js").PrStack>(await read({ op: "stack", key: keyOf(LENDING, 74) }));
  assert.equal(stack.source, "inferred");
  assert.deepEqual(stack.members.map(m => m.locator.number), [73, 74]);
  assert.equal(stack.position, 1);
  const p75 = pull(LENDING, 75, { base: "topic-73" });
  github.overrides[0]!.answer = answer([p73, p74, p75]);
  assert.equal(reason(await read({ op: "stack", key: keyOf(LENDING, 74) })), "invalid");
  const cyclic73 = { ...p73, base: { ...p73.base, ref: "topic-74" } };
  github.pulls.set("7301#73", cyclic73);
  github.overrides[0]!.answer = answer([cyclic73, p74]);
  assert.equal(reason(await read({ op: "stack", key: keyOf(LENDING, 74) })), "invalid");
});

test("CR-4 provider deployment evidence is read for the PR head with fixed status endpoints", async () => {
  const { github, read, prime } = setup();
  await prime();
  const answer = (rows: unknown[]) => ({ kind: "http" as const, status: 200, headers: {}, body: Buffer.from(JSON.stringify(rows)) });
  const commit = github.pulls.get("7301#73")!.head.sha;
  github.overrides.push({ pattern: /\/deployments\?/, answer: answer([{ id: 42, sha: commit, created_at: "2026-10-19T10:00:00Z", environment: "preview" }]) });
  github.overrides.push({ pattern: /\/deployments\/42\/statuses/, answer: answer([{ id: 43, state: "success", created_at: "2026-10-19T10:01:00Z", environment_url: "https://preview.example/73" }]) });
  const rows = value<import("../src/shared/code-review.js").PrActivity[]>(await read({ op: "activity", key: keyOf(LENDING, 73), cursor: null }));
  const deployment = rows.find(r => r.kind === "deployment");
  assert(deployment?.kind === "deployment");
  assert.equal(deployment.status, "success");
  assert.equal(deployment.commit, commit);
  assert.equal(deployment.url, "https://preview.example/73");
  assert(github.calls.some(c => c.endpoint.includes(`/deployments?sha=${commit}`)));
});

test("CR-4 denied deployment enrichment leaves timeline useful and explicitly partial", async () => {
  const { github, read, prime } = setup();
  await prime();
  github.overrides.push({ pattern: /\/deployments\?/, answer: { kind: "http", status: 403, headers: {}, body: Buffer.from('{}') } });
  const reply = await read({ op: "activity", key: keyOf(LENDING, 73), cursor: null });
  assert.equal(reply.result.state, "partial");
  assert(reply.result.state === "partial");
  assert.equal(reply.result.reason, "denied");
  assert.equal(reply.result.coverage.complete, false);
  assert(value<import("../src/shared/code-review.js").PrActivity[]>(reply).some(r => r.kind === "opened"));
});
