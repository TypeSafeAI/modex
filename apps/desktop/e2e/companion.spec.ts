import { test, expect } from "@playwright/test";
import fs from "node:fs";
import { seedHome, launch, tid } from "./support.js";

test("the Mac pairs an iPhone with a QR code and can revoke access", async () => {
  const { home, repo } = seedHome();
  const { app, page } = await launch(home);
  try {
    await tid(page, "open-companion").click();
    await expect(tid(page, "companion-dialog")).toBeVisible();
    await tid(page, "companion-start").click();
    await expect(tid(page, "companion-qr")).toBeVisible();
    const first = await page.evaluate(() => window.modex.invoke("companion:status", undefined));
    expect(first.enabled).toBe(true);
    expect(first.pairingUri).toMatch(/^modex:\/\/pair\?data=/);
    await page.getByRole("button", { name: "Forget paired phones" }).click();
    const rotated = await page.evaluate(() => window.modex.invoke("companion:status", undefined));
    expect(rotated.pairingUri).not.toBe(first.pairingUri);
    await page.getByRole("button", { name: "Turn off" }).click();
    await expect(tid(page, "companion-qr")).toHaveCount(0);
    expect((await page.evaluate(() => window.modex.invoke("companion:status", undefined))).enabled).toBe(false);
  } finally {
    await app.close();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
