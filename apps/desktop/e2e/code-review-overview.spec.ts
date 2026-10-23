import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import { launch, resizeWindow, seedHome, tid } from "./support.js";
import { R1, R2, R4, NOW } from "../test/fixtures/code-review.js";
let app: ElectronApplication, page: Page;
async function open(hostile = false, mode = "normal") {
  const { home } = seedHome();
  ({ app, page } = await launch(home));
  await app.evaluate(({ ipcMain }, { R1, R2, R4, NOW, hostile, mode }) => {
    const g = globalThis as any;
    g.__overviewMode = mode;
    g.__overviewRequests = [];
    g.__releasePage = undefined;
    ipcMain.removeHandler("code-review:read");
    ipcMain.handle("code-review:read", async (_event, req) => {
      g.__overviewRequests.push(req);
      if (req.op === "cancel") return null;
      const ready = (value: unknown) => ({ state: "ready", value, fetchedAt: NOW });
      const failed = { state: "unavailable", reason: "offline", fetchedAt: NOW };
      const overview = structuredClone(req.key?.number === 91 ? R4.overview : R1.overview);
      if (hostile) overview.body = '# Hostile fixture\n\n<script>window.__pwned=true</script>\n\n[bad](javascript:alert(1))\n\n![remote](https://invalid.example/tracker.svg)\n\n[Safe](https://example.com/path)';
      let result: unknown = failed;
      if (req.op === "connection") result = R1.connection;
      if (req.op === "inbox") result = R1.inbox;
      if (req.op === "overview") result = ready(overview);
      if (req.op === "checks") result = g.__overviewMode === "stale" && R1.checks.state !== "unavailable" ? { ...R1.checks, state: "stale", reason: "offline" } : R1.checks;
      if (req.op === "stack") result = R1.stack;
      if (req.op === "activity" && R2.activity.state !== "unavailable") {
        if (req.cursor && g.__overviewMode === "hold-page") await new Promise<void>(resolve => { g.__releasePage = resolve; });
        if (req.cursor && g.__overviewMode === "page-error") result = failed;
        else {
          const rows = R2.activity.value;
          result = { ...ready(req.cursor ? rows.slice(3) : rows.slice(0, 4)), coverage: { loaded: req.cursor ? rows.length : 4, total: rows.length, complete: !!req.cursor, next: req.cursor ? null : "p2" } };
        }
      }
      if (req.op === "activity" && !req.cursor && g.__overviewMode === "partial" && typeof result === "object" && result) result = { ...result, state: "partial", reason: "denied" };
      if (req.op === "activity" && g.__overviewMode === "hold-first" && req.key?.number === 73) await new Promise<void>(resolve => { g.__releaseFirst = resolve; });
      if (req.key?.number === 91 && req.op === "activity") result = { ...ready([]), coverage: { loaded: 0, total: 0, next: null, complete: true } };
      if (g.__overviewMode === "unavailable" && ["activity", "checks", "stack"].includes(req.op)) result = failed;
      return { requestId: req.requestId, op: req.op, scope: { account: req.key?.account ?? "1001", key: req.key ?? null, revision: req.revision ?? null }, result };
    });
  }, { R1, R2, R4, NOW, hostile, mode });
  await page.evaluate(() => localStorage.setItem("modex.codeReview", "on"));
  await page.reload();
  await tid(page, "rail-code-review").click();
  await page.locator('[data-testid="code-review-row"][data-pr="example-org/lending#73"]').first().click();
}
test.afterEach(async () => { await app?.close(); });
test("R1 metadata and R2 pagination stay truthful, deduplicated and keyboard accessible", async () => {
  await open();
  await expect(page.getByRole("heading", { name: R1.overview.title, exact: true })).toBeVisible();
  await resizeWindow(app, page, 1766, 1057);
  await capture("normal");
  await expect(page.getByTestId("cr-description")).toContainText("policy/schema.ts");
  await expect(page.getByTestId("cr-checks")).toContainText("pending");
  await expect(page.getByTestId("cr-checks")).toContainText("Elapsed at read");
  await page.getByRole("button", { name: "Show all checks" }).click();
  await expect(page.getByTestId("cr-stack")).toContainText("Inferred");
  const more = page.getByRole("button", { name: "Load more activity" });
  await more.scrollIntoViewIfNeeded();
  await more.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator('[data-activity-id="comment:comment-9001"]')).toHaveCount(1);
  await expect(page.getByTestId("cr-activity")).toContainText("All activity loaded");
  await expect(page.getByTestId("cr-activity").getByText("7 commits", { exact: true })).toBeVisible();
  await capture("activity");
  const check = page.getByTestId("cr-checks").locator("summary").first();
  await check.focus(); await page.keyboard.press("Enter");
  await expect(check.locator("..")).toHaveAttribute("open", "");
});
test("failed pages retain previous activity and expose a retry", async () => {
  await open();
  await app.evaluate(() => { (globalThis as any).__overviewMode = "page-error"; });
  await page.getByRole("button", { name: "Load more activity" }).click();
  await expect(page.getByTestId("cr-activity")).toContainText("GitHub couldn't be reached");
  await capture("page-error");
  await expect(page.locator('[data-activity-id="comment:comment-9001"]')).toHaveCount(1);
  await app.evaluate(() => { (globalThis as any).__overviewMode = "normal"; });
  await page.getByRole("button", { name: "Retry activity page" }).click();
  await expect(page.getByTestId("cr-activity")).toContainText("All activity loaded");
});
test("hostile Markdown is inert and narrow content remains reachable", async () => {
  await open(true);
  await resizeWindow(app, page, 900, 600);
  const description = page.getByTestId("cr-description");
  await expect(description).toContainText("<script>");
  await expect(description.locator("script,img,iframe,svg")).toHaveCount(0);
  await expect(description.locator('a[href^="javascript:"]')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__pwned)).toBeUndefined();
  await page.getByRole("button", { name: "Load more activity" }).click();
  const comment = page.getByRole("button", { name: "Comment", exact: true });
  await comment.focus();
  await expect(comment).toBeInViewport();
  await expect(comment).toHaveAttribute("aria-disabled", "true");
  await capture("narrow-hostile");
});

async function refresh() {
  await tid(page, "code-review-inbox-menu").click();
  await tid(page, "code-review-refresh").click();
}
test("refresh does not mix fresh and pending cached pages or lose scroll and focus", async () => {
  await open();
  await resizeWindow(app, page, 1440, 900);
  await page.getByRole("button", { name: "Load more activity" }).click();
  await expect(page.getByTestId("cr-activity")).toContainText("All activity loaded");
  const main = page.getByRole("main", { name: "Description and activity" });
  await main.evaluate(el => { el.scrollTop = 500; });
  const before = await main.evaluate(el => el.scrollTop);
  await app.evaluate(() => { (globalThis as any).__overviewMode = "hold-page"; });
  await refresh();
  await expect.poll(() => app.evaluate(() => !!(globalThis as any).__releasePage)).toBe(true);
  await expect(page.getByTestId("cr-activity")).not.toContainText("All activity loaded");
  expect(await main.evaluate(el => el.scrollTop)).toBe(before);
  const filter = page.getByRole("combobox", { name: "Activity filter" });
  await filter.focus();
  const focusedScroll = await main.evaluate(el => el.scrollTop);
  await app.evaluate(() => { (globalThis as any).__releasePage(); });
  await expect(page.getByTestId("cr-activity")).toContainText("All activity loaded");
  await expect(filter).toBeFocused();
  expect(await main.evaluate(el => el.scrollTop)).toBe(focusedScroll);
});

async function capture(name: string) {
  const dir = process.env.MODEX_CR4_EVIDENCE;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: `${dir}/${name}.png` });
}
test("stale checks and unavailable collections do not become empty or current evidence", async () => {
  await open();
  await app.evaluate(() => { (globalThis as any).__overviewMode = "stale"; });
  await refresh();
  await expect(page.getByTestId("cr-checks")).toContainText("Stale");
  await capture("stale");
  await app.evaluate(() => { (globalThis as any).__overviewMode = "unavailable"; });
  await refresh();
  await expect(page.getByTestId("cr-activity")).toContainText("GitHub couldn't be reached");
  await expect(page.getByTestId("cr-activity")).not.toContainText("No activity");
});
test("a delayed activity response cannot bleed into a different selected PR", async () => {
  await open(false, "hold-first");
  await expect.poll(() => app.evaluate(() => !!(globalThis as any).__releaseFirst)).toBe(true);
  await page.locator('[data-testid="code-review-row"][data-pr="example-org/field-guide#91"]').click();
  await expect(page.getByRole("heading", { name: R4.overview.title, exact: true })).toBeVisible();
  await expect(page.getByTestId("cr-activity")).toContainText("No activity");
  await app.evaluate(() => { (globalThis as any).__releaseFirst(); });
  await expect(page.getByTestId("cr-description")).toContainText("moveHold");
  await expect(page.getByTestId("cr-activity")).not.toContainText("Preview builds");
});

test("a failed refresh retains the terminal page and retries that page's own cursor", async () => {
  await open();
  await page.getByRole("button", { name: "Load more activity" }).click();
  await expect(page.getByTestId("cr-activity")).toContainText("All activity loaded");
  await app.evaluate(() => { (globalThis as any).__overviewMode = "page-error"; });
  await refresh();
  await expect(page.getByTestId("cr-activity")).toContainText("Stale");
  await expect(page.getByText("7 commits", { exact: true })).toBeVisible();
  await app.evaluate(() => { (globalThis as any).__overviewMode = "normal"; (globalThis as any).__overviewRequests = []; });
  await page.getByRole("button", { name: "Retry activity page", exact: true }).click();
  await expect(page.getByTestId("cr-activity")).toContainText("All activity loaded");
  expect(await app.evaluate(() => (globalThis as any).__overviewRequests.filter((r: any) => r.op === "activity").map((r: any) => r.cursor))).toEqual(["p2"]);
});

test("refresh follows later loaded pages when the first page is partial", async () => {
  await open();
  await page.getByRole("button", { name: "Load more activity" }).click();
  await expect(page.getByTestId("cr-activity")).toContainText("All activity loaded");
  await app.evaluate(() => { (globalThis as any).__overviewMode = "partial"; (globalThis as any).__overviewRequests = []; });
  await refresh();
  await expect.poll(() => app.evaluate(() => (globalThis as any).__overviewRequests.filter((r: any) => r.op === "activity").map((r: any) => r.cursor))).toEqual([null, "p2"]);
  await expect(page.getByTestId("cr-activity")).toContainText("Partial");
  await expect(page.getByTestId("cr-activity")).not.toContainText("All activity loaded");
});
test("retrying a partial first page refreshes cached later pages before claiming completeness", async () => {
  await open(false, "partial");
  await page.getByRole("button", { name: "Load more activity" }).click();
  await expect(page.getByTestId("cr-activity")).toContainText("Partial");
  await app.evaluate(() => { (globalThis as any).__overviewMode = "hold-page"; });
  await page.getByRole("button", { name: "Retry activity", exact: true }).click();
  await expect.poll(() => app.evaluate(() => !!(globalThis as any).__releasePage)).toBe(true);
  await expect(page.getByTestId("cr-activity")).not.toContainText("All activity loaded");
  await app.evaluate(() => { (globalThis as any).__releasePage(); });
  await expect(page.getByTestId("cr-activity")).toContainText("All activity loaded");
});
