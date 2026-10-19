import type {
  CodeReviewAccount, CodeReviewConnection, CodeReviewOp, CodeReviewRequest, Coverage, Inbox, PrActivity, PrActor, PrCheck, PrFile, PrFiles, PrKey,
  PrLocator, PrOverview, PrRevision, PrStack, PrSummary, ReadResult,
} from "../../src/shared/code-review.js";

/**
 * Synthetic Code Review data for the four reference states (docs/design/code-review.md) and the faults
 * around them. Text matches the references' density, never their content: every owner, login, title,
 * body and path here is made up. Plain data with a fixed clock: no network, model or disk.
 */

/** The fixture clock: just after the last reference capture. */
export const NOW = "2026-10-18T20:41:00Z";

export const ACCOUNT_A: CodeReviewAccount = { host: "github.com", id: "1001", login: "ada-fixture" };
export const ACCOUNT_B: CodeReviewAccount = { host: "github.com", id: "2002", login: "kit-fixture" };

export interface FixtureRepo { owner: string; repo: string; repoId: string }
export const RESERVOIR: FixtureRepo = { owner: "example-org", repo: "reservoir", repoId: "R_fixtureReservoir01" };
/** Has a #519 too, so two repositories share a PR number. */
export const HARBOR: FixtureRepo = { owner: "example-org", repo: "harbor-docs", repoId: "R_fixtureHarbor02" };

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

const R1_REVISION: PrRevision = { baseRef: "main", baseSha: sha("a1"), headSha: sha("b2") };
const R4_BEFORE: PrRevision = { baseRef: "main", baseSha: sha("d4"), headSha: sha("e5") };
const R4_REVISION: PrRevision = { baseRef: "main", baseSha: sha("d4"), headSha: sha("f6") };

const R1_BODY = `For #406 (parent #405). Nothing in the running ingest changes: the legacy poller keeps writing until #407's reviewed intake revision replaces it.

## What this adds

\`shared/intake-contract.js\` is one pure, versioned contract for the reservoir intake, with no database, DOM or network state, so the dashboard and the ingest worker read the same rules.

- **Stations and datum:** read from the survey export \`survey-2026-09.csv\` exactly as pinned in \`stations.json\` (41 stations, 212.409 m datum, not a grid). Local offsets, gauge frames and chart transforms, one per station.
- **Sensors:** 3/4/3 probes per tower on 15 s then 60 s cadences. Ranges 0–25/0–40/0–25 m, alarms at 22/36/22 under the 23.5/37.2/23.5 m caps. The middle tower's alarm stays 0.75 m below the spillway crest.
- **Channels:** C12 at 18 km and C23 at 11 km, gate to gate at sluice 4 (km 13), four lanes with three open. Each crossing hands its readings to the next channel, so a series continues across the weir instead of restarting.
- **Ground truth:** benchmarks, staff gauges, P1–P9, the pump house, the outfall screens, the stilling basin and intakes I1–I3 with explicit seams, plus the retained 1974 gauge.
- **Calibrations (#411):** 26 probes, 21 meters, 9 loggers and 11 rain gauges as typed instruments (\`intake.instruments\`), validated so every channel and tower has a reading path to its logger.
- **Levels:** keyed by elevation across the basin (\`intake/l0..l7\`), agreed with the #408 owner. \`readingAt(levelId, t, station)\` resolves a reading on its own level and never borrows the nearest neighbour's.
- **Offtakes:** 43 metered offtakes (3,279.7 ML/yr) with stable ids, a valve on the main line and a logged flow anchor. Tariffs are unset (#409).
- **Gates:** each gate and sluice record names where its reading is taken, 0.6 m upstream of the gate, so a spill record always lands outside the crest.
- **Validator:** \`validateIntake\` and \`checkIntakeCompatibility\`. Every gate must sit on the channel it joins, and every probe must have a clear sampling window.
- **Authority fixture:** \`server/tests/intake-support.test.js\` runs the model on the basin the server loads, under the worker's sampling rules (below).

Published from the module by \`node scripts/intake-views.mjs\` (\`--check\` gates them), in \`docs/design/intake/\`:

- **Review page:** rendered headlessly with no page errors. Validator ok; per-level instrument counts 9/0/14/6/12/6/7/3 (57); C12's readings span km 0–18. Views: stations, the l3 weir and the l0 benchmarks.

## Limits

- No live ingest, alerting, storage cost or two-site replication. Those are #407/#408/#411/#412.
- Tariffs and billing terms are #409.
- No device evidence. No production change, migration, merge or activation.
- Chart \`05-spillway-outlook\` uses an approximate crest height.

Provenance: synthetic fixture for the Code Review workspace.`;

const R4_BODY = `Part of #177 (TT-4). Follows #182 (TT-1) and #184 (TT-4 typed steps), tracker #173.

## The bug, on \`main\` (since \`8e2f534\`)

#184 stopped folding steps whose outcome is \`unknown\`, so unresolved work stays in view when an import finishes. But \`tideOutcome\` (from #182) returns \`unknown\` for **every** gauge sync. tide-cli 0.41.0's \`gaugeSync\` step has neither a \`status\` nor an \`error\` field (\`tide-cli describe-steps\`: \`{ id, gauge, window, … }\`), so no finished sync could be anything else. The result: every gauge sync in every finished import stays unfolded under "Worked for …", although nothing about it is unresolved.

I raised this in review on #184 before it merged ([comment](https://github.com/example-org/harbor-docs/pull/184#discussion_r1001)). It merged without the fix.

## The fix

A gauge sync's \`step/finished\` is the only report tide-cli makes about it, so a finished sync with no status reads as \`succeeded\`. Everything else keeps its current mapping. \`unknown\` keeps meaning work that never reported: a step still open when its run ended, or a status-less step of another kind. That is the case #184's folding rule is for.

- \`importers/tides.ts\` \`tideOutcome\`: three lines, plus its comment.
- \`test/tides.test.ts\`: the assertion that pinned a gauge sync as \`unknown\` now expects \`succeeded\`, with the reason.
- \`docs/tide-tables.md\`: the outcome row says the same.
- \`docs/status.md\`: one line under "On main, unreleased".

## Evidence

- \`pnpm build && pnpm test\`: 1,204 passed, 9 skipped.
- \`pnpm test:e2e\`: 14/14.`;

const R1_OVERVIEW: PrOverview = {
  key: key(ACCOUNT_A, RESERVOIR, 519),
  locator: locator(RESERVOIR, 519),
  revision: R1_REVISION,
  title: "#406: measured reservoir intake contract, storage model and validator",
  body: R1_BODY,
  state: "open",
  author: ada,
  createdAt: "2026-10-18T15:38:00Z",
  updatedAt: "2026-10-18T20:37:00Z",
  headRef: "feat/reservoir-intake-contract-261018",
  headRepo: null,
  totals: { files: 16, additions: 15_363, deletions: 0, commits: 13 },
  reviewers: [],
  comments: 0,
};

const R4_OVERVIEW: PrOverview = {
  key: key(ACCOUNT_A, HARBOR, 288),
  locator: locator(HARBOR, 288),
  revision: R4_REVISION,
  title: "Read a finished gauge sync as succeeded, so it folds again (TT-4)",
  body: R4_BODY,
  state: "open",
  author: ada,
  createdAt: "2026-10-18T10:39:00Z",
  updatedAt: "2026-10-18T20:27:00Z",
  headRef: "tide-gauge-sync-done",
  headRepo: null,
  totals: { files: 4, additions: 13, deletions: 5, commits: 2 },
  reviewers: [],
  comments: 0,
};

const ready = <T>(value: T, coverage?: Coverage): ReadResult<T> => (coverage ? { state: "ready", value, fetchedAt: NOW, coverage } : { state: "ready", value, fetchedAt: NOW });

function summary(repo: FixtureRepo, number: number, title: string, author: PrActor, updatedAt: string, stackHint = false): PrSummary {
  return { key: key(ACCOUNT_A, repo, number), locator: locator(repo, number), title, state: "open", author, updatedAt, stackHint };
}

const AUTHORED: PrSummary[] = [
  summary(RESERVOIR, 519, R1_OVERVIEW.title, ada, "2026-10-18T20:37:00Z"),
  summary(RESERVOIR, 521, "Basin gauges #408: authoritative levels, sluices and spill records", ada, "2026-10-18T20:36:00Z", true),
  summary(HARBOR, 291, "Answer each alarm once, and show station questions beside the chart", ada, "2026-10-18T20:36:00Z"),
  summary(HARBOR, 290, "test(ingest): prove read-only replay of a recovered batch", ada, "2026-10-18T20:30:00Z"),
  summary(HARBOR, 288, R4_OVERVIEW.title, ada, "2026-10-18T20:27:00Z"),
  summary(RESERVOIR, 516, "Give offline stations a cached reading per level and a stale badge", ada, "2026-10-18T20:22:00Z", true),
  summary(RESERVOIR, 514, "Intake screening: range checks and backfill scripts for a station", ada, "2026-10-18T20:20:00Z", true),
  summary(HARBOR, 286, "feat(ingest): inspect bounded retention metadata per series", ada, "2026-10-18T20:20:00Z"),
  summary(HARBOR, 285, "test: audit unit-preserving import of legacy logger files", ada, "2026-10-18T20:14:00Z"),
  summary(HARBOR, 284, "test(ingest): add the sluice-command conformance suite", ada, "2026-10-18T20:06:00Z"),
];

const REVIEW_REQUESTED: PrSummary[] = [
  summary(HARBOR, 288, R4_OVERVIEW.title, ada, "2026-10-18T20:27:00Z"),
  summary(HARBOR, 519, "Keep the harbour tide table readable at narrow widths", kit, "2026-10-18T19:58:00Z"),
  summary(RESERVOIR, 498, "Name the logger that sent each reading in the export", lin, "2026-10-18T18:12:00Z"),
];

const R1_INBOX: Inbox = {
  account: ACCOUNT_A.id,
  query: "",
  groups: {
    authored: ready(AUTHORED, { loaded: 10, total: 14, complete: false, next: "Y3Vyc29yOjEw" }),
    "review-requested": ready(REVIEW_REQUESTED, { loaded: 3, total: 3, complete: true, next: null }),
  },
};

function check(id: string, name: string, headSha: string, status: PrCheck["status"], conclusion: PrCheck["conclusion"], startedAt: string | null): PrCheck {
  const completedAt = status === "completed" && startedAt ? NOW : null;
  return { id, name, source: "check-run", headSha, status, conclusion, startedAt, completedAt, url: `https://github.com/example-org/fixture/actions/runs/1/job/${id}` };
}

/** Running since 20:35:46, so the sidebar's elapsed clock reads 05:14 at the fixture clock. */
const R1_CHECKS: PrCheck[] = [
  check("101", "preview checks", R1_REVISION.headSha, "running", null, "2026-10-18T20:35:46Z"),
  check("102", "preview shared (required)", R1_REVISION.headSha, "running", null, "2026-10-18T20:35:46Z"),
  check("103", "preview shared (development)", R1_REVISION.headSha, "running", null, "2026-10-18T20:35:47Z"),
  check("104", "preview shared (creator)", R1_REVISION.headSha, "running", null, "2026-10-18T20:35:47Z"),
  check("105", "preview experience (basin)", R1_REVISION.headSha, "running", null, "2026-10-18T20:35:48Z"),
  check("106", "Analyze (actions)", R1_REVISION.headSha, "completed", "success", "2026-10-18T20:35:46Z"),
  check("107", "unit (node 24)", R1_REVISION.headSha, "queued", null, null),
];

const R4_CHECK_NAMES = ["unit (node 24)", "unit (node 22)", "e2e (macOS)", "e2e (linux)", "typecheck", "build", "lint docs", "links", "Analyze (actions)",
  "Analyze (javascript)", "coverage", "store build", "site build"];
const R4_CHECKS: PrCheck[] = R4_CHECK_NAMES.map((name, i) => check(String(201 + i), name, R4_REVISION.headSha, "completed", "success", "2026-10-18T20:28:00Z"));

const R1_STACK: PrStack = {
  source: "inferred",
  position: 0,
  members: [
    { locator: locator(RESERVOIR, 519), title: R1_OVERVIEW.title, state: "open" },
    { locator: locator(RESERVOIR, 520), title: "Reservoir intake #407: replace the legacy poller with the reviewed worker", state: "open" },
    { locator: locator(RESERVOIR, 521), title: "Basin gauges #408: authoritative levels, sluices and spill records", state: "open" },
    { locator: locator(RESERVOIR, 522), title: "Basin gauges #411: finish calibrations for every logger", state: "open" },
    { locator: locator(RESERVOIR, 523), title: "Reservoir intake: owner-managed offtake leases", state: "open" },
    { locator: locator(RESERVOIR, 524), title: "Reservoir intake #410: metered offtakes on the dashboard", state: "open" },
  ],
};

const commit = (n: number, at: string, headline: string): PrActivity => ({ kind: "commit", id: `commit-${n}`, at, sha: sha(n.toString(16).padStart(2, "0")), headline, author: ada });

const PREVIEW_COMMENT = `The latest updates on your projects. Learn more about [Preview Bot for GitHub](https://preview-bot.example/docs).

| Project | Deployment | Actions | Updated |
| :--- | :--- | :--- | :--- |
| reservoir | Ready ([Inspect](https://preview-bot.example/inspect/1)) | [Preview](https://reservoir-git-intake.preview-bot.example) | Oct 18, 2026 3:42pm UTC |

<a href="https://preview-bot.example/agent?pr=519"><img src="https://preview-bot.example/button.svg" alt="Review with Preview Agent"></a>`;

/** R2's timeline: three commits, the opening, a bot's preview comment, then ten more commits. */
const R2_ACTIVITY: PrActivity[] = [
  commit(1, "2026-10-18T15:31:00Z", "Pin the station survey and datum"),
  commit(2, "2026-10-18T15:33:00Z", "Add the intake contract and its validator"),
  commit(3, "2026-10-18T15:36:00Z", "Publish the review views from the module"),
  { kind: "opened", id: "opened-519", at: "2026-10-18T15:38:00Z", actor: ada },
  { kind: "comment", id: "comment-9001", at: "2026-10-18T15:42:00Z", actor: previewBot, body: PREVIEW_COMMENT },
  ...[
    "Key levels by elevation", "Resolve readings per level", "Type the instruments", "Validate gates on their channels", "Clear sampling windows",
    "Add the authority fixture", "Count instruments per level", "Gate the views with --check", "Name the spillway outlook", "List the limits",
  ].map((headline, i) => commit(4 + i, `2026-10-18T20:3${i < 6 ? 5 : 6}:${String(10 + i * 5).padStart(2, "0")}Z`, headline)),
];

const tidesPatch = `@@ -694,8 +694,9 @@ export type StepOutcome = "succeeded" | "failed" | "denied" | "unknown";
  * How a finished import step ended, from its own status field: a \`declined\`
  * step is a refusal, \`failed\` a failure, \`completed\` a success, except a
  * read with no row count at all (unknown).
- * Any other step that reports no status (a gauge sync) is unknown: a
- * step still \`running\` when it finishes. Exported for the folding rule.
+ * A gauge sync has neither a status nor an error field, so finishing is all
+ * it reports: it finished. Any other step without a status is a step
+ * still \`running\` when it finishes. Exported for the folding rule.
  */
 export function tideOutcome(step: { kind: string; status?: string; rows?: number; error?: unknown }): StepOutcome {
   if (step.status === "declined") return "denied";
@@ -703,7 +704,8 @@ export function tideOutcome(step: { kind: string; status?: string; rows?: number
   const counted = typeof step.rows === "number" ? "succeeded" : "unknown";
   if (step.status === "completed") return step.kind === "read" ? counted : "succeeded";
   if (step.status === undefined && step.kind === "read") return counted;
-  return step.error ? "failed" : "unknown";
+  if (step.error) return "failed";
+  return step.status === undefined && step.kind === "gauge-sync" ? "succeeded" : "unknown";
 }

 function tideStepStatus(status: unknown): StepStatus {`;

const testPatch = `@@ -41,7 +41,9 @@ test("a finished step folds only when its outcome is known", () => {
   assert.equal(tideOutcome({ kind: "read", status: "completed", rows: 12 }), "succeeded");
   assert.equal(tideOutcome({ kind: "read", status: "declined" }), "denied");
   assert.equal(tideOutcome({ kind: "read" }), "unknown");
-  assert.equal(tideOutcome({ kind: "gauge-sync" }), "unknown");
+  // A gauge sync reports nothing but finishing: no status and no error means it finished.
+  assert.equal(tideOutcome({ kind: "gauge-sync" }), "succeeded");
+  assert.equal(tideOutcome({ kind: "gauge-sync", error: "timeout" }), "failed");
   assert.equal(tideOutcome({ kind: "export", status: "running" }), "unknown");
   assert.equal(tideOutcome({ kind: "export" }), "unknown");
 });`;

const docsPatch = `@@ -198,7 +198,7 @@ How a step's outcome is read:
 | \`completed\`, any other step | \`succeeded\` |
 | \`running\` when the step finishes | \`unknown\` |
 | no status, a read with a row count | from the row count |
-| no status (gauge sync), no error | \`unknown\` |
+| no status (gauge sync), no error | \`succeeded\`: a sync reports only that it finished |
 | no status, an error | \`failed\` |

 \`import/finished\` ends the run: \`completed\`, \`interrupted\` or \`failed\`.`;

const statusPatch = `@@ -64,6 +64,10 @@ Landed since the last release, newest first.
 ## On main, unreleased

+- **A finished gauge sync folds again.** A sync reports nothing but finishing, so a finished one
+  now reads as \`succeeded\` instead of \`unknown\`, and only steps that never reported stay open
+  ([tide tables](tide-tables.md#outcomes)).
+
 - **Imports keep their full log.** A long import's log is kept from the first byte up to 10 MiB.
   Show full log reads it back a page at a time.

 ## In flight`;

const R4_FILES: PrFiles = {
  revision: R4_REVISION,
  files: [
    { path: "apps/site/src/importers/tides.ts", previousPath: null, status: "modified", additions: 5, deletions: 3, patch: { kind: "text", patch: tidesPatch } },
    { path: "apps/site/test/tides.test.ts", previousPath: null, status: "modified", additions: 3, deletions: 1, patch: { kind: "text", patch: testPatch } },
    { path: "docs/tide-tables.md", previousPath: null, status: "modified", additions: 1, deletions: 1, patch: { kind: "text", patch: docsPatch } },
    { path: "docs/status.md", previousPath: null, status: "modified", additions: 4, deletions: 0, patch: { kind: "text", patch: statusPatch } },
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
  { path: "assets/basin-map.png", previousPath: null, status: "added", additions: 0, deletions: 0, patch: { kind: "omitted", reason: "binary" } },
  { path: "data/stations-2026.csv", previousPath: null, status: "added", additions: 48_210, deletions: 0, patch: { kind: "omitted", reason: "too-large" } },
];

export const FAULTS = {
  emptyInbox: ready<Inbox>({ account: ACCOUNT_A.id, query: "", groups: { authored: ready<PrSummary[]>([]), "review-requested": ready<PrSummary[]>([]) } }),
  signedOut: { state: "unavailable", reason: "signed-out", fetchedAt: NOW, detail: "Not signed in to GitHub CLI." } as ReadResult<Inbox>,
  noCli: { state: "no-cli", detail: "GitHub CLI (gh) was not found." } as CodeReviewConnection,
  denied: { state: "unavailable", reason: "denied", fetchedAt: NOW, detail: "This account can't see that repository." } as ReadResult<PrOverview>,
  /** An earlier inbox, kept while offline. */
  offline: { state: "stale", value: R1_INBOX, fetchedAt: "2026-10-18T20:10:00Z", reason: "offline" } as ReadResult<Inbox>,
  /** The first page of a 14-row group. */
  firstPage: ready(AUTHORED, { loaded: 10, total: 14, complete: false, next: "Y3Vyc29yOjEw" }),
  /** The second page failed: what arrived, without a total. */
  failedPage: { state: "partial", value: AUTHORED, fetchedAt: NOW, reason: "rate-limited", coverage: { loaded: 10, total: null, complete: false, next: "Y3Vyc29yOjEw" } } as ReadResult<PrSummary[]>,
  /** One of each outcome on R4's head, plus one result from the old head. */
  checks: ready<PrCheck[]>([
    check("301", "unit (node 24)", R4_REVISION.headSha, "completed", "success", "2026-10-18T20:28:00Z"),
    check("302", "e2e (macOS)", R4_REVISION.headSha, "completed", "failure", "2026-10-18T20:28:00Z"),
    check("303", "e2e (linux)", R4_REVISION.headSha, "completed", "timed-out", "2026-10-18T20:28:00Z"),
    check("304", "typecheck", R4_REVISION.headSha, "queued", null, null),
    check("305", "build", R4_REVISION.headSha, "running", null, "2026-10-18T20:29:00Z"),
    check("306", "links", R4_REVISION.headSha, "completed", "cancelled", "2026-10-18T20:28:00Z"),
    check("307", "lint docs", R4_REVISION.headSha, "completed", "neutral", "2026-10-18T20:28:00Z"),
    check("308", "store build", R4_REVISION.headSha, "completed", "skipped", "2026-10-18T20:28:00Z"),
    check("309", "coverage", R4_REVISION.headSha, "unknown", null, null),
    check("310", "unit (node 22)", R4_BEFORE.headSha, "completed", "success", "2026-10-18T19:10:00Z"),
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
  "inbox-page": { op: "inbox-page", requestId: "i-2", group: "authored", query: "", cursor: "Y3Vyc29yOjEw" },
  resolve: { op: "resolve", requestId: "s-1", input: "https://github.com/example-org/harbor-docs/pull/288" },
  overview: { op: "overview", requestId: "o-1", key: R1_OVERVIEW.key },
  activity: { op: "activity", requestId: "a-1", key: R1_OVERVIEW.key, cursor: null },
  checks: { op: "checks", requestId: "k-1", key: R1_OVERVIEW.key, revision: R1_REVISION },
  stack: { op: "stack", requestId: "t-1", key: R1_OVERVIEW.key },
  files: { op: "files", requestId: "f-1", key: R4_OVERVIEW.key, revision: R4_REVISION, cursor: null },
  context: { op: "context", requestId: "x-1", key: R4_OVERVIEW.key, revision: R4_REVISION, side: "head", path: "apps/site/src/importers/tides.ts", start: 680, end: 760 },
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
