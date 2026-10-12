import { test, expect, type ElectronApplication } from "@playwright/test";
import fs from "node:fs";
import { launch, seedHome, tid } from "./support";

// UI acceptance with simulated update status. No archive is downloaded, verified
// or installed. Main/native restart acceptance is a separate release gate.
async function offer(app: ElectronApplication) {
  await app.evaluate(({ ipcMain, BrowserWindow }) => {
    const release = { version: "999.0.0", url: "https://github.com/TypeSafeAI/modex/releases/tag/v999.0.0" };
    let state: any = { phase: "available", release, installable: true, canRestart: false, received: 0, total: 100 };
    let finishDownload: ((state: any) => void) | undefined;
    const publish = (patch: any) => { state = { ...state, ...patch }; BrowserWindow.getAllWindows()[0]!.webContents.send("updates:state", state); return state; };
    Object.assign(globalThis, { __updateUI: { publish, calls: [] as string[] } });
    const handlers: Record<string, () => any> = {
      "updates:check": () => release, "updates:state": () => state,
      "updates:download": () => { (globalThis as any).__updateUI.calls.push("download"); publish({ phase: "downloading", received: 25 }); return new Promise(resolve => { finishDownload = resolve; }); },
      "updates:cancel": () => { (globalThis as any).__updateUI.calls.push("cancel"); publish({ phase: "available", received: 0 }); finishDownload?.(state); },
      "updates:install": () => { (globalThis as any).__updateUI.calls.push("install"); return publish({ phase: "ready", message: "Let current turns finish before restarting." }); },
      "updates:quit": () => { (globalThis as any).__updateUI.calls.push("quit"); throw new Error("The current editor could not finish saving."); },
    };
    for (const [channel, handler] of Object.entries(handlers)) { ipcMain.removeHandler(channel); ipcMain.handle(channel, handler); }
  });
}
const publish = (app: ElectronApplication, patch: Record<string, unknown>) => app.evaluate((_electron, value) => { (globalThis as any).__updateUI.publish(value); }, patch);

test("update progress supports cancellation and preserves drafts when restart is refused", async () => {
  const seeded = seedHome(), home = fs.realpathSync(seeded.home), repo = seeded.repo;
  const { app, page } = await launch(home);
  console.log(JSON.stringify({ fixtureHome: home, fixtureRepo: repo, electronPid: app.process().pid }));
  try {
    await offer(app); await page.reload();
    await tid(page, "composer-input").fill("  Keep this unsent draft 😀\n");
    await page.getByRole("button", { name: "Download update", exact: true }).click({ timeout: 5000 });
    await expect(page.getByRole("progressbar", { name: "Update download" })).toHaveAttribute("value", "25");
    await page.getByRole("button", { name: "Cancel download", exact: true }).click({ timeout: 5000 });
    await expect(page.getByRole("button", { name: "Download update", exact: true })).toBeVisible();
    await publish(app, { phase: "ready", received: 100 });
    await page.getByRole("button", { name: "Restart to update", exact: true }).click();
    await expect(tid(page, "update-banner")).toContainText("Let current turns finish before restarting.");
    await expect(tid(page, "composer-input")).toHaveValue("  Keep this unsent draft 😀\n");
    expect(await app.evaluate(() => (globalThis as any).__updateUI.calls)).toEqual(["download", "cancel", "install"]);
  } finally { await app.close(); fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(repo, { recursive: true, force: true }); }
});

test("recovery controls stay usable outside the frozen workspace and show Quit refusal", async () => {
  const seeded = seedHome(), home = fs.realpathSync(seeded.home), repo = seeded.repo;
  const { app, page } = await launch(home);
  console.log(JSON.stringify({ fixtureHome: home, fixtureRepo: repo, electronPid: app.process().pid }));
  try {
    await offer(app); await page.reload();
    await tid(page, "composer-input").fill("Preserve recovery draft");
    await publish(app, { phase: "preparing" });
    await expect(tid(page, "update-restart-status")).toBeVisible({ timeout: 5000 });
    await expect(page.getByRole("button", { name: "Quit Modex", exact: true })).toHaveCount(0);
    await publish(app, { phase: "uncertain", message: "The update handoff could not be confirmed." });
    const quit = page.getByRole("button", { name: "Quit Modex", exact: true });
    await expect(quit).toBeEnabled();
    expect(await quit.evaluate(element => element.closest("[inert]") === null)).toBe(true);
    await page.keyboard.press("Meta+n"); await page.keyboard.type("must not append");
    await expect(tid(page, "composer-input")).toHaveValue("Preserve recovery draft");
    await quit.click(); await expect(tid(page, "update-restart-status")).toContainText("The current editor could not finish saving.");
    await expect(quit).toBeEnabled();
    await publish(app, { phase: "staged", canRestart: true });
    await expect(page.getByRole("button", { name: "Restart to update", exact: true })).toHaveCount(0);
  } finally {
    await publish(app, { phase: "available", message: undefined });
    await app.close(); fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(repo, { recursive: true, force: true });
  }
});
