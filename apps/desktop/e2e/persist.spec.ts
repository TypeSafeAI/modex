import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { createThread, launch, seedHome, tid } from "./support";

/**
 * Layout persistence: panel toggles (localStorage) and window geometry (MODEX_HOME/window-state.json)
 * survive quitting and relaunching the real app. Own home, so no other spec inherits this geometry.
 */
let app: ElectronApplication;
let page: Page;
let home: string;

test.beforeAll(async () => {
  ({ home } = seedHome());
  ({ app, page } = await launch(home));
});

test.afterAll(async () => {
  await app?.close();
});

const bounds = (a: ElectronApplication) => a.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getBounds());

test("closed panels and the window's size and position survive a relaunch", async () => {
  await expect(tid(page, "sidebar")).toBeVisible();
  await createThread(page, "Layout check");
  await expect(tid(page, "changes-panel")).toHaveCount(1);

  // Hide both panels and move/resize the window (small enough for a CI runner's display).
  await tid(page, "changes-toggle").click();
  await tid(page, "sidebar-toggle").click();
  await expect(tid(page, "changes-panel")).toHaveCount(0);
  await expect(tid(page, "sidebar")).toHaveCount(0);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setBounds({ x: 40, y: 60, width: 960, height: 620 }));
  const before = await bounds(app);
  expect(before.width).toBe(960);

  await app.close();
  ({ app, page } = await launch(home));
  await expect(tid(page, "thread-view")).toBeVisible();
  await expect(tid(page, "sidebar")).toHaveCount(0);
  await expect(tid(page, "changes-panel")).toHaveCount(0);
  await expect(tid(page, "changes-toggle")).toHaveAttribute("aria-pressed", "false");
  expect(await bounds(app)).toEqual(before);

  // Reopening them is persisted the same way.
  await tid(page, "changes-toggle").click();
  await tid(page, "sidebar-toggle").click();
  await app.close();
  ({ app, page } = await launch(home));
  await expect(tid(page, "thread-view")).toBeVisible();
  await expect(tid(page, "sidebar")).toBeVisible();
  await expect(tid(page, "changes-panel")).toHaveCount(1);
});

test("a maximized window reopens maximized, and un-maximizes to its saved size", async () => {
  await expect(tid(page, "sidebar")).toBeVisible();
  const normal = await bounds(app);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.maximize());
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isMaximized())).toBe(true);
  await app.close();
  ({ app, page } = await launch(home));
  await expect(tid(page, "sidebar")).toBeVisible();
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isMaximized())).toBe(true);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.unmaximize());
  await expect.poll(() => bounds(app).then((b) => b.width)).toBe(normal.width);
});
