import { test, expect, type ElectronApplication, _electron as electron } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { appDir, seedHome, tid } from "./support";

/** Real controller and main IPC; transport/publisher checks are simulated. */
async function launchInstallation() {
  const seeded = seedHome({ auto_retire: false }), home = fs.realpathSync(seeded.home), repo = seeded.repo;
  const env = { ...process.env, MODEX_HOME: home, MODEX_NO_LOGIN_PATH: "1", TYPESAFE_API_KEY: "", JEV_API_KEY: "", JEV_CONFIG: path.join(home, "no-jev.json") };
  delete env.MODEX_E2E; delete env.MODEX_PACKAGED_APP; delete env.MODEX_DEV_URL;
  const app = await electron.launch({ args: [path.join(appDir, "e2e/fixtures/update-installation.mjs")], cwd: appDir, env });
  console.log(JSON.stringify({ fixtureHome: home, fixtureRepo: repo, electronPid: app.process().pid }));
  const page = await app.firstWindow(); await page.waitForLoadState("domcontentloaded");
  return { home, repo, app, page };
}
async function finishDownload(app: ElectronApplication) {
  await app.evaluate(() => (globalThis as any).__updateScenario.finishDownload());
}
async function finishVerification(app: ElectronApplication, success: boolean) {
  await app.evaluate((_electron, success) => (globalThis as any).__updateScenario.finishVerification(success), success);
}
async function counts(app: ElectronApplication) {
  return app.evaluate(() => {
    const { downloads, downloadedDisposed, stagedDisposed, nativeCalls } = (globalThis as any).__updateScenario;
    return { downloads, downloadedDisposed, stagedDisposed, nativeCalls };
  });
}

async function cleanup(app: ElectronApplication, home: string, repo: string) {
  try {
    // An assertion can fail while the fake verifier is suspended. Release it so
    // production disposal can finish and the failed test cannot retain Electron.
    await app.evaluate(() => (globalThis as any).__updateScenario?.finishVerification?.(false));
  } finally {
    try {
      await app.close();
      const final = JSON.parse(fs.readFileSync(path.join(home, "final-installation-evidence.json"), "utf8"));
      expect(final.nativeCalls).toBe(0); expect(final.downloadedDisposed).toBe(final.stagedDisposed);
      const receipt = test.info().outputPath("installation-controller-evidence.json");
      fs.writeFileSync(receipt, JSON.stringify(final));
      await test.info().attach("installation-controller-evidence", { path: receipt, contentType: "application/json" });
    }
    finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    }
  }
}

test("installation UI shows progress, cancels and retries, then refuses restart with open Settings", async () => {
  test.skip(process.platform !== "darwin", "macOS native update controller");
  const { home, repo, app, page } = await launchInstallation();
  try {
    const banner = tid(page, "update-banner");
    await expect(banner.getByRole("button", { name: "Download update", exact: true })).toBeVisible();
    await banner.getByRole("button", { name: "Download update", exact: true }).click();
    await expect(page.getByRole("progressbar", { name: "Update download" })).toHaveAttribute("value", "25");
    await expect(banner).toContainText("Downloading the update…");
    await expect(banner.getByRole("button", { name: "Dismiss update notification" })).toHaveCount(0);
    await banner.getByRole("button", { name: "Cancel download", exact: true }).click();
    await expect(banner).toContainText("Update preparation cancelled.");
    await banner.getByRole("button", { name: "Download update", exact: true }).click();
    await expect(banner).toContainText("Downloading the update…");
    await finishDownload(app);
    await expect(banner).toContainText("Verifying the publisher and update…");
    await finishVerification(app, true);
    await expect(banner.getByRole("button", { name: "Restart to update", exact: true })).toBeEnabled();
    await expect(banner).toContainText("Verified and ready.");
    await expect(banner.getByRole("button", { name: "Dismiss update notification" })).toHaveCount(0);
    await tid(page, "open-settings").click();
    await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
    // Settings may still have admitted a model/health request. Its ordinary-work
    // refusal is valid too; retry only until the Settings preflight itself owns it.
    await expect(async () => {
      const refused = await page.evaluate(() => window.modex!.invoke("updates:install", undefined));
      expect(refused.phase).toBe("ready");
      expect(refused.message).toMatch(/Save or close the open dialog/);
    }).toPass({ timeout: 10_000 });
    await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(banner).toContainText("Save or close the open dialog");
    await tid(page, "composer-input").fill("Editable after the restart refusal");
    await expect(tid(page, "composer-input")).toHaveValue("Editable after the restart refusal");
    expect(await counts(app)).toEqual({ downloads: 2, downloadedDisposed: 1, stagedDisposed: 0, nativeCalls: 0 });
    await banner.screenshot({ path: test.info().outputPath("update-ready-after-refusal.png") });
  } finally {
    await cleanup(app, home, repo);
  }
});

test("failed publisher verification offers retry and never exposes an install action", async () => {
  test.skip(process.platform !== "darwin", "macOS native update controller");
  const { home, repo, app, page } = await launchInstallation();
  try {
    const banner = tid(page, "update-banner");
    await expect(banner.getByRole("button", { name: "Download update", exact: true })).toBeVisible();
    await banner.getByRole("button", { name: "Download update", exact: true }).click();
    await expect(banner).toContainText("Downloading the update…");
    await finishDownload(app);
    await expect(banner).toContainText("Verifying the publisher and update…");
    await finishVerification(app, false);
    await expect(banner).toContainText("could not be downloaded or verified");
    await expect(banner.getByRole("button", { name: "Restart to update", exact: true })).toHaveCount(0);
    await expect(banner.getByRole("link", { name: "View update" })).toHaveAttribute("href", "https://github.com/TypeSafeAI/modex/releases/tag/v999.0.0");
    await expect.poll(() => counts(app)).toEqual({ downloads: 1, downloadedDisposed: 1, stagedDisposed: 1, nativeCalls: 0 });
    await banner.getByRole("button", { name: "Download update", exact: true }).click();
    await expect(banner).toContainText("Downloading the update…");
    await finishDownload(app);
    await expect(banner).toContainText("Verifying the publisher and update…");
    await finishVerification(app, true);
    await expect(banner.getByRole("button", { name: "Restart to update", exact: true })).toBeEnabled();
    expect((await counts(app)).nativeCalls).toBe(0);
  } finally {
    await cleanup(app, home, repo);
  }
});
