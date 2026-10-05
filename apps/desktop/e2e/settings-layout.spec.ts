import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import { launch, seedHome, tid } from "./support";

let app: ElectronApplication;
let page: Page;
let home: string;
let repo: string;

test.beforeEach(async () => {
  ({ home, repo } = seedHome());
  ({ app, page } = await launch(home));
});

test.afterEach(async () => {
  await app?.close();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

test("Settings sections and persistent actions stay reachable in a narrow, short zoomed window", async () => {
  await page.setViewportSize({ width: 430, height: 470 });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.setZoomFactor(1.5));
  await tid(page, "open-settings").click();

  const dialog = tid(page, "settings");
  const header = tid(page, "settings-header");
  const nav = tid(page, "settings-nav");
  const content = tid(page, "settings-content");
  const footer = tid(page, "settings-actions");
  await expect(dialog).toHaveAttribute("aria-modal", "true");
  await expect(tid(page, "settings-routing-section")).toBeVisible();

  // Measure the actual painted boxes against both the dialog and the CSS viewport. Locator visibility
  // alone would pass when a fixed child is clipped by an undersized flex container.
  const shell = await dialog.evaluate((el) => {
    const rect = (node: Element) => {
      const r = node.getBoundingClientRect();
      return { top: r.top, right: r.right, bottom: r.bottom, left: r.left };
    };
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      dialog: rect(el),
      header: rect(el.querySelector('[data-testid="settings-header"]')!),
      nav: rect(el.querySelector('[data-testid="settings-nav"]')!),
      footer: rect(el.querySelector('[data-testid="settings-actions"]')!),
    };
  });
  const within = (inner: typeof shell.header, outer: typeof shell.dialog) =>
    inner.top >= outer.top - 1 && inner.left >= outer.left - 1 && inner.right <= outer.right + 1 && inner.bottom <= outer.bottom + 1;
  const onScreen = (box: typeof shell.header) =>
    box.top >= 0 && box.left >= 0 && box.right <= shell.viewport.width + 1 && box.bottom <= shell.viewport.height + 1;
  expect(within(shell.header, shell.dialog), "the fixed header is inside the dialog").toBe(true);
  expect(within(shell.nav, shell.dialog), "the section navigation is inside the dialog").toBe(true);
  expect(within(shell.footer, shell.dialog), "the actions are inside the dialog").toBe(true);
  expect(onScreen(shell.header), "the header is not clipped by the window").toBe(true);
  expect(onScreen(shell.nav), "the section navigation is not clipped by the window").toBe(true);
  expect(onScreen(shell.footer), "Save and Cancel are not clipped by the window").toBe(true);

  // Standard button tab order lets keyboard users move through sections; focus scrolls the tab strip
  // horizontally when needed, then Enter selects the section.
  const general = nav.getByRole("button", { name: "General" });
  await general.focus();
  for (const label of ["Coding CLIs", "Auto routing", "Advanced / demo"]) {
    await page.keyboard.press("Tab");
    const next = nav.getByRole("button", { name: label });
    await expect(next).toBeFocused();
  }
  const advanced = nav.getByRole("button", { name: "Advanced / demo" });
  const navBounds = await nav.boundingBox();
  const advancedBounds = await advanced.boundingBox();
  expect(advancedBounds!.x).toBeGreaterThanOrEqual(navBounds!.x);
  expect(advancedBounds!.x + advancedBounds!.width).toBeLessThanOrEqual(navBounds!.x + navBounds!.width + 1);
  await page.keyboard.press("Enter");
  await expect(tid(page, "settings-advanced-section")).toBeVisible();

  const footerBeforeScroll = await footer.boundingBox();
  const bottomField = dialog.locator('input[placeholder="/path/to/mock-script.json"]');
  const scrollBefore = await content.evaluate((el) => el.scrollTop);
  await bottomField.scrollIntoViewIfNeeded();
  expect(await content.evaluate((el) => el.scrollTop)).toBeGreaterThan(scrollBefore);
  const contentBounds = await content.boundingBox();
  const fieldBounds = await bottomField.boundingBox();
  expect(fieldBounds!.y).toBeGreaterThanOrEqual(contentBounds!.y - 1);
  expect(fieldBounds!.y + fieldBounds!.height).toBeLessThanOrEqual(contentBounds!.y + contentBounds!.height + 1);
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Save", exact: true })).toBeVisible();
  const footerAfterScroll = await footer.boundingBox();
  expect(footerAfterScroll!.y).toBe(footerBeforeScroll!.y);
  expect(footerAfterScroll!.y + footerAfterScroll!.height).toBeLessThanOrEqual(shell.viewport.height + 1);
  await dialog.getByRole("button", { name: "Cancel" }).click();
});
