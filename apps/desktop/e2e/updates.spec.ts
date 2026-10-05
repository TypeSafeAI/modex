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
  for (const dir of [home, repo]) fs.rmSync(dir, { recursive: true, force: true });
});
const offer = async (version: string | null, reload = true) => {
  await app.evaluate(({ ipcMain }, version) => {
    ipcMain.removeHandler("updates:check");
    ipcMain.handle("updates:check", () => version ? { version, url: `https://github.com/TypeSafeAI/modex/releases/tag/v${version}` } : null);
  }, version);
  if (reload) {
    await page.reload();
    await expect(tid(page, "sidebar")).toBeVisible();
  }
};

for (const theme of ["jev", "coven"] as const) test(`${theme}: update banner opens the release page, remembers dismissal and notices a rollout`, async () => {
  await page.evaluate((theme) => window.modex!.invoke("settings:update", { theme }), theme);
  await offer("999.0.0");
  const banner = tid(page, "update-banner");
  await expect(banner).toContainText("Modex 999.0.0 is available");
  const download = banner.getByRole("link", { name: "View update" });
  await expect(download).toHaveAttribute("href", "https://github.com/TypeSafeAI/modex/releases/tag/v999.0.0");
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]!.webContents.setWindowOpenHandler(({ url }) => {
      (globalThis as any).__openedUpdate = url;
      return { action: "deny" };
    });
  });
  await download.click();
  await expect.poll(() => app.evaluate(() => (globalThis as any).__openedUpdate)).toBe("https://github.com/TypeSafeAI/modex/releases/tag/v999.0.0");
  await banner.getByRole("button", { name: "Dismiss update notification" }).click();
  await expect(banner).toHaveCount(0);
  await app.close();
  ({ app, page } = await launch(home));
  await page.clock.install();
  await offer("999.0.0");
  const restored = tid(page, "update-banner");
  expect(await page.evaluate(() => localStorage.getItem("modex.dismissedUpdate"))).toBe("999.0.0");
  await expect(restored).toHaveCount(0);
  await offer("999.0.1", false);
  await page.clock.fastForward(60 * 60 * 1000);
  await expect(restored).toContainText("Modex 999.0.1 is available");
  await page.screenshot({ path: test.info().outputPath(`update-banner-${theme}.png`) });
  // Returning to an open window also discovers a rollout; the main process keeps
  // these checks cached/coalesced so switching applications never floods GitHub.
  await offer("999.0.2", false);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(restored).toContainText("Modex 999.0.2 is available");
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(900, 600));
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(900);
  await restored.getByRole("link", { name: "View update" }).focus();
  await expect(restored.getByRole("link", { name: "View update" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(restored.getByRole("button", { name: "Dismiss update notification" })).toBeFocused();
  const fits = await restored.evaluate((element) => {
    const banner = element.getBoundingClientRect();
    return Array.from(element.querySelectorAll("a, button, [role=status]")).every((child) => {
      const bounds = child.getBoundingClientRect();
      return bounds.left >= banner.left && bounds.right <= banner.right && bounds.bottom <= banner.bottom;
    }) && element.scrollWidth === element.clientWidth;
  });
  expect(fits).toBe(true);
  await page.screenshot({ path: test.info().outputPath(`update-banner-${theme}-compact.png`) });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(restored.getByRole("link", { name: "View update" })).toHaveCSS("transition-duration", "0s");
  await offer(null);
  await expect(restored).toHaveCount(0);
});
