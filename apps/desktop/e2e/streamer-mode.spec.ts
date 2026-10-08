import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { launch, seedHome, tid } from "./support";

let app: ElectronApplication;
let page: Page;
let home: string;

test.beforeEach(async () => {
  ({ home } = seedHome());
  ({ app, page } = await launch(home));
});

test.afterEach(async () => {
  await app?.close();
});

test("Streamer Mode fully covers private UI, survives relaunch, and reveals it only on request", async () => {
  const privatePrompt = "Client launch password is violet-orchid-927";
  await tid(page, "new-chat").click();
  await tid(page, "composer-input").fill(privatePrompt);
  await tid(page, "send").click();
  await expect(tid(page, "item-text").filter({ hasText: privatePrompt })).toBeVisible();

  await tid(page, "streamer-mode-toggle").click();
  const shield = tid(page, "streamer-shield");
  await expect(shield).toBeVisible();
  await expect(tid(page, "sheet")).toBeHidden();
  await expect(tid(page, "titlebar")).toBeHidden();
  await expect(tid(page, "rail")).toBeHidden();
  await expect(tid(page, "streamer-mode-disable")).toBeFocused();

  const coverage = await shield.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return {
      box: { x: box.x, y: box.y, width: box.width, height: box.height },
      viewport: { width: innerWidth, height: innerHeight },
      background: style.backgroundColor,
      position: style.position,
    };
  });
  expect(coverage).toEqual({
    box: { x: 0, y: 0, width: coverage.viewport.width, height: coverage.viewport.height },
    viewport: coverage.viewport,
    background: "rgb(20, 20, 20)",
    position: "fixed",
  });

  await app.close();
  ({ app, page } = await launch(home));
  await expect(tid(page, "streamer-shield")).toBeVisible();
  await expect(tid(page, "sheet")).toBeHidden();

  await tid(page, "streamer-mode-disable").click();
  await expect(tid(page, "streamer-shield")).toHaveCount(0);
  await expect(tid(page, "item-text").filter({ hasText: privatePrompt })).toBeVisible();
});

test("Streamer Mode covers startup while state is pending and after it loads", async () => {
  const state = await page.evaluate(() => window.modex!.invoke("state:get", undefined));
  await tid(page, "streamer-mode-toggle").click();
  await app.evaluate(({ ipcMain }, saved) => {
    let resolveState: (value: typeof saved) => void;
    let started: () => void;
    const pending = new Promise<void>((resolve) => { started = resolve; });
    ipcMain.removeHandler("state:get");
    ipcMain.handle("state:get", () => new Promise((resolve) => { resolveState = resolve; started(); }));
    // The test explicitly settles startup; no sleep or race against machine speed.
    ipcMain.handle("test:resolve-state", async () => { await pending; resolveState(saved); });
  }, state);

  await page.reload();
  await expect(tid(page, "streamer-shield")).toBeVisible();
  await expect(tid(page, "streamer-mode-disable")).toBeFocused();
  await expect(page.getByText("Loading…", { exact: true })).toBeHidden();

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.executeJavaScript(
    'window.modex.invoke("test:resolve-state")',
  ));
  await expect(tid(page, "sheet")).toBeAttached();
  await expect(tid(page, "sheet")).toBeHidden();
  await expect(tid(page, "streamer-mode-disable")).toBeFocused();
  await tid(page, "streamer-mode-disable").click();
  await expect(tid(page, "draft-view")).toBeVisible();
});

test("Streamer Mode keeps a startup error private until the workspace is explicitly revealed", async () => {
  await tid(page, "streamer-mode-toggle").click();
  const privateError = "Unable to read /Users/private-client/confidential/state.json";
  await app.evaluate(({ ipcMain }, message) => {
    ipcMain.removeHandler("state:get");
    ipcMain.handle("state:get", () => { throw new Error(message); });
  }, privateError);

  await page.reload();
  // Wait for the error state to settle, then check that it cannot be seen or read by AT.
  await expect(page.locator(".app")).toContainText(privateError);
  await expect(page.getByText(privateError, { exact: false })).toBeHidden();
  expect(await page.locator("body").ariaSnapshot()).not.toContain(privateError);
  await expect(tid(page, "streamer-shield")).toBeVisible();

  await tid(page, "streamer-mode-disable").click();
  await expect(tid(page, "streamer-shield")).toHaveCount(0);
  await expect(page.getByText(privateError, { exact: false })).toBeVisible();
});
