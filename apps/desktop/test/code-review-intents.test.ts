import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ReviewActions, type ReviewContext, type ReviewOperation } from "../src/main/engine/code-review-actions/intents.js";
import { anchorFor } from "../src/renderer/code-review/patch.js";
import type { PrFile } from "../src/shared/code-review.js";

const nativeTest = process.platform === "win32" ? test.skip : test;

const context = (): ReviewContext => ({ account: "1001", session: "document-1", permitted: true,
  key: { account: "1001", host: "github.com", repoId: "7301", number: 73 },
  revision: { baseRef: "main", baseSha: "b".repeat(40), headSha: "c".repeat(40) } });
function fixture(t: { after(fn: () => void): void }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "modex-cr7-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { home, actions: new ReviewActions(home), ctx: context() };
}
const comment = { kind: "comment" } as const;
const review = { kind: "review", event: "COMMENT" } as const;
const merge = { kind: "merge", method: "squash" } as const;

nativeTest("drafts isolate identical PR numbers by account/repository/revision and preserve newer asynchronous edits", t => {
  const { actions, ctx } = fixture(t);
  assert.equal(actions.saveDraft(ctx, "comment", 0, "first")?.version, 1);
  const second = actions.saveDraft(ctx, "comment", 1, "newer edit");
  assert.equal(second?.version, 2);
  assert.equal(actions.saveDraft(ctx, "comment", 1, "late asynchronous reply"), null);
  assert.equal(actions.getDraft(ctx, "comment")?.body, "newer edit");
  const other = context(); other.key.repoId = "7302";
  assert.equal(actions.getDraft(other, "comment"), null);
  other.key = { ...ctx.key, account: "2002" }; other.account = "2002";
  assert.equal(actions.getDraft(other, "comment"), null);
  other.key = { ...ctx.key }; other.account = ctx.account; other.revision.headSha = "d".repeat(40);
  assert.equal(actions.getDraft(other, "comment"), null);
  assert.equal(actions.getDraft({ ...ctx, permitted: false }, "comment")?.body, "newer edit");
});

nativeTest("double clicks yield one durable mock dispatch and snapshot the confirmed payload", async t => {
  const { actions, ctx } = fixture(t);
  actions.saveDraft(ctx, "comment", 0, "reviewed text");
  const prepared = actions.prepare(ctx, comment, 1)!;
  actions.saveDraft(ctx, "comment", 1, "newer unsent text");
  let requests = 0;
  const click = async () => {
    const permit = actions.dispatch(ctx, prepared.confirmation);
    if (!permit) return;
    requests++;
    assert.equal(permit.payload?.body, "reviewed text");
    await Promise.resolve();
    actions.complete(ctx, permit.id, { state: "confirmed", remoteId: "comment-41" });
  };
  await Promise.all([click(), click()]);
  assert.equal(requests, 1);
  assert.equal(actions.list(ctx)[0]?.state, "confirmed");
  assert.equal(actions.getDraft(ctx, "comment")?.body, "newer unsent text");
  assert.equal(actions.dispatch(ctx, prepared.confirmation), null);
});

nativeTest("restart retains drafts and turns dispatched outcomes unknown without granting another mock request", t => {
  const { actions, ctx, home } = fixture(t);
  actions.saveDraft(ctx, "review", 0, "kept after crash");
  const prepared = actions.prepare(ctx, review, 1)!;
  let requests = 0;
  if (actions.dispatch(ctx, prepared.confirmation)) requests++;
  const restarted = new ReviewActions(home);
  assert.equal(restarted.list(ctx)[0]?.state, "unknown");
  assert.equal(restarted.getDraft(ctx, "review")?.body, "kept after crash");
  if (restarted.dispatch(ctx, prepared.confirmation)) requests++;
  assert.equal(restarted.prepare(ctx, review, 1), null);
  assert.equal(restarted.prepare(ctx, merge), null);
  assert.equal(requests, 1);
});

nativeTest("unused confirmations expire on restart, requiring an explicit new preparation", t => {
  const { actions, ctx, home } = fixture(t);
  const prepared = actions.prepare(ctx, merge)!;
  const restarted = new ReviewActions(home);
  assert.equal(restarted.dispatch(ctx, prepared.confirmation), null);
  assert.equal(restarted.list(ctx)[0]?.state, "rejected");
  const next = restarted.prepare(ctx, merge)!;
  assert(next);
  assert.equal(restarted.dispatch(ctx, next.confirmation)?.state, "dispatched");
});

for (const change of ["account", "repository", "head", "base", "target", "session", "permission"] as const) {
  nativeTest(`dispatch rejects changed ${change} and forged confirmations`, t => {
    const { actions, ctx } = fixture(t);
    const prepared = actions.prepare(ctx, merge)!;
    const changed = structuredClone(ctx);
    if (change === "account") changed.account = "2002";
    if (change === "repository") changed.key.repoId = "7302";
    if (change === "head") changed.revision.headSha = "d".repeat(40);
    if (change === "base") changed.revision.baseSha = "e".repeat(40);
    if (change === "target") changed.revision.baseRef = "release";
    if (change === "session") changed.session = "document-2";
    if (change === "permission") changed.permitted = false;
    assert.equal(actions.dispatch(changed, prepared.confirmation), null);
    assert.equal(actions.dispatch(ctx, { ...prepared.confirmation }), null);
    assert.equal(actions.list(ctx)[0]?.state, "prepared");
  });
}

nativeTest("rejected and unknown outcomes keep drafts; only an exact correlated remote match confirms unknown", t => {
  const { actions, ctx } = fixture(t);
  actions.saveDraft(ctx, "comment", 0, "retained");
  const first = actions.prepare(ctx, comment, 1)!;
  actions.dispatch(ctx, first.confirmation);
  actions.complete(ctx, first.intent.id, { state: "rejected", reason: "denied" });
  assert.equal(actions.getDraft(ctx, "comment")?.body, "retained");
  const second = actions.prepare(ctx, comment, 1)!;
  actions.dispatch(ctx, second.confirmation);
  actions.complete(ctx, second.intent.id, { state: "unknown" });
  for (const kind of ["absent", "ambiguous"] as const) {
    assert.equal(actions.reconcile(ctx, second.intent.id, { kind })?.state, "unknown");
  }
  const match = { kind: "matched" as const, key: ctx.key, revision: ctx.revision, digest: second.intent.digest, remoteId: "comment-42" };
  assert.equal(actions.reconcile(ctx, second.intent.id, { ...match, digest: "0".repeat(64) })?.state, "unknown");
  assert.equal(actions.reconcile(ctx, second.intent.id, match)?.state, "confirmed");
  assert.equal(actions.getDraft(ctx, "comment")?.body, "retained");
});

nativeTest("inline drafts refuse stale or cross-account anchors and malformed repository paths", t => {
  const { actions, ctx } = fixture(t);
  const anchor = { key: ctx.key, revision: ctx.revision, commitSha: ctx.revision.headSha, path: "src/example.ts", side: "head" as const, start: 4, end: 4 };
  assert(actions.saveDraft(ctx, "review", 0, "body", [{ anchor, body: "line comment" }]));
  assert.equal(actions.saveDraft(ctx, "review", 1, "bad", [{ anchor: { ...anchor, revision: { ...ctx.revision, headSha: "d".repeat(40) } }, body: "x" }]), null);
  assert.equal(actions.saveDraft(ctx, "review", 1, "bad", [{ anchor: { ...anchor, key: { ...ctx.key, account: "2002" } }, body: "x" }]), null);
  assert.equal(actions.saveDraft(ctx, "review", 1, "bad", [{ anchor: { ...anchor, path: "../escape" }, body: "x" }]), null);
  assert.equal(actions.saveDraft(ctx, "comment", 0, "bad", [{ anchor, body: "x" }]), null);
});

nativeTest("CR-5 line anchors are accepted as produced, with their diff commit bound into the intent", t => {
  const { actions, ctx } = fixture(t);
  const file: PrFile = { path: "src/new.ts", previousPath: "src/old.ts", status: "renamed", additions: 1, deletions: 1, patch: { kind: "text", patch: "@@ -2,2 +4 @@\n-a\n-b\n+c\n" } };
  const mergeBase = "e".repeat(40);
  const head = anchorFor(ctx.key, ctx.revision, file, "head", 4)!, base = anchorFor(ctx.key, ctx.revision, file, "base", 2, 3, mergeBase)!;
  assert.equal(base.commitSha, mergeBase);
  const saved = actions.saveDraft(ctx, "review", 0, "", [{ anchor: head, body: "head line" }, { anchor: base, body: "base lines" }]);
  assert.deepEqual(saved?.comments.map(c => c.anchor), [head, base]);
  const prepared = actions.prepare(ctx, review, 1)!;
  assert.deepEqual(prepared.intent.payload?.comments.map(c => c.anchor.commitSha), [ctx.revision.headSha, mergeBase]);
  actions.cancel(ctx, prepared.intent.id);
  const moved = actions.saveDraft(ctx, "review", 1, "", [{ anchor: head, body: "head line" }, { anchor: { ...base, commitSha: "f".repeat(40) }, body: "base lines" }])!;
  assert.notEqual(actions.prepare(ctx, review, moved.version)!.intent.digest, prepared.intent.digest);
});

nativeTest("anchors without a provable diff commit, or naming another head, are refused", t => {
  const { actions, ctx } = fixture(t);
  const head = { key: ctx.key, revision: ctx.revision, commitSha: ctx.revision.headSha, path: "src/example.ts", side: "head" as const, start: 4, end: 4 };
  const { commitSha: _, ...legacy } = head;
  assert.equal(actions.saveDraft(ctx, "review", 0, "bad", [{ anchor: legacy as never, body: "x" }]), null);
  assert.equal(actions.saveDraft(ctx, "review", 0, "bad", [{ anchor: { ...head, commitSha: "d".repeat(40) }, body: "x" }]), null);
  assert.equal(actions.saveDraft(ctx, "review", 0, "bad", [{ anchor: { ...head, side: "base", commitSha: "NOT-A-SHA" }, body: "x" }]), null);
  assert.equal(actions.saveDraft(ctx, "review", 0, "bad", [{ anchor: { ...head, extra: true } as never, body: "x" }]), null);
});

nativeTest("one outstanding intent per PR prevents new IDs from bypassing ambiguous writes", t => {
  const { actions, ctx } = fixture(t);
  assert(actions.prepare(ctx, merge));
  assert.equal(actions.prepare(ctx, merge), null);
  const other = structuredClone(ctx); other.revision.headSha = "d".repeat(40);
  assert.equal(actions.prepare(other, merge), null);
});

for (const afterRequest of [false, true]) {
  nativeTest(`a killed process ${afterRequest ? "after the mock request" : "before the mock request"} recovers unknown with no replay`, t => {
    const { ctx, home } = fixture(t);
    const module = new URL("../src/main/engine/code-review-actions/intents.js", import.meta.url).href;
    const marker = path.join(home, "mock-requests.txt");
    const child = `import fs from 'node:fs';import {ReviewActions} from ${JSON.stringify(module)};
      const a=new ReviewActions(process.argv[1]),ctx=JSON.parse(process.argv[2]);
      const p=a.prepare(ctx,{kind:'merge',method:'squash'});if(!p||!a.dispatch(ctx,p.confirmation))process.exit(2);
      if(process.argv[3]==='yes')fs.appendFileSync(process.argv[4],'request\\n');process.kill(process.pid,'SIGKILL');`;
    assert.throws(() => execFileSync(process.execPath, ["--input-type=module", "-e", child, home, JSON.stringify(ctx), afterRequest ? "yes" : "no", marker], { timeout: 10000, stdio: "pipe" }),
      (error: unknown) => (error as { signal?: string }).signal === "SIGKILL");
    const recovered = new ReviewActions(home);
    assert.equal(recovered.list(ctx)[0]?.state, "unknown");
    assert.equal(recovered.prepare(ctx, merge), null);
    const count = fs.existsSync(marker) ? fs.readFileSync(marker, "utf8").split("request").length - 1 : 0;
    assert.equal(count, afterRequest ? 1 : 0);
    assert.equal(recovered.reconcile(ctx, recovered.list(ctx)[0]!.id, { kind: "absent" })?.state, "unknown");
  });
}

nativeTest("a failed durable dispatch grants no permit and fences the current instance", t => {
  const { actions, ctx, home } = fixture(t);
  const prepared = actions.prepare(ctx, merge)!;
  let requests = 0;
  const replace = t.mock.method(fs, "renameSync", () => { throw new Error("synthetic storage failure"); });
  assert.throws(() => { if (actions.dispatch(ctx, prepared.confirmation)) requests++; }, /storage requires recovery/);
  replace.mock.restore();
  assert.throws(() => { if (actions.dispatch(ctx, prepared.confirmation)) requests++; }, /storage requires recovery/);
  assert.equal(requests, 0);
  const reopened = new ReviewActions(home);
  assert.equal(reopened.list(ctx)[0]?.state, "rejected");
  assert.equal(reopened.dispatch(ctx, prepared.confirmation), null);
});

nativeTest("failure after receipt replacement stays unknown on restart even when no request was sent", t => {
  const { actions, ctx, home } = fixture(t);
  const prepared = actions.prepare(ctx, merge)!;
  const sync = fs.fsyncSync;
  const fault = t.mock.method(fs, "fsyncSync", (fd: number) => { if (fs.fstatSync(fd).isDirectory()) throw new Error("synthetic directory sync failure"); sync(fd); });
  assert.throws(() => actions.dispatch(ctx, prepared.confirmation), /storage requires recovery/);
  fault.mock.restore();
  const reopened = new ReviewActions(home);
  assert.equal(reopened.list(ctx)[0]?.state, "unknown");
  assert.equal(reopened.prepare(ctx, merge), null);
});

nativeTest("caller mutations and repeated/stale completions cannot change a stored operation or draft", t => {
  const { actions, ctx } = fixture(t);
  const saved = actions.saveDraft(ctx, "comment", 0, "original")!;
  saved.body = "mutated return"; saved.key.account = "2002";
  const prepared = actions.prepare(ctx, comment, 1)!;
  prepared.intent.payload!.body = "mutated preview";
  const permit = actions.dispatch(ctx, prepared.confirmation)!;
  assert.equal(permit.payload?.body, "original");
  assert.equal(actions.complete({ ...ctx, session: "other-document" }, permit.id, { state: "confirmed", remoteId: "wrong" }), null);
  assert.equal(actions.complete({ ...ctx, account: "2002" }, permit.id, { state: "confirmed", remoteId: "wrong" }), null);
  assert.equal(actions.complete(ctx, permit.id, { state: "confirmed", remoteId: "comment-43" })?.remoteId, "comment-43");
  assert.equal(actions.complete(ctx, permit.id, { state: "rejected", reason: "failed" }), null);
  assert.equal(actions.getDraft(ctx, "comment")?.body, "original");
});

nativeTest("a stale storage owner cannot overwrite another owner's draft or gain a dispatch permit", t => {
  const { actions, ctx, home } = fixture(t);
  const stale = new ReviewActions(home);
  actions.saveDraft(ctx, "comment", 0, "owned edit");
  assert.throws(() => stale.saveDraft(ctx, "comment", 0, "lost update"), /storage requires recovery/);
  assert.throws(() => stale.prepare(ctx, merge), /storage requires recovery/);
  assert.equal(new ReviewActions(home).getDraft(ctx, "comment")?.body, "owned edit");
});

for (const corrupt of ["state", "digest", "duplicate", "unknown-field"] as const) {
  nativeTest(`invalid persisted ${corrupt} refuses recovery and preserves the original bytes`, t => {
    const { actions, ctx, home } = fixture(t);
    actions.prepare(ctx, merge);
    const file = path.join(home, "review-actions", "state.json");
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    if (corrupt === "state") doc.intents[0].state = "ready-to-retry";
    if (corrupt === "digest") doc.intents[0].revision.headSha = "d".repeat(40);
    if (corrupt === "duplicate") doc.intents.push(doc.intents[0]);
    if (corrupt === "unknown-field") doc.token = "synthetic-credential-must-not-be-loaded";
    const raw = JSON.stringify(doc); fs.writeFileSync(file, raw);
    assert.throws(() => new ReviewActions(home));
    assert.equal(fs.readFileSync(file, "utf8"), raw);
  });
}

nativeTest("bounded receipt storage refuses new intents without evicting duplicate protection", t => {
  const { actions, ctx, home } = fixture(t);
  for (let i = 0; i < 127; i++) {
    const p = actions.prepare(ctx, merge)!; actions.dispatch(ctx, p.confirmation);
    actions.complete(ctx, p.intent.id, { state: "confirmed", remoteId: `merged-${i}` });
  }
  // A send in doubt on this PR: its earlier receipts are what keep a read-back from matching an old remote id.
  const doubt = actions.prepare(ctx, merge)!; actions.dispatch(ctx, doubt.confirmation);
  const bounded = new ReviewActions(home);
  const other = { ...ctx, key: { ...ctx.key, number: 74 } };
  assert.equal(bounded.prepare(other, merge), null);
  assert.equal(bounded.list(ctx).length, 128);
});

nativeTest("bounded receipt storage evicts the oldest settled receipts of PRs with nothing in doubt", t => {
  const { actions, ctx, home } = fixture(t);
  for (let i = 0; i < 128; i++) {
    const p = actions.prepare(ctx, merge)!; actions.dispatch(ctx, p.confirmation);
    actions.complete(ctx, p.intent.id, { state: "confirmed", remoteId: `merged-${i}` });
  }
  const bounded = new ReviewActions(home);
  assert.ok(bounded.prepare(ctx, merge));
  const kept = bounded.list(ctx);
  assert.equal(kept.length, 128);
  assert.equal(kept.some(i => i.remoteId === "merged-0"), false);
  assert.equal(kept.at(-2)?.remoteId, "merged-127");
});

nativeTest("wrong account, unsupported operations and oversized drafts stay inert", t => {
  const { actions, ctx } = fixture(t);
  assert.equal(actions.saveDraft({ ...ctx, account: "2002" }, "comment", 0, "wrong account"), null);
  assert.equal(actions.saveDraft(ctx, "comment", 0, "x".repeat(65537)), null);
  assert.equal(actions.prepare(ctx, { kind: "state" } as never), null);
  assert.equal(actions.prepare(ctx, { ...merge, token: "synthetic" } as never), null);
  assert.equal(actions.prepare({ ...ctx, permitted: false }, merge), null);
  assert.deepEqual(actions.list({ ...ctx, account: "2002" }), []);
  assert.equal(actions.prepare(ctx, comment, 1), null);
});

nativeTest("an earlier same-body operation cannot reconcile a distinct uncertain attempt", t => {
  const { actions, ctx } = fixture(t);
  actions.saveDraft(ctx, "comment", 0, "identical repeated text");
  const a = actions.prepare(ctx, comment, 1)!; actions.dispatch(ctx, a.confirmation);
  actions.complete(ctx, a.intent.id, { state: "confirmed", remoteId: "old-comment" });
  const b = actions.prepare(ctx, comment, 1)!; actions.dispatch(ctx, b.confirmation);
  actions.complete(ctx, b.intent.id, { state: "unknown" });
  const old = { kind: "matched" as const, key: ctx.key, revision: ctx.revision, digest: a.intent.digest, remoteId: "old-comment" };
  assert.equal(actions.reconcile(ctx, b.intent.id, old)?.state, "unknown");
  assert.equal(actions.prepare(ctx, comment, 1), null);
  assert.notEqual(a.intent.digest, b.intent.digest, "Correlation must distinguish identical payloads from separate attempts");
  assert.equal(actions.reconcile(ctx, b.intent.id, { ...old, digest: b.intent.digest })?.state, "unknown", "A known old remote ID cannot confirm a second attempt");
});

nativeTest("an abandoned or stale preparation can be cancelled once without cancelling an uncertain dispatch", t => {
  const { actions, ctx } = fixture(t);
  const old = actions.prepare(ctx, merge)!;
  const refreshed = structuredClone(ctx); refreshed.revision.headSha = "d".repeat(40); refreshed.session = "document-2";
  assert.equal(actions.dispatch(refreshed, old.confirmation), null);
  assert.equal(actions.cancel({ ...refreshed, account: "2002" }, old.intent.id), null);
  assert.equal(actions.cancel(refreshed, old.intent.id)?.state, "rejected");
  assert.equal(actions.cancel(refreshed, old.intent.id), null);
  assert.equal(actions.dispatch(ctx, old.confirmation), null);
  const next = actions.prepare(refreshed, merge)!;
  assert(actions.dispatch(refreshed, next.confirmation));
  assert.equal(actions.cancel(refreshed, next.intent.id), null);
  actions.complete(refreshed, next.intent.id, { state: "unknown" });
  assert.equal(actions.cancel(refreshed, next.intent.id), null);
  assert.equal(actions.prepare(refreshed, merge), null);
});

// The reused adapter deliberately cannot acknowledge strong Windows durability.
test("Windows refuses admission rather than returning an unsafe permit", { skip: process.platform !== "win32" }, t => {
  const { actions, ctx } = fixture(t);
  assert.throws(() => actions.prepare(ctx, merge), /storage requires recovery/);
  assert.deepEqual(actions.list(ctx), []);
});

nativeTest("decisions 2–4: state, edit and reviewer operations carry their exact data, with no draft, through a restart", t => {
  const { home, actions, ctx } = fixture(t);
  const ops: ReviewOperation[] = [
    { kind: "state", to: "closed" },
    { kind: "edit", title: "Lend holds between branches", body: null, expected: { title: "Move holds between branches", body: "" } },
    { kind: "reviewers", logins: ["grace-fixture", "kit-fixture"] },
  ];
  const digests = new Set<string>();
  for (const op of ops) {
    const prepared = actions.prepare(ctx, op);
    assert.ok(prepared, op.kind);
    assert.deepEqual([prepared.intent.payload, prepared.intent.draftVersion], [null, null], op.kind);
    assert.deepEqual(prepared.intent.operation, op);
    digests.add(prepared.intent.digest);
    assert.ok(actions.cancel(ctx, prepared.intent.id));
  }
  assert.equal(digests.size, 3);
  // A body edit may be long: up to the text bound, with the text it replaces.
  const long = "x".repeat(60_000);
  const big = actions.prepare(ctx, { kind: "edit", title: null, body: long, expected: { title: "T", body: long.slice(1) } });
  assert.ok(big);
  // A restart reads them back intact and turns the unsent one into a refusal.
  const restarted = new ReviewActions(home);
  assert.deepEqual(restarted.list(ctx).map((i) => [i.operation.kind, i.state, i.reason]),
    [["state", "rejected", "cancelled"], ["edit", "rejected", "cancelled"], ["reviewers", "rejected", "cancelled"], ["edit", "rejected", "restart"]]);
});

nativeTest("malformed state, edit and reviewer operations are refused", t => {
  const { actions, ctx } = fixture(t);
  const expected = { title: "T", body: "" };
  for (const op of [
    { kind: "state", to: "merged" },
    { kind: "state", to: "closed", extra: true },
    { kind: "edit", title: null, body: null, expected },
    { kind: "edit", title: "", body: null, expected },
    { kind: "edit", title: "two\nlines", body: null, expected },
    { kind: "edit", title: "x".repeat(257), body: null, expected },
    { kind: "edit", title: "ok", body: null },
    { kind: "edit", title: "ok", body: "bell\u0007", expected },
    { kind: "reviewers", logins: [] },
    { kind: "reviewers", logins: ["-bad"] },
    { kind: "reviewers", logins: ["Ada", "ada"] },
    { kind: "reviewers", logins: Array.from({ length: 16 }, (_, i) => `r${i}`) },
    { kind: "reviewers", logins: "ada" },
  ]) assert.equal(actions.prepare(ctx, op as never), null, JSON.stringify(op).slice(0, 80));
});
