import { test, expect } from "@playwright/test";
import fs from "node:fs";
import { launch, seedHome, tid } from "./support";

test("a failed send restores its draft without replacing newer typing", async () => {
  const { home, repo } = seedHome();
  const { app, page } = await launch(home);
  try {
    await app.evaluate(({ ipcMain }) => {
      const pending: Array<() => void> = [];
      const controls = globalThis as typeof globalThis & { modexPendingSends?: () => number; modexReleaseSend?: () => void };
      controls.modexPendingSends = () => pending.length;
      controls.modexReleaseSend = () => pending.shift()?.();
      ipcMain.removeHandler("thread:send");
      ipcMain.handle("thread:send", () => new Promise((resolve) => pending.push(() => resolve({ ok: false, error: "Synthetic send failure" }))));
    });

    const input = tid(page, "composer-input");
    await input.fill("Keep this first draft");
    await input.press("Meta+Enter");
    await expect(tid(page, "thread-view")).toBeVisible();
    await expect.poll(() => app.evaluate(() => (globalThis as typeof globalThis & { modexPendingSends: () => number }).modexPendingSends())).toBe(1);
    await app.evaluate(() => (globalThis as typeof globalThis & { modexReleaseSend: () => void }).modexReleaseSend());
    await expect(page.getByRole("alert")).toContainText("Synthetic send failure");
    await expect(input).toHaveValue("Keep this first draft");

    await page.getByRole("alert").getByRole("button").click();
    await input.fill("Message being sent");
    await input.press("Meta+Enter");
    await expect.poll(() => app.evaluate(() => (globalThis as typeof globalThis & { modexPendingSends: () => number }).modexPendingSends())).toBe(1);
    await input.fill("Newer thought");
    await app.evaluate(() => (globalThis as typeof globalThis & { modexReleaseSend: () => void }).modexReleaseSend());
    await expect(page.getByRole("alert")).toContainText("Synthetic send failure");
    await expect(input).toHaveValue("Newer thought");

    await page.getByRole("alert").getByRole("button").click();
    await page.keyboard.press("Meta+n");
    await expect(tid(page, "draft-view")).toBeVisible();
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler("thread:create");
      ipcMain.handle("thread:create", () => { throw new Error("Synthetic create failure"); });
    });
    await input.fill("Draft before creation");
    await input.press("Meta+Enter");
    await expect(page.getByRole("alert")).toContainText("Synthetic create failure");
    await expect(input).toHaveValue("Draft before creation");
  } finally {
    await app.close();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
