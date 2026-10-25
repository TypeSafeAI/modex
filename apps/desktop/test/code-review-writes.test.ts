import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GhAnswer } from "../src/main/engine/code-review/gh.js";
import { ghWriteArgs, type GhWriteCall } from "../src/main/engine/code-review-actions/write-gh.js";
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
  pr = { id: 7301073, number: 73, title: "Lend a hold", body: "", state: "open", draft: false, merged_at: null, locked: false, user: KIT,
    created_at: "2026-10-18T10:00:00Z", updated_at: "2026-10-19T09:00:00Z", base: { ref: "main", sha: sha("b"), repo: LENDING },
    head: { ref: "topic-73", sha: sha("c"), repo: LENDING }, changed_files: 1, additions: 1, deletions: 0, commits: 1, comments: 0, review_comments: 0, requested_reviewers: [] };
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
    if (e === "repositories/7301") return ok(200, { ...LENDING, ...(this.permissions ? { permissions: this.permissions } : {}) });
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
