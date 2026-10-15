import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { createThread, launch, resizeWindow, seedHome, tid } from "./support";

let app: ElectronApplication;
let page: Page;
let repo: string;
test.beforeEach(async () => {
  const seed = seedHome();
  repo = seed.repo;
  fs.appendFileSync(path.join(seed.repo, "README.md"), "A readable change in a narrow workspace.\n");
  fs.writeFileSync(path.join(seed.repo, "notes.txt"), "Keep my selection\n");
  ({ app, page } = await launch(seed.home));
  await createThread(page, "Review the workspace");
  await resizeWindow(app, page, 1366, 900);
});
test.afterEach(async () => { await app?.close(); });

test("compact review gives the diff full width and retains context across tools", async ({}, info) => {
  await expect(page.getByRole("tab")).toHaveCount(1);
  const tree = tid(page, "review-tree");
  const diff = tid(page, "changes-diff");
  await expect(tree).toBeVisible();
  const treeBox = (await tree.boundingBox())!;
  const diffBox = (await diff.boundingBox())!;
  expect(diffBox.width).toBeGreaterThan(330);
  expect(treeBox.height).toBeLessThan(150);
  expect(treeBox.y + treeBox.height).toBeLessThanOrEqual(diffBox.y + 1);
  await page.getByRole("button", { name: "View diff for notes.txt", exact: true }).click();
  await expect(tid(page, "diff")).toContainText("Keep my selection");
  await tid(page, "review-filter").fill("notes");
  await page.keyboard.press("Meta+Shift+b");
  await expect(tid(page, "workspace-address")).toBeFocused();
  await expect(page.getByText("Suggested", { exact: true })).toHaveCount(0);
  await page.getByRole("tab", { name: "Review", exact: true }).click();
  await expect(tid(page, "review-filter")).toHaveValue("notes");
  await expect(tid(page, "diff")).toContainText("Keep my selection");
  await page.getByRole("button", { name: "Review options", exact: true }).click();
  const wrap = page.getByRole("menuitemcheckbox", { name: "Wrap lines", exact: true });
  await expect(wrap).toHaveAttribute("aria-checked", "true");
  await wrap.click();
  await expect(tid(page, "diff")).not.toHaveClass(/wrap/);
  await expect(page.getByRole("button", { name: "Review options", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "Show file tree", exact: true }).click();
  await expect(tree).toBeHidden();
  await page.getByRole("button", { name: "Filter changed files", exact: true }).click();
  await expect(tid(page, "review-filter")).toBeFocused();
  await tid(page, "workspace").screenshot({ path: info.outputPath("compact-review.png") });
  await page.getByRole("button", { name: "Hide side panel", exact: true }).click();
  await tid(page, "changes-toggle").click();
  await expect(tid(page, "review-filter")).toHaveValue("notes");
  await expect(tid(page, "diff")).toContainText("Keep my selection");
});

test("keyboard resizing adapts the file tree without overflowing the rail", async ({}, info) => {
  const resize = page.getByRole("separator", { name: "Resize workspace" });
  await resize.focus();
  await resize.press("End");
  const tree = (await tid(page, "review-tree").boundingBox())!;
  const diff = (await tid(page, "changes-diff").boundingBox())!;
  expect(tree.x).toBeGreaterThanOrEqual(diff.x + diff.width - 1);
  await tid(page, "workspace").screenshot({ path: info.outputPath("wide-review.png") });
  await resize.press("Home");
  await expect.poll(() => tid(page, "workspace").evaluate((rail) => rail.scrollWidth - rail.clientWidth)).toBeLessThanOrEqual(1);
  await tid(page, "workspace-full").click();
  await expect(tid(page, "main")).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(tid(page, "main")).toBeVisible();
});


test("large changesets stay bounded and keyboard tab closure restores focus", async ({}, info) => {
  execFileSync("git", ["checkout", "-qb", "feature/a-long-branch-name-for-the-compact-review-toolbar"], { cwd: repo });
  const env = { ...process.env, GIT_AUTHOR_NAME: "e2e", GIT_AUTHOR_EMAIL: "e2e@modex.local", GIT_COMMITTER_NAME: "e2e", GIT_COMMITTER_EMAIL: "e2e@modex.local" };
  fs.writeFileSync(path.join(repo, "large.txt"), "Before\n".repeat(16_000));
  execFileSync("git", ["add", "large.txt"], { cwd: repo, env });
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-qm", "Seed large diff fixture"], { cwd: repo, env });
  fs.writeFileSync(path.join(repo, "large.txt"), "After\n".repeat(16_000));
  for (let i = 0; i < 60; i++) fs.writeFileSync(path.join(repo, `file-${i}.txt`), "A change\n".repeat(200));
  await tid(page, "changes-refresh").click();
  await expect(tid(page, "changes-file")).toHaveCount(63);
  const tree = (await tid(page, "review-tree").boundingBox())!;
  const rail = (await tid(page, "workspace").boundingBox())!;
  expect(tree.height).toBeLessThan(rail.height * .31);
  const resize = page.getByRole("separator", { name: "Resize workspace" });
  await resize.focus();
  await resize.press("Home");
  const toolbar = page.locator(".review-toolbar");
  expect(await toolbar.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  const minimum = (await tid(page, "workspace").boundingBox())!;
  for (const control of await toolbar.getByRole("button").all()) {
    const bounds = (await control.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(minimum.x);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(minimum.x + minimum.width);
  }
  expect((await tid(page, "changes-diff").boundingBox())!.width).toBeLessThanOrEqual(minimum.width);

  await tid(page, "workspace").screenshot({ path: info.outputPath("minimum-review.png"), scale: "css" });
  await page.getByRole("button", { name: "View diff for file-0.txt", exact: true }).click();
  await expect(tid(page, "diff").locator('[data-line="add"]')).toHaveCount(200);
  const scroll = async (id: string) => tid(page, id).evaluate((el) => { el.scrollTop = 120; return el.scrollTop; });
  const diffScroll = await scroll("changes-diff");
  const treeScroll = await scroll("review-tree");
  expect(diffScroll).toBeGreaterThan(0);
  expect(treeScroll).toBeGreaterThan(0);

  await page.keyboard.press("Meta+Shift+b");
  const close = page.getByRole("button", { name: "Close New tab tab", exact: true });
  await close.focus();
  await close.press("Enter");
  await expect(page.getByRole("tab", { name: "Review", exact: true })).toBeFocused();
  await expect.poll(() => tid(page, "changes-diff").evaluate((el) => el.scrollTop)).toBe(diffScroll);
  await expect.poll(() => tid(page, "review-tree").evaluate((el) => el.scrollTop)).toBe(treeScroll);
  await page.keyboard.press("Meta+Shift+b");
  const inactiveTab = page.getByRole("tab", { name: "New tab", exact: true });
  await expect(inactiveTab).toBeVisible();
  const reviewTab = page.getByRole("tab", { name: "Review", exact: true });
  await reviewTab.click();
  await inactiveTab.focus();
  await page.keyboard.press("Tab");
  await expect(close).toBeFocused();
  await expect(reviewTab).toHaveAttribute("aria-selected", "true");
  await close.press("Enter");
  await expect(page.getByRole("tab", { name: "Review", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "Hide side panel", exact: true }).click();
  await tid(page, "changes-toggle").click();
  await expect.poll(() => tid(page, "changes-diff").evaluate((el) => el.scrollTop)).toBe(diffScroll);
  await expect.poll(() => tid(page, "review-tree").evaluate((el) => el.scrollTop)).toBe(treeScroll);

  await page.getByRole("button", { name: "Review options", exact: true }).focus();
  await page.keyboard.press("Enter");
  const options = page.getByRole("menu", { name: "Review options", exact: true });
  const optionsBox = (await options.boundingBox())!;
  const railBox = (await tid(page, "workspace").boundingBox())!;
  expect(optionsBox.x).toBeGreaterThanOrEqual(railBox.x);
  expect(optionsBox.x + optionsBox.width).toBeLessThanOrEqual(railBox.x + railBox.width);
  await expect(page.getByRole("menuitemcheckbox", { name: "Wrap lines", exact: true })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitemcheckbox", { name: "Highlight changes", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(tid(page, "diff")).not.toHaveClass(/highlight/);
  await expect(page.getByRole("button", { name: "Review options", exact: true })).toBeFocused();
});

test("browser and Canvas adapt to rail widths while Review keeps its place", async () => {
  fs.writeFileSync(path.join(repo, "preview.html"), "<h1>A local Canvas preview</h1>");
  await page.getByRole("button", { name: "View diff for notes.txt", exact: true }).click();
  await tid(page, "review-filter").fill("notes");
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end("<title>Rail browser</title><h1>A local browser page</h1>");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  const checkWidths = async (toolbar: string, hostId: string, urlPrefix: string) => {
    const resize = page.getByRole("separator", { name: "Resize workspace" });
    for (const key of ["Enter", "Home", "End"]) {
      await resize.press(key);
      const rail = (await tid(page, "workspace").boundingBox())!;
      if (key !== "End") expect(rail.width).toBeCloseTo(key === "Home" ? 280 : 360, 0);
      const controls = page.locator(toolbar).locator("button, input, select");
      for (const control of await controls.all()) {
        const box = (await control.boundingBox())!;
        expect(box.width).toBeGreaterThan(0);
        expect(box.x).toBeGreaterThanOrEqual(rail.x);
        expect(box.x + box.width).toBeLessThanOrEqual(rail.x + rail.width + 1);
      }
      const host = (await tid(page, hostId).boundingBox())!;
      expect(host.width).toBeGreaterThan(0);
      expect(host.height).toBeGreaterThan(0);
      await expect.poll(() => app.evaluate(({ BrowserWindow }, { prefix, host }) => {
        const view = BrowserWindow.getAllWindows()[0]!.contentView.children.find(view => "webContents" in view &&
          !(view as import("electron").WebContentsView).webContents.isDestroyed() &&
          (view as import("electron").WebContentsView).webContents.getURL().startsWith(prefix));
        if (!view?.getVisible()) return false;
        const bounds = view.getBounds();
        return (["x", "y", "width", "height"] as const).every(key => Math.abs(bounds[key] - host[key]) <= 1);
      }, { prefix: urlPrefix, host })).toBe(true);
    }
  };
  try {
    await page.keyboard.press("Meta+Shift+b");
    await tid(page, "workspace-address").fill(url);
    await tid(page, "workspace-address").press("Enter");
    await expect(page.getByRole("tab", { name: "Rail browser", exact: true })).toBeVisible();
    await checkWidths(".workspace-navigation", "workspace-browser", url);
    await page.keyboard.press("Meta+Shift+b");
    await page.getByRole("button", { name: "Canvas", exact: true }).click();
    await expect(page.getByLabel("Canvas file").locator('option[value="preview.html"]')).toHaveCount(1);
    await page.getByLabel("Canvas file").selectOption("preview.html");
    await checkWidths(".canvas-toolbar", "canvas-preview", "modex-canvas:");
    await page.getByRole("tab", { name: "Review", exact: true }).click();
    await expect(tid(page, "review-filter")).toHaveValue("notes");
    await expect(tid(page, "diff")).toContainText("Keep my selection");
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
