import { test, expect, type ElectronApplication, type Page, type Locator } from "@playwright/test";
import { launch, seedHome, createThread, tid } from "./support";

let app: ElectronApplication;
let page: Page;
let home: string;
test.beforeEach(async () => {
  ({ home } = seedHome());
  ({ app, page } = await launch(home));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1366, 816));
  await createThread(page, "Resize the panels");
});
test.afterEach(async () => { await app?.close(); });
const width = async (pane: Locator) => (await pane.boundingBox())!.width;
async function drag(handle: Locator, delta: number) {
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + delta, box.y + box.height / 2, { steps: 12 });
  await page.mouse.up();
}

test("both panels resize by dragging and keyboard, retain widths, and keep chat usable", async () => {
  let left = page.getByRole("separator", { name: "Resize sidebar" });
  let right = page.getByRole("separator", { name: "Resize workspace" });
  await expect(left).toBeVisible();
  await expect(right).toBeVisible();
  const leftStart = await width(tid(page, "sidebar"));
  const rightStart = await width(tid(page, "workspace"));
  await drag(left, 56);
  await drag(right, -48);
  await expect.poll(() => width(tid(page, "sidebar"))).toBe(leftStart + 56);
  await expect.poll(() => width(tid(page, "workspace"))).toBe(rightStart + 48);
  await left.focus();
  await page.keyboard.press("ArrowLeft");
  await right.focus();
  await page.keyboard.press("ArrowRight");
  const expectedLeft = leftStart + 48;
  const expectedRight = rightStart + 40;
  await expect.poll(() => width(tid(page, "sidebar"))).toBe(expectedLeft);
  await expect.poll(() => width(tid(page, "workspace"))).toBe(expectedRight);
  await tid(page, "sidebar-toggle").click();
  await expect(left).toBeHidden();
  await tid(page, "sidebar-toggle").click();
  await expect.poll(() => width(tid(page, "sidebar"))).toBe(expectedLeft);
  await app.close();
  ({ app, page } = await launch(home));
  left = page.getByRole("separator", { name: "Resize sidebar" });
  right = page.getByRole("separator", { name: "Resize workspace" });
  await expect.poll(() => width(tid(page, "sidebar"))).toBe(expectedLeft);
  await expect.poll(() => width(tid(page, "workspace"))).toBe(expectedRight);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(900, 700));
  await expect.poll(() => width(tid(page, "main"))).toBeGreaterThanOrEqual(350);
  await drag(right, -900);
  await expect.poll(() => width(tid(page, "main"))).toBeGreaterThanOrEqual(350);
  await expect.poll(() => page.evaluate(() => document.body.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  await tid(page, "workspace-full").click();
  await expect(left).toBeHidden();
  await expect(right).toBeHidden();
  await tid(page, "workspace-full").click();
  await right.dblclick();
  await expect.poll(() => width(tid(page, "main"))).toBeGreaterThanOrEqual(350);
});

test("Space shares the draggable sidebar and Knowledge uses a single slim toolbar", async ({}, testInfo) => {
  await tid(page, "rail-space").click();
  let left = page.getByRole("separator", { name: "Resize sidebar" });
  const sidebar = page.getByRole("complementary", { name: "Space pages" });
  const before = await width(sidebar);
  await drag(left, 40);
  await expect.poll(() => width(sidebar)).toBe(before + 40);
  await expect(page.getByRole("separator", { name: "Resize workspace" })).toBeHidden();
  await page.getByRole("button", { name: "Knowledge base", exact: true }).click();
  const maintenance = page.getByRole("button", { name: "Agent maintenance" });
  await expect(maintenance).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("checkbox", { name: /Maintain knowledge/ })).toBeHidden();
  expect((await page.locator(".knowledge-topbar").boundingBox())!.height).toBeLessThanOrEqual(36);
  await page.screenshot({ path: testInfo.outputPath("knowledge-slim.png") });
  await maintenance.click();
  await expect(page.getByRole("checkbox", { name: /Maintain knowledge/ })).toBeVisible();
  await maintenance.click();
  await tid(page, "rail-chat").click();
  await expect.poll(() => width(tid(page, "sidebar"))).toBe(before + 40);
});
