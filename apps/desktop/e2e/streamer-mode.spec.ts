import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { launch, seedHome, tid } from "./support";

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
