import type {
  CodeReviewAccount, CodeReviewConnection, CodeReviewOp, CodeReviewRequest, Coverage, Inbox, PrActivity, PrActor, PrCheck, PrFile, PrFiles, PrKey,
  PrLocator, PrOverview, PrRevision, PrStack, PrSummary, ReadResult,
} from "../../src/shared/code-review.js";

/**
 * Synthetic Code Review data for the four reference states (docs/design/code-review.md) and the faults
 * around them. It follows the references' layout and density (title lengths, a long description,
 * a stack, a run of checks, folded diff hunks), never their content: the library-lending project,
 * its people, numbers, check names and code are made up for these fixtures. Plain data with a fixed
 * clock: no network, model or disk.
 */

/** The fixture clock: just after the last reference capture. */
export const NOW = "2026-10-18T20:41:00Z";

export const ACCOUNT_A: CodeReviewAccount = { host: "github.com", id: "1001", login: "ada-fixture" };
export const ACCOUNT_B: CodeReviewAccount = { host: "github.com", id: "2002", login: "kit-fixture" };

export interface FixtureRepo { owner: string; repo: string; repoId: string }
export const LENDING: FixtureRepo = { owner: "example-org", repo: "lending", repoId: "R_fixtureLending01" };
/** Has a #73 too, so two repositories share a PR number. */
export const FIELD_GUIDE: FixtureRepo = { owner: "example-org", repo: "field-guide", repoId: "R_fixtureFieldGuide02" };

export function locator(repo: FixtureRepo, number: number): PrLocator {
  return { host: "github.com", owner: repo.owner, repo: repo.repo, number };
}

export function key(account: CodeReviewAccount, repo: FixtureRepo, number: number): PrKey {
  return { account: account.id, host: "github.com", repoId: repo.repoId, number };
}

const sha = (seed: string) => seed.repeat(40 / seed.length);
const ada: PrActor = { login: "ada-fixture", id: "1001", bot: false };
const kit: PrActor = { login: "kit-fixture", id: "2002", bot: false };
const lin: PrActor = { login: "lin-fixture", id: "3003", bot: false };
const previewBot: PrActor = { login: "preview-bot[bot]", id: "9009", bot: true };

const R1_REVISION: PrRevision = { baseRef: "main", baseSha: sha("1a"), headSha: sha("2b") };
const R4_BEFORE: PrRevision = { baseRef: "main", baseSha: sha("4d"), headSha: sha("5e") };
const R4_REVISION: PrRevision = { baseRef: "main", baseSha: sha("4d"), headSha: sha("6f") };

const R1_BODY = `Part of the lending rework (#61). Members see no change yet: the current rules keep deciding due dates until #74 switches the desk over.

## What changes

\`policy/schema.ts\` describes a loan policy as data: who may borrow what, for how long, and what happens when an item comes back late. The desk, the member app and the nightly batch all read it.

- **Item classes:** books, periodicals, media kits and equipment, each with its own default term (21, 7, 14 and 3 days) and a renewal cap. Reference items have no term and cannot leave the building.
- **Member tiers:** adult, junior, staff and partner library. A tier can lengthen a term but never shorten it below the class minimum, so a policy edit cannot quietly strand someone's open loans.
- **Holds:** a hold freezes renewals for the item it targets. When two holds land in the same minute, the earlier request wins and the later one is told its position instead of being refused.
- **Fines:** a daily rate per class with a ceiling, waived for junior members and for any day the branch was closed. Closures come from \`calendar/closures.json\`, the file the opening-hours page already uses.
- **Planner:** \`planMigration(oldPolicy, newPolicy, loans)\` lists every open loan whose due date would move, and by how many days, before anything is saved.
- **Checks:** \`checkPolicy\` rejects overlapping tiers, a renewal cap of zero on a renewable class, and any term longer than the class's insurance limit.
- **Exports:** \`policy/export.ts\` writes the active policy as a dated JSON snapshot, so a member who disputes a fine can be shown the rule that applied that day.

## How it was checked

- \`pnpm test\`: the schema, planner and checks suites, 214 tests, all passing.
- The planner ran against last month's anonymised loan export (38,410 open loans): 1,206 due dates would move, none by more than two days.
- \`checkPolicy\` accepts the current rules once written as data, which is how this PR's default policy was made.

## Not in this PR

- No desk or member-app screens. Those are #74 and #76.
- No change to how fines are collected (#77).
- Nothing is migrated or switched on.

Provenance: synthetic fixture for the Code Review workspace.`;

const R4_BODY = `Fixes #89. Found while checking #84's notice schedule against real holds.

## What went wrong

When a member moved a hold to another branch, \`moveHold\` deleted the hold and placed a new one, so the member dropped to the back of the queue. A hold that had waited three weeks for a popular title could lose its place to someone who asked yesterday. The help page promised the opposite: "Moving a hold keeps your place."

## The fix

\`moveHold\` now keeps the hold's id and original request time and changes only its pickup branch. The queue is still ordered by request time, so the member keeps their position. Cancelling and placing a hold again still starts at the back, as the help page says.

- \`src/holds/move.ts\`: keep the id and \`requestedAt\`, change \`pickupBranch\`, and say so in the comment.
- \`src/holds/move.test.ts\`: a moved hold keeps its id, its request time and its position.
- \`docs/holds.md\`: the "Move the hold" row now matches the code.
- \`docs/changelog.md\`: one entry under Unreleased.

## Checked

- \`pnpm test\`: 96 passed.
- On the staging desk, a hold moved between two branches kept position 4 of 9.`;

const R1_OVERVIEW: PrOverview = {
  key: key(ACCOUNT_A, LENDING, 73),
  locator: locator(LENDING, 73),
  revision: R1_REVISION,
  title: "Add a versioned loan-policy schema, a migration planner and its checks",
  body: R1_BODY,
  state: "open",
  author: ada,
  createdAt: "2026-10-18T15:44:00Z",
  updatedAt: "2026-10-18T20:38:00Z",
  headRef: "loan-policy-schema",
  headRepo: null,
  totals: { files: 11, additions: 8_912, deletions: 47, commits: 9 },
  reviewers: [],
  comments: 0,
};

const R4_OVERVIEW: PrOverview = {
  key: key(ACCOUNT_A, FIELD_GUIDE, 91),
  locator: locator(FIELD_GUIDE, 91),
  revision: R4_REVISION,
  title: "Keep a moved hold's place in the queue when its branch changes",
  body: R4_BODY,
  state: "open",
  author: ada,
  createdAt: "2026-10-18T09:12:00Z",
  updatedAt: "2026-10-18T20:22:00Z",
  headRef: "keep-hold-position",
  headRepo: null,
  totals: { files: 4, additions: 11, deletions: 4, commits: 2 },
  reviewers: [],
  comments: 0,
};

const ready = <T>(value: T, coverage?: Coverage): ReadResult<T> => (coverage ? { state: "ready", value, fetchedAt: NOW, coverage } : { state: "ready", value, fetchedAt: NOW });

function summary(repo: FixtureRepo, number: number, title: string, author: PrActor, updatedAt: string, stackHint = false): PrSummary {
  return { key: key(ACCOUNT_A, repo, number), locator: locator(repo, number), title, state: "open", author, updatedAt, stackHint };
}

const AUTHORED: PrSummary[] = [
  summary(LENDING, 73, R1_OVERVIEW.title, ada, "2026-10-18T20:38:00Z"),
  summary(LENDING, 74, "Switch the desk to the loan-policy schema and show the planner's report", ada, "2026-10-18T20:35:00Z", true),
  summary(FIELD_GUIDE, 88, "Explain hold positions on the member help pages", ada, "2026-10-18T20:31:00Z"),
  summary(LENDING, 70, "test(batch): replay a failed nightly run without charging a fine twice", ada, "2026-10-18T20:26:00Z"),
  summary(FIELD_GUIDE, 91, R4_OVERVIEW.title, ada, "2026-10-18T20:22:00Z"),
  summary(LENDING, 68, "Grey out closed days on the due-date picker", ada, "2026-10-18T20:09:00Z", true),
  summary(LENDING, 66, "Import partner-library tiers from the consortium feed", ada, "2026-10-18T19:52:00Z", true),
  summary(FIELD_GUIDE, 85, "feat(search): rank exact call numbers above title matches", ada, "2026-10-18T19:40:00Z"),
  summary(FIELD_GUIDE, 84, "docs: describe when each overdue notice is sent", ada, "2026-10-18T19:15:00Z"),
];

const REVIEW_REQUESTED: PrSummary[] = [
  summary(FIELD_GUIDE, 73, "Fix the broken anchors on the opening-hours page", kit, "2026-10-18T18:47:00Z"),
  summary(LENDING, 59, "Name the branch that issued each card in member exports", lin, "2026-10-18T16:03:00Z"),
];

const R1_INBOX: Inbox = {
  account: ACCOUNT_A.id,
  query: "",
  groups: {
    authored: ready(AUTHORED, { loaded: 9, total: 12, complete: false, next: "cGFnZTI" }),
    "review-requested": ready(REVIEW_REQUESTED, { loaded: 2, total: 2, complete: true, next: null }),
  },
};

function check(id: string, name: string, headSha: string, status: PrCheck["status"], conclusion: PrCheck["conclusion"], startedAt: string | null, reporter = "github-actions"): PrCheck {
  const completedAt = status === "completed" && startedAt ? NOW : null;
  return { id, name, source: "check-run", reporter, headSha, status, conclusion, startedAt, completedAt, url: `https://github.com/example-org/fixture/actions/runs/1/job/${id}` };
}

/** Running since 20:37:33, so the sidebar's elapsed clock reads 03:27 at the fixture clock. */
const R1_CHECKS: PrCheck[] = [
  check("101", "lint", R1_REVISION.headSha, "completed", "success", "2026-10-18T20:37:33Z"),
  check("102", "typecheck", R1_REVISION.headSha, "running", null, "2026-10-18T20:37:33Z"),
  check("103", "unit (node 22)", R1_REVISION.headSha, "running", null, "2026-10-18T20:37:34Z"),
  check("104", "unit (node 24)", R1_REVISION.headSha, "running", null, "2026-10-18T20:37:34Z"),
  check("105", "integration (postgres)", R1_REVISION.headSha, "running", null, "2026-10-18T20:37:35Z"),
  check("106", "docs build", R1_REVISION.headSha, "running", null, "2026-10-18T20:37:36Z"),
  check("107", "CodeQL", R1_REVISION.headSha, "queued", null, null),
];

const R4_CHECK_NAMES = ["lint", "typecheck", "unit (node 22)", "unit (node 24)", "integration (postgres)", "smoke (linux)", "smoke (macOS)",
  "links", "spelling", "docs build", "CodeQL"];
const R4_CHECKS: PrCheck[] = R4_CHECK_NAMES.map((name, i) => check(String(201 + i), name, R4_REVISION.headSha, "completed", "success", "2026-10-18T20:23:00Z"));

const R1_STACK: PrStack = {
  source: "inferred",
  position: 0,
  members: [
    { locator: locator(LENDING, 73), title: R1_OVERVIEW.title, state: "open" },
    { locator: locator(LENDING, 74), title: "Switch the desk to the loan-policy schema and show the planner's report", state: "open" },
    { locator: locator(LENDING, 76), title: "Show renewal limits and hold positions in the member app", state: "open" },
    { locator: locator(LENDING, 77), title: "Collect fines at the new policy rates", state: "draft" },
  ],
};

const commit = (n: number, at: string, headline: string): PrActivity => ({ kind: "commit", id: `commit-${n}`, at, sha: sha(n.toString(16).padStart(2, "0")), headline, author: ada });

const PREVIEW_COMMENT = `Preview builds for this branch are ready. [What is this?](https://preview-bot.example/docs)

| Site | Status | Link | Built |
| :--- | :--- | :--- | :--- |
| lending-desk | Ready ([Logs](https://preview-bot.example/logs/1)) | [Open preview](https://lending-desk-loan-policy.preview-bot.example) | Oct 18, 2026 3:47pm UTC |

<a href="https://preview-bot.example/feedback?pr=73"><img src="https://preview-bot.example/button.svg" alt="Send feedback on this preview"></a>`;

/** R2's timeline: two commits, the opening, a bot's preview comment, then seven more commits. */
const R2_ACTIVITY: PrActivity[] = [
  commit(1, "2026-10-18T15:39:00Z", "Describe item classes and member tiers as data"),
  commit(2, "2026-10-18T15:42:00Z", "Add the policy checks"),
  { kind: "opened", id: "opened-73", at: "2026-10-18T15:44:00Z", actor: ada },
  { kind: "comment", id: "comment-9001", at: "2026-10-18T15:47:00Z", actor: previewBot, body: PREVIEW_COMMENT },
  ...[
    "Freeze renewals while a hold waits", "Waive fines on closed days", "Plan a policy migration before saving", "Reject terms past the insurance limit",
    "Export the active policy as a dated snapshot", "Write the current rules as the default policy", "Run the planner over last month's export",
  ].map((headline, i) => commit(3 + i, `2026-10-18T20:3${i}:${String(5 + i * 7).padStart(2, "0")}Z`, headline)),
];

const movePatch = `@@ -38,5 +38,5 @@ import type { Branch, Hold } from "./types.js";
 /**
  * Moves a hold to another pickup branch. The queue is ordered by request
- * time, and a move places a new hold at the back of it.
+ * time, and a move keeps the hold's request time, so it keeps its place.
  */
 export function moveHold(hold: Hold, to: Branch, now: Date): Hold {
@@ -47,7 +47,9 @@ export function moveHold(hold: Hold, to: Branch, now: Date): Hold {
   if (!to.acceptsHolds) throw new HoldError("branch-closed", to.id);
   const rule = pickupRule(to);
   if (!rule.allows(hold.itemClass)) throw new HoldError("class-not-held", hold.itemClass);
-  return { ...hold, id: newHoldId(), pickupBranch: to.id, requestedAt: now.toISOString() };
+  // Same id and request time: only the pickup branch changes, so the queue
+  // position stays the same (#89).
+  return { ...hold, pickupBranch: to.id, movedAt: now.toISOString() };
 }
\u0020
 export function cancelHold(hold: Hold, now: Date): Hold {`;

const testPatch = `@@ -22,6 +22,8 @@ test("a hold moves to a branch that accepts its class", () => {
   const moved = moveHold(hold, eastBranch, at("2026-10-02"));
   assert.equal(moved.pickupBranch, "east");
-  assert.notEqual(moved.id, hold.id);
+  assert.equal(moved.id, hold.id, "a move keeps the hold");
+  assert.equal(moved.requestedAt, hold.requestedAt, "and its place in the queue");
+  assert.equal(queuePosition(moved, queue), queuePosition(hold, queue));
 });
\u0020
 test("a hold cannot move to a closed branch", () => {`;

const docsPatch = `@@ -54,7 +54,7 @@ What each action does to a hold:
 | Renew the item | nothing; renewals are frozen while a hold waits |
 | Suspend the hold | keeps its place; it is skipped until resumed |
 | Cancel the hold | removes it; placing it again starts at the back |
-| Move the hold | places a new hold at the back of the queue |
+| Move the hold | changes the pickup branch and keeps its place |
 | Let it expire | removes it after the pickup window |
\u0020
 Holds on reference items are refused at the desk.`;

const changelogPatch = `@@ -3,5 +3,8 @@
 ## Unreleased
\u0020
+- **Moving a hold keeps its place.** A hold moved to another branch keeps its request time,
+  so the member stays where they were in the queue (#89).
+
 - **Overdue notices follow the branch calendar.** No notice goes out for a day the branch was closed.
\u0020
 ## 2026.10`;

const R4_FILES: PrFiles = {
  revision: R4_REVISION,
  files: [
    { path: "src/holds/move.ts", previousPath: null, status: "modified", additions: 4, deletions: 2, patch: { kind: "text", patch: movePatch } },
    { path: "src/holds/move.test.ts", previousPath: null, status: "modified", additions: 3, deletions: 1, patch: { kind: "text", patch: testPatch } },
    { path: "docs/holds.md", previousPath: null, status: "modified", additions: 1, deletions: 1, patch: { kind: "text", patch: docsPatch } },
    { path: "docs/changelog.md", previousPath: null, status: "modified", additions: 3, deletions: 0, patch: { kind: "text", patch: changelogPatch } },
  ],
};

/** `count` small added files, the same every time: for the 1,000-file and provider-cap cases. */
export function stressFiles(count: number): PrFile[] {
  return Array.from({ length: count }, (_, i) => {
    const n = String(i).padStart(4, "0");
    return {
      path: `packages/stress/src/module-${n}.ts`, previousPath: null, status: "added", additions: 3, deletions: 0,
      patch: { kind: "text", patch: `@@ -0,0 +1,3 @@\n+export const id = ${i};\n+export const label = "module ${n}";\n+export default id;` },
    };
  });
}

export const R1 = {
  connection: ready<CodeReviewConnection>({ state: "connected", account: ACCOUNT_A }),
  inbox: ready(R1_INBOX),
  overview: R1_OVERVIEW,
  checks: ready(R1_CHECKS),
  stack: ready(R1_STACK),
};

/** R2 is R1's PR scrolled to its activity. */
export const R2 = { overview: R1_OVERVIEW, activity: ready(R2_ACTIVITY, { loaded: R2_ACTIVITY.length, total: R2_ACTIVITY.length, complete: true, next: null }) };

/** R3 is R2 with the review-instructions popover open. Instructions are #325's; until then the field is empty. */
export const R3 = { overview: R1_OVERVIEW, popover: "review-instructions" as const, instructions: "" };

export const R4 = {
  overview: R4_OVERVIEW,
  checks: ready(R4_CHECKS),
  files: ready(R4_FILES, { loaded: 4, total: 4, complete: true, next: null }),
};

const truncated: PrFile[] = [
  ...stressFiles(2998),
  { path: "assets/branch-map.png", previousPath: null, status: "added", additions: 0, deletions: 0, patch: { kind: "omitted", reason: "binary" } },
  { path: "data/loans-2026.csv", previousPath: null, status: "added", additions: 52_118, deletions: 0, patch: { kind: "omitted", reason: "too-large" } },
];

export const FAULTS = {
  emptyInbox: ready<Inbox>({ account: ACCOUNT_A.id, query: "", groups: { authored: ready<PrSummary[]>([]), "review-requested": ready<PrSummary[]>([]) } }),
  signedOut: { state: "unavailable", reason: "signed-out", fetchedAt: NOW, detail: "Not signed in to GitHub CLI." } as ReadResult<Inbox>,
  noCli: { state: "no-cli", detail: "GitHub CLI (gh) was not found." } as CodeReviewConnection,
  denied: { state: "unavailable", reason: "denied", fetchedAt: NOW, detail: "This account can't see that repository." } as ReadResult<PrOverview>,
  /** An earlier inbox, kept while offline. */
  offline: { state: "stale", value: R1_INBOX, fetchedAt: "2026-10-18T20:10:00Z", reason: "offline" } as ReadResult<Inbox>,
  /** The first page of a 12-row group. */
  firstPage: ready(AUTHORED, { loaded: 9, total: 12, complete: false, next: "cGFnZTI" }),
  /** The second page failed: what arrived, without a total. */
  failedPage: { state: "partial", value: AUTHORED, fetchedAt: NOW, reason: "rate-limited", coverage: { loaded: 9, total: null, complete: false, next: "cGFnZTI" } } as ReadResult<PrSummary[]>,
  /** One of each outcome on R4's head, plus one result from the old head. */
  checks: ready<PrCheck[]>([
    check("301", "unit (node 24)", R4_REVISION.headSha, "completed", "success", "2026-10-18T20:23:00Z"),
    check("302", "integration (postgres)", R4_REVISION.headSha, "completed", "failure", "2026-10-18T20:23:00Z"),
    check("303", "smoke (linux)", R4_REVISION.headSha, "completed", "timed-out", "2026-10-18T20:23:00Z"),
    check("304", "typecheck", R4_REVISION.headSha, "queued", null, null),
    check("305", "docs build", R4_REVISION.headSha, "running", null, "2026-10-18T20:24:00Z"),
    check("306", "links", R4_REVISION.headSha, "completed", "cancelled", "2026-10-18T20:23:00Z"),
    check("307", "spelling", R4_REVISION.headSha, "completed", "neutral", "2026-10-18T20:23:00Z"),
    check("308", "smoke (macOS)", R4_REVISION.headSha, "completed", "skipped", "2026-10-18T20:23:00Z"),
    check("309", "lint", R4_REVISION.headSha, "unknown", null, null),
    check("310", "unit (node 22)", R4_BEFORE.headSha, "completed", "success", "2026-10-18T19:10:00Z"),
  ]),
  /** A check that failed and passed on re-run: the newer run (the higher id) is the one that counts. */
  rerun: ready<PrCheck[]>([
    check("401", "smoke (linux)", R4_REVISION.headSha, "completed", "failure", "2026-10-18T20:23:00Z"),
    check("402", "smoke (linux)", R4_REVISION.headSha, "completed", "success", "2026-10-18T20:31:00Z"),
  ]),
  /** Two reporters with a check of the same name: one is not a re-run of the other. */
  sameName: ready<PrCheck[]>([
    check("501", "build", R4_REVISION.headSha, "completed", "failure", "2026-10-18T20:23:00Z", "ci-runner-example"),
    check("502", "build", R4_REVISION.headSha, "completed", "success", "2026-10-18T20:31:00Z"),
  ]),
  /** GitHub stops listing files at 3,000; this PR has 3,412. One patch is binary, one too large to send. */
  truncatedFiles: { state: "partial", value: { revision: R4_REVISION, files: truncated }, fetchedAt: NOW, reason: "capped", coverage: { loaded: 3000, total: 3412, complete: false, next: null, cap: 3000 } } as ReadResult<PrFiles>,
  /** R4's PR before its last push, and the diff read then. */
  headChanged: {
    before: R4_BEFORE,
    after: R4_REVISION,
    filesBefore: { state: "stale", value: { revision: R4_BEFORE, files: R4_FILES.files.slice(0, 3) }, fetchedAt: "2026-10-18T19:12:00Z", reason: "head-changed" } as ReadResult<PrFiles>,
  },
};

/** One well-formed request per operation. */
export const REQUESTS = {
  connection: { op: "connection", requestId: "c-1" },
  inbox: { op: "inbox", requestId: "i-1", query: "" },
  "inbox-page": { op: "inbox-page", requestId: "i-2", group: "authored", query: "", cursor: "cGFnZTI" },
  resolve: { op: "resolve", requestId: "s-1", input: "https://github.com/example-org/field-guide/pull/91" },
  overview: { op: "overview", requestId: "o-1", key: R1_OVERVIEW.key },
  activity: { op: "activity", requestId: "a-1", key: R1_OVERVIEW.key, cursor: null },
  checks: { op: "checks", requestId: "k-1", key: R1_OVERVIEW.key, revision: R1_REVISION },
  stack: { op: "stack", requestId: "t-1", key: R1_OVERVIEW.key },
  files: { op: "files", requestId: "f-1", key: R4_OVERVIEW.key, revision: R4_REVISION, cursor: null },
  context: { op: "context", requestId: "x-1", key: R4_OVERVIEW.key, revision: R4_REVISION, side: "head", path: "src/holds/move.ts", start: 1, end: 80 },
  cancel: { op: "cancel", requestId: "x-1" },
} satisfies { [K in CodeReviewOp]: Extract<CodeReviewRequest, { op: K }> };

/**
 * The four references (docs/design/code-review.md). They stay on Val's Mac and are never committed.
 * `devicePixelsPerCss` is inferred from layout, not read from the PNG (all four say 144 dpi);
 * `offset` is where each crop sits relative to R2's, in CSS px, from the red window button.
 */
export const REFERENCES = [
  { id: "R1", file: "Screenshot 2026-10-18 at 15.38.42.png", capturedAt: "2026-10-18T20:38:42Z", pixels: { width: 1766, height: 1057 }, devicePixelsPerCss: 1, css: { width: 1766, height: 1057 }, offset: { x: 0, y: 2 }, sha256: "ad7365cfb4cede0ad0ace887fbe4167d5c77efb1699994886428c1082d9675ec", state: "Overview at the top: title, description, stack and checks sidebar, floating PR composer" },
  { id: "R2", file: "Screenshot 2026-10-18 at 15.38.52.png", capturedAt: "2026-10-18T20:38:52Z", pixels: { width: 3536, height: 2102 }, devicePixelsPerCss: 2, css: { width: 1768, height: 1051 }, offset: { x: 0, y: 0 }, sha256: "448ce452b9b858f614a6109f797e06bf605070823048550874012426567cc212", state: "The same PR scrolled to its activity: commits, the opening, a bot's preview comment, the comment composer" },
  { id: "R3", file: "Screenshot 2026-10-18 at 15.38.55.png", capturedAt: "2026-10-18T20:38:55Z", pixels: { width: 3538, height: 2098 }, devicePixelsPerCss: 2, css: { width: 1769, height: 1049 }, offset: { x: 0, y: -1 }, sha256: "6a6c2291c9263f7d355abe97bd5beb537433e73b390eeb2d39f604bedeff86c0", state: "R2 with the review-instructions popover open" },
  { id: "R4", file: "Screenshot 2026-10-18 at 15.40.30.png", capturedAt: "2026-10-18T20:40:30Z", pixels: { width: 3528, height: 2094 }, devicePixelsPerCss: 2, css: { width: 1764, height: 1047 }, offset: { x: -6, y: -2 }, sha256: "022642da9ed9dbaf160a8aa99d4c0462cd772404ef8239f22c94acefdac320dc", state: "Another PR split: description beside its Changes tab, grouped unified diffs and a file tree" },
] as const;
