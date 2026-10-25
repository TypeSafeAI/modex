import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CODE_REVIEW_FEATURES, acceptsReply, canonicalPrUrl, capabilities, diffCoverage, inboxGroup, isEmpty, knownCount, parsePrLocator, prKeyId,
  sameRevision, scopeOf, summarizeChecks, validateRequest,
  type Inbox, type PrCheck, type ReadResult,
} from "../src/shared/code-review.js";
import * as fx from "./fixtures/code-review.js";

/**
 * Code Review read contract (docs/design/code-review.md): a PR is named by a locator, read under an
 * account-scoped key and pinned to a revision. Unavailable is not empty, pending is not passing, a
 * reply for another account, repository, PR or head is dropped, and requests are bounded plain data.
 */

test("a pasted link names a github.com pull request and nothing else", () => {
  const guide = { host: "github.com", owner: "example-org", repo: "field-guide", number: 91 };
  for (const input of [
    "https://github.com/example-org/field-guide/pull/91",
    "https://github.com/example-org/field-guide/pull/91/files",
    "https://github.com/example-org/field-guide/pull/91/files#diff-abc123",
    "  https://www.github.com/example-org/field-guide/pull/91?w=1  ",
    "http://github.com/example-org/field-guide/pull/91",
    "github.com/example-org/field-guide/pull/91",
    "example-org/field-guide#91",
  ]) assert.deepEqual(parsePrLocator(input), guide, input);
  assert.equal(canonicalPrUrl(guide as never), "https://github.com/example-org/field-guide/pull/91");
  for (const input of [
    "", "   ", "91", "#91", "example-org/field-guide", "example-org/field-guide#0", "example-org/field-guide#-1", "example-org/field-guide#2.5",
    "example-org/field-guide#99999999999", "-org/field-guide#1", "example-org/..#1", "example-org/.#1",
    "https://gitlab.com/example-org/field-guide/pull/91",
    "https://github.com.example.test/example-org/field-guide/pull/91",
    "https://example.test/github.com/example-org/field-guide/pull/91",
    "https://user@github.com/example-org/field-guide/pull/91",
    "https://github.com:8443/example-org/field-guide/pull/91",
    "https://gist.github.com/example-org/field-guide/pull/91",
    "https://github.com/example-org/field-guide/issues/91",
    "https://github.com/example-org/field-guide/pull/091",
    "https://github.com/example-org/field-guide/pull/1e3",
    "https://github.com/example-org/%2e%2e/pull/91",
    "https://github.com/example-org/field-guide/../other/pull/91",
    "javascript:alert(1)//github.com/example-org/field-guide/pull/91",
    "file:///github.com/example-org/field-guide/pull/91",
    `https://github.com/example-org/${"r".repeat(101)}/pull/1`,
    "x".repeat(5000),
  ]) assert.equal(parsePrLocator(input), null, input);
});

test("a key tells apart two accounts, and two repositories that share a PR number", () => {
  const lending = fx.key(fx.ACCOUNT_A, fx.LENDING, 73);
  const guide = fx.key(fx.ACCOUNT_A, fx.FIELD_GUIDE, 73);
  const other = fx.key(fx.ACCOUNT_B, fx.LENDING, 73);
  assert.equal(new Set([prKeyId(lending), prKeyId(guide), prKeyId(other)]).size, 3);
  const request = { op: "overview" as const, requestId: "r-2", key: lending };
  const asked = { requestId: "r-2", op: request.op, scope: scopeOf(request, fx.ACCOUNT_A.id) };
  assert.equal(acceptsReply(asked, { ...asked }), true);
  assert.equal(acceptsReply(asked, { ...asked, requestId: "r-1" }), false, "an older request for the same PR");
  assert.equal(acceptsReply(asked, { ...asked, op: "stack" }), false, "another operation");
  assert.equal(acceptsReply(asked, { ...asked, scope: scopeOf({ ...request, key: guide }, fx.ACCOUNT_A.id) }), false, "same number, other repository");
  assert.equal(acceptsReply(asked, { ...asked, scope: scopeOf({ ...request, key: other }, fx.ACCOUNT_B.id) }), false, "other account");
  const inbox = { requestId: "i-1", op: "inbox" as const, scope: scopeOf(fx.REQUESTS.inbox, null) };
  assert.equal(acceptsReply(inbox, inbox), false, "an account-scoped read with no account applies nowhere");
});

test("a reply's scope is its request's, so main and the renderer agree; connection matches by id", () => {
  for (const request of Object.values(fx.REQUESTS)) {
    const asked = { requestId: request.requestId, op: request.op, scope: scopeOf(request, fx.ACCOUNT_A.id) };
    const reply = { requestId: request.requestId, op: request.op, scope: scopeOf(validateRequest(request)!, fx.ACCOUNT_A.id) };
    assert.equal(acceptsReply(asked, reply), true, request.op);
  }
  assert.equal(scopeOf(fx.REQUESTS.overview, fx.ACCOUNT_A.id).revision, null, "an overview names no revision; its value carries one");
  assert.deepEqual(scopeOf(fx.REQUESTS.files, null).revision, fx.R4.overview.revision);
  assert.equal(scopeOf(fx.REQUESTS.overview, fx.ACCOUNT_B.id).account, fx.ACCOUNT_A.id, "a key's own account, not whoever is asking");
  const before = { requestId: "c-1", op: "connection" as const, scope: scopeOf(fx.REQUESTS.connection, null) };
  assert.equal(acceptsReply(before, { ...before, scope: { account: fx.ACCOUNT_A.id, key: null, revision: null } }), true, "the reply that names the account");
  assert.equal(acceptsReply(before, { ...before, requestId: "c-0" }), false);
});

test("once the head moves, a reply or a diff for the old head is dropped or marked stale", () => {
  const { before, after, filesBefore } = fx.FAULTS.headChanged;
  assert.equal(sameRevision(before, after), false);
  assert.equal(sameRevision(before, { ...before }), true);
  const key = fx.key(fx.ACCOUNT_A, fx.FIELD_GUIDE, 91);
  const request = { op: "files" as const, requestId: "f-2", key, revision: after, cursor: null };
  const asked = { requestId: "f-2", op: request.op, scope: scopeOf(request, null) };
  assert.equal(acceptsReply(asked, { ...asked, scope: scopeOf({ ...request, revision: before }, null) }), false);
  assert.equal(filesBefore.state, "stale");
  assert.equal(filesBefore.state === "stale" && filesBefore.reason, "head-changed");
  assert.deepEqual(filesBefore.state === "stale" && filesBefore.value.revision, before, "a stale diff still says which head it shows");
  assert.equal(diffCoverage(filesBefore)?.complete, false, "a diff of an old head is not complete coverage of the PR");
});

test("an unavailable, stale or partly read list is not an empty one", () => {
  const authored = (inbox: ReadResult<Inbox>) => inboxGroup(inbox, "authored");
  assert.equal(isEmpty(authored(fx.FAULTS.emptyInbox)), true);
  assert.deepEqual(knownCount(authored(fx.FAULTS.emptyInbox)), { count: 0, exact: true });
  for (const group of [authored(fx.FAULTS.signedOut), authored(fx.FAULTS.offline), fx.FAULTS.firstPage, fx.FAULTS.failedPage]) {
    assert.equal(isEmpty(group), false, group.state);
  }
  assert.equal(authored(fx.FAULTS.signedOut).state, "unavailable", "a signed-out inbox has no groups to show");
  assert.equal(knownCount(authored(fx.FAULTS.signedOut)), null, "unavailable has no count");
  assert.equal(authored(fx.FAULTS.offline).state, "stale", "offline keeps the earlier list, marked as such");
  assert.deepEqual(knownCount(authored(fx.FAULTS.offline)), { count: 12, exact: false }, "a stale total is from then");
  assert.deepEqual(knownCount(fx.FAULTS.firstPage), { count: 12, exact: true }, "the provider's total, not the page");
  assert.deepEqual(knownCount(fx.FAULTS.failedPage), { count: 9, exact: false }, "what arrived, marked inexact");
  const partialEmpty: ReadResult<never[]> = { state: "partial", value: [], fetchedAt: fx.NOW, reason: "timeout", coverage: { loaded: 0, total: null, complete: false, next: null } };
  assert.equal(isEmpty(partialEmpty), false);
  const staleWithPartial: ReadResult<Inbox> = { state: "stale", fetchedAt: "2026-10-18T20:10:00Z", reason: "offline", value: { account: fx.ACCOUNT_A.id, query: "", groups: { authored: fx.FAULTS.failedPage, "review-requested": fx.FAULTS.firstPage } } };
  const group = authored(staleWithPartial);
  assert.equal(group.state, "stale", "a partial group of a stale inbox is stale too");
  assert.equal(group.state === "stale" && group.coverage?.complete, false, "and keeps its coverage");
  assert.deepEqual([fx.FAULTS.denied.state, fx.FAULTS.denied.state === "unavailable" && fx.FAULTS.denied.reason], ["unavailable", "denied"], "a PR the account can't see is unavailable, not missing");
});

test("pending, cancelled, unknown, superseded and other-head checks never read as passing", () => {
  const revision = fx.R4.overview.revision;
  const ready = (value: PrCheck[]): ReadResult<PrCheck[]> => ({ state: "ready", value, fetchedAt: fx.NOW });
  const passing = fx.R4.checks.state === "ready" ? fx.R4.checks.value : [];
  assert.equal(passing.length, 11);
  assert.equal(summarizeChecks(fx.R4.checks, revision).verdict, "passing");
  assert.equal(summarizeChecks(fx.R1.checks, fx.R1.overview.revision).verdict, "pending");
  const mixed = summarizeChecks(fx.FAULTS.checks, revision);
  assert.equal(mixed.verdict, "failing");
  assert.deepEqual(
    [mixed.passed, mixed.failed, mixed.pending, mixed.cancelled, mixed.neutral, mixed.skipped, mixed.unknown, mixed.stale, mixed.superseded],
    [1, 2, 2, 1, 1, 1, 1, 1, 0],
  );
  const one = passing[0]!;
  assert.equal(summarizeChecks(ready([{ ...one, conclusion: "cancelled" }]), revision).verdict, "incomplete");
  assert.equal(summarizeChecks(ready([{ ...one, status: "unknown", conclusion: null }]), revision).verdict, "incomplete");
  assert.equal(summarizeChecks(ready([{ ...one, headSha: fx.FAULTS.headChanged.before.headSha }]), revision).verdict, "incomplete", "only an old head's results");
  assert.equal(summarizeChecks(ready([]), revision).verdict, "none");
  assert.equal(summarizeChecks({ state: "unavailable", reason: "offline", fetchedAt: fx.NOW }, revision).verdict, "unknown");
  assert.equal(summarizeChecks({ state: "partial", value: passing, fetchedAt: fx.NOW, reason: "rate-limited", coverage: { loaded: 11, total: 20, complete: false, next: "p2" } }, revision).verdict, "incomplete");
  assert.equal(summarizeChecks({ state: "stale", value: passing, fetchedAt: fx.NOW, reason: "offline" }, revision).verdict, "incomplete");
  const rerun = summarizeChecks(fx.FAULTS.rerun, revision);
  assert.deepEqual([rerun.verdict, rerun.passed, rerun.failed, rerun.superseded], ["passing", 1, 0, 1], "a passing re-run replaces the failure it repeats");
  const runs = fx.FAULTS.rerun.state === "ready" ? fx.FAULTS.rerun.value : [];
  const regressed = summarizeChecks(ready([{ ...runs[1]!, id: "401" }, { ...runs[0]!, id: "402" }]), revision);
  assert.equal(regressed.verdict, "failing", "a failing re-run replaces the pass it repeats");
  const sameName = summarizeChecks(fx.FAULTS.sameName, revision);
  assert.deepEqual([sameName.verdict, sameName.superseded], ["failing", 0], "another reporter's check of the same name is not a re-run");
  const named = (id: string, startedAt: string | null, conclusion: PrCheck["conclusion"]): PrCheck =>
    ({ ...runs[0]!, id, startedAt, status: startedAt ? "completed" : "queued", conclusion });
  const queued = summarizeChecks(ready([named("run-a", "2026-10-18T20:23:00Z", "failure"), named("run-b", null, null)]), revision);
  assert.deepEqual([queued.verdict, queued.pending, queued.superseded], ["pending", 1, 1], "without numeric ids, a queued re-run is the latest");
});

test("diff coverage says when files or patches are missing, and a binary file is not a gap", () => {
  assert.deepEqual(diffCoverage(fx.R4.files), { files: 4, total: 4, complete: true, binary: 0, missing: 0 });
  assert.deepEqual(diffCoverage(fx.FAULTS.truncatedFiles), { files: 3000, total: 3412, complete: false, binary: 1, missing: 1 });
  assert.equal(diffCoverage({ state: "unavailable", reason: "denied", fetchedAt: fx.NOW }), null);
  const files = fx.FAULTS.truncatedFiles.state === "partial" ? fx.FAULTS.truncatedFiles.value.files : [];
  const tooLarge = files.find((file) => file.patch.kind === "omitted" && file.patch.reason === "too-large")!;
  assert.ok(tooLarge.additions > 0, "a missing patch keeps the provider's line counts: it is not a zero-line change");
});

test("requests are bounded plain data, rebuilt from validated fields", () => {
  for (const request of Object.values(fx.REQUESTS)) assert.deepEqual(validateRequest(request), request, request.op);
  const { overview, context, files } = fx.REQUESTS;
  const bad: [string, unknown][] = [
    ["not an object", "overview"],
    ["array", [overview]],
    ["unknown op", { ...overview, op: "merge" }],
    ["inherited op name", { ...overview, op: "toString" }],
    ["extra field", { ...overview, url: "https://example.test" }],
    ["request id", { ...overview, requestId: "has spaces" }],
    ["no request id", { op: "connection" }],
    ["host", { ...overview, key: { ...overview.key, host: "gitlab.com" } }],
    ["PR zero", { ...overview, key: { ...overview.key, number: 0 } }],
    ["PR fraction", { ...overview, key: { ...overview.key, number: 1.5 } }],
    ["account login, not id", { ...overview, key: { ...overview.key, account: "ada-fixture" } }],
    ["repo id", { ...overview, key: { ...overview.key, repoId: "../repos" } }],
    ["short sha", { ...files, revision: { ...files.revision, headSha: "abc123" } }],
    ["ref range", { ...files, revision: { ...files.revision, baseRef: "main..evil" } }],
    ["ref with a bidi override", { ...files, revision: { ...files.revision, baseRef: "main‮" } }],
    ["cursor", { ...files, cursor: "next page" }],
    ["absolute path", { ...context, path: "/etc/passwd" }],
    ["parent path", { ...context, path: "docs/../../secrets" }],
    ["empty segment", { ...context, path: "docs//holds.md" }],
    ["dot segment", { ...context, path: "./docs/holds.md" }],
    ["control character", { ...context, path: "docs/a\u0000b" }],
    ["C1 control character", { ...context, path: "docs/a\u0085b" }],
    ["line separator", { ...context, path: "docs/a\u2028b" }],
    ["bidi override in a path", { ...context, path: "src/holds/‮move.ts" }],
    ["zero-width joiner in a path", { ...context, path: "src/ho‍lds.ts" }],
    ["lone surrogate in a path", { ...context, path: "src/\ud800.ts" }],
    ["lone surrogate in a query", { op: "inbox", requestId: "i-9", query: "\udc00" }],
    ["side", { ...context, side: "working-tree" }],
    ["range order", { ...context, start: 20, end: 10 }],
    ["range size", { ...context, start: 1, end: 100_000 }],
    ["signal", { ...overview, key: { ...overview.key, signal: { aborted: false, addEventListener() {} } } }],
    ["class instance", Object.assign(new (class Request {})(), overview)],
    ["query length", { op: "inbox", requestId: "i-9", query: "q".repeat(257) }],
    ["resolve length", { op: "resolve", requestId: "s-9", input: "x".repeat(2049) }],
    ["page group", { op: "inbox-page", requestId: "i-9", group: "everything", query: "", cursor: "p2" }],
    ["page without cursor", { op: "inbox-page", requestId: "i-9", group: "authored", query: "", cursor: null }],
  ];
  for (const [label, input] of bad) assert.equal(validateRequest(input), null, label);
  for (const path of ["docs/a\\b.md", "docs/100%.md", "docs/why?.md", "docs/#1.md", "docs/sérénité.md"]) {
    assert.ok(validateRequest({ ...context, path }), `${path} is a real file name; main encodes it`);
  }
  const rebuilt = validateRequest(overview);
  assert.notEqual(rebuilt, overview, "main works on its own copy");
  assert.equal(rebuilt?.op === "overview" && rebuilt.key === overview.key, false, "nested objects are copied too");
});

test("Gate A: reads, comments and reviews follow the connection; agent review and the other writes stay unavailable with a reason", () => {
  const connected = capabilities(fx.R1.connection.state === "ready" ? fx.R1.connection.value : fx.FAULTS.noCli);
  assert.deepEqual(connected.read, { available: true });
  for (const connection of [fx.FAULTS.noCli, { state: "signed-out", detail: "Not signed in." } as const]) {
    const read = capabilities(connection).read;
    assert.equal(read.available, false);
    assert.ok(!read.available && read.reason.length > 0 && read.owner === null, "the person fixes this, not an issue");
  }
  for (const feature of ["comment", "submit-review"] as const) {
    assert.deepEqual(connected[feature], { available: true }, feature);
    assert.deepEqual(capabilities(fx.FAULTS.noCli)[feature], capabilities(fx.FAULTS.noCli).read, feature);
  }
  for (const feature of CODE_REVIEW_FEATURES.filter((f) => !["read", "comment", "submit-review"].includes(f))) {
    const capability = connected[feature];
    assert.equal(capability.available, false, feature);
    assert.ok(!capability.available && capability.reason.length > 0 && /^#32[56]$/.test(capability.owner ?? ""), feature);
  }
});

test("fixtures are deterministic data: serializable, fixed timestamps, consistent patches, no I/O", () => {
  const data = { NOW: fx.NOW, R1: fx.R1, R2: fx.R2, R3: fx.R3, R4: fx.R4, FAULTS: fx.FAULTS, REQUESTS: fx.REQUESTS, REFERENCES: fx.REFERENCES };
  assert.deepEqual(JSON.parse(JSON.stringify(data)), data, "nothing but JSON values");
  assert.deepEqual(fx.stressFiles(3), fx.stressFiles(3), "generated fixtures repeat exactly");
  const stamps = JSON.stringify(data).match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g) ?? [];
  assert.ok(stamps.length > 20);
  for (const stamp of stamps) assert.ok(stamp <= fx.NOW, `${stamp} is not after the fixture clock`);
  // Template literals (the fixture patches) are data: blank them so only code is scanned.
  const source = readFileSync(new URL("./fixtures/code-review.js", import.meta.url), "utf8").replace(/`(?:\\[\s\S]|[^\\`])*`/g, "``");
  const imports = [...source.matchAll(/\bfrom\s+["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']|\brequire\s*\(\s*["']([^"']+)["']/g)].map((m) => m[1] ?? m[2] ?? m[3]);
  assert.ok(imports.every((specifier) => specifier === "../../src/shared/code-review.js"), `fixtures import only the contract, nothing that can reach a network, model or disk: ${imports.join(", ")}`);
  assert.doesNotMatch(source, /\bfetch\s*\(|process\.|globalThis/);
  for (const result of [inboxGroup(fx.R1.inbox, "authored"), inboxGroup(fx.R1.inbox, "review-requested"), fx.FAULTS.firstPage, fx.FAULTS.failedPage]) {
    if (result.state !== "unavailable" && result.coverage) assert.equal(result.coverage.loaded, result.value.length, "coverage counts what the fixture holds");
  }
  for (const result of [fx.R4.files, fx.FAULTS.truncatedFiles]) {
    if (result.state !== "unavailable" && result.coverage) assert.equal(result.coverage.loaded, result.value.files.length);
  }
  const files = fx.R4.files.state === "ready" ? fx.R4.files.value.files : [];
  for (const file of [...files, ...fx.stressFiles(2)]) {
    if (file.patch.kind !== "text") continue;
    let added = 0;
    let removed = 0;
    for (const hunk of file.patch.patch.split(/^(?=@@ )/m)) {
      const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(hunk)!;
      const lines = hunk.split("\n").slice(1).filter((line) => line !== "");
      const old = lines.filter((line) => line[0] === " " || line[0] === "-").length;
      const now = lines.filter((line) => line[0] === " " || line[0] === "+").length;
      assert.deepEqual([old, now], [Number(header[2] ?? 1), Number(header[4] ?? 1)], `${file.path}: ${header[0]} counts its lines`);
      added += lines.filter((line) => line[0] === "+").length;
      removed += lines.filter((line) => line[0] === "-").length;
    }
    assert.deepEqual([added, removed], [file.additions, file.deletions], `${file.path}: its totals are its patch's`);
  }
  const totals = files.reduce((sum, file) => [sum[0]! + file.additions, sum[1]! + file.deletions], [0, 0]);
  assert.deepEqual(totals, [fx.R4.overview.totals.additions, fx.R4.overview.totals.deletions], "R4's files add up to its overview");
});

test("the reference manifest and control inventory in the design doc match the fixtures", () => {
  const doc = readFileSync(new URL("../../../../docs/design/code-review.md", import.meta.url), "utf8");
  const signed = (n: number) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : "0");
  for (const reference of fx.REFERENCES) {
    const row = doc.split("\n").find((line) => line.startsWith(`| ${reference.id} | ${reference.file} |`));
    assert.ok(row, `${reference.id} has a manifest row`);
    for (const cell of [
      `${reference.pixels.width}×${reference.pixels.height}`, `\`${reference.sha256}\``, ` ${reference.devicePixelsPerCss} `,
      `${reference.css.width}×${reference.css.height}`, `${signed(reference.offset.x)}, ${signed(reference.offset.y)}`, reference.capturedAt.slice(11, 19),
    ]) assert.ok(row!.includes(cell), `${reference.id} row records ${cell}`);
  }
  const inventory = doc.slice(doc.indexOf("## Control inventory"), doc.indexOf("\n## ", doc.indexOf("## Control inventory") + 1));
  const rows = inventory.split("\n").filter((line) => /^\| C\d{2} /.test(line)).map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()));
  assert.ok(rows.length >= 40, `${rows.length} controls inventoried`);
  const owners = /^(#32[2-7]|shell|native chrome|deferred|needs decision)$/;
  const ids = new Set<string>();
  for (const [id, refs, , control, owner, evidence] of rows as string[][]) {
    assert.ok(!ids.has(id!), `${id} is unique`);
    ids.add(id!);
    assert.match(refs!, /^R[1-4](, R[1-4])*$/, `${id} names its references`);
    assert.match(owner!, owners, `${id} ${control} has an owner`);
    assert.ok((evidence ?? "").length > 0, `${id} ${control} names its test or evidence`);
  }
  for (const ref of ["R1", "R2", "R3", "R4"]) assert.ok(rows.some((row) => row[1]!.includes(ref)), `${ref} has controls`);
});
