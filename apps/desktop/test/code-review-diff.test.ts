import { test } from "node:test";
import assert from "node:assert/strict";
import { anchorFor, anchorState, parsePatch, hunkBounds, contextWindow, PATCH_LIMITS } from "../src/renderer/code-review/patch.js";
import type { PrFile } from "../src/shared/code-review.js";
import { R4, FAULTS } from "./fixtures/code-review.js";

const file = (patch: string, extra: Partial<PrFile> = {}): PrFile => ({ path: "src/旧 file.ts", previousPath: null, status: "modified", additions: 2, deletions: 1, patch: { kind: "text", patch }, ...extra });

test("multiple hunks keep both line numbers and final-newline markers", () => {
  const model = parsePatch(file("@@ -2,2 +2,3 @@\n same\n-old\n+new\n+extra\n\\ No newline at end of file\n@@ -20 +21 @@\n-end\n+finish\n", { additions: 3, deletions: 2 }));
  assert.equal(model.state, "text");
  assert.deepEqual(model.hunks.map(h => h.rows.map(r => [r.kind, r.oldLine, r.newLine, r.noNewline])), [
    [["context", 2, 2, false], ["del", 3, null, false], ["add", null, 3, false], ["add", null, 4, true]],
    [["del", 20, null, false], ["add", null, 21, false]],
  ]);
  assert.equal(model.complete, true);
});

test("added and removed files have zero-length sides; empty files carry no invented lines", () => {
  const added = parsePatch(file("@@ -0,0 +1,2 @@\n+a\n+b", { status: "added", deletions: 0 }));
  assert.deepEqual(added.hunks[0]!.rows.map(r => [r.oldLine, r.newLine]), [[null, 1], [null, 2]]);
  const removed = parsePatch(file("@@ -1,2 +0,0 @@\n-a\n-b", { status: "removed", additions: 0, deletions: 2 }));
  assert.deepEqual(removed.hunks[0]!.rows.map(r => [r.oldLine, r.newLine]), [[1, null], [2, null]]);
  assert.equal(parsePatch(file("", { additions: 0, deletions: 0 })).complete, true);
  assert.equal(parsePatch(file("", { additions: 1 })).complete, false);
});

test("binary, provider omitted, oversized and truncated text remain distinguishable", () => {
  for (const reason of ["binary", "provider", "too-large"] as const) {
    const m = parsePatch(file("", { patch: { kind: "omitted", reason } }));
    assert.equal(m.state, reason);
    assert.equal(m.complete, reason === "binary");
  }
  assert.equal(parsePatch(file("@@ -1,2 +1,2 @@\n same")).complete, false);
  assert.equal(parsePatch(file("@@ -1 +1 @@\n-old\n+new", { additions: 4 })).complete, false);
  assert.equal(parsePatch(file("x".repeat(3 * 1024 * 1024))).state, "too-large");
  assert.ok(PATCH_LIMITS.characters < 3 * 1024 * 1024);
});

test("anchors retain renamed paths, side and exact revision; changed keys or heads are outdated", () => {
  const f = file("", { status: "renamed", previousPath: "old/空 name.ts" });
  const a = anchorFor(R4.overview.key, R4.overview.revision, f, "base", 3, 5);
  assert.ok(a);
  assert.equal(a.path, "old/空 name.ts");
  assert.equal(anchorFor(R4.overview.key, R4.overview.revision, f, "head", 4)?.path, f.path);
  assert.equal(anchorState(a, R4.overview.key, R4.overview.revision), "current");
  assert.equal(anchorState(a, R4.overview.key, FAULTS.headChanged.before), "outdated");
  assert.equal(anchorState(a, { ...R4.overview.key, account: "999" }, R4.overview.revision), "outdated");
  assert.equal(anchorFor(R4.overview.key, R4.overview.revision, f, "head", 0), null);
  assert.equal(anchorFor(R4.overview.key, R4.overview.revision, f, "head", 5, 4), null);
  for (const path of ["../local", "/tmp/file", "a/../b", "a/\u202eb", "a//b"]) {
    assert.equal(anchorFor(R4.overview.key, R4.overview.revision, { ...f, path }, "head", 1), null);
  }
});

test("R4 fixture patches preserve provider totals and valid line references", () => {
  assert.notEqual(R4.files.state, "unavailable");
  if (R4.files.state === "unavailable") return;
  for (const f of R4.files.value.files) {
    const m = parsePatch(f);
    assert.equal(m.complete, true, f.path);
    for (const h of m.hunks) for (const r of h.rows) {
      if (r.oldLine !== null) assert.ok(anchorFor(R4.overview.key, R4.overview.revision, f, "base", r.oldLine));
      if (r.newLine !== null) assert.ok(anchorFor(R4.overview.key, R4.overview.revision, f, "head", r.newLine));
    }
  }
});

test("malformed or overlapping hunk ranges cannot create complete patch evidence", () => {
  for (const patch of [
    "@@ -1 +1 @@\n-a\n+b\n+extra",
    "@@ -1 +1 @@\n-a\n+b\n@@ -1 +1 @@\n-a\n+b",
    "@@ -99999999999999999999 +1 @@\n-a\n+b",
    "@@ -1 +1 @@\nnot a diff row",
  ]) assert.equal(parsePatch(file(patch)).complete, false);
  const tooMany = `@@ -0,0 +1,${PATCH_LIMITS.rows + 1} @@\n${"+a\n".repeat(PATCH_LIMITS.rows + 1)}`;
  assert.equal(parsePatch(file(tooMany, { additions: PATCH_LIMITS.rows + 1, deletions: 0 })).state, "too-large");
});

test("zero-count hunk coordinates mean after that line, including context between hunks", () => {
  const f = file("@@ -5,0 +6,2 @@\n+insert one\n+insert two\n@@ -10 +12 @@\n-old\n+new", { additions: 3, deletions: 1 });
  const m = parsePatch(f);
  assert.equal(m.complete, true);
  assert.deepEqual(hunkBounds(m.hunks[0]!), { oldStart: 6, newStart: 6, oldEnd: 6, newEnd: 8 });
  assert.deepEqual(hunkBounds(m.hunks[1]!), { oldStart: 10, newStart: 12, oldEnd: 11, newEnd: 13 });
  const inconsistent = parsePatch(file("@@ -5,0 +7,2 @@\n+insert one\n+insert two\n@@ -10 +12 @@\n-old\n+new", { additions: 3, deletions: 1 }));
  assert.equal(inconsistent.complete, false);
});

test("context windows reveal both ends of a distant gap within the same file budget", () => {
  const gap = { oldStart: 1, newStart: 1, count: 9999, top: 0, bottom: 0, budget: 200 };
  assert.deepEqual(contextWindow({ ...gap, direction: "before" }), { start: 9960, end: 9999, oldStart: 9960, length: 40 });
  assert.deepEqual(contextWindow({ ...gap, bottom: 40, budget: 160, direction: "after" }), { start: 1, end: 40, oldStart: 1, length: 40 });
  assert.deepEqual(contextWindow({ oldStart: 6, newStart: 8, count: 4, top: 0, bottom: 0, budget: 200, direction: "before" }), { start: 8, end: 11, oldStart: 6, length: 4 });
  assert.equal(contextWindow({ ...gap, budget: 0, direction: "before" }), null);
  assert.equal(contextWindow({ ...gap, count: 10, top: 5, bottom: 5, direction: "before" }), null);
});
