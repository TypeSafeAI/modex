import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
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
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

test("saving freezes the draft until persistence resolves and keeps it available after failure", async () => {
  await app.evaluate(({ ipcMain }) => {
    let rejectSave: ((error: Error) => void) | undefined;
    ipcMain.removeHandler("settings:update");
    ipcMain.handle("settings:update", () => new Promise((_resolve, reject) => { rejectSave = reject; }));
    (globalThis as any).__modexRejectSettingsSave = () => rejectSave?.(new Error("fake persistence failure"));
  });

  await tid(page, "open-settings").click();
  const dialog = tid(page, "settings");
  await dialog.getByRole("button", { name: "General" }).click();
  const mode = dialog.getByRole("combobox", { name: "Default mode for new threads" });
  await mode.selectOption("agent");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Saving…" })).toBeDisabled();
  await expect(dialog).toHaveAttribute("aria-busy", "true");
  await expect(tid(dialog, "settings-content")).toHaveAttribute("inert", "");
  await expect(dialog.getByRole("button", { name: "Auto routing" })).toBeDisabled();
  await page.keyboard.press("Tab");
  await expect(dialog).toBeFocused();

  await app.evaluate(() => (globalThis as any).__modexRejectSettingsSave());
  await expect(tid(page, "settings-save-error")).toContainText("fake persistence failure");
  await expect(tid(page, "settings-save-error")).not.toContainText("Error invoking remote method");
  expect((await tid(page, "settings-save-error").innerText()).match(/Your draft is still here; retry or cancel\./g)).toHaveLength(1);
  await expect(dialog).toHaveAttribute("aria-busy", "false");
  await expect(tid(dialog, "settings-content")).not.toHaveAttribute("inert", "");
  await expect(mode).toHaveValue("agent");
  await dialog.getByRole("button", { name: "Cancel" }).click();
});

test("a failed learning reset stays in the dialog and explains how to check the result", async () => {
  const initial = await page.evaluate(() => window.modex!.invoke("routing:status", undefined));
  await app.evaluate(({ ipcMain }, current) => {
    ipcMain.removeHandler("routing:status");
    ipcMain.handle("routing:status", async () => ({ ...current, fit: { ...current.fit, routes: 1 } }));
    ipcMain.removeHandler("routing:reset");
    ipcMain.handle("routing:reset", async () => { throw new Error("fake reset persistence failure"); });
  }, initial);

  await tid(page, "open-settings").click();
  const dialog = tid(page, "settings");
  page.once("dialog", async (confirmation) => { await confirmation.accept(); });
  await dialog.getByRole("button", { name: "Reset learning…" }).click();
  await expect(tid(page, "routing-reset-error")).toContainText("fake reset persistence failure");
  await expect(tid(page, "routing-reset-error")).toContainText("Reopen Settings to check the current learning state");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
});

test("a test locks settings while running and marks its result stale after a relevant draft change", async () => {
  const initial = await page.evaluate(() => window.modex!.invoke("routing:status", undefined));
  await app.evaluate(({ ipcMain }, current) => {
    const tested = { executable: null, model: current.model };
    const lastTest = { ok: true, message: "fake Jev answered", transport: "http", ms: 4, tested, at: Date.now() };
    ipcMain.removeHandler("routing:status");
    ipcMain.handle("routing:status", async () => ({ ...current, live: true, detail: undefined, transport: { kind: "http" }, secrets: { ...current.secrets, present: true }, lastTest, fit: { ...current.fit, routes: 1 } }));
    ipcMain.removeHandler("routing:test");
    ipcMain.handle("routing:test", () => new Promise((resolve) => {
      (globalThis as any).__modexResolveRoutingTest = () => resolve({ ok: true, message: "fake Jev answered", transport: "http", ms: 4, tested, current: true });
    }));
  }, initial);

  await tid(page, "open-settings").click();
  const dialog = tid(page, "settings");
  await tid(dialog, "jev-key").locator('input[type="password"]').fill("fake-ui-test-key");
  await dialog.getByRole("button", { name: "Test judge" }).click();
  await expect(dialog.getByText("Asking Jev…")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Save key now" })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Clear now" })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Reset learning…" })).toBeDisabled();
  const transport = dialog.getByRole("combobox", { name: "Judge transport" });
  await expect(dialog).toHaveAttribute("aria-busy", "true");
  await expect(tid(dialog, "settings-content")).toHaveAttribute("inert", "");
  await app.evaluate(() => (globalThis as any).__modexResolveRoutingTest());
  await expect(tid(page, "routing-test")).toContainText("fake Jev answered");
  await dialog.getByRole("button", { name: "Advanced / demo" }).click();
  const model = tid(dialog, "jev-model");
  await model.fill("jev-next-model");
  await dialog.getByRole("button", { name: "Auto routing" }).click();
  await expect(tid(page, "routing-verification")).toHaveText("Configured · untested");
  await expect(tid(page, "routing-test-stale")).toContainText("Settings changed while this test ran");
  await dialog.getByRole("button", { name: "Cancel" }).click();
});

test("a delayed opening status cannot overwrite a completed immediate key action", async () => {
  const before = await page.evaluate(() => window.modex!.invoke("routing:status", undefined));
  await app.evaluate(({ ipcMain }, initial) => {
    let releaseOldStatus: (() => void) | undefined;
    ipcMain.removeHandler("routing:status");
    ipcMain.handle("routing:status", () => new Promise((resolve) => {
      releaseOldStatus = () => resolve(initial);
    }));
    ipcMain.removeHandler("routing:setKey");
    ipcMain.handle("routing:setKey", async () => ({
      ...initial, live: true, keyLast4: "7890", keySource: "modex",
      transport: { kind: "http" }, secrets: { ...initial.secrets, available: true, present: true },
    }));
    (globalThis as any).__modexReleaseOldRoutingStatus = () => releaseOldStatus?.();
  }, before);

  await tid(page, "open-settings").click();
  const dialog = tid(page, "settings");
  await tid(dialog, "jev-key").locator('input[type="password"]').fill("fake-offline-key-7890");
  await dialog.getByRole("button", { name: "Save key now" }).click();
  await expect(tid(dialog, "routing-status")).toContainText("key ****7890");
  await app.evaluate(() => (globalThis as any).__modexReleaseOldRoutingStatus());
  await expect(tid(dialog, "routing-status")).toContainText("key ****7890");
  await expect(tid(dialog, "jev-key")).toContainText("saved in");
  await dialog.getByRole("button", { name: "Cancel" }).click();
});

test("test stays pending through status refresh and cannot be dismissed mid-operation", async () => {
  const before = await page.evaluate(() => window.modex!.invoke("routing:status", undefined));
  await app.evaluate(({ ipcMain }, initial) => {
    let statusCalls = 0;
    let releaseRefresh: (() => void) | undefined;
    ipcMain.removeHandler("routing:status");
    ipcMain.handle("routing:status", () => {
      if (++statusCalls === 1) return initial;
      return new Promise((resolve) => { releaseRefresh = () => resolve(initial); });
    });
    ipcMain.removeHandler("routing:test");
    ipcMain.handle("routing:test", async () => ({ ok: true, message: "fake judge response", transport: "none", ms: 1 }));
    (globalThis as any).__modexReleaseRoutingRefresh = () => releaseRefresh?.();
  }, before);

  await tid(page, "open-settings").click();
  const dialog = tid(page, "settings");
  await dialog.getByRole("button", { name: "Test judge" }).click();
  await expect(dialog.getByText("Asking Jev…")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await page.locator(".modal-backdrop").click({ position: { x: 2, y: 2 } });
  await expect(dialog).toBeVisible();
  await app.evaluate(() => (globalThis as any).__modexReleaseRoutingRefresh());
  await expect(tid(dialog, "routing-test")).toContainText("fake judge response");
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeEnabled();
  await dialog.getByRole("button", { name: "Cancel" }).click();
});

test("a saved setting remains visible on reopen when the full-state refresh fails", async () => {
  await tid(page, "open-settings").click();
  const dialog = tid(page, "settings");
  await dialog.getByRole("button", { name: "General" }).click();
  const mode = dialog.getByRole("combobox", { name: "Default mode for new threads" });
  await expect(mode).toHaveValue("chat");
  await mode.selectOption("agent");
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler("state:get");
    ipcMain.handle("state:get", async () => { throw new Error("fake refresh failure after save"); });
  });
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("alert")).toContainText("Settings were saved, but Modex could not refresh its view");

  await tid(page, "open-settings").click();
  const reopened = tid(page, "settings");
  await reopened.getByRole("button", { name: "General" }).click();
  await expect(reopened.getByRole("combobox", { name: "Default mode for new threads" })).toHaveValue("agent");
  await reopened.getByRole("button", { name: "Cancel" }).click();
});

test("unsaved Auto and CLI drafts never claim a transport was checked", async () => {
  const initial = await page.evaluate(() => window.modex!.invoke("routing:status", undefined));
  await app.evaluate(({ ipcMain }, current) => {
    ipcMain.removeHandler("routing:status");
    ipcMain.handle("routing:status", async () => ({ ...current, live: true, detail: undefined, transport: { kind: "http" } }));
  }, initial);
  await tid(page, "open-settings").click();
  const dialog = tid(page, "settings");
  const hint = dialog.locator(".field").filter({ hasText: "jev executable" }).locator("small");
  for (const transport of ["auto", "cli"]) {
    await dialog.getByRole("combobox", { name: "Judge transport" }).selectOption(transport);
    await expect(hint).toHaveText("Draft transport or executable has not been checked. Save or revert before testing.");
    await expect(dialog.getByRole("button", { name: "Test judge" })).toBeDisabled();
  }
  await dialog.getByRole("combobox", { name: "Judge transport" }).selectOption("http");
  await expect(hint).toHaveText("The jev CLI is not used or checked in HTTP-only mode.");
  await dialog.getByRole("button", { name: "Cancel" }).click();
});

test("an IPC test rejection explains the failure without claiming settings changed", async () => {
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler("routing:test");
    ipcMain.handle("routing:test", async () => { throw new Error("fake judge IPC failure"); });
  });
  await tid(page, "open-settings").click();
  const dialog = tid(page, "settings");
  await dialog.getByRole("button", { name: "Test judge" }).click();
  await expect(tid(dialog, "routing-test")).toContainText("fake judge IPC failure");
  await expect(tid(dialog, "routing-test")).not.toContainText("Error invoking remote method");
  await expect(tid(dialog, "routing-test-stale")).toHaveCount(0);
  await expect(tid(dialog, "routing-status")).toContainText("Judge status unavailable");
  await expect(dialog.getByRole("button", { name: "Test judge" })).toBeEnabled();
  await dialog.getByRole("button", { name: "Cancel" }).click();
});

test("testing before opening status resolves handles a failed refresh and permits a fresh retry", async () => {
  const initial = await page.evaluate(() => window.modex!.invoke("routing:status", undefined));
  await app.evaluate(({ ipcMain }, current) => {
    let calls = 0;
    let releaseOpening: (() => void) | undefined;
    ipcMain.removeHandler("routing:status");
    ipcMain.handle("routing:status", () => {
      if (++calls === 1) return new Promise((resolve) => { releaseOpening = () => resolve(current); });
      if (calls === 2) throw new Error("fake status refresh failure");
      return { ...current, live: true, detail: undefined, transport: { kind: "http" } };
    });
    ipcMain.removeHandler("routing:test");
    ipcMain.handle("routing:test", async () => ({ ok: true, message: "fake explicit response", transport: "http", ms: 1, tested: { executable: null, model: current.model }, current: true }));
    (globalThis as any).__modexReleaseOpeningStatus = () => releaseOpening?.();
  }, initial);

  await tid(page, "open-settings").click();
  const dialog = tid(page, "settings");
  await expect(tid(dialog, "routing-status")).toContainText("Checking the judge");
  await dialog.getByRole("button", { name: "Test judge" }).click();
  await expect(tid(dialog, "routing-test")).toContainText("fake explicit response");
  await expect(tid(dialog, "routing-status")).toContainText("fake status refresh failure");
  await expect(tid(dialog, "routing-test-stale")).toHaveCount(0);
  await app.evaluate(() => (globalThis as any).__modexReleaseOpeningStatus());
  await expect(tid(dialog, "routing-status")).toContainText("Judge status unavailable");
  await dialog.getByRole("button", { name: "Test judge" }).click();
  await expect(tid(dialog, "routing-status")).toContainText("Jev transport configured");
  await expect(tid(dialog, "routing-status")).not.toContainText("Judge status unavailable");
  await expect(tid(dialog, "routing-test-stale")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Cancel" }).click();
});

test("failed immediate key and reset actions show unavailable status and permit recovery", async () => {
  for (const action of ["key", "reset"] as const) {
    const initial = await page.evaluate(() => window.modex!.invoke("routing:status", undefined));
    await app.evaluate(({ ipcMain }, { current, action }) => {
      let releaseOpening: (() => void) | undefined;
      ipcMain.removeHandler("routing:status");
      ipcMain.handle("routing:status", () => new Promise((resolve) => { releaseOpening = () => resolve(current); }));
      ipcMain.removeHandler("routing:setKey");
      ipcMain.handle("routing:setKey", async () => { throw new Error("fake key action failure"); });
      ipcMain.removeHandler("routing:reset");
      ipcMain.handle("routing:reset", async () => { throw new Error("fake reset action failure"); });
      // Reset is only available after opening status loads; key save can run before it.
      if (action === "reset") {
        ipcMain.removeHandler("routing:status");
        ipcMain.handle("routing:status", async () => ({ ...current, fit: { ...current.fit, routes: 1 } }));
      }
      (globalThis as any).__modexReleaseOpeningStatus = () => releaseOpening?.();
      (globalThis as any).__modexRestoreRoutingStatus = () => {
        ipcMain.removeHandler("routing:status");
        ipcMain.handle("routing:status", async () => current);
      };
    }, { current: initial, action });
    await tid(page, "open-settings").click();
    const dialog = tid(page, "settings");
    if (action === "key") {
      await tid(dialog, "jev-key").locator('input[type="password"]').fill("fake-test-key");
      await dialog.getByRole("button", { name: "Save key now" }).click();
    } else {
      page.once("dialog", async (confirmation) => confirmation.accept());
      await dialog.getByRole("button", { name: "Reset learning…" }).click();
    }
    await expect(tid(dialog, "routing-status")).toContainText(`fake ${action} action failure`);
    await app.evaluate(() => (globalThis as any).__modexReleaseOpeningStatus());
    await expect(tid(dialog, "routing-status")).toContainText("Judge status unavailable");
    await app.evaluate(() => (globalThis as any).__modexRestoreRoutingStatus());
    await dialog.getByRole("button", { name: "Test judge" }).click();
    await expect(tid(dialog, "routing-status")).not.toContainText("Judge status unavailable");
    await dialog.getByRole("button", { name: "Cancel" }).click();
  }
});

test("an empty save failure message keeps one plain retry instruction", async () => {
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler("settings:update");
    ipcMain.handle("settings:update", async () => { throw new Error(""); });
  });
  await tid(page, "open-settings").click();
  const dialog = tid(page, "settings");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(tid(dialog, "settings-save-error")).toHaveText("Could not save settings. Your draft is still here; retry or cancel.");
  await dialog.getByRole("button", { name: "Cancel" }).click();
});
