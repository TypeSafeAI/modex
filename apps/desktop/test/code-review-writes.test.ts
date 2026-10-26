import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GhAnswer } from "../src/main/engine/code-review/gh.js";
import { DRAFT_MUTATIONS, ghWriteArgs, type GhWriteCall } from "../src/main/engine/code-review-actions/write-gh.js";
import { CodeReviewWrites } from "../src/main/engine/code-review-actions/write-service.js";
import { intentMarker, validateWrite, type WriteReply, type WriteRequest } from "../src/shared/code-review-write.js";
import type { LineAnchor, PrKey, PrRevision } from "../src/shared/code-review.js";

/**
 * CR-7 (#326): the main-owned `code-review:write` service over a synthetic GitHub. Everything below is made
 * up. Shapes follow GitHub's REST answers (API 2022-11-28): `GET /repositories/{id}` carries the signed-in
 * account's `permissions`, a pull carries `locked`, a created comment or review answers 201/200 with its id.
 */
const nativeTest = process.platform === "win32" ? test.skip : test;
const sha = (c: string) => c.repeat(40);
const ADA = { id: 1001, login: "ada-fixture", type: "User" };
const KIT = { id: 2002, login: "kit-fixture", type: "User" };
const LENDING = { id: 7301, full_name: "example-org/lending", name: "lending", owner: { login: "example-org" }, default_branch: "main" };
const KEY: PrKey = { account: "1001", host: "github.com", repoId: "7301", number: 73 };
const REV: PrRevision = { baseRef: "main", baseSha: sha("b"), headSha: sha("c") };
const ok = (status: number, body: unknown, headers: Record<string, string> = {}): GhAnswer => ({ kind: "http", status, headers, body: Buffer.from(JSON.stringify(body)) });

class FakeGitHub {
  user: typeof ADA | null = ADA;
  stamp = "hosts-1";
  permissions: Record<string, boolean> | undefined = { admin: false, maintain: false, push: false, triage: false, pull: true };
  /** The repository's merge settings, as GitHub shows them to an account with push access. */
  settings: Record<string, boolean> | null = { allow_merge_commit: false, allow_squash_merge: true, allow_rebase_merge: true };
  /** The target branch's active ruleset rules. */
  rules: { type: string }[] | null = [{ type: "pull_request" }];
  pr = { id: 7301073, number: 73, title: "Lend a hold", body: "", state: "open", draft: false, merged_at: null as string | null, locked: false, user: KIT,
    mergeable: true as boolean | null, mergeable_state: "clean", merged: false, merged_by: null as typeof ADA | null, merge_commit_sha: null as string | null,
    node_id: "PR_kwFixture73", requested_reviewers: [] as { id: number; login: string; type: string }[],
    created_at: "2026-10-18T10:00:00Z", updated_at: "2026-10-19T09:00:00Z", base: { ref: "main", sha: sha("b"), repo: LENDING },
    head: { ref: "topic-73", sha: sha("c"), repo: LENDING }, changed_files: 1, additions: 1, deletions: 0, commits: 1, comments: 0, review_comments: 0 };
  edits = 0;
  mergeBase = sha("a");
  comments: { id: number; user: typeof ADA; body: string }[] = [];
  reviews: { id: number; user: typeof ADA; body: string; state: string; commit_id: string }[] = [];
  next = 500;
  calls: GhWriteCall[] = [];
  /** Answers to force, by method and endpoint pattern. `after`: the remote change happens, then this answer. */
  overrides: { method: string; pattern: RegExp; answer: GhAnswer; after?: boolean }[] = [];
  gates: { pattern: RegExp; open: Promise<void> }[] = [];

  hold(pattern: RegExp): () => void {
    let release!: () => void;
    this.gates.push({ pattern, open: new Promise<void>((resolve) => { release = resolve; }) });
    return () => release();
  }
  posts(): GhWriteCall[] { return this.calls.filter((c) => c.method === "POST"); }
  merges(): GhWriteCall[] { return this.calls.filter((c) => c.method === "PUT"); }
  mutations(): GhWriteCall[] { return this.calls.filter((c) => c.method !== "GET"); }

  transport = async (call: GhWriteCall): Promise<GhAnswer> => {
    ghWriteArgs(call);
    this.calls.push(structuredClone(call));
    for (const gate of this.gates) if (gate.pattern.test(call.endpoint)) await gate.open;
    const forced = this.overrides.find((o) => o.method === call.method && o.pattern.test(call.endpoint));
    if (forced && !forced.after) return forced.answer;
    const answer = this.answer(call);
    return forced ? forced.answer : answer;
  };

  private answer(call: GhWriteCall): GhAnswer {
    const e = call.endpoint;
    if (e === "user") return this.user ? ok(200, this.user) : { kind: "signed-out" };
    if (e === "repositories/7301") return ok(200, { ...LENDING, ...(this.permissions ? { permissions: this.permissions } : {}), ...(this.settings ?? {}) });
    if (e === "repos/example-org/lending/rules/branches/main?per_page=100&page=1") return this.rules ? ok(200, this.rules) : ok(403, { message: "Resource not accessible" });
    const touch = () => { this.pr.updated_at = `2026-10-25T12:00:${String(++this.edits).padStart(2, "0")}Z`; };
    if (call.method === "PATCH" && e === "repos/example-org/lending/pulls/73") {
      Object.assign(this.pr, call.input);
      touch();
      return ok(200, this.pr);
    }
    if (call.method === "POST" && e === "repos/example-org/lending/pulls/73/requested_reviewers") {
      for (const login of call.input!.reviewers as string[]) this.pr.requested_reviewers.push({ id: 3000 + this.pr.requested_reviewers.length, login, type: "User" });
      touch();
      return ok(201, this.pr);
    }
    if (call.method === "POST" && e === "graphql") {
      const draft = call.input!.query === DRAFT_MUTATIONS.draft;
      if ((call.input!.variables as { id: string }).id !== this.pr.node_id) return ok(200, { data: null, errors: [{ type: "NOT_FOUND" }] });
      this.pr.draft = draft;
      touch();
      return ok(200, { data: { [draft ? "convertPullRequestToDraft" : "markPullRequestReadyForReview"]: { pullRequest: { isDraft: draft, updatedAt: this.pr.updated_at } } } });
    }
    if (call.method === "PUT" && e === "repos/example-org/lending/pulls/73/merge") {
      if (call.input!.sha !== this.pr.head.sha) return ok(409, { message: "Head branch was modified. Review and try the merge again." });
      Object.assign(this.pr, { merged: true, merged_at: "2026-10-25T12:00:00Z", state: "closed", merged_by: this.user, merge_commit_sha: sha("e"), mergeable: null, mergeable_state: "unknown" });
      return ok(200, { sha: sha("e"), merged: true, message: "Pull Request successfully merged" });
    }
    if (e === "repos/example-org/lending/pulls/73") return ok(200, this.pr);
    if (e.startsWith("repos/example-org/lending/compare/")) return ok(200, { base_commit: { sha: this.pr.base.sha }, merge_base_commit: { sha: this.mergeBase } });
    const page = Number(/[?&]page=(\d+)/.exec(e)?.[1] ?? 1);
    if (e.startsWith("repos/example-org/lending/issues/73/comments?")) return ok(200, this.comments.slice((page - 1) * 100, page * 100));
    if (e.startsWith("repos/example-org/lending/pulls/73/reviews?")) return ok(200, this.reviews.slice((page - 1) * 100, page * 100));
    if (call.method === "POST" && e === "repos/example-org/lending/issues/73/comments") {
      const created = { id: this.next++, user: this.user!, body: String(call.input!.body) };
      this.comments.push(created);
      return ok(201, created);
    }
    if (call.method === "POST" && e === "repos/example-org/lending/pulls/73/reviews") {
      const event = String(call.input!.event);
      const created = { id: this.next++, user: this.user!, body: String(call.input!.body), commit_id: String(call.input!.commit_id),
        state: event === "APPROVE" ? "APPROVED" : event === "REQUEST_CHANGES" ? "CHANGES_REQUESTED" : "COMMENTED" };
      this.reviews.push(created);
      return ok(200, created);
    }
    return ok(404, { message: "Not Found" });
  }
}

let ids = 0;
function fixture(t: { after(fn: () => void): void }, gh = new FakeGitHub()) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "modex-cr7w-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const open = () => new CodeReviewWrites({ home, transport: gh.transport, identityStamp: () => gh.stamp });
  let service = open();
  const ask = async <K extends WriteRequest["op"]>(request: Omit<Extract<WriteRequest, { op: K }>, "requestId">, session = "window-1"): Promise<WriteReply<K>> =>
    await service.handle({ ...request, requestId: `w${++ids}` }, session) as WriteReply<K>;
  const value = <K extends WriteRequest["op"]>(reply: WriteReply<K>) => {
    assert.equal(reply.result.state, "ok", reply.result.state === "refused" ? `${reply.result.reason}: ${reply.result.detail}` : "");
    return (reply.result as Extract<typeof reply.result, { state: "ok" }>).value;
  };
  const refusal = (reply: WriteReply) => reply.result.state === "refused" ? reply.result.reason : `ok`;
  const restart = () => { service = open(); };
  return { gh, home, ask, value, refusal, restart };
}
async function draft(f: ReturnType<typeof fixture>, kind: "comment" | "review", body: string, comments: { anchor: LineAnchor; body: string }[] = []) {
  return f.value(await f.ask<"save">({ op: "save", key: KEY, revision: REV, kind, expectedVersion: 0, body, comments }));
}
const anchor = (side: "base" | "head", commitSha: string): LineAnchor => ({ key: KEY, revision: REV, commitSha, path: "src/holds/move.ts", side, start: 2, end: 3 });

test("the write contract accepts only bounded, exact requests and grants nothing by passing", () => {
  assert.ok(validateWrite({ op: "status", requestId: "a", key: KEY, revision: REV }));
  assert.equal(validateWrite({ op: "status", requestId: "a", key: KEY, revision: REV, canWrite: true }), null);
  assert.equal(validateWrite({ op: "prepare", requestId: "a", key: KEY, revision: REV, operation: { kind: "merge", method: "squash" }, draftVersion: 1 }), null);
  assert.equal(validateWrite({ op: "save", requestId: "a", key: KEY, revision: REV, kind: "comment", expectedVersion: 0, body: "x\u0007", comments: [] }), null);
  assert.equal(validateWrite({ op: "save", requestId: "a", key: KEY, revision: REV, kind: "comment", expectedVersion: 0, body: "x", comments: [{ anchor: anchor("head", sha("c")), body: "y" }] }), null);
  assert.equal(validateWrite({ op: "submit", requestId: "a", key: KEY, intentId: "not-a-uuid" }), null);
  assert.equal(validateWrite({ op: "submit", requestId: "a", key: { ...KEY, account: "ada" }, intentId: "6f9619ff-8b86-4011-b42d-00c04fc964ff" }), null);
});

test("the write transport allows only the fixed endpoints and methods", () => {
  const call = (method: "GET" | "POST", endpoint: string, input: Record<string, unknown> | null = null) => () => ghWriteArgs({ method, endpoint, input, maxBytes: 1, timeoutMs: 1 });
  assert.deepEqual(call("POST", "repos/example-org/lending/issues/73/comments", { body: "x" })().slice(0, 6), ["api", "repos/example-org/lending/issues/73/comments", "--hostname", "github.com", "--method", "POST"]);
  assert.ok(call("POST", "repos/example-org/lending/issues/73/comments", { body: "x" })().includes("--input"));
  for (const [method, endpoint] of [["POST", "repos/example-org/lending/pulls/73/merge"], ["POST", "repos/example-org/lending/issues/73/labels"], ["POST", "user"],
    ["GET", "repos/example-org/lending/pulls/73/merge"], ["POST", "repos/example-org/../pulls/73/reviews"], ["POST", "repos/example-org/lending/issues/73/comments --hostname evil"]] as const) {
    assert.throws(call(method, endpoint, method === "POST" ? { body: "x" } : null), /not allowed/, endpoint);
  }
  assert.throws(call("POST", "repos/example-org/lending/issues/73/comments"), /body/);
  assert.throws(call("GET", "user", { body: "x" }), /body/);
});

nativeTest("a comment stays local until an explicit preview and submit, then posts once with its marker", async t => {
  const f = fixture(t);
  const saved = await draft(f, "comment", "Looks right to me.");
  assert.equal(f.gh.posts().length, 0);
  const status = f.value(await f.ask<"status">({ op: "status", key: KEY, revision: REV }));
  assert.equal(status.drafts.comment?.body, "Looks right to me.");
  const preview = f.value(await f.ask<"prepare">({ op: "prepare", key: KEY, revision: REV, operation: { kind: "comment" }, draftVersion: saved.version }));
  assert.deepEqual(preview.destination, { owner: "example-org", repo: "lending", number: 73, url: "https://github.com/example-org/lending/pull/73" });
  assert.deepEqual(preview.account, { id: "1001", login: "ada-fixture" });
  assert.equal(f.gh.posts().length, 0, "a preview sends nothing");
  const receipt = f.value(await f.ask<"submit">({ op: "submit", key: KEY, intentId: preview.intentId }));
  assert.equal(receipt.state, "confirmed");
  assert.equal(receipt.remoteUrl, "https://github.com/example-org/lending/pull/73#issuecomment-500");
  assert.equal(f.gh.posts().length, 1);
  assert.equal(f.gh.posts()[0]!.input!.body, `Looks right to me.\n\n${intentMarker(preview.intentId)}`);
  // The draft it sent is cleared; nothing newer was written meanwhile.
  assert.equal(f.value(await f.ask<"status">({ op: "status", key: KEY, revision: REV })).drafts.comment?.body ?? "", "");
});

nativeTest("double submit, a second window and a replayed preview dispatch at most one request", async t => {
  const f = fixture(t);
  const saved = await draft(f, "comment", "Once only.");
  const preview = f.value(await f.ask<"prepare">({ op: "prepare", key: KEY, revision: REV, operation: { kind: "comment" }, draftVersion: saved.version }));
  assert.equal(f.refusal(await f.ask<"submit">({ op: "submit", key: KEY, intentId: preview.intentId }, "window-2")), "no-preview");
  const [a, b] = await Promise.all([f.ask<"submit">({ op: "submit", key: KEY, intentId: preview.intentId }), f.ask<"submit">({ op: "submit", key: KEY, intentId: preview.intentId })]);
  assert.deepEqual([a.result.state, b.result.state].sort(), ["ok", "refused"]);
  assert.equal(f.gh.posts().length, 1);
  assert.equal(f.refusal(await f.ask<"submit">({ op: "submit", key: KEY, intentId: preview.intentId })), "no-preview");
  assert.equal(f.gh.posts().length, 1);
});

nativeTest("a renderer cannot grant itself permission: main reads it, and unreadable permission is refusal", async t => {
  const f = fixture(t);
  const saved = await draft(f, "comment", "Hello");
  // Opening a PR's composers reads nothing from GitHub but the account.
  f.value(await f.ask<"status">({ op: "status", key: KEY, revision: REV }));
  assert.deepEqual([...new Set(f.gh.calls.map(c => c.endpoint))], ["user"]);
  const prepare = () => f.ask<"prepare">({ op: "prepare", key: KEY, revision: REV, operation: { kind: "comment" }, draftVersion: saved.version });
  f.gh.permissions = undefined;
  assert.equal(f.refusal(await prepare()), "permission-unknown");
  f.gh.permissions = { pull: false, push: false };
  assert.equal(f.refusal(await prepare()), "denied");
  f.gh.permissions = { pull: true, push: false }; f.gh.pr.locked = true;
  assert.equal(f.refusal(await prepare()), "locked");
  f.gh.permissions = { pull: true, push: true };
  assert.equal(f.refusal(await prepare()), "ok");
  assert.equal(f.gh.posts().length, 0);
});

nativeTest("the account, head and target are checked again at submit; any change needs a new preview", async t => {
  const f = fixture(t);
  const reset = () => { f.gh.user = ADA; f.gh.stamp = "hosts-1"; f.gh.pr.head.sha = sha("c"); f.gh.pr.base.ref = "main"; f.gh.permissions = { pull: true, push: false }; f.gh.gates = []; };
  const previewed = async (text: string) => {
    reset();
    const current = f.value(await f.ask<"status">({ op: "status", key: KEY, revision: REV })).drafts.comment;
    const saved = f.value(await f.ask<"save">({ op: "save", key: KEY, revision: REV, kind: "comment", expectedVersion: current?.version ?? 0, body: text, comments: [] }));
    return f.value(await f.ask<"prepare">({ op: "prepare", key: KEY, revision: REV, operation: { kind: "comment" }, draftVersion: saved.version }));
  };
  const cases: [string, () => void][] = [
    ["account-changed", () => { f.gh.user = KIT; }],
    ["head-changed", () => { f.gh.pr.head.sha = sha("d"); }],
    ["target-changed", () => { f.gh.pr.base.ref = "release"; }],
    ["denied", () => { f.gh.permissions = { pull: false, push: false }; }],
  ];
  for (const [reason, change] of cases) {
    const preview = await previewed(`For ${reason}`);
    change();
    assert.equal(f.refusal(await f.ask<"submit">({ op: "submit", key: KEY, intentId: preview.intentId })), reason);
    reset();
    assert.equal(f.refusal(await f.ask<"submit">({ op: "submit", key: KEY, intentId: preview.intentId })), "no-preview", `${reason}: the refused preview is spent`);
  }
  // gh's login changes after main checked the account but before it sends: nothing goes out.
  const preview = await previewed("Switched mid-submit");
  const release = f.gh.hold(/^repos\/example-org\/lending\/pulls\/73$/);
  const submit = f.ask<"submit">({ op: "submit", key: KEY, intentId: preview.intentId });
  await new Promise(r => setTimeout(r, 20));
  f.gh.stamp = "hosts-2";
  release();
  assert.equal(f.refusal(await submit), "account-changed");
  assert.equal(f.gh.posts().length, 0);
});

nativeTest("a review pins the head, refuses self-approval and outdated base-side anchors", async t => {
  const f = fixture(t);
  const saved = await draft(f, "review", "Two notes.", [{ anchor: anchor("head", sha("c")), body: "Rename this." }, { anchor: anchor("base", sha("a")), body: "Was this used?" }]);
  const preview = f.value(await f.ask<"prepare">({ op: "prepare", key: KEY, revision: REV, operation: { kind: "review", event: "REQUEST_CHANGES" }, draftVersion: saved.version }));
  assert.equal(preview.comments, 2);
  const receipt = f.value(await f.ask<"submit">({ op: "submit", key: KEY, intentId: preview.intentId }));
  assert.equal(receipt.remoteUrl, "https://github.com/example-org/lending/pull/73#pullrequestreview-500");
  const body = f.gh.posts()[0]!.input!;
  assert.equal(body.commit_id, sha("c"));
  assert.equal(body.event, "REQUEST_CHANGES");
  assert.deepEqual(body.comments, [
    { path: "src/holds/move.ts", body: "Rename this.", side: "RIGHT", line: 3, start_line: 2, start_side: "RIGHT" },
    { path: "src/holds/move.ts", body: "Was this used?", side: "LEFT", line: 3, start_line: 2, start_side: "LEFT" },
  ]);
  // Self-review: the PR's author cannot approve it, and main says so before anything is sent.
  f.gh.pr.user = ADA;
  const current = f.value(await f.ask<"status">({ op: "status", key: KEY, revision: REV }));
  const approval = f.value(await f.ask<"save">({ op: "save", key: KEY, revision: REV, kind: "review", expectedVersion: current.drafts.review!.version, body: "", comments: [] }));
  assert.equal(f.refusal(await f.ask<"prepare">({ op: "prepare", key: KEY, revision: REV, operation: { kind: "review", event: "APPROVE" }, draftVersion: approval.version })), "self-review");
  // A base-side anchor counted in a diff base the PR no longer has.
  f.gh.pr.user = KIT; f.gh.mergeBase = sha("e");
  const stale = f.value(await f.ask<"save">({ op: "save", key: KEY, revision: REV, kind: "review", expectedVersion: approval.version, body: "Old base.", comments: [{ anchor: anchor("base", sha("a")), body: "Gone?" }] }));
  assert.equal(f.refusal(await f.ask<"prepare">({ op: "prepare", key: KEY, revision: REV, operation: { kind: "review", event: "COMMENT" }, draftVersion: stale.version })), "anchor-outdated");
  assert.equal(f.gh.posts().length, 1);
});

nativeTest("a server denial is shown as one, never as success, and the draft survives", async t => {
  const f = fixture(t);
  const saved = await draft(f, "comment", "Denied text");
  f.gh.overrides.push({ method: "POST", pattern: /comments$/, answer: ok(403, { message: "Resource not accessible" }) });
  const preview = f.value(await f.ask<"prepare">({ op: "prepare", key: KEY, revision: REV, operation: { kind: "comment" }, draftVersion: saved.version }));
  const receipt = f.value(await f.ask<"submit">({ op: "submit", key: KEY, intentId: preview.intentId }));
  assert.deepEqual([receipt.state, receipt.reason, receipt.remoteUrl], ["rejected", "denied", null]);
  assert.equal(f.value(await f.ask<"status">({ op: "status", key: KEY, revision: REV })).drafts.comment?.body, "Denied text");
  f.gh.overrides = [{ method: "POST", pattern: /comments$/, answer: ok(422, { message: "Validation Failed" }) }];
  const second = f.value(await f.ask<"prepare">({ op: "prepare", key: KEY, revision: REV, operation: { kind: "comment" }, draftVersion: saved.version }));
  assert.equal(f.value(await f.ask<"submit">({ op: "submit", key: KEY, intentId: second.intentId })).reason, "failed");
});

nativeTest("a timeout is unknown, blocks a resend, and a read-back proves the comment was posted", async t => {
  const f = fixture(t);
  const saved = await draft(f, "comment", "Did it land?");
  // GitHub made the comment, but gh was killed before its answer arrived.
  f.gh.overrides.push({ method: "POST", pattern: /comments$/, answer: { kind: "timeout" }, after: true });
  const preview = f.value(await f.ask<"prepare">({ op: "prepare", key: KEY, revision: REV, operation: { kind: "comment" }, draftVersion: saved.version }));
  const receipt = f.value(await f.ask<"submit">({ op: "submit", key: KEY, intentId: preview.intentId }));
  assert.equal(receipt.state, "unknown");
  assert.equal(f.refusal(await f.ask<"prepare">({ op: "prepare", key: KEY, revision: REV, operation: { kind: "comment" }, draftVersion: saved.version })), "busy");
  assert.equal(f.gh.posts().length, 1);
  // A same-text comment by someone else, and one by this account without the marker, are not proof.
  f.gh.comments.unshift({ id: 9, user: KIT, body: `Did it land?\n\n${intentMarker(preview.intentId)}` }, { id: 10, user: ADA, body: "Did it land?" });
  const reconciled = f.value(await f.ask<"reconcile">({ op: "reconcile", key: KEY, intentId: preview.intentId }));
  assert.deepEqual([reconciled.state, reconciled.remoteUrl], ["confirmed", "https://github.com/example-org/lending/pull/73#issuecomment-500"]);
  assert.equal(f.gh.posts().length, 1);
});

nativeTest("a crash after dispatch restarts as unknown, sends nothing, and needs an explicit decision when nothing is found", async t => {
  const f = fixture(t);
  const saved = await draft(f, "comment", "Lost in a crash");
  f.gh.overrides.push({ method: "POST", pattern: /comments$/, answer: { kind: "offline" } });
  const preview = f.value(await f.ask<"prepare">({ op: "prepare", key: KEY, revision: REV, operation: { kind: "comment" }, draftVersion: saved.version }));
  const release = f.gh.hold(/comments$/);
  const pending = f.ask<"submit">({ op: "submit", key: KEY, intentId: preview.intentId });
  await new Promise(r => setTimeout(r, 20));
  // The app stops while gh is still running: a new main process reads the durable receipt.
  f.restart();
  const after = f.value(await f.ask<"status">({ op: "status", key: KEY, revision: REV }));
  assert.equal(after.receipts.at(-1)?.state, "unknown");
  assert.equal(after.drafts.comment?.body, "Lost in a crash");
  assert.equal(f.gh.posts().length, 1, "restart dispatches nothing");
  const reconciled = f.value(await f.ask<"reconcile">({ op: "reconcile", key: KEY, intentId: preview.intentId }));
  assert.equal(reconciled.state, "unknown", "absence is not proof that nothing was sent");
  const abandoned = f.value(await f.ask<"abandon">({ op: "abandon", key: KEY, intentId: preview.intentId }));
  assert.deepEqual([abandoned.state, abandoned.reason], ["rejected", "abandoned"]);
  assert.equal(f.refusal(await f.ask<"prepare">({ op: "prepare", key: KEY, revision: REV, operation: { kind: "comment" }, draftVersion: saved.version })), "ok");
  release();
  await pending;
});

nativeTest("drafts stay with their account and head; an earlier head's body can be carried, its anchors cannot", async t => {
  const f = fixture(t);
  await draft(f, "review", "Old head notes", [{ anchor: anchor("head", sha("c")), body: "Line note" }]);
  // `gh auth switch` rewrites hosts.yml: main checks the account again rather than trust its last answer.
  f.gh.user = KIT; f.gh.stamp = "hosts-2";
  assert.equal(f.refusal(await f.ask<"status">({ op: "status", key: KEY, revision: REV })), "account-changed");
  assert.equal(f.refusal(await f.ask<"save">({ op: "save", key: KEY, revision: REV, kind: "comment", expectedVersion: 0, body: "x", comments: [] })), "account-changed");
  f.gh.user = ADA; f.gh.stamp = "hosts-3"; f.gh.pr.head.sha = sha("d");
  const moved = { ...REV, headSha: sha("d") };
  const status = f.value(await f.ask<"status">({ op: "status", key: KEY, revision: moved }));
  assert.equal(status.drafts.review, undefined);
  assert.deepEqual(status.earlier.map(d => [d.kind, d.revision.headSha, d.comments]), [["review", sha("c"), 1]]);
  const carried = f.value(await f.ask<"carry">({ op: "carry", key: KEY, revision: moved, kind: "review", from: REV }));
  assert.deepEqual([carried.body, carried.comments.length, carried.revision.headSha], ["Old head notes", 0, sha("d")]);
  assert.equal(f.refusal(await f.ask<"carry">({ op: "carry", key: KEY, revision: moved, kind: "review", from: REV })), "draft-conflict");
});

nativeTest("writes are off in demos and tests, and nothing about a token reaches a reply", async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "modex-cr7w-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const gh = new FakeGitHub();
  const off = new CodeReviewWrites({ home, enabled: false, transport: gh.transport });
  const reply = await off.handle({ op: "status", requestId: "x", key: KEY, revision: REV }, "window-1");
  assert.equal(reply.result.state === "refused" && reply.result.reason, "disabled");
  assert.equal(gh.calls.length, 0);
  await assert.rejects(off.handle({ op: "status", requestId: "x", key: KEY, revision: REV, token: "ghp_x" }, "window-1"), /Invalid/);
  const f = fixture(t);
  f.gh.overrides.push({ method: "GET", pattern: /^user$/, answer: { kind: "http", status: 401, headers: {}, body: Buffer.from('{"message":"Bad credentials ghp_secret"}') } });
  const refused = await f.ask<"status">({ op: "status", key: KEY, revision: REV });
  assert.doesNotMatch(JSON.stringify(refused), /ghp_|Bad credentials/);
});

// --- Merge (increment 2) ----------------------------------------------------------------------------

function merger(t: { after(fn: () => void): void }) {
  const gh = new FakeGitHub();
  gh.permissions = { admin: false, maintain: false, push: true, triage: true, pull: true };
  return fixture(t, gh);
}
const checkMerge = async (f: ReturnType<typeof fixture>) => f.value(await f.ask<"merge-check">({ op: "merge-check", key: KEY, revision: REV }));

test("merge requests are exact: a known method, no draft, and no merge through prepare", () => {
  assert.ok(validateWrite({ op: "merge-check", requestId: "a", key: KEY, revision: REV }));
  assert.ok(validateWrite({ op: "prepare-merge", requestId: "a", key: KEY, revision: REV, method: "squash" }));
  assert.equal(validateWrite({ op: "prepare-merge", requestId: "a", key: KEY, revision: REV, method: "fast-forward" }), null);
  assert.equal(validateWrite({ op: "prepare-merge", requestId: "a", key: KEY, revision: REV, method: "squash", sha: sha("c") }), null);
  assert.equal(validateWrite({ op: "merge-check", requestId: "a", key: KEY, revision: REV, checks: "green" }), null);
});

test("the merge transport allows one PUT, to the PR's merge endpoint, with a body", () => {
  const call = (method: "GET" | "POST" | "PUT", endpoint: string, input: Record<string, unknown> | null) => () => ghWriteArgs({ method, endpoint, input, maxBytes: 1, timeoutMs: 1 });
  assert.deepEqual(call("PUT", "repos/example-org/lending/pulls/73/merge", { sha: sha("c"), merge_method: "squash" })().slice(4, 6), ["--method", "PUT"]);
  assert.ok(call("GET", "repos/example-org/lending/rules/branches/release%2F2026?per_page=100&page=1", null)());
  for (const [method, endpoint] of [["PUT", "repos/example-org/lending/pulls/73/reviews"], ["PUT", "repos/example-org/lending/issues/73/comments"], ["PUT", "repos/example-org/lending/pulls/73"],
    ["GET", "repos/example-org/lending/rules/branches/..?per_page=100&page=1"], ["GET", "repos/example-org/lending/rules/branches/%2e%2e?per_page=100&page=1"]] as const) {
    assert.throws(call(method, endpoint, method === "PUT" ? { sha: sha("c") } : null), /not allowed/, `${method} ${endpoint}`);
  }
  assert.throws(call("PUT", "repos/example-org/lending/pulls/73/merge", null), /body/);
});

nativeTest("merge offers only the allowed methods, previews without sending, and sends the reviewed head once", async t => {
  const f = merger(t);
  const offer = await checkMerge(f);
  assert.equal(offer.kind, "offer");
  assert.deepEqual(offer.kind === "offer" && offer.methods, ["squash", "rebase"], "a method the repository doesn't allow is never offered");
  const refused = await f.ask<"prepare-merge">({ op: "prepare-merge", key: KEY, revision: REV, method: "merge" });
  assert.equal(f.refusal(refused), "merge-unavailable");
  const preview = f.value(await f.ask<"prepare-merge">({ op: "prepare-merge", key: KEY, revision: REV, method: "squash" }));
  assert.deepEqual(preview.operation, { kind: "merge", method: "squash" });
  assert.equal(preview.destination.url, "https://github.com/example-org/lending/pull/73");
  assert.equal(f.gh.merges().length, 0, "a check and a preview send nothing");
  const [first, second] = await Promise.all([
    f.ask<"submit">({ op: "submit", key: KEY, intentId: preview.intentId }),
    f.ask<"submit">({ op: "submit", key: KEY, intentId: preview.intentId }),
  ]);
  assert.equal(f.value(first).state, "confirmed");
  assert.equal(f.value(first).remoteUrl, "https://github.com/example-org/lending/pull/73");
  assert.equal(f.refusal(second), "no-preview");
  assert.deepEqual(f.gh.merges().map((c) => c.input), [{ sha: sha("c"), merge_method: "squash" }]);
  const after = await checkMerge(f);
  assert.deepEqual(after.kind === "unavailable" && after.reason, "not-open");
});

nativeTest("merge is never offered on unknown, blocked or unreadable state, and needs push permission read now", async t => {
  const cases: [string, (gh: FakeGitHub) => void, string][] = [
    ["mergeability not computed", (gh) => { gh.pr.mergeable = null; gh.pr.mergeable_state = "unknown"; }, "unknown"],
    ["unknown state with mergeable true", (gh) => { gh.pr.mergeable_state = "unknown"; }, "unknown"],
    ["required checks or reviews", (gh) => { gh.pr.mergeable_state = "blocked"; }, "blocked"],
    ["conflicts", (gh) => { gh.pr.mergeable = false; gh.pr.mergeable_state = "dirty"; }, "conflicts"],
    ["behind", (gh) => { gh.pr.mergeable_state = "behind"; }, "behind"],
    ["draft", (gh) => { gh.pr.draft = true; gh.pr.mergeable_state = "draft"; }, "draft"],
    ["settings hidden from this account", (gh) => { gh.settings = null; }, "policy-unreadable"],
    ["rules unreadable", (gh) => { gh.rules = null; }, "policy-unreadable"],
    ["merge queue", (gh) => { gh.rules = [{ type: "merge_queue" }]; }, "queue"],
    ["no method allowed", (gh) => { gh.settings = { allow_merge_commit: false, allow_squash_merge: false, allow_rebase_merge: false }; }, "no-methods"],
    ["unrecognised state", (gh) => { gh.pr.mergeable_state = "green"; }, "unknown"],
  ];
  for (const [name, change, reason] of cases) {
    const f = merger(t);
    change(f.gh);
    const check = await checkMerge(f);
    assert.equal(check.kind === "unavailable" && check.reason, reason, name);
    assert.equal(check.kind === "unavailable" && check.url, "https://github.com/example-org/lending/pull/73", name);
    assert.equal(f.refusal(await f.ask<"prepare-merge">({ op: "prepare-merge", key: KEY, revision: REV, method: "squash" })), "merge-unavailable", name);
    assert.equal(f.gh.merges().length, 0, name);
  }
  // Failing checks that aren't required leave GitHub's state `unstable`: offered, and said so.
  const unstable = merger(t);
  unstable.gh.pr.mergeable_state = "unstable";
  const offer = await checkMerge(unstable);
  assert.equal(offer.kind === "offer" && offer.unstable, true);
  const noPush = fixture(t);
  assert.equal(noPush.refusal(await noPush.ask<"merge-check">({ op: "merge-check", key: KEY, revision: REV })), "denied");
  const unknown = fixture(t);
  unknown.gh.permissions = undefined;
  assert.equal(unknown.refusal(await unknown.ask<"merge-check">({ op: "merge-check", key: KEY, revision: REV })), "permission-unknown");
});

nativeTest("a moved head, a moved target or a withdrawn method between preview and merge sends nothing", async t => {
  const cases: [string, (gh: FakeGitHub) => void, string][] = [
    ["head", (gh) => { gh.pr.head.sha = sha("d"); }, "head-changed"],
    ["target", (gh) => { gh.pr.base.sha = sha("9"); }, "target-changed"],
    ["method", (gh) => { gh.settings = { ...gh.settings!, allow_squash_merge: false }; }, "merge-unavailable"],
    ["blocked", (gh) => { gh.pr.mergeable_state = "blocked"; }, "merge-unavailable"],
    ["push", (gh) => { gh.permissions = { ...gh.permissions!, push: false }; }, "denied"],
    ["account", (gh) => { gh.stamp = "hosts-2"; gh.user = KIT; }, "account-changed"],
  ];
  for (const [name, change, reason] of cases) {
    const f = merger(t);
    const preview = f.value(await f.ask<"prepare-merge">({ op: "prepare-merge", key: KEY, revision: REV, method: "squash" }));
    change(f.gh);
    assert.equal(f.refusal(await f.ask<"submit">({ op: "submit", key: KEY, intentId: preview.intentId })), reason, name);
    assert.equal(f.gh.merges().length, 0, name);
    assert.equal(f.refusal(await f.ask<"submit">({ op: "submit", key: KEY, intentId: preview.intentId })), "no-preview", `${name}: the preview is spent`);
  }
});

nativeTest("a refused merge is rejected; an unclear one is unknown, blocks the PR and is confirmed only by GitHub's own record", async t => {
  // GitHub refuses: the branch moved after main's last read (409), or it can't merge now (405).
  for (const status of [405, 409]) {
    const f = merger(t);
    f.gh.overrides.push({ method: "PUT", pattern: /\/merge$/, answer: ok(status, { message: "nope" }) });
    const preview = f.value(await f.ask<"prepare-merge">({ op: "prepare-merge", key: KEY, revision: REV, method: "squash" }));
    const receipt = f.value(await f.ask<"submit">({ op: "submit", key: KEY, intentId: preview.intentId }));
    assert.deepEqual([receipt.state, receipt.reason], ["rejected", "failed"], String(status));
  }
  // A gateway error after GitHub merged it.
  const f = merger(t);
  f.gh.overrides.push({ method: "PUT", pattern: /\/merge$/, answer: ok(502, { message: "Bad gateway" }), after: true });
  const preview = f.value(await f.ask<"prepare-merge">({ op: "prepare-merge", key: KEY, revision: REV, method: "rebase" }));
  const unclear = f.value(await f.ask<"submit">({ op: "submit", key: KEY, intentId: preview.intentId }));
  assert.equal(unclear.state, "unknown");
  assert.equal(f.refusal(await f.ask<"prepare-merge">({ op: "prepare-merge", key: KEY, revision: REV, method: "rebase" })), "merge-unavailable", "the PR now reads as merged");
  const settled = f.value(await f.ask<"reconcile">({ op: "reconcile", key: KEY, intentId: preview.intentId }));
  assert.equal(settled.state, "confirmed");
  assert.equal(f.gh.merges().length, 1);

  // Someone else merged it: that proves nothing about this request, which stays unknown.
  const g = merger(t);
  g.gh.overrides.push({ method: "PUT", pattern: /\/merge$/, answer: { kind: "timeout" } });
  const other = g.value(await g.ask<"prepare-merge">({ op: "prepare-merge", key: KEY, revision: REV, method: "squash" }));
  assert.equal(g.value(await g.ask<"submit">({ op: "submit", key: KEY, intentId: other.intentId })).state, "unknown");
  Object.assign(g.gh.pr, { merged: true, merged_at: "2026-10-25T12:00:00Z", state: "closed", merged_by: KIT, merge_commit_sha: sha("e") });
  assert.equal(g.value(await g.ask<"reconcile">({ op: "reconcile", key: KEY, intentId: other.intentId })).state, "unknown");
  const saved = await draft(g, "comment", "Merged?");
  assert.equal(g.refusal(await g.ask<"prepare">({ op: "prepare", key: KEY, revision: REV, operation: { kind: "comment" }, draftVersion: saved.version })), "busy");
});

nativeTest("a crash after a merge is admitted restarts unknown and never merges again on its own", async t => {
  const f = merger(t);
  const release = f.gh.hold(/\/merge$/);
  const preview = f.value(await f.ask<"prepare-merge">({ op: "prepare-merge", key: KEY, revision: REV, method: "squash" }));
  const inFlight = f.ask<"submit">({ op: "submit", key: KEY, intentId: preview.intentId });
  while (f.gh.merges().length === 0) await new Promise((r) => setTimeout(r, 5));
  f.restart();
  const after = f.value(await f.ask<"status">({ op: "status", key: KEY, revision: REV }));
  assert.deepEqual(after.receipts.map((r) => [r.operation.kind, r.state]), [["merge", "unknown"]]);
  assert.equal(f.refusal(await f.ask<"prepare-merge">({ op: "prepare-merge", key: KEY, revision: REV, method: "squash" })), "busy");
  release();
  await inFlight;
  assert.equal(f.gh.merges().length, 1);
});

// --- Decisions 2–4: state, edits, reviewers (increment 3) -------------------------------------------

const act = (f: ReturnType<typeof fixture>, action: unknown) => f.ask<"prepare-action">({ op: "prepare-action", key: KEY, revision: REV, action } as never);
async function perform(f: ReturnType<typeof fixture>, action: unknown) {
  const preview = f.value(await act(f, action));
  return f.value(await f.ask<"submit">({ op: "submit", key: KEY, intentId: preview.intentId }));
}
const EXPECTED = { title: "Lend a hold", body: "" };
function triager(t: { after(fn: () => void): void }) {
  const gh = new FakeGitHub();
  gh.permissions = { admin: false, maintain: false, push: false, triage: true, pull: true };
  return fixture(t, gh);
}

test("state, edit and reviewer requests are exact and bounded", () => {
  const ok = (action: unknown) => validateWrite({ op: "prepare-action", requestId: "a", key: KEY, revision: REV, action });
  assert.ok(ok({ kind: "state", to: "closed" }));
  assert.ok(ok({ kind: "edit", title: "New", body: null, expected: EXPECTED }));
  assert.ok(ok({ kind: "reviewers", logins: ["grace-fixture"] }));
  for (const action of [{ kind: "state", to: "merged" }, { kind: "edit", title: "a\nb", body: null, expected: EXPECTED }, { kind: "edit", title: null, body: null, expected: EXPECTED },
    { kind: "edit", title: "x", body: null, expected: { title: "x" } }, { kind: "reviewers", logins: [] }, { kind: "reviewers", logins: ["@grace"] }, { kind: "merge", method: "squash" }]) {
    assert.equal(ok(action), null, JSON.stringify(action));
  }
  assert.equal(validateWrite({ op: "prepare", requestId: "a", key: KEY, revision: REV, operation: { kind: "state", to: "closed" }, draftVersion: 1 }), null);
});

test("the action transport allows one PATCH shape, the reviewer request and only GitHub's two draft mutations", () => {
  const call = (method: GhWriteCall["method"], endpoint: string, input: Record<string, unknown> | null) => () => ghWriteArgs({ method, endpoint, input, maxBytes: 1, timeoutMs: 1 });
  assert.ok(call("PATCH", "repos/example-org/lending/pulls/73", { state: "closed" })());
  assert.ok(call("PATCH", "repos/example-org/lending/pulls/73", { title: "t", body: "b" })());
  assert.ok(call("POST", "repos/example-org/lending/pulls/73/requested_reviewers", { reviewers: ["grace-fixture"] })());
  assert.deepEqual(call("POST", "graphql", { query: DRAFT_MUTATIONS.draft, variables: { id: "PR_kwFixture73" } })().slice(0, 2), ["api", "graphql"]);
  for (const [method, endpoint, input] of [
    ["PATCH", "repos/example-org/lending/pulls/73", { base: "release" }],
    ["PATCH", "repos/example-org/lending/pulls/73", { state: "closed", maintainer_can_modify: false }],
    ["PATCH", "repos/example-org/lending/pulls/73", {}],
    ["PATCH", "repos/example-org/lending/issues/73", { state: "closed" }],
    ["POST", "repos/example-org/lending/pulls/73/requested_reviewers", { reviewers: ["a"], team_reviewers: ["b"] }],
    ["POST", "graphql", { query: "mutation { deleteRepository(input: {}) { clientMutationId } }", variables: { id: "PR_x" } }],
    ["POST", "graphql", { query: DRAFT_MUTATIONS.draft, variables: { id: "PR_x", extra: 1 } }],
    ["POST", "graphql", { query: DRAFT_MUTATIONS.ready, variables: { id: "PR x" } }],
  ] as const) assert.throws(call(method, endpoint, input as Record<string, unknown>), /not allowed/, `${method} ${endpoint} ${JSON.stringify(input)}`);
  for (const method of ["DELETE"] as const) assert.throws(call(method as never, "repos/example-org/lending/pulls/73/requested_reviewers", { reviewers: ["a"] }), /not allowed/);
});

nativeTest("the state menu closes and reopens, converts to draft and back, each previewed and sent once", async t => {
  const f = triager(t);
  const preview = f.value(await act(f, { kind: "state", to: "closed" }));
  assert.deepEqual(preview.operation, { kind: "state", to: "closed" });
  assert.equal(f.gh.mutations().length, 0, "a preview changes nothing");
  const closed = f.value(await f.ask<"submit">({ op: "submit", key: KEY, intentId: preview.intentId }));
  assert.deepEqual([closed.state, closed.remoteUrl], ["confirmed", "https://github.com/example-org/lending/pull/73"]);
  assert.equal(f.refusal(await act(f, { kind: "state", to: "closed" })), "state-conflict", "already closed");
  assert.equal(f.refusal(await act(f, { kind: "state", to: "draft" })), "state-conflict", "a closed PR isn't made a draft");
  assert.equal((await perform(f, { kind: "state", to: "open" })).state, "confirmed");
  assert.equal((await perform(f, { kind: "state", to: "draft" })).state, "confirmed");
  assert.equal(f.gh.pr.draft, true);
  assert.equal(f.refusal(await act(f, { kind: "state", to: "draft" })), "state-conflict");
  assert.equal((await perform(f, { kind: "state", to: "ready" })).state, "confirmed");
  assert.deepEqual(f.gh.mutations().map((c) => [c.method, c.endpoint, c.endpoint === "graphql" ? (c.input!.query === DRAFT_MUTATIONS.draft ? "draft" : "ready") : c.input]), [
    ["PATCH", "repos/example-org/lending/pulls/73", { state: "closed" }],
    ["PATCH", "repos/example-org/lending/pulls/73", { state: "open" }],
    ["POST", "graphql", "draft"],
    ["POST", "graphql", "ready"],
  ]);
  // A merged PR changes no more.
  Object.assign(f.gh.pr, { state: "closed", merged: true, merged_at: "2026-10-25T13:00:00Z" });
  for (const to of ["open", "closed", "draft", "ready"]) assert.equal(f.refusal(await act(f, { kind: "state", to })), "state-conflict", to);
});

nativeTest("changing state needs triage, push or authorship, read now; unreadable permission is refusal", async t => {
  const reader = fixture(t);
  assert.equal(reader.refusal(await act(reader, { kind: "state", to: "closed" })), "denied");
  const author = fixture(t);
  author.gh.pr.user = ADA;
  assert.equal((await perform(author, { kind: "state", to: "closed" })).state, "confirmed", "an author may close their own PR");
  const unknown = triager(t);
  unknown.gh.permissions = undefined;
  assert.equal(unknown.refusal(await act(unknown, { kind: "state", to: "closed" })), "permission-unknown");
  // Permission withdrawn between preview and send: nothing is sent.
  const withdrawn = triager(t);
  const preview = withdrawn.value(await act(withdrawn, { kind: "state", to: "closed" }));
  withdrawn.gh.permissions = { ...withdrawn.gh.permissions!, triage: false };
  assert.equal(withdrawn.refusal(await withdrawn.ask<"submit">({ op: "submit", key: KEY, intentId: preview.intentId })), "denied");
  assert.equal(withdrawn.gh.mutations().length, 0);
});

nativeTest("an edit never overwrites text that changed on GitHub since it was read", async t => {
  const f = fixture(t);
  f.gh.pr.user = ADA;
  assert.equal(f.refusal(await act(f, { kind: "edit", title: "Mine", body: null, expected: { title: "An older title", body: "" } })), "edit-conflict");
  const preview = f.value(await act(f, { kind: "edit", title: "Lend a hold, keep its place", body: "Fixes the queue.", expected: EXPECTED }));
  f.gh.pr.body = "Someone else's description";
  assert.equal(f.refusal(await f.ask<"submit">({ op: "submit", key: KEY, intentId: preview.intentId })), "edit-conflict");
  assert.equal(f.gh.mutations().length, 0);
  const done = await perform(f, { kind: "edit", title: "Lend a hold, keep its place", body: null, expected: { title: "Lend a hold", body: "Someone else's description" } });
  assert.equal(done.state, "confirmed");
  assert.deepEqual(f.gh.mutations().map((c) => c.input), [{ title: "Lend a hold, keep its place" }], "only the changed field is sent");
  assert.equal(f.gh.pr.body, "Someone else's description");
  // Without authorship, editing needs push.
  const other = triager(t);
  assert.equal(other.refusal(await act(other, { kind: "edit", title: "x", body: null, expected: EXPECTED })), "denied");
});

nativeTest("reviewer requests go to others only, on an open PR, with triage or push", async t => {
  const f = triager(t);
  assert.equal(f.refusal(await act(f, { kind: "reviewers", logins: ["kit-fixture"] })), "reviewer-invalid", "the author");
  assert.equal(f.refusal(await act(f, { kind: "reviewers", logins: ["Ada-Fixture"] })), "reviewer-invalid", "oneself, in any case");
  const done = await perform(f, { kind: "reviewers", logins: ["grace-fixture", "lin-fixture"] });
  assert.equal(done.state, "confirmed");
  assert.deepEqual(f.gh.mutations().map((c) => [c.endpoint, c.input]), [["repos/example-org/lending/pulls/73/requested_reviewers", { reviewers: ["grace-fixture", "lin-fixture"] }]]);
  f.gh.overrides.push({ method: "POST", pattern: /requested_reviewers$/, answer: ok(422, { message: "Reviews may only be requested from collaborators." }) });
  const refused = await perform(f, { kind: "reviewers", logins: ["outsider"] });
  assert.deepEqual([refused.state, refused.reason], ["rejected", "failed"]);
  const reader = fixture(t);
  assert.equal(reader.refusal(await act(reader, { kind: "reviewers", logins: ["grace-fixture"] })), "denied");
});

nativeTest("an unclear state change or edit stays unknown until the PR shows it; a GraphQL error is a refusal; a moved head re-asks", async t => {
  const f = triager(t);
  f.gh.overrides.push({ method: "PATCH", pattern: /pulls\/73$/, answer: ok(502, { message: "Bad gateway" }), after: true });
  const preview = f.value(await act(f, { kind: "state", to: "closed" }));
  assert.equal(f.value(await f.ask<"submit">({ op: "submit", key: KEY, intentId: preview.intentId })).state, "unknown");
  // The close went through, but Modex can't know that yet: even reopening waits for it to be settled.
  assert.equal(f.refusal(await act(f, { kind: "state", to: "open" })), "busy");
  assert.equal(f.value(await f.ask<"reconcile">({ op: "reconcile", key: KEY, intentId: preview.intentId })).state, "confirmed");
  assert.equal(f.gh.mutations().length, 1);

  // GitHub didn't make the change: reconcile finds nothing and proves nothing.
  const g = triager(t);
  g.gh.overrides.push({ method: "PATCH", pattern: /pulls\/73$/, answer: { kind: "timeout" } });
  const lost = g.value(await act(g, { kind: "state", to: "closed" }));
  assert.equal(g.value(await g.ask<"submit">({ op: "submit", key: KEY, intentId: lost.intentId })).state, "unknown");
  assert.equal(g.value(await g.ask<"reconcile">({ op: "reconcile", key: KEY, intentId: lost.intentId })).state, "unknown");
  assert.equal(g.value(await g.ask<"abandon">({ op: "abandon", key: KEY, intentId: lost.intentId })).reason, "abandoned");

  const h = triager(t);
  h.gh.overrides.push({ method: "POST", pattern: /^graphql$/, answer: ok(200, { data: null, errors: [{ type: "FORBIDDEN" }] }) });
  const refused = await perform(h, { kind: "state", to: "draft" });
  assert.deepEqual([refused.state, refused.reason], ["rejected", "failed"]);

  const moved = triager(t);
  const stale = moved.value(await act(moved, { kind: "state", to: "closed" }));
  moved.gh.pr.head.sha = sha("d");
  assert.equal(moved.refusal(await moved.ask<"submit">({ op: "submit", key: KEY, intentId: stale.intentId })), "head-changed");
  assert.equal(moved.gh.mutations().length, 0);
});

