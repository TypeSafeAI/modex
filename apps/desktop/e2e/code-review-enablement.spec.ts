import { test, expect } from "@playwright/test";
import fs from "node:fs";
import { tid } from "./support.js";
import { baseWorld, launchWithGh, prRow, type Harness } from "./code-review-support.js";

/**
 * The Code Review setting (#319, #327): hidden by default in a built app until its gates pass, shown from Settings →
 * General or by the old switch's "on". Turning it off hides the surface; it does not touch main's records.
 */
let h: Harness;
test.afterEach(async () => { await h?.close(); });

async function general() {
  await tid(h.page, "open-settings").click();
  await tid(h.page, "settings-nav").getByRole("button", { name: "General" }).click();
  return tid(h.page, "code-review-in-rail");
}

test("Code Review is hidden by default: the rail leaves it out, makes no gh read, and Settings can show it", async () => {
  h = await launchWithGh(baseWorld(), { showCodeReview: false });
  const { page } = h;
  await expect(tid(page, "open-settings")).toBeVisible();
  await expect(tid(page, "rail-code-review")).toHaveCount(0);
  const box = await general();
  await expect(box).not.toBeChecked();
  expect(h.calls().filter((call) => call.includes("search"))).toEqual([]);
  await box.check();
  await page.keyboard.press("Escape");
  await tid(page, "rail-code-review").click();
  await expect(prRow(page, "example-org/lending#73")).toBeVisible();
  await page.reload();
  await expect(tid(page, "rail-code-review")).toBeVisible();
});

test("turning it off is the rollback: the surface leaves at once, survives a relaunch, keeps a draft, and can come back", async () => {
  h = await launchWithGh(baseWorld());
  let { page } = h;
  await tid(page, "rail-code-review").click();
  await prRow(page, "example-org/lending#73").click();
  const region = () => h.page.getByRole("region", { name: "Comment on this pull request" });
  await region().getByRole("button", { name: "Comment", exact: true }).click();
  await region().getByRole("textbox", { name: "Comment text" }).fill("Keep me through the rollback.");
  await expect.poll(() => { try { return fs.readFileSync(`${h.home}/review-actions/state.json`, "utf8").includes("Keep me through the rollback."); } catch { return false; } }).toBe(true);

  const box = await general();
  await box.uncheck();
  await page.keyboard.press("Escape");
  await expect(tid(page, "rail-code-review")).toHaveCount(0);
  await expect(tid(page, "code-review")).not.toBeVisible();

  await h.restart();
  page = h.page;
  await expect(tid(page, "open-settings")).toBeVisible();
  await expect(tid(page, "rail-code-review")).toHaveCount(0);
  const calls = h.calls().length;
  expect(fs.readFileSync(`${h.home}/review-actions/state.json`, "utf8")).toContain("Keep me through the rollback.");

  const again = await general();
  await expect(again).not.toBeChecked();
  await again.check();
  await page.keyboard.press("Escape");
  await tid(page, "rail-code-review").click();
  await prRow(page, "example-org/lending#73").click();
  await expect(region().getByRole("textbox", { name: "Comment text" })).toHaveValue("Keep me through the rollback.");
  expect(h.calls().length).toBeGreaterThan(calls);
  expect(h.posts()).toEqual([]);
});

test("an explicit off on the old switch stays off, an old on stays on, and a later choice wins", async () => {
  h = await launchWithGh(baseWorld());
  let { page } = h;
  await page.evaluate(() => { localStorage.setItem("modex.codeReview", "off"); localStorage.removeItem("modex.layout"); });
  await page.reload();
  await expect(tid(page, "open-settings")).toBeVisible();
  await expect(tid(page, "rail-code-review")).toHaveCount(0);
  const box = await general();
  await expect(box).not.toBeChecked();
  await box.check();
  await page.keyboard.press("Escape");
  await expect(tid(page, "rail-code-review")).toBeVisible();
  await page.reload();
  await expect(tid(page, "rail-code-review")).toBeVisible();

  await page.evaluate(() => { localStorage.setItem("modex.codeReview", "on"); localStorage.removeItem("modex.layout"); });
  await page.reload();
  await expect(tid(page, "rail-code-review")).toBeVisible();
});
