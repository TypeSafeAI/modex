import { test } from "node:test";
import assert from "node:assert/strict";
import { retainFilePage, filePageRows, FILE_LIMITS, pageStopReason } from "../src/renderer/code-review/file-pages.js";
import type { PrFile, PrFiles, ReadResult } from "../src/shared/code-review.js";
import { NOW, R4, stressFiles } from "./fixtures/code-review.js";
const ready = (files: PrFile[], next: string | null = null): Extract<ReadResult<PrFiles>, { state: "ready" }> => ({ state: "ready", value: { revision: R4.overview.revision, diffBaseSha: R4.overview.revision.baseSha, files }, fetchedAt: NOW, coverage: { loaded: files.length, total: 1000, complete: next === null, next } });

test("page retention preserves merge-base identity and refuses mixed provenance", () => {
  const first = ready([]);
  Object.assign(first.value, { diffBaseSha: "a".repeat(40) });
  const pages = retainFilePage([], null, first);
  assert.equal((pages[0]!.result as typeof first).value && Reflect.get((pages[0]!.result as typeof first).value, "diffBaseSha"), "a".repeat(40));
  const next = ready([]);
  Object.assign(next.value, { diffBaseSha: "b".repeat(40) });
  const mixed = retainFilePage(pages, "p2", next);
  assert.equal(mixed[1]!.result.state, "unavailable");
});

test("file pages retain failed cursor identity and replace that page on retry", () => {
  let pages = retainFilePage([], null, ready(stressFiles(1), "p2"));
  pages = retainFilePage(pages, "p2", { state: "unavailable", reason: "timeout", fetchedAt: NOW });
  // A saved view is serializable; its failure cursor survives remount.
  pages = JSON.parse(JSON.stringify(pages));
  assert.equal(pages.at(-1)!.cursor, "p2");
  pages = retainFilePage(pages, "p2", ready(stressFiles(2).slice(1)));
  assert.equal(pages.length, 2);
  assert.equal(filePageRows(pages).length, 2);
  assert.equal(pages.at(-1)!.result.state, "ready");
});

test("retained payload is bounded independently of parsed or mounted file bodies", () => {
  const files = stressFiles(300).map((f): PrFile => ({ ...f, additions: 1, patch: { kind: "text", patch: "@@ -0,0 +1 @@\n+" + "x".repeat(64 * 1024) } }));
  let pages = retainFilePage([], null, ready(files.slice(0, 100), "p2"));
  pages = retainFilePage(pages, "p2", ready(files.slice(100, 200), "p3"));
  pages = retainFilePage(pages, "p3", ready(files.slice(200)));
  const rows = filePageRows(pages);
  assert.equal(rows.length, 300);
  const characters = rows.reduce((n, f) => n + (f.patch.kind === "text" ? f.patch.patch.length : 0), 0);
  assert.ok(characters <= FILE_LIMITS.characters);
  assert.equal(rows.at(-1)!.patch.kind, "omitted");
  assert.equal(rows.at(-1)!.additions, 1);
  const huge = retainFilePage([], null, ready([{ ...files[0]!, patch: { kind: "text", patch: "x".repeat(3 * 1024 * 1024) } }]));
  assert.deepEqual(filePageRows(huge)[0]!.patch, { kind: "omitted", reason: "too-large" });
});

test("duplicate cursors and files cannot grow retained pages; no-progress replies stop pagination", () => {
  let pages = retainFilePage([], null, ready(stressFiles(2), "p2"));
  pages = retainFilePage(pages, "p2", ready(stressFiles(2), "p2"));
  assert.ok(pageStopReason(pages));
  for (let i = 0; i < 100; i++) pages = retainFilePage(pages, "p2", ready(stressFiles(2), "p2"));
  assert.equal(pages.length, 2);
  assert.equal(filePageRows(pages).length, 2);
  for (let i = 3; i < 50; i++) pages = retainFilePage(pages, `p${i}`, ready(stressFiles(2), `p${i + 1}`));
  assert.ok(pages.length <= FILE_LIMITS.pages);
});

test("a provider-capped multi-file response keeps provider totals but retains at most 1000 files", () => {
  const read = ready(stressFiles(3000));
  read.coverage = { loaded: 3000, total: 3000, complete: true, next: null };
  const pages = retainFilePage([], null, read);
  assert.equal(filePageRows(pages).length, FILE_LIMITS.files);
  assert.equal(pages[0]!.result.state === "ready" && pages[0]!.result.coverage?.total, 3000);
});
