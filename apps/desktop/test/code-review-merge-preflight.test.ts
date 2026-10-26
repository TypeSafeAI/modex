import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeOperation, mergePreflight, type MergeFacts } from "../src/main/engine/code-review-actions/merge-preflight.js";

const reviewed = () => ({ key: { account: "1001", host: "github.com" as const, repoId: "7301", number: 73 },
  revision: { baseRef: "main", baseSha: "b".repeat(40), headSha: "c".repeat(40) } });
const facts = (extra: Partial<MergeFacts> = {}): MergeFacts => ({ ...reviewed(), state: "open", mergeable: true, mergeState: "clean",
  methods: { merge: false, squash: true, rebase: null }, queue: "none", ...extra });

test("a clean open PR offers only the methods the repository explicitly allows, bound to the reviewed head", () => {
  const result = mergePreflight(reviewed(), facts());
  assert.deepEqual(result, { kind: "offer", key: reviewed().key, revision: reviewed().revision, expectedHeadSha: "c".repeat(40), methods: ["squash"], mergeState: "clean" });
  assert.deepEqual(mergeOperation(result, "squash"), { kind: "merge", method: "squash" });
  assert.equal(mergeOperation(result, "merge"), null);
  assert.equal(mergeOperation(result, "rebase"), null);
});

test("changed head, base or account requires renewed confirmation instead of adapting", () => {
  const moved = (patch: (f: MergeFacts) => void) => { const f = facts(); patch(f); return mergePreflight(reviewed(), f); };
  assert.deepEqual(moved(f => { f.revision = { ...f.revision, headSha: "d".repeat(40) }; }), { kind: "reconfirm", reason: "head-changed" });
  assert.deepEqual(moved(f => { f.revision = { ...f.revision, baseSha: "e".repeat(40) }; }), { kind: "reconfirm", reason: "target-changed" });
  assert.deepEqual(moved(f => { f.revision = { ...f.revision, baseRef: "release" }; }), { kind: "reconfirm", reason: "target-changed" });
  assert.deepEqual(moved(f => { f.key = { ...f.key, account: "2002" }; }), { kind: "reconfirm", reason: "scope-changed" });
  assert.deepEqual(moved(f => { f.key = { ...f.key, repoId: "7302" }; }), { kind: "reconfirm", reason: "scope-changed" });
  assert.deepEqual(moved(f => { f.key = { ...f.key, number: 74 }; }), { kind: "reconfirm", reason: "scope-changed" });
});

test("unknown mergeability and unreadable policy never count as permission", () => {
  const unavailable = (reason: string) => ({ kind: "unavailable", reason, fallback: "open-in-github" });
  assert.deepEqual(mergePreflight(reviewed(), facts({ mergeable: null })), unavailable("unknown"));
  assert.deepEqual(mergePreflight(reviewed(), facts({ mergeState: "unknown" })), unavailable("unknown"));
  assert.deepEqual(mergePreflight(reviewed(), facts({ mergeState: null })), unavailable("unknown"));
  assert.deepEqual(mergePreflight(reviewed(), facts({ methods: null })), unavailable("policy-unreadable"));
  assert.deepEqual(mergePreflight(reviewed(), facts({ methods: { merge: null, squash: null, rebase: null } })), unavailable("no-methods"));
  assert.deepEqual(mergePreflight(reviewed(), facts({ queue: null })), unavailable("policy-unreadable"));
  assert.deepEqual(mergePreflight(reviewed(), facts({ queue: "required" })), unavailable("queue"));
});

test("blocking states stay unavailable and offer GitHub instead of a bypass", () => {
  const unavailable = (reason: string) => ({ kind: "unavailable", reason, fallback: "open-in-github" });
  assert.deepEqual(mergePreflight(reviewed(), facts({ state: "closed" })), unavailable("not-open"));
  assert.deepEqual(mergePreflight(reviewed(), facts({ state: "merged" })), unavailable("not-open"));
  assert.deepEqual(mergePreflight(reviewed(), facts({ state: "draft" })), unavailable("draft"));
  assert.deepEqual(mergePreflight(reviewed(), facts({ mergeState: "draft" })), unavailable("draft"));
  assert.deepEqual(mergePreflight(reviewed(), facts({ mergeable: false })), unavailable("conflicts"));
  assert.deepEqual(mergePreflight(reviewed(), facts({ mergeState: "dirty" })), unavailable("conflicts"));
  assert.deepEqual(mergePreflight(reviewed(), facts({ mergeState: "blocked" })), unavailable("blocked"));
  assert.deepEqual(mergePreflight(reviewed(), facts({ mergeState: "behind" })), unavailable("behind"));
  const unstable = mergePreflight(reviewed(), facts({ mergeState: "unstable" }));
  assert.equal(unstable.kind === "offer" && unstable.mergeState, "unstable");
});

test("check counts, model findings and other extra inputs make the facts unreadable", () => {
  for (const extra of [{ checks: { passing: 11, total: 11 } }, { aiVerdict: "approve" }, { findings: [] }]) {
    assert.deepEqual(mergePreflight(reviewed(), { ...facts(), ...extra }), { kind: "unavailable", reason: "policy-unreadable", fallback: "open-in-github" });
  }
  assert.deepEqual(mergePreflight(reviewed(), { ...facts(), methods: { squash: true } }), { kind: "unavailable", reason: "policy-unreadable", fallback: "open-in-github" });
  assert.deepEqual(mergePreflight(reviewed(), { ...facts(), methods: { merge: "yes", squash: true, rebase: false } }), { kind: "unavailable", reason: "policy-unreadable", fallback: "open-in-github" });
  assert.deepEqual(mergePreflight(reviewed(), { ...facts(), mergeState: "mergeable" }), { kind: "unavailable", reason: "policy-unreadable", fallback: "open-in-github" });
  assert.deepEqual(mergePreflight(reviewed(), null), { kind: "unavailable", reason: "policy-unreadable", fallback: "open-in-github" });
  const bad = reviewed(); bad.revision.headSha = "not-a-sha";
  assert.deepEqual(mergePreflight(bad, facts()), { kind: "unavailable", reason: "policy-unreadable", fallback: "open-in-github" });
});

test("only an offer yields a merge operation, and the result never aliases caller data", () => {
  const f = facts({ methods: { merge: true, squash: true, rebase: true } });
  const result = mergePreflight(reviewed(), f);
  assert(result.kind === "offer");
  f.methods!.merge = false; f.revision.headSha = "d".repeat(40);
  assert.deepEqual(result.methods, ["merge", "squash", "rebase"]);
  assert.equal(result.expectedHeadSha, "c".repeat(40));
  assert.equal(mergeOperation({ kind: "reconfirm", reason: "head-changed" }, "squash"), null);
  assert.equal(mergeOperation({ kind: "unavailable", reason: "unknown", fallback: "open-in-github" }, "squash"), null);
  assert.equal(mergeOperation(result, "fast-forward" as never), null);
});
