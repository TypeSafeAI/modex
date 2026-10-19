import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CODE_REVIEW_FEATURES, acceptsReply, canonicalPrUrl, capabilities, diffCoverage, inboxGroup, isEmpty, knownCount, parsePrLocator, prKeyId,
  sameRevision, summarizeChecks, validateRequest,
  type Inbox, type PrCheck, type ReadResult,
} from "../src/shared/code-review.js";
import * as fx from "./fixtures/code-review.js";

/**
 * Code Review read contract (docs/design/code-review.md): a PR is named by a locator, read under an
 * account-scoped key and pinned to a revision. Unavailable is not empty, pending is not passing, a
 * reply for another account, repository, PR or head is dropped, and requests are bounded plain data.
 */

test("a pasted link names a github.com pull request and nothing else", () => {
  const harbor = { host: "github.com", owner: "example-org", repo: "harbor-docs", number: 288 };
  for (const input of [
    "https://github.com/example-org/harbor-docs/pull/288",
    "https://github.com/example-org/harbor-docs/pull/288/files",
    "https://github.com/example-org/harbor-docs/pull/288/files#diff-abc123",
    "  https://www.github.com/example-org/harbor-docs/pull/288?w=1  ",
    "http://github.com/example-org/harbor-docs/pull/288",
    "github.com/example-org/harbor-docs/pull/288",
    "example-org/harbor-docs#288",
  ]) assert.deepEqual(parsePrLocator(input), harbor, input);
  assert.equal(canonicalPrUrl(harbor as never), "https://github.com/example-org/harbor-docs/pull/288");
  for (const input of [
    "", "   ", "288", "#288", "example-org/harbor-docs", "example-org/harbor-docs#0", "example-org/harbor-docs#-1", "example-org/harbor-docs#2.5",
    "example-org/harbor-docs#99999999999", "-org/harbor-docs#1", "example-org/..#1", "example-org/.#1",
    "https://gitlab.com/example-org/harbor-docs/pull/288",
    "https://github.com.example.test/example-org/harbor-docs/pull/288",
    "https://example.test/github.com/example-org/harbor-docs/pull/288",
    "https://user@github.com/example-org/harbor-docs/pull/288",
    "https://github.com:8443/example-org/harbor-docs/pull/288",
    "https://gist.github.com/example-org/harbor-docs/pull/288",
    "https://github.com/example-org/harbor-docs/issues/288",
    "https://github.com/example-org/harbor-docs/pull/0288",
    "https://github.com/example-org/harbor-docs/pull/1e3",
    "https://github.com/example-org/%2e%2e/pull/288",
    "https://github.com/example-org/harbor-docs/../other/pull/288",
    "javascript:alert(1)//github.com/example-org/harbor-docs/pull/288",
    "file:///github.com/example-org/harbor-docs/pull/288",
    `https://github.com/example-org/${"r".repeat(101)}/pull/1`,
    "x".repeat(5000),
  ]) assert.equal(parsePrLocator(input), null, input);
});

test("a key tells apart two accounts, and two repositories that share a PR number", () => {
  const ids = new Set([
    prKeyId(fx.key(fx.ACCOUNT_A, fx.RESERVOIR, 519)),
    prKeyId(fx.key(fx.ACCOUNT_A, fx.HARBOR, 519)),
    prKeyId(fx.key(fx.ACCOUNT_B, fx.RESERVOIR, 519)),
  ]);
  assert.equal(ids.size, 3);
  const scope = { account: fx.ACCOUNT_A.id, key: fx.key(fx.ACCOUNT_A, fx.RESERVOIR, 519), revision: null };
  const asked = { requestId: "r-2", scope };
  assert.equal(acceptsReply(asked, { requestId: "r-2", scope }), true);
  assert.equal(acceptsReply(asked, { requestId: "r-1", scope }), false, "an older request for the same PR");
  assert.equal(acceptsReply(asked, { requestId: "r-2", scope: { ...scope, key: fx.key(fx.ACCOUNT_A, fx.HARBOR, 519) } }), false, "same number, other repository");
  assert.equal(acceptsReply(asked, { requestId: "r-2", scope: { ...scope, account: fx.ACCOUNT_B.id, key: fx.key(fx.ACCOUNT_B, fx.RESERVOIR, 519) } }), false, "other account");
  assert.equal(acceptsReply({ requestId: "i-1", scope: { account: null, key: null, revision: null } }, { requestId: "i-1", scope: { account: null, key: null, revision: null } }), false, "no account, no reply");
});

test("once the head moves, a reply or a diff for the old head is dropped or marked stale", () => {
  const { before, after, filesBefore } = fx.FAULTS.headChanged;
  assert.equal(sameRevision(before, after), false);
  assert.equal(sameRevision(before, { ...before }), true);
  const key = fx.key(fx.ACCOUNT_A, fx.HARBOR, 288);
  const asked = { requestId: "f-2", scope: { account: fx.ACCOUNT_A.id, key, revision: after } };
  assert.equal(acceptsReply(asked, { requestId: "f-2", scope: { account: fx.ACCOUNT_A.id, key, revision: before } }), false);
  assert.equal(filesBefore.state, "stale");
  assert.equal(filesBefore.state === "stale" && filesBefore.reason, "head-changed");
  assert.deepEqual(filesBefore.state === "stale" && filesBefore.value.revision, before, "a stale diff still says which head it shows");
  assert.equal(diffCoverage(filesBefore)?.complete, false, "a diff of an old head is not complete coverage of the PR");
});

test("an unavailable or partly read list is not an empty one", () => {
  const authored = (inbox: ReadResult<Inbox>) => inboxGroup(inbox, "authored");
  assert.equal(isEmpty(authored(fx.FAULTS.emptyInbox)), true);
  assert.deepEqual(knownCount(authored(fx.FAULTS.emptyInbox)), { count: 0, exact: true });
  for (const group of [authored(fx.FAULTS.signedOut), authored(fx.FAULTS.offline), fx.FAULTS.firstPage, fx.FAULTS.failedPage]) {
    assert.equal(isEmpty(group), false, group.state);
  }
  assert.equal(authored(fx.FAULTS.signedOut).state, "unavailable", "a signed-out inbox has no groups to show");
  assert.equal(authored(fx.FAULTS.offline).state, "stale", "offline keeps the earlier list, marked as such");
  assert.equal(knownCount(authored(fx.FAULTS.signedOut)), null, "unavailable has no count");
  assert.deepEqual(knownCount(fx.FAULTS.firstPage), { count: 14, exact: true }, "the provider's total, not the page");
  assert.deepEqual(knownCount(fx.FAULTS.failedPage), { count: 10, exact: false }, "what arrived, marked inexact");
  const partialEmpty: ReadResult<never[]> = { state: "partial", value: [], fetchedAt: fx.NOW, reason: "timeout", coverage: { loaded: 0, total: null, complete: false, next: null } };
  assert.equal(isEmpty(partialEmpty), false);
});

test("pending, cancelled, unknown and other-head checks never read as passing", () => {
  const revision = fx.R4.overview.revision;
  const ready = (value: PrCheck[]): ReadResult<PrCheck[]> => ({ state: "ready", value, fetchedAt: fx.NOW });
  const passing = fx.R4.checks.state === "ready" ? fx.R4.checks.value : [];
  assert.equal(passing.length, 13);
  assert.equal(summarizeChecks(fx.R4.checks, revision).verdict, "passing");
  assert.equal(summarizeChecks(fx.R1.checks, fx.R1.overview.revision).verdict, "pending");
  const mixed = summarizeChecks(fx.FAULTS.checks, revision);
  assert.equal(mixed.verdict, "failing");
  assert.deepEqual(
    [mixed.passed, mixed.failed, mixed.pending, mixed.cancelled, mixed.neutral, mixed.skipped, mixed.unknown, mixed.stale],
    [1, 2, 2, 1, 1, 1, 1, 1],
  );
  const one = passing[0]!;
  assert.equal(summarizeChecks(ready([{ ...one, conclusion: "cancelled" }]), revision).verdict, "incomplete");
  assert.equal(summarizeChecks(ready([{ ...one, status: "unknown", conclusion: null }]), revision).verdict, "incomplete");
  assert.equal(summarizeChecks(ready([{ ...one, headSha: fx.FAULTS.headChanged.before.headSha }]), revision).verdict, "incomplete", "only an old head's results");
  assert.equal(summarizeChecks(ready([]), revision).verdict, "none");
  assert.equal(summarizeChecks({ state: "unavailable", reason: "offline", fetchedAt: fx.NOW }, revision).verdict, "unknown");
  assert.equal(summarizeChecks({ state: "partial", value: passing, fetchedAt: fx.NOW, reason: "rate-limited", coverage: { loaded: 13, total: 20, complete: false, next: "p2" } }, revision).verdict, "incomplete");
  assert.equal(summarizeChecks({ state: "stale", value: passing, fetchedAt: fx.NOW, reason: "offline" }, revision).verdict, "incomplete");
});

test("diff coverage says when files or patches are missing, and a binary file is not a gap", () => {
  assert.deepEqual(diffCoverage(fx.R4.files), { files: 4, total: 4, complete: true, binary: 0, missing: 0 });
  const truncated = diffCoverage(fx.FAULTS.truncatedFiles);
  assert.deepEqual(truncated, { files: 3000, total: 3412, complete: false, binary: 1, missing: 1 });
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
    ["extra field", { ...overview, url: "https://example.test" }],
    ["request id", { ...overview, requestId: "has spaces" }],
    ["no request id", { op: "connection" }],
    ["host", { ...overview, key: { ...overview.key, host: "gitlab.com" } }],
    ["PR zero", { ...overview, key: { ...overview.key, number: 0 } }],
    ["PR fraction", { ...overview, key: { ...overview.key, number: 1.5 } }],
    ["account login, not id", { ...overview, key: { ...overview.key, account: "ada-fixture" } }],
    ["repo id", { ...overview, key: { ...overview.key, repoId: "../repos" } }],
    ["short sha", { ...files, revision: { ...files.revision, headSha: "abc123" } }],
    ["ref", { ...files, revision: { ...files.revision, baseRef: "main..evil" } }],
    ["cursor", { ...files, cursor: "next page" }],
    ["absolute path", { ...context, path: "/etc/passwd" }],
    ["parent path", { ...context, path: "docs/../../secrets" }],
    ["empty segment", { ...context, path: "docs//status.md" }],
    ["dot segment", { ...context, path: "./docs/status.md" }],
    ["control character", { ...context, path: "docs/a\u0000b" }],
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
  const rebuilt = validateRequest(overview);
  assert.notEqual(rebuilt, overview, "main works on its own copy");
  assert.equal(rebuilt?.op === "overview" && rebuilt.key === overview.key, false, "nested objects are copied too");
});

test("Gate A: reads follow the connection, and review and every write stay unavailable with a reason", () => {
  const connected = capabilities(fx.R1.connection.state === "ready" ? fx.R1.connection.value : fx.FAULTS.noCli);
  assert.deepEqual(connected.read, { available: true });
  for (const connection of [fx.FAULTS.noCli, { state: "signed-out", detail: "Not signed in." } as const]) {
    const read = capabilities(connection).read;
    assert.equal(read.available, false);
    assert.ok(!read.available && read.reason.length > 0);
  }
  for (const feature of CODE_REVIEW_FEATURES.filter((f) => f !== "read")) {
    const capability = connected[feature];
    assert.equal(capability.available, false, feature);
    assert.ok(!capability.available && capability.reason.length > 0 && /^#32[56]$/.test(capability.owner), feature);
  }
});

test("fixtures are deterministic data: serializable, fixed timestamps, no I/O", () => {
  const data = { NOW: fx.NOW, R1: fx.R1, R2: fx.R2, R3: fx.R3, R4: fx.R4, FAULTS: fx.FAULTS, REQUESTS: fx.REQUESTS, REFERENCES: fx.REFERENCES };
  assert.deepEqual(JSON.parse(JSON.stringify(data)), data, "nothing but JSON values");
  assert.deepEqual(fx.stressFiles(3), fx.stressFiles(3), "generated fixtures repeat exactly");
  const stamps = JSON.stringify(data).match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g) ?? [];
  assert.ok(stamps.length > 20);
  for (const stamp of stamps) assert.ok(stamp <= fx.NOW, `${stamp} is not after the fixture clock`);
  const source = readFileSync(new URL("./fixtures/code-review.js", import.meta.url), "utf8");
  const imports = [...source.matchAll(/\bfrom\s+["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']|\brequire\s*\(\s*["']([^"']+)["']/g)].map((m) => m[1] ?? m[2] ?? m[3]);
  assert.ok(imports.every((specifier) => specifier === "../../src/shared/code-review.js"), `fixtures import only the contract, nothing that can reach a network, model or disk: ${imports.join(", ")}`);
  assert.doesNotMatch(source, /\bfetch\s*\(|process\.|globalThis/);
  for (const result of [inboxGroup(fx.R1.inbox, "authored"), inboxGroup(fx.R1.inbox, "review-requested"), fx.FAULTS.firstPage, fx.FAULTS.failedPage]) {
    if (result.state !== "unavailable" && result.coverage) assert.equal(result.coverage.loaded, result.value.length, "coverage counts what the fixture holds");
  }
  for (const result of [fx.R4.files, fx.FAULTS.truncatedFiles]) {
    if (result.state !== "unavailable" && result.coverage) assert.equal(result.coverage.loaded, result.value.files.length);
  }
});

test("the reference manifest and control inventory in the design doc match the fixtures", () => {
  const doc = readFileSync(new URL("../../../../docs/design/code-review.md", import.meta.url), "utf8");
  for (const reference of fx.REFERENCES) {
    assert.ok(doc.includes(reference.sha256), `${reference.id} checksum is recorded`);
    assert.ok(doc.includes(reference.file), `${reference.id} file name is recorded`);
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
