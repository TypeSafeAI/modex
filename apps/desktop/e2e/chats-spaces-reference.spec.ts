import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { appDir, seedHome, launch, tid, resizeWindow } from "./support.js";

test("reference chat rows stay still while their details open", async () => {
  const { home, repo } = seedHome({ theme: "graphite" });
  const file = path.join(home, "app/state.json");
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  state.projects[0].name = "coven-threads";
  const at = new Date().toISOString();
  state.threads = Array.from({ length: 7 }, (_, i) => ({ id: `reference-${i}`, projectId: "p1", title: ["Upgrade Ember with look directions", "Finish promotion integration", "Review incomplete tasks"][i] ?? `Chat ${i}`, createdAt: at, updatedAt: at, cwd: repo, backend: "mock", model: "mock", mode: "chat", plan: false, status: "idle" }));
  fs.writeFileSync(file, JSON.stringify(state));
  const { app, page } = await launch(home);
  try {
    const rows = tid(page, "thread-row");
    await expect(rows).toHaveCount(5);
    await tid(page, "composer-input").fill(Array(40).fill("A long draft for scrolling").join("\n"));
    const before = await rows.nth(1).boundingBox();
    // Native pointer movement can enter an Electron test window between actions.
    await expect(async () => {
      await rows.first().hover();
      await expect(page.getByRole("dialog", { name: "Chat details" })).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 15_000 });
    await tid(page, "composer-input").evaluate(async element => { element.scrollTop = 0; await new Promise(requestAnimationFrame); });
    await expect(page.getByRole("dialog", { name: "Chat details" })).toBeVisible();
    await page.screenshot({ path: path.join(appDir, ".probes/chats-spaces/chat-details.png") });
    await page.getByRole("dialog", { name: "Chat details" }).locator("summary").click();
    await expect(page.getByRole("dialog", { name: "Chat details" }).getByText("Mock · mock", { exact: true })).toBeVisible();
    expect((await rows.first().boundingBox())!.height).toBe(30);
    expect((await rows.nth(1).boundingBox())!.y).toBe(before!.y);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Chat details" })).toHaveCount(0);
    await rows.first().locator(".thread-main").focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("dialog", { name: "Chat details" }).locator("summary")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(rows.first().locator(".thread-main")).toBeFocused();
    await tid(page, "composer-input").fill("");
    await tid(page, "show-more").click();
    await expect(rows).toHaveCount(7);
    await page.screenshot({ path: path.join(appDir, ".probes/chats-spaces/chats.png") });
    await tid(page, "rail-space").click();
    await page.getByRole("button", { name: "Open chat", exact: true }).click();
    await tid(page, "composer-input").fill("Keep my thread draft");
    await page.keyboard.press("Meta+j");
    await expect(tid(page, "workspace")).toBeVisible();
    await expect(tid(page, "rail-chat")).toHaveAttribute("aria-current", "page");
    await tid(page, "rail-space").click();
    await expect(tid(page, "space-chat")).toBeVisible();
    await tid(page, "composer-input").focus();
    await page.keyboard.press("Control+Backquote");
    await expect(tid(page, "terminal-panel")).toBeVisible();
    await expect(tid(page, "composer-input")).toHaveValue("Keep my thread draft");
  } finally { await app.close(); fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(repo, { recursive: true, force: true }); }
});

test("Space toolbar, comments and floating chat preserve the open page", async () => {
  const { home, repo } = seedHome({ theme: "graphite" });
  const { app, page } = await launch(home);
  try {
    await resizeWindow(app, page, 1923, 1049);
    await tid(page, "rail-space").click();
    await page.getByLabel("Import Markdown file").setInputFiles({ name: "weekly.md", mimeType: "text/markdown", buffer: Buffer.from("# Weekly update\n\n## ✨ Highlights\n\n\u200b\n\n- Progress made\n\n## 🤞 Needs attention\n\n- Blockers and decisions needing input\n\n## ▶️ Next week\n\n- Upcoming milestones and confirmed commitments\n\n## 🔗 Sources\n\n- Links to sources") });
    await expect(page.getByRole("textbox", { name: "Page title" })).toHaveValue("Weekly update");
    await page.getByRole("button", { name: "Comments", exact: true }).click();
    await expect(page.getByRole("complementary", { name: "Comments" })).toBeVisible();
    await expect(page.getByText("No comments yet", { exact: true })).toBeVisible();
    fs.mkdirSync(path.join(appDir, ".probes/chats-spaces"), { recursive: true });
    fs.writeFileSync(path.join(appDir, ".probes/chats-spaces/geometry.json"), JSON.stringify(await page.locator(".space-title, .space-block, .space-block-preview, .space-block-preview h2, .space-block-preview ul").evaluateAll(elements => elements.map(element => { const r = element.getBoundingClientRect(); const s = getComputedStyle(element); return { tag: element.tagName, class: element.className, text: element.textContent, x: r.x, y: r.y, width: r.width, height: r.height, margin: s.margin, padding: s.padding }; })), null, 2));
    await page.mouse.move(1200, 700);
    await page.screenshot({ path: path.join(appDir, ".probes/chats-spaces/space-comments.png") });
    await page.getByRole("button", { name: "Add comment", exact: true }).click();
    await page.getByRole("textbox", { name: "Comment" }).fill("Confirm the milestones before Friday.");
    await page.getByRole("button", { name: "Close comments" }).click();
    await page.getByRole("button", { name: "Comments", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Comment" })).toHaveValue("Confirm the milestones before Friday.");
    await page.getByRole("button", { name: "Post comment", exact: true }).click();
    await expect(page.getByText("Confirm the milestones before Friday.", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Close comments" }).click();
    await page.getByRole("button", { name: "Insert", exact: true }).click();
    await expect(page.getByRole("menu", { name: "Insert into page" })).toBeVisible();
    await page.screenshot({ path: path.join(appDir, ".probes/chats-spaces/space-insert.png") });
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Open chat", exact: true }).click();
    await expect(tid(page, "space-chat")).toBeVisible();
    await tid(page, "composer-input").fill("Keep this draft beside my page");
    await page.screenshot({ path: path.join(appDir, ".probes/chats-spaces/space-chat.png") });
    await tid(page, "open-settings").click();
    await expect(page.getByRole("dialog", { name: "Settings", exact: true })).toBeVisible();
    expect(await tid(page, "space-chat").evaluate(element => {
      const rect = element.getBoundingClientRect();
      return Boolean(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.closest(".modal-backdrop"));
    })).toBe(true);
    await page.keyboard.press("Escape");
    await expect(tid(page, "composer-input")).toHaveValue("Keep this draft beside my page");
    await page.getByRole("button", { name: "Minimize chat" }).click();
    await expect(page.getByRole("textbox", { name: "Page title" })).toHaveValue("Weekly update");
    await page.getByRole("button", { name: "Open chat", exact: true }).click();
    await expect(tid(page, "composer-input")).toHaveValue("Keep this draft beside my page");
    await page.getByRole("button", { name: "Minimize chat" }).click();
    await page.reload();
    await tid(page, "rail-space").click();
    await page.getByRole("button", { name: "Open Weekly update", exact: true }).click();
    await page.getByRole("button", { name: "Comments", exact: true }).click();
    await expect(page.getByText("Confirm the milestones before Friday.", { exact: true })).toBeVisible();
    await resizeWindow(app, page, 900, 620);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: path.join(appDir, ".probes/chats-spaces/space-narrow.png") });
  } finally { await app.close(); fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(repo, { recursive: true, force: true }); }
});
