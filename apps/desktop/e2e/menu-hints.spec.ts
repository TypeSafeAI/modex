import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import { launch, seedHome, tid } from "./support";

/**
 * The composer's menus keep each row to one line. The sentence that used to sit under a row's title is
 * the row's accessible description, and shows once, at the foot of the menu, for the row under the
 * pointer or the keyboard focus. A menu that passes no hints keeps its rows and has no foot.
 */
let app: ElectronApplication;
let page: Page;
let home: string;
let repo: string;

const ATTACH = "Add files or images to your next message.";
const PLAN = "Investigate read-only and return a plan instead of editing.";
const AUTO = "A fast judge picks the model, effort and speed for each turn, within your limits.";

test.beforeAll(async () => {
  ({ home, repo } = seedHome());
  ({ app, page } = await launch(home));
  // A draft has a composer and no thread: the seeded mode is Chat and the backend is the mock.
  await page.keyboard.press("Meta+n");
  await expect(tid(page, "draft-view")).toBeVisible();
});

test.afterAll(async () => {
  await app?.close();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

test("the access menu keeps each choice to one line and describes the focused or hovered one at its foot", async () => {
  await tid(page, "access-picker").click();
  const menu = tid(page, "access-menu");
  const option = (mode: string) => menu.locator(`[data-testid="access-option"][data-mode="${mode}"]`);
  const foot = tid(menu, "menu-hint");
  // Opened without touching a row: the checked choice has focus, and the foot already describes it.
  await expect(option("chat")).toBeFocused();
  await expect(foot).toHaveText("Read-only. Asks before any command or edit.");
  // The foot is the visible copy; assistive technology reads the description from the row itself.
  await expect(foot).toHaveAttribute("aria-hidden", "true");
  await expect(option("chat")).toHaveText("Read only");
  await expect(option("chat")).toHaveAttribute("aria-description", "Read-only. Asks before any command or edit.");
  await expect(option("full-access")).toHaveText("Full access");
  await expect(option("full-access")).toHaveAttribute("aria-description", "No sandbox, no prompts. Only in a trusted environment.");
  expect(Math.round((await option("agent").boundingBox())!.height)).toBe(32);
  await page.keyboard.press("ArrowDown");
  await expect(option("agent")).toBeFocused();
  await expect(foot).toHaveText("Edits and runs commands inside the project; asks to go outside it.");
  await option("full-access").hover();
  await expect(foot).toHaveText("No sandbox, no prompts. Only in a trusted environment.");
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(tid(page, "access-picker")).toBeFocused();
  // Nothing was chosen.
  await expect(tid(page, "access-picker")).toHaveAttribute("data-mode", "chat");
});

test("the + menu shows Plan and Auto as switches and describes each row", async () => {
  await tid(page, "composer-plus").click();
  const menu = tid(page, "composer-plus-menu");
  const foot = tid(menu, "menu-hint");
  await expect(page.getByRole("menuitem", { name: "Attach files", exact: true })).toBeFocused();
  await expect(foot).toHaveText(ATTACH);
  await page.keyboard.press("ArrowDown");
  const plan = tid(menu, "plan-toggle");
  await expect(plan).toBeFocused();
  await expect(foot).toHaveText(PLAN);
  await expect(plan).toHaveRole("menuitemcheckbox");
  await expect(plan).toHaveAttribute("aria-checked", "false");
  await expect(plan).toHaveAttribute("aria-description", PLAN);
  // The row is its title and key hint; the sentence is no longer part of the row's text.
  await expect(plan).not.toContainText("Investigate");
  expect(Math.round((await plan.boundingBox())!.height)).toBe(32);
  await tid(menu, "auto-toggle").hover();
  await expect(foot).toHaveText(AUTO);
  const backend = tid(menu, "backend-picker").getByRole("menuitemradio", { checked: true });
  await expect(backend).toHaveText("Mock");
  // A disabled row may not report the pointer; its description is still on the row.
  await expect(backend).toHaveAttribute("aria-description", "Offline scripted engine (demo)");
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(tid(page, "plan-chip")).toHaveCount(0);
});

test("a menu without hints has no foot", async () => {
  await tid(page, "model-picker").click();
  const menu = tid(page, "model-menu");
  await expect(menu).toBeVisible();
  await expect(tid(menu, "menu-hint")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
});
