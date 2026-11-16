import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import { answerConfirm, launch, seedHome, tid } from "./support";

/**
 * Confirmations are answered in the app (components/ConfirmDialog.tsx), never in the browser's own
 * confirm box: Cancel has focus when one opens, Escape cancels, focus stays inside it, and nothing
 * behind it reacts to the keyboard.
 */
let app: ElectronApplication;
let page: Page;
let home: string;
let repo: string;
let nativeDialogs = 0;

test.beforeAll(async () => {
  ({ home, repo } = seedHome());
  ({ app, page } = await launch(home));
  page.on("dialog", (dialog) => { nativeDialogs++; void dialog.dismiss(); });
});

test.afterAll(async () => {
  await app?.close();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

async function askToRemoveProject() {
  const project = tid(page, "project").first();
  await project.hover();
  await tid(project, "project-menu").click();
  await tid(project, "project-remove").click();
  const dialog = tid(page, "confirm-dialog");
  await expect(dialog).toBeVisible();
  return dialog;
}

test("removing a project asks in the app, Cancel has focus, and cancelling changes nothing", async () => {
  const dialog = await askToRemoveProject();
  await expect(dialog).toHaveAttribute("role", "alertdialog");
  await expect(dialog).toHaveAttribute("aria-modal", "true");
  await expect(dialog).toHaveAttribute("data-tone", "warn");
  await expect(tid(dialog, "confirm-title")).toHaveText("Remove this project from Modex?");
  await expect(tid(dialog, "confirm-fact").first()).toHaveText("Files on disk are not touched.");
  await expect(tid(dialog, "confirm-fact").first()).toHaveAttribute("data-kind", "kept");
  await expect(tid(dialog, "confirm-accept")).toHaveText("Remove project");
  // Enter must never accept by default: the safe button holds focus, and Tab stays inside the dialog.
  await expect(tid(dialog, "confirm-cancel")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(tid(dialog, "confirm-accept")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(tid(dialog, "confirm-cancel")).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(tid(dialog, "confirm-accept")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(tid(page, "project")).toHaveCount(1);
  expect(nativeDialogs).toBe(0);
});

test("shortcuts do nothing behind an open confirm", async () => {
  const dialog = await askToRemoveProject();
  await page.keyboard.press("Meta+Shift+p");
  await expect(tid(page, "plan-chip")).toHaveCount(0);
  await tid(dialog, "confirm-cancel").click();
  await expect(dialog).toHaveCount(0);
  // The same shortcut works once the dialog is gone, so the assertion above is not vacuous.
  await page.keyboard.press("Meta+Shift+p");
  await expect(tid(page, "plan-chip")).toBeVisible();
  await page.keyboard.press("Meta+Shift+p");
  await expect(tid(page, "plan-chip")).toHaveCount(0);
});

test("a confirm over Settings: Escape cancels the confirm and Settings stays open", async () => {
  const current = await page.evaluate(() => window.modex!.invoke("routing:status", undefined));
  await app.evaluate(({ ipcMain }, status) => {
    ipcMain.removeHandler("routing:status");
    ipcMain.handle("routing:status", async () => ({ ...status, fit: { ...status.fit, routes: 1 } }));
  }, current);
  await tid(page, "open-settings").click();
  const settings = tid(page, "settings");
  await settings.getByRole("button", { name: "Reset learning…" }).click();
  const dialog = tid(page, "confirm-dialog");
  await expect(tid(dialog, "confirm-title")).toHaveText("Reset Auto routing's learned preferences?");
  await expect(dialog).toHaveAttribute("data-tone", "danger");
  await expect(tid(dialog, "confirm-cancel")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(tid(dialog, "confirm-accept")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(settings).toBeVisible();
  await expect(settings.getByRole("button", { name: "Reset learning…" })).toBeVisible();
  await settings.getByRole("button", { name: "Cancel" }).click();
  await expect(settings).toHaveCount(0);
});

test("the backdrop cancels, and accepting runs the action once", async () => {
  const dialog = await askToRemoveProject();
  await tid(page, "confirm-backdrop").click({ position: { x: 8, y: 8 } });
  await expect(dialog).toHaveCount(0);
  await expect(tid(page, "project")).toHaveCount(1);
  await askToRemoveProject();
  await answerConfirm(page, "accept", "Remove this project from Modex?");
  await expect(tid(page, "project")).toHaveCount(0);
  expect(nativeDialogs).toBe(0);
});
