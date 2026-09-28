import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { launch, seedHome, tid, items } from "./support";

let app: ElectronApplication;
let page: Page;
let home: string;
let repo: string;

test.beforeEach(async () => {
  ({ home, repo } = seedHome());
  const file = path.join(home, "app/state.json");
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  state.threads = ["one", "two"].map((id) => ({ id, projectId: "p1", title: id, cwd: repo, backend: "mock", model: "mock", mode: "chat", plan: false, status: "idle", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
  fs.writeFileSync(file, JSON.stringify(state));
  fs.writeFileSync(path.join(repo, "a.txt"), "first diff\n");
  fs.writeFileSync(path.join(repo, "b.txt"), "second diff\n");
  ({ app, page } = await launch(home));
  await expect(tid(page, "thread-view")).toHaveAttribute("data-thread-id", "one");
  await expect(tid(page, "context-branch")).toHaveText("main");
});

test.afterEach(async () => { await app?.close(); fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(repo, { recursive: true, force: true }); });

test("background completion cannot replace selected changes", async () => {
  await app.evaluate(({ ipcMain, BrowserWindow }) => {
    ipcMain.removeHandler("changes:status");
    ipcMain.handle("changes:status", (_e, { threadId }) => ({ cwd: "/fake", branch: threadId === "two" ? "background" : "main", isRepo: true, files: [] }));
    BrowserWindow.getAllWindows()[0]!.webContents.send("thread:event", { type: "status", threadId: "two", status: "idle" });
  });
  // A foreground refresh round-trip is a barrier after the background event has been handled.
  await tid(page, "changes-refresh").click();
  await expect(tid(page, "changes-file")).toHaveCount(0);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.send("thread:event", { type: "status", threadId: "two", status: "error" }));
  await expect(page.locator('[data-thread-id="two"][data-testid="thread-row"]')).toHaveAttribute("data-status", "error");
  await expect(tid(page, "context-branch")).toHaveText("main");
});

test("an older refresh cannot replace a newer snapshot", async () => {
  await app.evaluate(({ ipcMain }) => {
    let count = 0;
    let resolveFirst: (value: unknown) => void;
    ipcMain.removeHandler("changes:status");
    ipcMain.handle("changes:status", () => {
      const result = (branch: string) => ({ cwd: "/fake", branch, isRepo: true, files: [] });
      if (++count === 1) return new Promise((resolve) => { resolveFirst = resolve; });
      setTimeout(() => resolveFirst(result("stale")), 100);
      return result("latest");
    });
  });
  await tid(page, "changes-refresh").click();
  await tid(page, "changes-refresh").click();
  await expect(tid(page, "context-branch")).toHaveText("latest");
  // Wait on the deliberately delayed old response, not on presumed rendering speed.
  await page.waitForTimeout(200);
  await expect(tid(page, "context-branch")).toHaveText("latest");
});

test("changed files can be selected with the keyboard", async () => {
  await expect(tid(page, "changes-file")).toHaveCount(2);
  const file = page.getByRole("button", { name: "View diff for b.txt", exact: true });
  await expect(file).toBeVisible({ timeout: 1500 });
  await file.focus();
  await page.keyboard.press("Enter");
  await expect(tid(page, "changes-diff")).toContainText("second diff");
  await expect(file).toHaveAttribute("aria-pressed", "true");
});

test("Enter during IME composition keeps the unsent message", async () => {
  const input = tid(page, "composer-input");
  await input.fill("日本語");
  await input.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true });
  await expect(input).toHaveValue("日本語");
  await expect(items(page, "user")).toHaveCount(0);
});

test("Settings owns focus, traps Tab, blocks app shortcuts, and restores focus on Escape", async () => {
  const trigger = tid(page, "open-settings");
  await trigger.click();
  const dialog = tid(page, "settings");
  await expect(dialog).toHaveAttribute("aria-modal", "true", { timeout: 1500 });
  expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  const controls = dialog.locator('button:not(:disabled), input:not(:disabled), select:not(:disabled)');
  await controls.last().focus();
  await page.keyboard.press("Tab");
  await expect(controls.first()).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(controls.last()).toBeFocused();
  await page.keyboard.press("Meta+n");
  await expect(tid(page, "thread-view")).toHaveAttribute("data-thread-id", "one");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test("streaming does not reparse completed Markdown", async () => {
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]!;
    for (let i = 0; i < 100; i++) win.webContents.send("thread:event", { type: "item", threadId: "one", item: { id: `old-${i}`, kind: "assistant", text: `ARCHIVED-${i} **finished**`, at: new Date().toISOString() } });
    win.webContents.send("thread:event", { type: "item", threadId: "one", item: { id: "stream", kind: "assistant", text: "live", at: new Date().toISOString() } });
  });
  await expect(items(page, "assistant")).toHaveCount(101);
  await page.evaluate(() => {
    const original = String.prototype.replace;
    (window as any).archivedParses = 0;
    String.prototype.replace = function (...args: any[]) {
      if (String(this).startsWith("ARCHIVED-") && args[0] instanceof RegExp && args[0].source === "\\r\\n") (window as any).archivedParses++;
      return (original as any).apply(this, args);
    } as typeof original;
  });
  for (let i = 0; i < 10; i++) {
    await app.evaluate(({ BrowserWindow }, i) => BrowserWindow.getAllWindows()[0]!.webContents.send("thread:event", { type: "item_update", threadId: "one", id: "stream", patch: { text: `live ${i}` } }), i);
    await expect(items(page, "assistant").last()).toHaveText(`live ${i}`);
  }
  expect(await page.evaluate(() => (window as any).archivedParses)).toBe(0);
});

test("loading a transcript preserves events received while the snapshot is in flight", async () => {
  await app.evaluate(({ ipcMain, BrowserWindow }) => {
    ipcMain.removeHandler("thread:items");
    ipcMain.handle("thread:items", (_event, { threadId }) => new Promise((resolve) => {
      const old = { id: "reply", kind: "assistant", text: "old snapshot", at: new Date().toISOString() };
      BrowserWindow.getAllWindows()[0]!.webContents.send("thread:event", { type: "item_update", threadId, id: "reply", patch: { text: "live reply" } });
      BrowserWindow.getAllWindows()[0]!.webContents.send("thread:event", { type: "item", threadId, item: { id: "notice", kind: "notice", level: "info", text: "arrived while loading", at: old.at } });
      setTimeout(() => resolve([old]), 50);
    }));
  });
  await page.locator('[data-thread-id="two"][data-testid="thread-row"]').click();
  await expect(items(page, "assistant")).toHaveText("live reply");
  await expect(items(page, "notice")).toHaveText("arrived while loading");
});

test("closing the macOS window during streaming allows the turn to finish and reopen", async () => {
  test.skip(process.platform !== "darwin", "macOS keeps the app running after its last window closes");
  const script = path.join(home, "window-script.json");
  const content = "The turn continues while the window is closed. ".repeat(8);
  fs.writeFileSync(script, JSON.stringify([{ content }]));
  await page.evaluate((mock_script) => window.modex!.invoke("settings:update", { mock_script }), script);
  await tid(page, "composer-input").fill("continue in background");
  await page.keyboard.press("Enter");
  await expect(items(page, "assistant").first()).toContainText("The turn");
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
  await expect.poll(() => JSON.parse(fs.readFileSync(path.join(home, "app/state.json"), "utf8")).threads.find((t: { id: string }) => t.id === "one").status).toBe("idle");
  const nextWindow = app.waitForEvent("window");
  await app.evaluate(({ app }) => app.emit("activate"));
  page = await nextWindow;
  await expect(items(page, "assistant").first()).toHaveText(content.trim());
  await expect(items(page, "notice").filter({ hasText: /destroyed|error/i })).toHaveCount(0);
});

test("selecting a file never shows the previous file's diff while loading", async () => {
  await expect(tid(page, "changes-diff")).toContainText("first diff");
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler("changes:diff");
    ipcMain.handle("changes:diff", () => new Promise((resolve) => setTimeout(() => resolve("+replacement diff"), 400)));
  });
  await page.getByRole("button", { name: "View diff for b.txt", exact: true }).click();
  expect(await tid(page, "changes-diff").innerText()).not.toContain("first diff");
  await expect(tid(page, "changes-diff")).toContainText("Loading diff…");
  await expect(tid(page, "changes-diff")).toContainText("replacement diff");
});
