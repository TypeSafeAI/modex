import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { UpdateRecovery } from "../dist/src/main/engine/update-recovery.js";
import { currentRow, items, launch, seedHome, tid } from "./support";

let app: ElectronApplication;
let page: Page;
let home: string;
let repo: string;

test.beforeAll(async () => {
  ({ home, repo } = seedHome());
  ({ app, page } = await launch(home));
  console.log(JSON.stringify({ fixture: "approval-policy", home, repo, pid: app.process().pid }));
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
  const raw = "  Unrelated new chat 😀\nkeep exact whitespace  ";
  const attachmentName = "unrelated-draft.txt", attachmentBytes = "Retained next to a finished task.";
  let savedProjects: unknown;
  if (process.platform !== "win32") {
    await page.keyboard.press("Meta+n");
    await tid(page, "composer-input").fill(raw);
    await page.evaluate(({ name, bytes }) => {
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(new File([bytes], name, { type: "text/plain" }));
      window.dispatchEvent(new DragEvent("drop", { dataTransfer, bubbles: true, cancelable: true }));
    }, { name: attachmentName, bytes: attachmentBytes });
    await expect(tid(page, "attachment-chip")).toHaveCount(1);
  }
  await app.close();
  const file = path.join(home, "app/state.json");
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  state.threads[0].retired = { at: new Date().toISOString(), reason: "merged", pr: 12, url: "https://github.com/o/r/pull/12" };
  state.threads[0].title = "Finished example";
  fs.writeFileSync(file, JSON.stringify(state));
  if (process.platform !== "win32") {
    // Opening the unrelated new chat already saved the empty thread without
    // a draft owner. This case covers rendering; owner-removal.spec covers retirement.
    const recovery = new UpdateRecovery(path.join(home, "app"));
    const drafts = recovery.read().drafts!;
    const retiredId = state.threads[0].id;
    savedProjects = structuredClone(drafts.projects);
    expect(drafts.projects).toHaveLength(1);
    expect(drafts.projects[0]!.text).toBe(raw);
    expect(drafts.projects[0]!.attachments).toHaveLength(1);
    expect(drafts.threads.find(row => row.threadId === retiredId)).toBeUndefined();
    expect(drafts.selectedThreadId).toBeNull();
  }
  ({ app, page } = await launch(home));
  console.log(JSON.stringify({ fixture: "approval-policy", home, repo, pid: app.process().pid }));
  if (process.platform !== "win32") {
    await expect(tid(page, "composer-input")).toHaveValue(raw);
    await expect(tid(page, "attachment-chip")).toContainText(attachmentName);
    const restored = new UpdateRecovery(path.join(home, "app")).read().drafts!;
    expect(restored.projects).toEqual(savedProjects);
    expect(fs.readFileSync(path.join(home, "attachments", restored.projects[0]!.attachments[0]!.rel), "utf8")).toBe(attachmentBytes);
  }
  await page.getByRole("button", { name: "Search threads" }).click();
  await page.getByPlaceholder("Search threads").fill("Finished example");
  await expect(tid(page, "search-empty")).toHaveCount(0);
  await expect(tid(page, "thread-row")).toContainText("Finished example");
  await tid(page, "thread-row").click();
  await expect(tid(page, "composer-input")).toHaveCount(0);
  await expect(tid(page, "retired-notice")).toContainText("Pull request #12 merged");
  await expect(items(page, "assistant").last()).toContainText("Done");
});
