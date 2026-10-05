import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { createThread, launch, seedHome, tid } from "./support";

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
  for (const dir of [home, repo]) fs.rmSync(dir, { recursive: true, force: true });
});
const openAppearance = async () => {
  await tid(page, "open-settings").click();
  await tid(page, "settings-nav").getByRole("button", { name: "General", exact: true }).click();
};
const canvas = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bg-main").trim());

test("theme is a saved Settings draft; switching preserves the terminal and survives relaunch", async () => {
  await openAppearance();
  const coven = page.getByRole("radio", { name: "OpenCoven", exact: true });
  await expect(coven).toBeVisible();
  await coven.check();
  await tid(page, "settings").getByRole("button", { name: "Cancel", exact: true }).click();
  expect(await canvas()).toBe("#0b0f1b");

  const threadId = await createThread(page, "Theme persistence");
  await tid(page, "terminal-toggle").click();
  const before = await page.evaluate((threadId) => window.modex!.invoke("terminal:open", { threadId, cols: 80, rows: 24 }), threadId);
  await openAppearance();
  await page.getByRole("radio", { name: "Jev", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(coven).toBeChecked();
  await tid(page, "settings").getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(canvas).toBe("#1c1b1d");
  await expect(page.locator(".xterm-scrollable-element")).toHaveCSS("background-color", "rgb(28, 27, 29)");
  const after = await page.evaluate((threadId) => window.modex!.invoke("terminal:open", { threadId, cols: 80, rows: 24 }), threadId);
  expect(after.sessionId).toBe(before.sessionId);
  expect((await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getBackgroundColor())).toLowerCase()).toBe("#1c1b1d");
  expect(JSON.parse(fs.readFileSync(path.join(home, "app", "state.json"), "utf8")).settings.theme).toBe("coven");

  await app.close();
  ({ app, page } = await launch(home));
  await expect(tid(page, "sidebar")).toBeVisible();
  await expect.poll(canvas).toBe("#1c1b1d");
  await page.screenshot({ path: test.info().outputPath("opencoven-workspace.png") });
  const contrasts = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    const luminance = (token: string) => {
      const hex = style.getPropertyValue(token).trim().slice(1);
      const values = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return values[0]! * 0.2126 + values[1]! * 0.7152 + values[2]! * 0.0722;
    };
    return [
      ["body", "--text-1", "--bg-main"], ["metadata", "--text-4", "--bg-elevated"],
      ["placeholder", "--text-placeholder", "--bg-composer"], ["quiet text", "--text-3", "--bg-row-hover"],
      ["primary action", "--accent-ink", "--accent-strong"], ["primary hover", "--accent-ink", "--accent-strong-hover"],
      ["focus", "--accent", "--bg-main"],
    ].map(([name, fg, bg]) => { const a = luminance(fg!), b = luminance(bg!); return { name, ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) }; });
  });
  for (const { name, ratio } of contrasts) expect(ratio, name).toBeGreaterThanOrEqual(4.5);
  await openAppearance();
  await expect(page.getByRole("radio", { name: "OpenCoven", exact: true })).toBeChecked();
  await page.screenshot({ path: test.info().outputPath("opencoven-settings.png") });
  await page.getByRole("radio", { name: "Jev", exact: true }).check();
  await tid(page, "settings").getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(canvas).toBe("#0b0f1b");
});
