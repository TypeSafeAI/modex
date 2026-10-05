import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { launch, seedHome, tid } from "./support";

let app: ElectronApplication;
let page: Page;
let home: string;

test.beforeEach(async () => {
  ({ home } = seedHome());
  ({ app, page } = await launch(home));
  await expect(tid(page, "sidebar")).toBeVisible();
});

test.afterEach(async () => { await app?.close(); });

async function panel(id: "sidebar" | "changes", visible: boolean): Promise<void> {
  const toggle = tid(page, `${id}-toggle`);
  if ((await toggle.getAttribute("aria-pressed")) !== String(visible)) await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", String(visible));
  await expect(tid(page, id === "sidebar" ? id : "changes-panel")).toHaveCount(visible ? 1 : 0);
}

// Assert against the sheet, not just the main pane: centering within a collapsed main
// was already correct before #74. Check all pane edges to catch gaps and implicit rows.
async function expectLayout(): Promise<void> {
  await expect.poll(() => page.evaluate(() => {
    const element = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
    const sheet = element("sheet");
    const outer = sheet.getBoundingClientRect();
    const style = getComputedStyle(sheet);
    const left = outer.left + parseFloat(style.borderLeftWidth);
    const right = outer.right - parseFloat(style.borderRightWidth);
    const top = outer.top + parseFloat(style.borderTopWidth);
    const bottom = outer.bottom - parseFloat(style.borderBottomWidth);
    const main = element("main").getBoundingClientRect();
    const sidebar = element("sidebar")?.getBoundingClientRect();
    const changes = element("changes-panel")?.getBoundingClientRect();
    const errors = [main.left - (sidebar?.right ?? left), main.right - (changes?.left ?? right)];
    for (const pane of [main, sidebar, changes]) {
      if (pane) errors.push(pane.top - top, pane.bottom - bottom);
    }
    if (sidebar) errors.push(sidebar.left - left);
    if (changes) errors.push(changes.right - right);
    const mainElement = element("main");
    const mainStyle = getComputedStyle(mainElement);
    const center = (main.left + parseFloat(mainStyle.borderLeftWidth) + main.right - parseFloat(mainStyle.borderRightWidth)) / 2;
    for (const id of ["composer-box", "draft-title"]) {
      const child = element(id);
      if (child) {
        const rect = child.getBoundingClientRect();
        errors.push((rect.left + rect.right) / 2 - center);
        errors.push(Math.max(0, main.left - rect.left, rect.right - main.right));
      }
    }
    errors.push(Math.max(0, sheet.scrollWidth - sheet.clientWidth, mainElement.scrollWidth - mainElement.clientWidth));
    return Math.max(...errors.map(Math.abs));
  })).toBeLessThanOrEqual(1);
}

for (const width of [1366, 960]) {
  test(`draft stays centered through repeated sidebar toggles at ${width}px`, async ({}, testInfo) => {
    await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0]!.setContentSize(width, 816), width);
    await tid(page, "new-chat").click();
    await expect(tid(page, "draft-view")).toBeVisible();
    await tid(page, "composer-input").fill("Keep this draft while toggling");
    const project = await tid(page, "draft-view").getAttribute("data-project-id");
    await expectLayout();
    for (const visible of [false, true, false, true]) {
      await panel("sidebar", visible);
      if (!visible) await page.screenshot({ path: testInfo.outputPath("sidebar-hidden.png") });
      await expectLayout();
      await expect(tid(page, "composer-input")).toHaveValue("Keep this draft while toggling");
      await expect(tid(page, "draft-view")).toHaveAttribute("data-project-id", project!);
    }
  });

  test(`thread fills remaining width for every panel combination and relaunch at ${width}px`, async ({}, testInfo) => {
    await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0]!.setContentSize(width, 816), width);
    await tid(page, "new-chat").click();
    await tid(page, "composer-input").fill("Panel layout check");
    await tid(page, "send").click();
    await expect(tid(page, "thread-view")).toBeVisible();
    await expect(tid(page, "stop")).toBeVisible();
    await tid(page, "stop").click();
    await expect(tid(page, "send")).toBeVisible();
    const thread = await tid(page, "thread-view").getAttribute("data-thread-id");
    await tid(page, "composer-input").fill("Keep this unsent message");
    for (const [sidebar, changes] of [[true, true], [false, true], [false, false], [true, false], [false, false]]) {
      await panel("sidebar", sidebar);
      await panel("changes", changes);
      await expectLayout();
      await expect(tid(page, "composer-input")).toHaveValue("Keep this unsent message");
      await expect(tid(page, "thread-view")).toHaveAttribute("data-thread-id", thread!);
    }
    await page.screenshot({ path: testInfo.outputPath("thread-panels-hidden.png") });
    await app.close();
    ({ app, page } = await launch(home));
    await expect(tid(page, "thread-view")).toHaveAttribute("data-thread-id", thread!);
    await expect(tid(page, "sidebar-toggle")).toHaveAttribute("aria-pressed", "false");
    await expect(tid(page, "changes-toggle")).toHaveAttribute("aria-pressed", "false");
    await expectLayout();

    // The test terminal uses /bin/bash; exercise it on macOS CI and Linux.
    if (process.platform !== "win32") {
      await tid(page, "terminal-toggle").click();
      await expect(tid(page, "terminal-panel")).toBeVisible();
      await panel("changes", true);
      await expectLayout();
      await expect.poll(async () => {
        const terminal = (await tid(page, "terminal-panel").boundingBox())!;
        const main = (await tid(page, "main").boundingBox())!;
        return Math.max(Math.abs(terminal.x - main.x), Math.abs(terminal.width - main.width), Math.abs(terminal.y + terminal.height - main.y - main.height));
      }).toBeLessThanOrEqual(1);
    }
  });
}
