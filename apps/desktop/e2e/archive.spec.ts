import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { seedHome, launch, tid } from "./support.js";

test("archived threads leave the working list, survive relaunch, stay searchable and come back from the title bar or the notice", async () => {
  const { home, repo } = seedHome();
  const file = path.join(home, "app/state.json");
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  const at = new Date().toISOString();
  const base = { projectId: "p1", createdAt: at, updatedAt: at, cwd: repo, backend: "mock", model: "mock", mode: "chat", plan: false, status: "idle" };
  state.threads = [{ ...base, id: "keep0001", title: "Keep working" }, { ...base, id: "putaway1", title: "Put away" }];
  fs.writeFileSync(file, JSON.stringify(state));
  let { app, page } = await launch(home);
  try {
    // Functions, not locators: the page object changes at the relaunch below.
    const rows = () => tid(page, "thread-row");
    const row = (id: string) => page.locator(`[data-testid="thread-row"][data-thread-id="${id}"]`);
    await expect(rows()).toHaveCount(2);
    await expect(tid(page, "archived-toggle")).toHaveCount(0);

    // Archive from the row menu: the row leaves the working list and waits under a collapsed group.
    await row("putaway1").hover();
    await tid(row("putaway1"), "thread-menu").click();
    await tid(page, "thread-archive").click();
    const toggle = tid(page, "archived-toggle");
    await expect(toggle).toHaveText("Archived (1)");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(rows()).toHaveCount(1);
    await expect(rows().first()).toHaveAttribute("data-thread-id", "keep0001");

    // Search still finds it.
    await tid(page, "search-toggle").click();
    await tid(page, "thread-search").fill("Put away");
    await expect(tid(page, "search-empty")).toHaveCount(0);
    await expect(row("putaway1")).toHaveAttribute("data-archived", "true");
    await page.keyboard.press("Escape");

    // The choice is saved on the Mac.
    await app.close();
    expect(JSON.parse(fs.readFileSync(file, "utf8")).threads.find((t: { id: string }) => t.id === "putaway1").archived.at).toBeTruthy();
    ({ app, page } = await launch(home));
    await expect(tid(page, "archived-toggle")).toHaveText("Archived (1)");
    await expect(rows()).toHaveCount(1);

    // Reveal, open: the transcript explains the state, and the title bar brings it back.
    await tid(page, "archived-toggle").click();
    await expect(tid(page, "archived-toggle")).toHaveAttribute("aria-expanded", "true");
    await expect(row("putaway1")).toHaveAttribute("data-archived", "true");
    await expect(tid(row("putaway1"), "thread-row-archived")).toBeVisible();
    await row("putaway1").locator(".thread-main").click();
    await expect(tid(page, "archived-notice")).toContainText("This thread is archived");
    await expect(tid(page, "composer-input")).toBeVisible();
    await tid(page, "thread-menu-toggle").click();
    await expect(tid(page, "action-archive")).toHaveText("Unarchive thread");
    await tid(page, "action-archive").click();
    await expect(tid(page, "archived-notice")).toHaveCount(0);
    await expect(tid(page, "archived-toggle")).toHaveCount(0);
    await expect(rows()).toHaveCount(2);
    await expect(row("putaway1")).not.toHaveAttribute("data-archived", "true");

    // Archive the selected thread from the title bar: it stays visible because it is selected, and the notice restores it.
    await tid(page, "thread-menu-toggle").click();
    await expect(tid(page, "action-archive")).toHaveText("Archive thread");
    await tid(page, "action-archive").click();
    await expect(tid(page, "archived-toggle")).toHaveAttribute("aria-expanded", "true");
    await expect(row("putaway1")).toHaveAttribute("data-archived", "true");
    await expect(row("putaway1")).toHaveAttribute("aria-current", "true");
    await tid(page, "archived-restore").click();
    await expect(tid(page, "archived-notice")).toHaveCount(0);
    await expect(tid(page, "archived-toggle")).toHaveCount(0);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).threads.find((t: { id: string }) => t.id === "putaway1").archived).toBeUndefined();
  } finally {
    await app.close();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
