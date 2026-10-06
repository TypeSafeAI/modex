import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { seedHome, launch, tid } from "./support.js";

let home: string, repo: string, app: ElectronApplication, page: Page;
test.beforeEach(async () => {
  ({ home, repo } = seedHome());
  const file = path.join(home, "app/state.json");
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  state.settings.codex_bin = path.join(home, "missing-codex");
  const at = new Date().toISOString();
  state.threads = [{ id: "sidebar-thread", projectId: "p1", title: "Prepare next release", createdAt: at, updatedAt: at, cwd: repo, backend: "codex", model: "gpt-5.4", mode: "agent", plan: false, status: "idle" }];
  state.threads.push({ ...state.threads[0], id: "busy-worktree", title: "A long worktree title with an unsent message and running status", backend: "mock", model: "mock", worktree: { path: repo, branch: "old-branch" } });
  fs.writeFileSync(file, JSON.stringify(state));
  ({ app, page } = await launch(home));
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler("models:list");
    ipcMain.handle("models:list", (_event, { backend }) => ({ models: [{ id: backend === "mock" ? "mock" : "gpt-5.4", label: backend === "mock" ? "Mock" : "GPT-5.4", isDefault: true }] }));
  });
  await page.reload();
});

test("long thread titles cannot overlap unsent, running and worktree indicators", async () => {
  const row = page.locator('[data-thread-id="busy-worktree"]');
  await row.locator(".thread-main").click();
  await tid(page, "composer-input").fill("Unsent follow-up");
  await page.locator('[data-thread-id="sidebar-thread"] .thread-main').click();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.send("thread:event", { type: "status", threadId: "busy-worktree", status: "running" }));
  await expect(tid(row, "thread-row-unsent")).toBeVisible();
  await expect(tid(row, "thread-row-status")).toBeVisible();
  await expect(tid(row, "thread-row-worktree")).toBeVisible();
  const title = await tid(row, "thread-row-title").boundingBox();
  const metadata = await row.locator(".row-meta").boundingBox();
  expect(title!.x + title!.width).toBeLessThanOrEqual(metadata!.x);
});
test.afterEach(async () => { await app?.close(); fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(repo, { recursive: true, force: true }); });

test("sidebar shows provider, model, and the current checkout branch without inventing a PR", async () => {
  const row = tid(page, "thread-row").first();
  await expect(tid(row, "thread-row-provider")).toHaveText("Codex");
  await expect(tid(row, "thread-row-model")).toHaveText("gpt-5.4");
  await expect(tid(row, "thread-row-branch")).toHaveText("main");
  await expect(tid(row, "thread-row-pr")).toHaveText("No GitHub remote");
  execFileSync("git", ["switch", "-qc", "release/sidebar"], { cwd: repo });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(tid(row, "thread-row-branch")).toHaveText("release/sidebar");
});

test("PR metadata is legible in both themes and remains keyboard accessible", async () => {
  // Return controlled metadata at the host boundary; the real Git/REST reader has unit coverage.
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler("thread:context");
    ipcMain.handle("thread:context", () => ({ isRepo: true, branch: "release/sidebar", pullRequest: { state: "merged", number: 128, title: "Prepare the rail", url: "https://github.com/TypeSafeAI/modex/pull/128" } }));
  });
  await page.reload();
  const row = tid(page, "thread-row").first();
  await expect(tid(row, "thread-row-pr")).toHaveText("#128 Merged");
  await expect(tid(row, "thread-row-pr")).toHaveAttribute("href", "https://github.com/TypeSafeAI/modex/pull/128");
  for (const theme of ["jev", "coven"] as const) {
    await page.evaluate((theme) => window.modex!.invoke("settings:update", { theme }), theme);
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await row.locator(".thread-main").focus();
    await page.keyboard.press("Tab");
    await expect(tid(row, "thread-row-pr")).toBeFocused();
    await expect(tid(row, "thread-row-pr")).toBeVisible();
    await expect(tid(row, "thread-row-provider")).toHaveText("Codex");
    await expect(tid(row, "thread-row-model")).toHaveText("gpt-5.4");
    const overflow = await row.evaluate((element) => element.scrollWidth > element.clientWidth);
    expect(overflow).toBe(false);
    await page.screenshot({ path: `test-results/sidebar-${theme}.png` });
  }
});
