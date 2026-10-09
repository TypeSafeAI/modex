import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { currentRow, items, launch, seedHome, tid } from "./support";

let app: ElectronApplication;
let page: Page;
let home: string;
let repo: string;

test.beforeAll(async () => {
  ({ home, repo } = seedHome());
  ({ app, page } = await launch(home));
});
test.afterAll(async () => {
  await app?.close();
  for (const dir of [home, repo]) if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

test("Always allow in thread answers the waiting card, shows a chip that turns it off, and YOLO is selectable from the access menu", async () => {
  await page.keyboard.press("Meta+n");
  await tid(page, "composer-input").fill("Add a contributing guide");
  await page.keyboard.press("Meta+Enter");
  const card = items(page, "approval").first();
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(currentRow(page)).toHaveAttribute("data-status", "waiting");
  await tid(card, "approval-always-thread").click();
  await expect(tid(card, "approval-answer")).toHaveText("Approved");
  const chip = tid(page, "approvals-chip");
  await expect(chip).toHaveAttribute("data-policy", "always");
  await expect(items(page, "assistant").last()).toContainText("Done", { timeout: 15_000 });

  // The chip turns the policy back off, and the menu shows the same state.
  await chip.click();
  await expect(chip).toHaveCount(0);
  await tid(page, "access-picker").click();
  await expect(tid(page, "approvals-option").first()).toHaveAttribute("data-policy", "ask");
  await expect(tid(page, "approvals-option").first()).toHaveAttribute("aria-checked", "true");
  await page.evaluate(() => { window.confirm = () => false; });
  await page.locator('[data-testid="approvals-option"][data-policy="yolo"]').click();
  await expect(chip).toHaveCount(0);
  await tid(page, "access-picker").click();
  await page.evaluate(() => { window.confirm = () => true; });
  await page.locator('[data-testid="approvals-option"][data-policy="yolo"]').click();
  await expect(chip).toHaveAttribute("data-policy", "yolo");
  const stored = await page.evaluate(() => window.modex!.invoke("state:get", undefined));
  expect(stored.threads[0]!.approvals).toBe("yolo");
});

test("finished tasks are searchable read-only transcripts", async () => {
  await app.close();
  const file = path.join(home, "app/state.json");
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  state.threads[0].retired = { at: new Date().toISOString(), reason: "merged", pr: 12, url: "https://github.com/o/r/pull/12" };
  state.threads[0].title = "Finished example";
  fs.writeFileSync(file, JSON.stringify(state));
  ({ app, page } = await launch(home));
  await expect(tid(page, "composer-input")).toHaveCount(0);
  await expect(tid(page, "retired-notice")).toContainText("Pull request #12 merged");
  await page.getByRole("button", { name: "Search threads" }).click();
  await page.getByPlaceholder("Search threads").fill("Finished example");
  await expect(tid(page, "search-empty")).toHaveCount(0);
  await expect(tid(page, "thread-row")).toContainText("Finished example");
});
