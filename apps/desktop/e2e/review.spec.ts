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

test("Settings sections navigate by keyboard and advanced Jev policy saves and reopens", async () => {
  const trigger = tid(page, "open-settings");
  await trigger.click();
  const dialog = tid(page, "settings");
  const nav = tid(page, "settings-nav");
  const routing = nav.getByRole("button", { name: "Auto routing" });
  await expect(tid(page, "settings-routing-section")).toBeVisible();
  await expect(tid(page, "routing-posture")).toBeVisible();

  const general = nav.getByRole("button", { name: "General" });
  await general.focus();
  await page.keyboard.press("Enter");
  await expect(dialog.getByRole("heading", { name: "General" })).toBeVisible();
  await routing.focus();
  await page.keyboard.press("Enter");
  await expect(tid(page, "settings-routing-section")).toBeVisible();

  const advanced = nav.getByRole("button", { name: "Advanced / demo" });
  await advanced.click();
  await expect(tid(page, "jev-model")).toHaveValue("jev-latest");
  await tid(page, "jev-model").fill("   ");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Enter a Jev model id before saving");
  await expect(dialog).toBeVisible();
  await tid(page, "jev-model").fill("jev-review-model");
  const codex = dialog.getByRole("checkbox", { name: "Codex" });
  const claude = dialog.getByRole("checkbox", { name: "Claude" });
  await expect(codex).toBeChecked();
  await expect(claude).toBeChecked();
  await claude.uncheck();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toHaveCount(0);

  const saved = JSON.parse(fs.readFileSync(path.join(home, "app", "state.json"), "utf8"));
  expect(saved.settings.routing.jev_model).toBe("jev-review-model");
  expect(saved.settings.routing.allow_backends).toEqual(["codex"]);
  await trigger.click();
  await advanced.click();
  await expect(tid(page, "jev-model")).toHaveValue("jev-review-model");
  await expect(codex).toBeChecked();
  await expect(claude).not.toBeChecked();

  await codex.uncheck();
  await expect(dialog.getByText(/With an empty allowed-backend list, Auto stays on the thread’s current backend/)).toBeVisible();
  await expect(tid(dialog, "allow-mock-routing")).not.toBeChecked();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await trigger.click();
  await advanced.click();
  await expect(codex).not.toBeChecked();
  await expect(claude).not.toBeChecked();
  await expect(JSON.parse(fs.readFileSync(path.join(home, "app", "state.json"), "utf8")).settings.routing.allow_backends).toEqual([]);
  await dialog.getByRole("button", { name: "Cancel" }).click();
});

test("editing coding backends preserves a legacy Mock routing entry", async () => {
  await app.close();
  const file = path.join(home, "app", "state.json");
  const persisted = JSON.parse(fs.readFileSync(file, "utf8"));
  persisted.settings.routing = { ...persisted.settings.routing, allow_backends: ["codex", "claude", "mock"] };
  fs.writeFileSync(file, JSON.stringify(persisted));
  ({ app, page } = await launch(home));

  await tid(page, "open-settings").click();
  const dialog = tid(page, "settings");
  await dialog.getByRole("button", { name: "Advanced / demo" }).click();
  const mock = tid(dialog, "allow-mock-routing");
  await expect(mock).toBeChecked();
  await expect(dialog.getByText(/Existing Mock allowlist entries stay enabled until you turn this off/)).toBeVisible();
  await dialog.getByRole("checkbox", { name: "Claude" }).uncheck();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  expect(saved.settings.routing.allow_backends).toEqual(["codex", "mock"]);
  await expect(dialog).toHaveCount(0);

  await tid(page, "open-settings").click();
  await dialog.getByRole("button", { name: "Advanced / demo" }).click();
  await tid(dialog, "allow-mock-routing").uncheck();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  expect(JSON.parse(fs.readFileSync(file, "utf8")).settings.routing.allow_backends).toEqual(["codex"]);
  await expect(dialog).toHaveCount(0);
});

test("Settings keeps Save and Cancel visible in a short zoomed window", async () => {
  await page.setViewportSize({ width: 430, height: 470 });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.setZoomFactor(1.5));
  await tid(page, "open-settings").click();
  const dialog = tid(page, "settings");
  const content = tid(page, "settings-content");
  const footer = tid(page, "settings-actions");
  await expect(tid(page, "settings-routing-section")).toBeVisible();
  expect(await content.evaluate((el) => el.scrollHeight)).toBeGreaterThan(await content.evaluate((el) => el.clientHeight));
  const viewport = page.viewportSize()!;
  const before = await footer.boundingBox();
  expect(before).not.toBeNull();
  expect(before!.y + before!.height).toBeLessThanOrEqual(viewport.height);
  await content.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await expect(dialog.getByRole("button", { name: "Save", exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeVisible();
  const after = await footer.boundingBox();
  expect(after!.y).toBe(before!.y);
  expect(after!.y + after!.height).toBeLessThanOrEqual(viewport.height);
  await dialog.getByRole("button", { name: "Cancel" }).click();
});

test("Jev test health identifies the tested setup, stays explicit, and HTTP-only does not claim the CLI is missing", async () => {
  const status = await page.evaluate(() => window.modex!.invoke("routing:status", undefined));
  await app.evaluate(({ ipcMain }, current) => {
    ipcMain.removeHandler("routing:test");
    ipcMain.handle("routing:test", async () => ({ ok: true, message: "fake Jev answered", transport: "http", ms: 4, tested: { executable: null, model: current.model }, current: true }));
    ipcMain.removeHandler("routing:status");
    ipcMain.handle("routing:status", async () => ({ ...current, live: true, detail: undefined, transport: { kind: "http" }, fit: { ...current.fit, routes: 1 }, lastTest: { ok: true, message: "fake Jev answered", transport: "http", ms: 4, tested: { executable: null, model: current.model }, at: Date.now() } }));
    ipcMain.removeHandler("routing:reset");
    ipcMain.handle("routing:reset", async () => ({ ...current, live: true, detail: undefined, transport: { kind: "http" }, fit: { ...current.fit, routes: 0 } }));
  }, status);
  await tid(page, "open-settings").click();
  const dialog = tid(page, "settings");
  await expect(dialog.locator(".field").filter({ hasText: "jev executable" }).locator("small")).toContainText("not used or checked in HTTP-only mode");
  let resetMessage = "";
  page.once("dialog", async (dialog) => { resetMessage = dialog.message(); await dialog.dismiss(); });
  await dialog.getByRole("button", { name: "Reset learning…" }).click();
  expect(resetMessage).toMatch(/Reset Auto routing's learned preferences/);
  await expect(dialog.getByRole("button", { name: "Reset learning…" })).toBeVisible();
  page.once("dialog", async (confirmation) => { await confirmation.accept(); });
  await dialog.getByRole("button", { name: "Reset learning…" }).click();
  await expect(dialog.getByRole("button", { name: "Reset learning…" })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Test judge" }).click();
  await expect(tid(page, "routing-test")).toContainText("tested HTTPS");
  await expect(tid(page, "routing-verification")).toContainText("Verified · HTTPS");
  const executable = dialog.locator(".field").filter({ hasText: "jev executable" }).locator("input");
  const savedExecutable = await executable.inputValue();
  await executable.fill("/tmp/changed-jev");
  await expect(tid(page, "routing-verification")).toHaveText("Configured · untested");
  await expect(dialog.getByRole("button", { name: "Test judge" })).toBeDisabled();
  await executable.fill(savedExecutable);
  await expect(tid(page, "routing-verification")).toContainText("Verified · HTTPS");
  const transport = dialog.locator(".field").filter({ hasText: "Judge transport" }).locator("select");
  await transport.selectOption("auto");
  await expect(tid(page, "routing-test-draft")).toBeVisible();
  await expect(dialog.locator(".field").filter({ hasText: "jev executable" }).locator("small")).toContainText("Draft transport or executable has not been checked");
  await expect(dialog.locator(".field").filter({ hasText: "jev executable" }).locator("small")).not.toContainText("Auto selected HTTPS");
  await expect(dialog.locator(".field").filter({ hasText: "jev executable" }).locator("small")).not.toContainText("not found on PATH");
  await expect(dialog.getByRole("button", { name: "Test judge" })).toBeDisabled();
  await expect(tid(page, "routing-verification")).toHaveText("Configured · untested");
  await dialog.getByRole("button", { name: "Cancel" }).click();
});

test("settings save stays pending through dismissal attempts and preserves drafts for retry", async () => {
  await app.evaluate(({ ipcMain }) => {
    let attempts = 0;
    let release: (() => void) | undefined;
    ipcMain.removeHandler("settings:update");
    ipcMain.handle("settings:update", async () => {
      attempts++;
      await new Promise<void>((resolve, reject) => {
        release = () => attempts === 1 ? reject(new Error("fake persistence failure")) : resolve();
      });
    });
    (globalThis as any).__modexE2EReleaseSettingsSave = () => release?.();
  });
  await tid(page, "open-settings").click();
  const dialog = tid(page, "settings");
  await dialog.getByRole("button", { name: "General" }).click();
  const mode = dialog.locator(".field").filter({ hasText: "Default mode" }).locator("select");
  await mode.selectOption("agent");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Saving…" })).toBeDisabled();
  await page.locator(".modal-backdrop").click({ position: { x: 1, y: 1 } });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await app.evaluate(() => (globalThis as any).__modexE2EReleaseSettingsSave());
  await expect(tid(page, "settings-save-error")).toContainText("fake persistence failure");
  await expect(mode).toHaveValue("agent");
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler("state:get");
    ipcMain.handle("state:get", async () => { throw new Error("fake refresh failure"); });
  });
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Saving…" })).toBeDisabled();
  await app.evaluate(() => (globalThis as any).__modexE2EReleaseSettingsSave());
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("alert")).toContainText("Settings were saved, but Modex could not refresh its view:");
  await expect(page.getByRole("alert")).toContainText("fake refresh failure");
});

test("blocked Auto receipts identify the stop while older pinned receipts still show Auto kept", async () => {
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]!;
    const receipt = { kind: "route", backend: "codex", model: "", effort: undefined, fast: false, source: "heuristic", task: "review", confidence: 0.9, complexity: 2, pinned: true, reasons: ["Cannot honor the effort ceiling; the route was stopped."], durationMs: 1, at: new Date().toISOString() };
    win.webContents.send("thread:event", { type: "item", threadId: "one", item: { ...receipt, id: "blocked", blocked: true } });
    win.webContents.send("thread:event", { type: "item", threadId: "one", item: { ...receipt, id: "legacy-pinned" } });
  });
  const receipts = items(page, "route");
  await expect(tid(receipts.first(), "route-label")).toHaveText("Auto blocked Codex · CLI default");
  await expect(tid(receipts.last(), "route-label")).toContainText("Auto kept");
  await tid(receipts.first(), "item-toggle").click();
  await expect(tid(receipts.first(), "item-body")).toContainText("Cannot honor the effort ceiling");
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
