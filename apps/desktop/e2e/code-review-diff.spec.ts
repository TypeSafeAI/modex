import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { launch, resizeWindow, seedHome, tid } from "./support.js";
import { NOW, R1, R4, stressFiles } from "../test/fixtures/code-review.js";
import type { PrFile } from "../src/shared/code-review.js";

let home: string, repo: string, app: ElectronApplication, page: Page;
async function open(files?: PrFile[], hold: string | null = null) {
  ({ home, repo } = seedHome());
  ({ app, page } = await launch(home));
  if (R4.files.state === "unavailable") throw new Error("fixture");
  await app.evaluate(({ ipcMain }, data) => {
    const g = globalThis as any;
    g.__diff = { log: [], files: data.files, revision: data.overview.revision, hold: data.hold, held: [], local: [] };
    for (const op of ["changes:diff", "changes:revert", "files:read"]) {
      ipcMain.removeHandler(op);
      ipcMain.handle(op, () => { g.__diff.local.push(op); throw new Error("Remote diff reached local operation"); });
    }
    ipcMain.removeHandler("code-review:read");
    ipcMain.handle("code-review:read", async (_event, req) => {
      const s = g.__diff;
      s.log.push(req);
      if (req.op === "cancel") return null;
      const ready = (value: unknown, coverage?: unknown) => ({ state: "ready", value, fetchedAt: data.at, ...(coverage ? { coverage } : {}) });
      let result;
      if (req.op === "connection") result = s.connection ?? data.connection;
      else if (req.op === "inbox") result = data.inbox;
      else if (req.op === "overview") result = ready(req.key.repoId === data.alternate.key.repoId ? data.alternate : { ...data.overview, revision: s.revision });
      else if (req.op === "files") {
        const source = req.key.repoId === data.alternate.key.repoId ? [{ ...s.files[0], path: "other-pr.ts" }] : s.files;
        const offset = req.cursor ? (Number(req.cursor.slice(1)) - 1) * 100 : 0, files = source.slice(offset, offset + 100);
        result = ready({ revision: req.revision, diffBaseSha: s.diffBaseSha ?? req.revision.baseSha, files }, { loaded: offset + files.length, total: source.length, complete: offset + files.length >= source.length, next: offset + files.length < source.length ? `p${offset / 100 + 2}` : null });
      } else if (req.op === "context") result = ready({ revision: req.revision, commitSha: s.badContextCommit ? "f".repeat(40) : req.revision.headSha, side: req.side, path: req.path, start: req.start, lines: s.contextLines ?? Array.from({ length: req.end - req.start + 1 }, (_, i) => `remote context ${req.start + i}`), total: Math.max(req.end + 100, 900) });
      else result = { state: "unavailable", reason: "failed", fetchedAt: data.at };
      // Capture the old answer before holding it, so changing the head really delivers an old reply.
      if (s.badFilesRevision && req.op === "files") result = ready({ revision: { ...req.revision, headSha: "0".repeat(40) }, files: s.files });
      if (s.repeatCursor && req.op === "files" && req.cursor) result = ready({ revision: req.revision, diffBaseSha: s.diffBaseSha ?? req.revision.baseSha, files: s.files.slice(0, 100) }, { loaded: 100, total: s.files.length, complete: false, next: req.cursor });
      if (s.failCursor && req.cursor === s.failCursor) result = { state: "unavailable", reason: "timeout", fetchedAt: data.at };
      if (s.badContext && req.op === "context") result = ready({ revision: req.revision, commitSha: s.badContextCommit ? "f".repeat(40) : req.revision.headSha, side: "head", path: "other.ts", start: req.start, lines: ["wrong file code"], total: 20 });
      if (s.hold === req.op) await new Promise<void>(resolve => s.held.push(resolve));
      return { requestId: req.requestId, op: req.op, scope: { account: req.key?.account ?? data.account, key: req.key ?? null, revision: req.revision ?? null }, result };
    });
  }, { files: files ?? R4.files.value.files, overview: R4.overview, alternate: R1.overview, connection: R1.connection, inbox: R1.inbox, at: NOW, account: R4.overview.key.account, hold });
  await page.evaluate(() => localStorage.setItem("modex.codeReview", "on"));
  await page.reload();
  await tid(page, "rail-code-review").click();
  await page.locator('[data-testid="code-review-row"][data-pr="example-org/field-guide#91"]').click();
  await tid(page, "code-review-tab-changes").click();
}
const log = () => app.evaluate(() => (globalThis as any).__diff.log);
test.afterEach(async () => { await app?.close(); for (const dir of [home, repo]) if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

test("grouped diffs, both gutters, hierarchy, filter and keyboard selection use remote data only", async () => {
  await open();
  await expect(tid(page, "cr-file-section")).toHaveCount(4);
  await expect(tid(page, "cr-file-section").first()).toContainText("src/holds/move.ts");
  await expect(page.locator('[data-old-line][data-new-line]').first()).toBeVisible();
  await page.getByRole("textbox", { name: "Filter remote files" }).fill("changelog");
  await expect(tid(page, "cr-tree-file")).toHaveCount(1);
  const file = tid(page, "cr-tree-file").first();
  await file.focus(); await page.keyboard.press("Enter");
  await expect(file).toHaveAttribute("aria-current", "true");
  await expect(tid(page, "cr-file-section").last()).toBeInViewport();
  await page.getByRole("textbox", { name: "Filter remote files" }).fill("");
  await expect(tid(page, "cr-tree-file")).toHaveCount(4);
  await file.focus(); await page.keyboard.press("Home");
  await expect(tid(page, "cr-tree-file").first()).toBeFocused();
  await page.getByRole("button", { name: "Collapse src/holds/move.ts", exact: true }).click();
  await expect(tid(page, "cr-file-section").first().getByTestId("diff")).toHaveCount(0);
  expect(await app.evaluate(() => (globalThis as any).__diff.local)).toEqual([]);
  expect((await log()).filter((r: any) => r.op === "files")).toHaveLength(1);
});

test("expanding context asks the exact remote revision and never a local file", async () => {
  await open();
  const section = tid(page, "cr-file-section").first();
  await section.getByRole("button", { name: /Expand.*unchanged/ }).first().click();
  await expect(section).toContainText("remote context");
  const req = (await log()).find((r: any) => r.op === "context");
  expect(req.revision).toEqual(R4.overview.revision);
  expect(req.key).toEqual(R4.overview.key);
  expect(req.end - req.start + 1).toBeLessThanOrEqual(40);
  expect(await app.evaluate(() => (globalThis as any).__diff.local)).toEqual([]);
});

test("binary, omitted, oversized and truncated patches disclose missing coverage and provider counts", async () => {
  const files: PrFile[] = [
    { ...stressFiles(1)[0]!, path: "binary.png", additions: 0, patch: { kind: "omitted", reason: "binary" } },
    { ...stressFiles(1)[0]!, path: "omitted.ts", additions: 89, patch: { kind: "omitted", reason: "provider" } },
    { ...stressFiles(1)[0]!, path: "huge.ts", patch: { kind: "text", patch: "x".repeat(3 * 1024 * 1024) } },
    { ...stressFiles(1)[0]!, path: "truncated.ts", patch: { kind: "text", patch: "@@ -0,0 +1,3 @@\n+one" } },
  ];
  await open(files);
  await expect(tid(page, "cr-file-section").nth(0)).toContainText("No text diff");
  for (let i = 1; i < files.length; i++) {
    const toggle = page.getByRole("button", { name: `Expand ${files[i]!.path}`, exact: true });
    if (await toggle.count()) await toggle.click();
  }
  await expect(tid(page, "cr-file-section").nth(1)).toContainText("Patch omitted by provider");
  await expect(tid(page, "cr-file-section").nth(1)).toContainText("+89");
  await expect(tid(page, "cr-file-section").nth(2)).toContainText("Patch exceeds display limit");
  await expect(tid(page, "cr-file-section").nth(3)).toContainText("Incomplete patch");
  await expect(page.locator('[data-testid="cr-file-section"] [data-testid="diff"]')).toHaveCount(1);
});

test("narrow tree selection returns to the diff and retains keyboard access", async () => {
  await open(); await resizeWindow(app, page, 900, 600);
  await page.getByRole("separator", { name: "Resize sidebar", exact: true }).focus();
  await page.keyboard.press("End");
  await tid(page, "code-review-files-toggle").click();
  await expect(tid(page, "code-review-tree")).toBeVisible();
  await tid(page, "cr-tree-file").last().click();
  await expect(tid(page, "code-review-diff")).toBeVisible();
  await expect(tid(page, "cr-file-section").last()).toBeInViewport();
});

async function refreshOverview() {
  await tid(page, "code-review-inbox-menu").click();
  await tid(page, "code-review-refresh").click();
}
async function releaseHeld() {
  await app.evaluate(() => { const s = (globalThis as any).__diff; s.hold = null; for (const release of s.held.splice(0)) release(); });
}

test("head change cancels delayed context, keeps the old anchor outdated and drops old code", async () => {
  await open();
  await page.getByRole("button", { name: /^New line / }).first().click();
  await app.evaluate(() => { (globalThis as any).__diff.hold = "context"; });
  await tid(page, "cr-file-section").first().getByRole("button", { name: /Expand.*unchanged/ }).first().click();
  await expect.poll(async () => (await log()).filter((r: any) => r.op === "context").length).toBe(1);
  await app.evaluate(() => { const s = (globalThis as any).__diff; s.hold = null; s.revision = { ...s.revision, headSha: "f".repeat(40) }; s.files = s.files.map((f: any) => ({ ...f, path: `new/${f.path}` })); });
  await refreshOverview();
  await expect(tid(page, "cr-file-section").first()).toHaveAttribute("data-head-sha", "f".repeat(40));
  await expect(page.getByRole("status").filter({ hasText: "Outdated line anchor" })).toBeVisible();
  await releaseHeld();
  await expect(tid(page, "code-review-diff")).not.toContainText("remote context");
  expect((await log()).some((r: any) => r.op === "cancel")).toBe(true);
});

test("a new head cannot be overwritten by a delayed file page", async () => {
  await open(undefined, "files");
  await expect.poll(async () => (await log()).filter((r: any) => r.op === "files").length).toBe(1);
  await app.evaluate(() => { const s = (globalThis as any).__diff; s.hold = null; s.revision = { ...s.revision, headSha: "e".repeat(40) }; s.files = s.files.slice(0, 1).map((f: any) => ({ ...f, path: "new-head.ts" })); });
  await refreshOverview();
  await expect(tid(page, "cr-file-section")).toHaveCount(1);
  await expect(tid(page, "cr-file-section")).toHaveAttribute("data-path", "new-head.ts");
  await releaseHeld();
  await expect(tid(page, "cr-file-section")).toHaveCount(1);
  await expect(tid(page, "cr-file-section")).toHaveAttribute("data-head-sha", "e".repeat(40));
  const ids = (await log()).filter((r: any) => r.op === "files").map((r: any) => r.requestId);
  expect(new Set(ids).size).toBe(ids.length);
});

test("cancelled first-page reads can be retried through Refresh files", async () => {
  await open(undefined, "files");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await releaseHeld();
  await expect(tid(page, "cr-file-section")).toHaveCount(0);
  await page.getByRole("button", { name: "Refresh files", exact: true }).click();
  await expect(tid(page, "cr-file-section")).toHaveCount(4);
});

test("1,000 files keep requests and mounted patch bodies bounded", async ({}, testInfo) => {
  const started = performance.now();
  await open(stressFiles(1000));
  await expect(tid(page, "cr-file-section")).toHaveCount(100);
  expect((await log()).filter((r: any) => r.op === "files")).toHaveLength(1);
  for (let i = 2; i <= 10; i++) {
    await page.getByRole("button", { name: "Load next 100 files", exact: true }).click();
    await expect(tid(page, "cr-file-section")).toHaveCount(i * 100);
  }
  const loadedMs = performance.now() - started;
  await expect(page.locator('[data-testid="code-review-diff"] [data-testid="diff"]')).toHaveCount(4);
  await expect(tid(page, "cr-tree-file")).toHaveCount(1000);
  await page.getByRole("textbox", { name: "Filter remote files" }).fill("module-0999");
  const selectedAt = performance.now();
  await tid(page, "cr-tree-file").click();
  await expect(tid(page, "cr-file-section").last()).toBeInViewport();
  const selectMs = performance.now() - selectedAt;
  const metrics = await page.evaluate(() => ({ domNodes: document.querySelector('[data-testid="code-review-pane-changes"]')!.querySelectorAll("*").length, heap: (performance as any).memory?.usedJSHeapSize ?? null }));
  expect(metrics.domNodes).toBeLessThan(25000);
  if (metrics.heap !== null) expect(metrics.heap).toBeLessThan(256 * 1024 * 1024);
  expect(selectMs).toBeLessThan(3000);
  expect((await log()).filter((r: any) => r.op === "files")).toHaveLength(10);
  expect((await log()).filter((r: any) => r.op === "context")).toHaveLength(0);
  const runtime = await app.evaluate(() => ({ electron: process.versions.electron, chromium: process.versions.chrome, node: process.versions.node }));
  const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const metricsPath = testInfo.outputPath("1000-files-metrics.json");
  fs.writeFileSync(metricsPath, JSON.stringify({ head, runtime, loadedMs, selectMs, ...metrics, environment: { platform: process.platform, arch: process.arch, node: process.version, cpu: os.cpus()[0]?.model, ram: os.totalmem() }, requests: 10, openBodies: 4 }, null, 2));
  await testInfo.attach("1000-files-metrics.json", { path: metricsPath, contentType: "application/json" });
  await page.screenshot({ path: testInfo.outputPath("1000-files.png") });
});

test("failed pagination keeps loaded files and retries the exact failed cursor", async () => {
  await open(stressFiles(200));
  await expect(tid(page, "cr-file-section")).toHaveCount(100);
  await app.evaluate(() => { (globalThis as any).__diff.failCursor = "p2"; });
  await page.getByRole("button", { name: "Load next 100 files", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry files", exact: true })).toBeVisible();
  await expect(tid(page, "cr-file-section")).toHaveCount(100);
  await tid(page, "code-review-tab-overview").click();
  await tid(page, "code-review-tab-changes").click();
  await app.evaluate(() => { (globalThis as any).__diff.failCursor = null; });
  await page.getByRole("button", { name: "Retry files", exact: true }).click();
  await expect(tid(page, "cr-file-section")).toHaveCount(200);
  expect((await log()).filter((r: any) => r.op === "files").map((r: any) => r.cursor)).toEqual([null, "p2", "p2"]);
});

test("payload mismatch is rejected even when the context reply scope matches", async () => {
  await open();
  await app.evaluate(() => { (globalThis as any).__diff.badContext = true; });
  await tid(page, "cr-file-section").first().getByRole("button", { name: /Expand.*unchanged/ }).first().click();
  await expect(page.getByRole("alert")).toContainText("did not match the requested file");
  await expect(tid(page, "code-review-diff")).not.toContainText("wrong file code");
  await app.evaluate(() => { (globalThis as any).__diff.badContext = false; });
  await page.getByRole("button", { name: "Retry context", exact: true }).click();
  await expect(tid(page, "cr-file-section").first()).toContainText("remote context");
});

test("sign-out during a delayed patch page clears the view and drops its response", async () => {
  await open(undefined, "files");
  await app.evaluate(() => { (globalThis as any).__diff.connection = { state: "ready", value: { state: "signed-out", detail: "Signed out for race test" }, fetchedAt: new Date().toISOString() }; });
  await refreshOverview();
  await expect(tid(page, "code-review-connection-error")).toBeVisible();
  await releaseHeld();
  await expect(tid(page, "cr-file-section")).toHaveCount(0);
});

test("returning from Overview preserves loaded pages, selected file and overall scroll position", async () => {
  await open(stressFiles(200));
  await page.getByRole("button", { name: "Load next 100 files", exact: true }).click();
  await expect(tid(page, "cr-file-section")).toHaveCount(200);
  await page.getByRole("textbox", { name: "Filter remote files" }).fill("module-0199");
  await tid(page, "cr-tree-file").click();
  await expect(tid(page, "cr-file-section").last()).toBeInViewport();
  const before = await tid(page, "code-review-diff").evaluate(el => el.scrollTop);
  expect(before).toBeGreaterThan(0);
  await tid(page, "code-review-tab-overview").click();
  await tid(page, "code-review-tab-changes").click();
  await expect(tid(page, "cr-file-section")).toHaveCount(200);
  await expect(tid(page, "cr-tree-file")).toHaveAttribute("aria-current", "true");
  await expect.poll(() => tid(page, "code-review-diff").evaluate(el => el.scrollTop)).toBe(before);
  expect((await log()).filter((r: any) => r.op === "files")).toHaveLength(2);
});

test("line anchors have one keyboard entry per file and arrow navigation through its gutters", async () => {
  const f: PrFile = { ...stressFiles(1)[0]!, path: "many-lines.ts", additions: 800, patch: { kind: "text", patch: `@@ -0,0 +1,800 @@\n${"+unchanged-looking text\n".repeat(800)}` } };
  await open([f]);
  const section = tid(page, "cr-file-section");
  await expect(section.locator('.line-number[tabindex="0"]')).toHaveCount(1);
  await section.getByRole("button", { name: "New line 1", exact: true }).focus();
  await page.keyboard.press("ArrowDown");
  await expect(section.getByRole("button", { name: "New line 2", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status").filter({ hasText: "Line anchor" })).toContainText("head 2");
});

test("a 3 MiB textual patch is disclosed without mounting code", async ({}, testInfo) => {
  const started = performance.now();
  const f: PrFile = { ...stressFiles(1)[0]!, path: "oversized.ts", additions: 150000, patch: { kind: "text", patch: "+large synthetic line\n".repeat(Math.ceil(3 * 1024 * 1024 / 22)).slice(0, 3 * 1024 * 1024) } };
  await open([f]);
  await expect(tid(page, "cr-file-section")).toContainText("Patch exceeds display limit");
  await expect(tid(page, "cr-file-section").getByTestId("diff")).toHaveCount(0);
  const metrics = await page.evaluate(() => ({ domNodes: document.querySelector('[data-testid="code-review-pane-changes"]')!.querySelectorAll("*").length, heap: (performance as any).memory?.usedJSHeapSize ?? null }));
  expect(metrics.domNodes).toBeLessThan(1000);
  const runtime = await app.evaluate(() => ({ electron: process.versions.electron, chromium: process.versions.chrome, node: process.versions.node }));
  const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const metricsPath = testInfo.outputPath("3-mib-patch-metrics.json");
  fs.writeFileSync(metricsPath, JSON.stringify({ head, runtime, elapsedMs: performance.now() - started, patchCharacters: f.patch.kind === "text" ? f.patch.patch.length : 0, ...metrics, cpu: os.cpus()[0]?.model, platform: process.platform, arch: process.arch }, null, 2));
  await testInfo.attach("3-mib-patch-metrics.json", { path: metricsPath, contentType: "application/json" });
  await page.screenshot({ path: testInfo.outputPath("3-mib-patch.png") });
});

test("captures populated R4 diff geometry and narrow keyboard file selection", async ({}, testInfo) => {
  await open();
  await resizeWindow(app, page, 1764, 1047);
  await tid(page, "code-review-split-toggle").click();
  await expect(tid(page, "code-review-workspace")).toHaveAttribute("data-panes", "overview changes");
  await expect(tid(page, "cr-file-section")).toHaveCount(4);
  await expect(tid(page, "code-review-tree")).toBeVisible();
  await expect(page.getByRole("heading", { name: R4.overview.title, exact: true })).toBeVisible();
  await expect(tid(page, "cr-description")).toContainText("holds");
  await page.screenshot({ path: testInfo.outputPath("cr5-r4-fixture.png"), animations: "disabled" });
  await resizeWindow(app, page, 900, 600);
  await tid(page, "code-review-tab-changes").click();
  await page.getByRole("separator", { name: "Resize sidebar", exact: true }).focus();
  await page.keyboard.press("End");
  await tid(page, "code-review-files-toggle").click();
  await page.screenshot({ path: testInfo.outputPath("cr5-narrow-tree.png"), animations: "disabled" });
  await tid(page, "cr-tree-file").last().focus();
  await page.keyboard.press("Enter");
  await expect(tid(page, "cr-file-section").last()).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath("cr5-narrow-diff.png"), animations: "disabled" });
});

test("review: closed omitted and oversized fifth files disclose known incomplete patch coverage", async () => {
  const files = stressFiles(6);
  files[4] = { ...files[4]!, patch: { kind: "omitted", reason: "provider" } };
  files[5] = { ...files[5]!, patch: { kind: "text", patch: "x".repeat(3 * 1024 * 1024) } };
  await open(files);
  await expect(tid(page, "cr-file-section")).toHaveCount(6);
  await expect(page.getByRole("status").filter({ hasText: "Incomplete patch coverage" })).toContainText("2 textual patches unavailable");
  await expect(tid(page, "cr-file-section").nth(4)).toContainText("Patch unavailable");
  await expect(tid(page, "cr-file-section").nth(4).getByTestId("diff")).toHaveCount(0);
});

test("review: context expands adjacent to both ends of a distant gap and preserves both gutters", async () => {
  const f: PrFile = { ...stressFiles(1)[0]!, path: "distant.ts", status: "modified", additions: 3, deletions: 1, patch: { kind: "text", patch: "@@ -5,0 +6,2 @@\n+insert one\n+insert two\n@@ -10000 +10002 @@\n-old\n+new" } };
  await open([f]);
  const section = tid(page, "cr-file-section");
  await section.getByRole("button", { name: /Expand 40 unchanged lines above change/ }).click();
  await expect(section.locator('[data-old-line="9999"][data-new-line="10001"]')).toContainText("remote context 10001");
  await section.getByRole("button", { name: /Expand 40 unchanged lines below previous change/ }).click();
  await expect(section.locator('[data-old-line="6"][data-new-line="8"]')).toContainText("remote context 8");
  const requests = (await log()).filter((r: any) => r.op === "context");
  expect(requests.map((r: any) => [r.start, r.end])).toEqual([[9962, 10001], [8, 47]]);
  expect(requests.every((r: any) => r.revision.headSha === R4.overview.revision.headSha)).toBe(true);
});

test("review: repeated cursor with no new files stops pagination without growing retained pages", async () => {
  await open(stressFiles(200));
  await app.evaluate(() => { (globalThis as any).__diff.repeatCursor = true; });
  await page.getByRole("button", { name: "Load next 100 files", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "provider repeated a page cursor" })).toBeVisible();
  await expect(tid(page, "cr-file-section")).toHaveCount(100);
  await expect(page.getByRole("button", { name: "Load next 100 files", exact: true })).toHaveCount(0);
  expect((await log()).filter((r: any) => r.op === "files")).toHaveLength(2);
});

test("review: aggregate patch retention omits later text while preserving all filenames and counts", async () => {
  const files = stressFiles(200).map((f): PrFile => ({ ...f, additions: 1, patch: { kind: "text", patch: "@@ -0,0 +1 @@\n+" + "x".repeat(64 * 1024) } }));
  await open(files);
  await page.getByRole("button", { name: "Load next 100 files", exact: true }).click();
  await expect(tid(page, "cr-file-section")).toHaveCount(200);
  await expect(page.getByRole("status").filter({ hasText: "Incomplete patch coverage" })).toBeVisible();
  await page.getByRole("textbox", { name: "Filter remote files" }).fill("module-0199");
  await tid(page, "cr-tree-file").click();
  await expect(tid(page, "cr-file-section").last()).toContainText("Patch exceeds display limit");
  await expect(tid(page, "cr-file-section").last()).toContainText("+1");
});

test("review: context cancellation refunds its reservation for retry and collapse", async () => {
  const f: PrFile = { ...stressFiles(1)[0]!, path: "distant.ts", status: "modified", additions: 1, deletions: 1, patch: { kind: "text", patch: "@@ -10000 +10000 @@\n-old\n+new" } };
  await open([f]);
  for (let i = 0; i < 6; i++) {
    await app.evaluate(() => { (globalThis as any).__diff.hold = "context"; });
    await page.getByRole("button", { name: /Expand 40 unchanged lines above change/ }).click();
    await page.getByRole("button", { name: "Cancel context", exact: true }).click();
    await releaseHeld();
  }
  await page.getByRole("button", { name: /Expand 40 unchanged lines above change/ }).click();
  await expect(tid(page, "cr-file-section")).toContainText("remote context 9999");
  await page.getByRole("button", { name: "Collapse expanded context", exact: true }).click();
  await expect(tid(page, "cr-file-section")).not.toContainText("remote context");
  await expect(page.getByRole("button", { name: /Expand 40 unchanged lines above change/ })).toBeEnabled();
});

test("review: deleted ranges and renamed paths retain base anchors after context expansion", async () => {
  const f: PrFile = { ...stressFiles(1)[0]!, path: "new/name.ts", previousPath: "old/名前.ts", status: "renamed", additions: 1, deletions: 3, patch: { kind: "text", patch: "@@ -6,2 +5,0 @@\n-old one\n-old two\n@@ -10 +8 @@\n-old\n+new" } };
  await open([f]);
  const section = tid(page, "cr-file-section");
  await section.getByRole("button", { name: /Expand 2 unchanged lines above change/ }).click();
  await expect(section.locator('[data-old-line="8"][data-new-line="6"]')).toContainText("remote context 6");
  await section.getByRole("button", { name: "Old line 8", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Line anchor" })).toContainText("old/名前.ts");
  expect((await log()).find((r: any) => r.op === "context").path).toBe("new/name.ts");
});

test("review: mismatched file payload revision is rejected despite a matching reply scope", async () => {
  await open();
  await app.evaluate(() => { (globalThis as any).__diff.badFilesRevision = true; });
  await page.getByRole("button", { name: "Refresh files", exact: true }).click();
  await expect(tid(page, "cr-file-section")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Retry files", exact: true })).toBeVisible();
  await app.evaluate(() => { (globalThis as any).__diff.badFilesRevision = false; });
  await page.getByRole("button", { name: "Retry files", exact: true }).click();
  await expect(tid(page, "cr-file-section")).toHaveCount(4);
});

test("review: changing PR during a delayed patch request drops the previous PR response", async () => {
  await open(undefined, "files");
  await expect.poll(async () => (await log()).filter((r: any) => r.op === "files").length).toBe(1);
  await app.evaluate(() => { (globalThis as any).__diff.hold = null; });
  await page.locator('[data-testid="code-review-row"][data-pr="example-org/lending#73"]').click();
  await tid(page, "code-review-tab-changes").click();
  await expect(tid(page, "cr-file-section")).toHaveCount(1);
  await expect(tid(page, "cr-file-section")).toHaveAttribute("data-path", "other-pr.ts");
  await releaseHeld();
  await expect(tid(page, "cr-file-section")).toHaveCount(1);
  await expect(tid(page, "cr-file-section")).toHaveAttribute("data-head-sha", R1.overview.revision.headSha);
});


test("accepted token-dense patches keep remote rendering bounded", async ({}, testInfo) => {
  const dense = "'x' ".repeat(100000);
  const files = Array.from({ length: 4 }, (_, i): PrFile => ({ ...stressFiles(1)[0]!, path: `dense-${i}.ts`, status: "modified", additions: 1, deletions: 0, patch: { kind: "text", patch: "@@ -0,0 +1 @@\n+" + dense } }));
  await open(files);
  await expect(tid(page, "cr-file-section")).toHaveCount(4);
  await expect(tid(page, "cr-file-section").first().locator("code")).toHaveText(dense);
  const nodes = await tid(page, "code-review-diff").evaluate(el => el.querySelectorAll("*").length);
  expect(nodes).toBeLessThan(25000);
  const metricsPath = testInfo.outputPath("dense-patch-metrics.json");
  fs.writeFileSync(metricsPath, JSON.stringify({ domNodes: nodes, openFiles: 4, charactersPerLine: dense.length }, null, 2));
  await testInfo.attach("dense-patch-metrics.json", { path: metricsPath, contentType: "application/json" });
});

test("oversized context lines are explicitly omitted before mounting", async () => {
  await open();
  await app.evaluate(() => { (globalThis as any).__diff.contextLines = ["context-too-large-" + "x".repeat(65536)]; });
  await tid(page, "cr-file-section").first().getByRole("button", { name: /Expand.*unchanged lines below/ }).first().click();
  await expect(tid(page, "cr-file-section").first()).toContainText("Context exceeds display text limit");
  await expect(tid(page, "cr-file-section").first()).not.toContainText("context-too-large-");
});

test("context text budget is shared between folds and refunded on collapse", async () => {
  await open();
  const section = tid(page, "cr-file-section").first();
  await app.evaluate(() => { (globalThis as any).__diff.contextLines = Array.from({ length: 4 }, () => "budgeted-context-" + "x".repeat(9983)); });
  await section.getByRole("button", { name: /Expand 37 unchanged lines above/ }).click();
  await expect(section.locator(".cr-context-fold").first().locator("code")).toHaveCount(4);
  await section.getByRole("button", { name: /Expand 4 unchanged lines above/ }).click();
  await expect(section).toContainText("Context exceeds display text limit");
  await expect(section.locator(".cr-context-fold").nth(1).locator("code")).toHaveCount(0);
  await section.getByRole("button", { name: "Collapse expanded context", exact: true }).click();
  await section.getByRole("button", { name: "Retry context", exact: true }).click();
  await expect(section.locator(".cr-context-fold").nth(1).locator("code")).toHaveCount(4);
  await expect(section).not.toContainText("Context exceeds display text limit");
});


test("old-line anchors name the merge base when the target tip differs", async () => {
  await open();
  await app.evaluate(() => { (globalThis as any).__diff.diffBaseSha = "a".repeat(40); });
  await page.getByRole("button", { name: "Refresh files", exact: true }).click();
  await tid(page, "cr-file-section").first().getByRole("button", { name: /^Old line/ }).first().click();
  const section = tid(page, "cr-file-section").first();
  await expect(section).toHaveAttribute("data-base-sha", "a".repeat(40));
  await expect(section).toHaveAttribute("data-target-sha", R4.overview.revision.baseSha);
  await expect(page.locator(".cr-revision")).toContainText("Diff base aaaaaaaa");
  await expect(page.locator(".cr-revision")).toContainText(`Target ${R4.overview.revision.baseSha.slice(0, 8)}`);
  const anchor = page.getByRole("status").filter({ hasText: "Line anchor" });
  await expect(anchor).toContainText("aaaaaaaa");
  await expect(anchor).not.toContainText(R4.overview.revision.baseSha.slice(0, 8));
});

test("context from a different commit is refused even when revision and path match", async () => {
  await open();
  await app.evaluate(() => { (globalThis as any).__diff.badContextCommit = true; });
  await tid(page, "cr-file-section").first().getByRole("button", { name: /Expand.*unchanged/ }).first().click();
  await expect(page.getByRole("alert")).toContainText("did not match the requested file");
  await expect(tid(page, "code-review-diff")).not.toContainText("remote context");
});
