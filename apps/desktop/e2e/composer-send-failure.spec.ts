import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { launch, seedHome, tid } from "./support";

test("a failed send restores its draft without replacing newer typing", async () => {
  const { home, repo } = seedHome();
  const { app, page } = await launch(home);
  console.log(JSON.stringify({ fixtureHome: home, fixtureRepo: repo, electronPid: app.process().pid }));
  try {
    if (process.platform !== "win32") {
      const readPending = () => fs.readdirSync(path.join(home, "app/pending-sends")).map(file => JSON.parse(fs.readFileSync(path.join(home, "app/pending-sends", file), "utf8")));
      await app.evaluate(({ ipcMain }) => {
        const ipc = ipcMain as typeof ipcMain & { _invokeHandlers: Map<string, (...args: any[]) => any> };
        const original = ipc._invokeHandlers.get("drafts:send")!;
        const waits: Array<() => void> = [], ids: string[] = [];
        Object.assign(globalThis, { nativeSendWaits: () => waits.length, nativeSendIds: ids, releaseNativeSend: () => waits.shift()?.(),
          restoreNativeSend: () => { ipcMain.removeHandler("drafts:send"); ipcMain.handle("drafts:send", original); } });
        ipcMain.removeHandler("drafts:send");
        ipcMain.handle("drafts:send", (_event, request) => { ids.push(request.intentId); return new Promise(resolve => waits.push(() => resolve({ ok: false, error: "Synthetic send failure" }))); });
      });
      const input = tid(page, "composer-input"), raw = "  Keep this first draft 😀\n";
      await input.fill(raw); await input.press("Meta+Enter");
      await expect(tid(page, "thread-view")).toBeVisible();
      const id = (await tid(page, "thread-view").getAttribute("data-thread-id"))!;
      await expect.poll(() => app.evaluate(() => (globalThis as any).nativeSendWaits())).toBe(1);
      await app.evaluate(() => (globalThis as any).releaseNativeSend());
      await expect(tid(page, "toast")).toContainText("Synthetic send failure");
      await expect(input).toHaveValue(""); await expect(tid(page, "pending-message")).toContainText(raw.trim());
      const original = readPending()[0]; expect(original.rawText).toBe(raw);
      await input.fill("Newer thought"); await tid(page, "pending-message-retry").click();
      await expect.poll(() => app.evaluate(() => (globalThis as any).nativeSendWaits())).toBe(1);
      await app.evaluate(() => (globalThis as any).releaseNativeSend());
      await expect(tid(page, "pending-message-retry")).toBeEnabled(); await expect(input).toHaveValue("Newer thought");
      expect(readPending()[0].id).toBe(original.id);
      expect(await app.evaluate(() => (globalThis as any).nativeSendIds)).toEqual([original.id, original.id]);
      await app.evaluate(() => (globalThis as any).restoreNativeSend());
      await tid(page, "pending-message-retry").click(); await expect(tid(page, "pending-message")).toHaveCount(0);
      const users = JSON.parse(fs.readFileSync(path.join(home, "app/threads", `${id}.json`), "utf8")).filter((row: any) => row.kind === "user");
      expect(users).toMatchObject([{ id: original.id, text: raw }]); expect(users).toHaveLength(1);
      await expect(input).toHaveValue("Newer thought"); await page.evaluate(id => window.modex!.invoke("thread:stop", { threadId: id }), id);
      await page.keyboard.press("Meta+n"); await expect(tid(page, "draft-view")).toBeVisible();
      await app.evaluate(({ ipcMain }) => { ipcMain.removeHandler("drafts:create"); ipcMain.handle("drafts:create", () => { throw new Error("Synthetic create failure"); }); });
      await input.fill("Draft before creation"); await input.press("Meta+Enter");
      await expect(tid(page, "toast")).toContainText("Synthetic create failure");
      await expect(input).toHaveValue(""); await expect(tid(page, "pending-message")).toContainText("Draft before creation");
      expect(readPending()[0].rawText).toBe("Draft before creation");
      await input.fill("Independent creation draft"); await expect(input).toHaveValue("Independent creation draft");
      return;
    }
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

    await page.getByRole("alert").getByRole("button", { name: "Dismiss" }).click();
    await input.fill("Message being sent");
    await input.press("Meta+Enter");
    await expect.poll(() => app.evaluate(() => (globalThis as typeof globalThis & { modexPendingSends: () => number }).modexPendingSends())).toBe(1);
    await input.fill("Newer thought");
    await app.evaluate(() => (globalThis as typeof globalThis & { modexReleaseSend: () => void }).modexReleaseSend());
    await expect(page.getByRole("alert")).toContainText("Synthetic send failure");
    await expect(input).toHaveValue("Newer thought");

    await page.getByRole("alert").getByRole("button", { name: "Dismiss" }).click();
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
