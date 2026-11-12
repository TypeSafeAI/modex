import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { appDir, launch, seedHome, tid } from "./support";

test("automatic credit conservation defaults on, thresholds save, and disabling persists", async () => {
  const { home } = seedHome();
  const { app, page } = await launch(home);
  try {
    const open = async () => {
      await tid(page, "open-settings").click();
      await tid(page, "settings-nav").getByRole("button", { name: "Auto routing", exact: true }).click();
    };
    await open();
    const enabled = tid(page, "conserve-credits"), percent = tid(page, "low-quota-percent"), balance = tid(page, "low-credit-balance");
    await expect(enabled).toBeChecked();
    await expect(percent).toHaveValue("20");
    await expect(balance).toHaveValue("10");
    await percent.fill("25");
    await balance.fill("5");
    await page.getByText("Conservation chooses economical models", { exact: false }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(appDir, "test-results", "credit-conservation-settings.png") });
    await tid(page, "settings").getByRole("button", { name: "Save", exact: true }).click();
    await open();
    await expect(percent).toHaveValue("25");
    await expect(balance).toHaveValue("5");
    await enabled.uncheck();
    await tid(page, "settings").getByRole("button", { name: "Save", exact: true }).click();
    await open();
    await expect(enabled).not.toBeChecked();
    await expect(percent).toBeDisabled();
    await expect(balance).toBeDisabled();
    const saved = JSON.parse(fs.readFileSync(path.join(home, "app", "state.json"), "utf8")).settings.routing;
    expect([saved.conserve_credits, saved.low_quota_percent, saved.low_credit_balance]).toEqual([false, 25, 5]);
  } finally { await app.close(); }
});
