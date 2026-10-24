import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { tid } from "./support.js";
import { baseWorld, LENDING, launchWithGh, prRow, type Harness } from "./code-review-support.js";
import { ghFile, ghPull, ghRow } from "../test/fixtures/code-review-gh-world.js";
import type { CodeReviewReply, CodeReviewRequest, Inbox, PrKey, PrOverview } from "../src/shared/code-review.js";

/**
 * CR-8 (#327) stress fixtures through the production read service and real Electron (e2e/code-review-support.ts):
 *
 * 1. A 300-row authored inbox: 10 search pages, opened and paged with Show more. Counted: gh requests, mounted
 *    rows and DOM nodes, the renderer's JS heap, and the time to each page's rows.
 * 2. A 1,000-file PR's files list (10 pages of 100) and a 3 MiB textual patch, read over IPC. #324 has not built the
 *    diff view, so this measures main's read and the IPC hop only, not rendering.
 *
 * These are product fixtures, not GitHub's limits (GitHub serves 1,000 search results and 3,000 files, and omits
 * very large patches). The asserted bounds hold on any machine; the times are this machine's. MODEX_MEASURE=<file>
 * writes them as JSON with the machine's description before anything is asserted. No budget is enforced yet:
 * #327 agrees budgets from a measured baseline first.
 */
let h: Harness;
test.afterEach(async () => { await h?.close(); });

function record(name: string, value: unknown): void {
  const file = process.env.MODEX_MEASURE;
  if (!file) return;
  const cpus = os.cpus();
  let sha = "";
  try { sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(); } catch { /* Not a checkout. */ }
  let model = "";
  try { model = execFileSync("sysctl", ["-n", "hw.model"], { encoding: "utf8" }).trim(); } catch { /* Not macOS. */ }
  const all = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown> : {};
  fs.writeFileSync(file, JSON.stringify({ ...all, measuredAt: new Date().toISOString(), sha,
    machine: { model, cpu: cpus[0]?.model, cores: cpus.length, memoryGiB: Math.round(os.totalmem() / 2 ** 30), platform: process.platform, arch: process.arch, release: os.release(), loadAverage: os.loadavg() },
    [name]: value }, null, 2) + "\n");
}

const ROWS = 300;

test("a 300-row inbox pages in with one search per page and bounded DOM", async () => {
  const world = baseWorld();
  world.search.authored = Array.from({ length: ROWS }, (_, i) => ghRow(LENDING, 1000 + i, `Synthetic change ${String(i + 1).padStart(3, "0")} to the lending queue`, [1001, "ada-fixture"],
    new Date(Date.parse("2026-10-18T20:30:00Z") - i * 60_000).toISOString()));
  h = await launchWithGh(world);
  const { page } = h;
  // The renderer's resident memory, from main: `performance.memory` reads 0 in this renderer.
  const rendererMiB = () => h.app.evaluate(({ app }) => Math.round((app.getAppMetrics().find((m) => m.type === "Tab")?.memory.workingSetSize ?? 0) / 1024 * 10) / 10);
  const metrics = async () => ({ ...(await page.evaluate(() => ({ nodes: document.getElementsByTagName("*").length, rows: document.querySelectorAll('[data-testid="code-review-row"]').length }))),
    rendererMiB: await rendererMiB() });
  const searches = () => h.calls().filter((c) => c.startsWith("search/issues")).length;
  const empty = await metrics();
  let t = Date.now();
  await tid(page, "rail-code-review").click();
  await expect(prRow(page, "example-org/lending#1029")).toBeVisible();
  const first = { ms: Date.now() - t, ...(await metrics()), searches: searches(), requests: h.calls().length };
  const pages: number[] = [];
  for (let n = 2; n <= ROWS / 30; n++) {
    t = Date.now();
    await tid(page, "code-review-show-more-authored").click();
    await expect(prRow(page, `example-org/lending#${1000 + n * 30 - 1}`)).toBeVisible();
    pages.push(Date.now() - t);
  }
  const last = { ...(await metrics()), searches: searches(), requests: h.calls().length };
  // Scrolling the full list: the time for the list to reach its end and paint.
  const list = tid(page, "code-review-inbox-list");
  const scrollMs = await list.evaluate(async (el) => { const t0 = performance.now(); el.scrollTop = el.scrollHeight; await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); return Math.round(performance.now() - t0); });
  // Opening a PR from the bottom of the long list.
  t = Date.now();
  await prRow(page, "example-org/lending#1299").click();
  await expect(tid(page, "code-review-pr-id").first()).toHaveText("lending #1299");
  const open = Date.now() - t;
  record("inbox300", { empty, first, showMoreMs: pages, last, scrollToEndMs: scrollMs, openFromBottomMs: open });
  // 2 searches for the first read (both groups), then one per Show more; no repeated repository lookups.
  expect(first.searches).toBe(2);
  expect(last.searches).toBe(2 + ROWS / 30 - 1);
  expect(h.calls().filter((c) => c === "repos/example-org/lending").length).toBe(1);
  expect(last.rows).toBe(ROWS + 1);
  await expect(tid(page, "code-review-show-more-authored")).toHaveCount(0);
});

test("a 1,000-file PR and a 3 MiB patch read over IPC in bounded requests", async () => {
  const world = baseWorld();
  const files = Array.from({ length: 1000 }, (_, i) => ghFile(`src/generated/module-${String(i).padStart(4, "0")}.ts`, `@@ -0,0 +1 @@\n+export const value${i} = ${i};`, 1, 0, "added"));
  world.routes["repos/example-org/lending/pulls/73"] = ghPull(LENDING, 73, "A thousand files", { files: 1000, additions: 1000, deletions: 0 });
  world.routes["repos/example-org/lending/pulls/73/files"] = files;
  // 3 MiB of added text in one patch: 49,152 lines of 63 characters plus the newline.
  const line = "+" + "x".repeat(62);
  const big = `@@ -0,0 +1,49152 @@\n${Array.from({ length: 49152 }, () => line).join("\n")}`;
  world.routes["repos/example-org/lending/pulls/70"] = ghPull(LENDING, 70, "One very large patch", { files: 1, additions: 49152, deletions: 0 });
  world.routes["repos/example-org/lending/pulls/70/files"] = [ghFile("data/large.txt", big, 49152, 0, "added")];
  h = await launchWithGh(world);
  const { page } = h;
  const invoke = (request: CodeReviewRequest) => page.evaluate((r) => window.modex!.invoke("code-review:read", r), request) as Promise<CodeReviewReply>;
  const inbox = await invoke({ op: "inbox", requestId: "inbox", query: "" });
  const rows = Object.values((inbox.result as { value: Inbox }).value.groups).flatMap((g) => g.state === "unavailable" ? [] : g.value);
  const keyOf = (n: number) => rows.find((r) => r.locator.repo === "lending" && r.locator.number === n)!.key as PrKey;
  const before = h.calls().length;
  const overview = await invoke({ op: "overview", requestId: "o73", key: keyOf(73) });
  const revision = (overview.result as { value: PrOverview }).value.revision;
  let cursor: string | null = null, loaded = 0, bytes = 0, pagesRead = 0;
  const t = Date.now();
  do {
    const reply: CodeReviewReply = await invoke({ op: "files", requestId: `f${pagesRead}`, key: keyOf(73), revision, cursor });
    if (reply.result.state === "unavailable") throw new Error(`files page ${pagesRead}: ${reply.result.reason}`);
    bytes += JSON.stringify(reply).length;
    loaded = reply.result.coverage?.loaded ?? loaded;
    cursor = reply.result.coverage?.next ?? null;
    pagesRead++;
    if (!cursor) expect(reply.result).toMatchObject({ state: "ready", coverage: { loaded: 1000, total: 1000, complete: true } });
  } while (cursor);
  const thousand = { ms: Date.now() - t, pages: pagesRead, replyBytes: bytes, requests: h.calls().length - before };
  const o70 = await invoke({ op: "overview", requestId: "o70", key: keyOf(70) });
  const t2 = Date.now();
  const large = await invoke({ op: "files", requestId: "large", key: keyOf(70), revision: (o70.result as { value: PrOverview }).value.revision, cursor: null });
  const patch = { ms: Date.now() - t2, replyBytes: JSON.stringify(large).length, state: large.result.state };
  record("files", { thousand, patch3MiB: patch });
  expect(loaded).toBe(1000);
  expect(pagesRead).toBe(10);
  // Each page is the list plus a read of the PR on either side of it: 1 overview + 10 × 3.
  expect(thousand.requests).toBe(1 + 10 * 3);
  expect(large.result).toMatchObject({ state: "ready", value: { files: [{ patch: { kind: "text" } }] } });
  expect(patch.replyBytes).toBeGreaterThan(3 * 2 ** 20);
});
