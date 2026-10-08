import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { appDir, launch, seedHome, tid } from "./support";

test("importing a page heading preserves indented code and lists through relaunch", async () => {
  const { home } = seedHome();
  let { app, page } = await launch(home);
  const markdown = "    const value = 1;\r\n    console.log(value);\r\n\r\n  - first\r\n    - nested\r\n";
  try {
    await tid(page, "rail-space").click();
    await page.getByLabel("Import Markdown file").setInputFiles({ name: "indented.md", mimeType: "text/markdown", buffer: Buffer.from(`# Indented content\r\n\r\n${markdown}`) });
    await expect(page.getByRole("textbox", { name: "Page title" })).toHaveValue("Indented content");
    const saved = () => page.evaluate(() => window.modex.invoke("space:list", undefined).then(pages => pages.find(p => p.title === "Indented content")?.markdown));
    await expect.poll(saved).toBe(markdown);
    await app.close();
    ({ app, page } = await launch(home));
    await expect.poll(saved).toBe(markdown);
  } finally { await app.close(); }
});

test("adding a block to imported Markdown keeps separate blocks after relaunch", async () => {
  const { home } = seedHome();
  let { app, page } = await launch(home);
  try {
    await tid(page, "rail-space").click();
    await page.getByLabel("Import Markdown file").setInputFiles({ name: "boundary.md", mimeType: "text/markdown", buffer: Buffer.from("First\n") });
    await page.getByRole("button", { name: "Add a block", exact: true }).click();
    await page.getByRole("textbox", { name: "Block 2", exact: true }).fill("Second");
    await page.getByRole("textbox", { name: "Page title" }).click();
    await expect(page.getByRole("status", { name: "Save status" })).toHaveText("Saved locally");
    await app.close();
    ({ app, page } = await launch(home));
    await tid(page, "rail-space").click();
    await page.getByRole("button", { name: "Open boundary", exact: true }).click();
    await expect(tid(page, "space-block")).toHaveCount(2);
    await expect(page.getByLabel("Edit block 1", { exact: true })).toHaveText("First");
    await expect(page.getByLabel("Edit block 2", { exact: true })).toHaveText("Second");
  } finally { await app.close(); }
});

test("Space preserves dedented imported tasks and checks only the selected task", async () => {
  const { home } = seedHome();
  const { app, page } = await launch(home);
  const source = "  - First\n- [ ] Earlier task\nA paragraph\n- [ ] Later task";
  try {
    await tid(page, "rail-space").click();
    await page.getByLabel("Import Markdown file").setInputFiles({ name: "tasks.md", mimeType: "text/markdown", buffer: Buffer.from(source) });
    await expect(page.getByRole("checkbox", { name: "Earlier task" })).not.toBeChecked();
    await page.getByRole("checkbox", { name: "Later task" }).check();
    await expect(page.getByRole("checkbox", { name: "Later task" })).toBeChecked();
    await expect(page.getByRole("checkbox", { name: "Earlier task" })).not.toBeChecked();
    await expect.poll(() => JSON.parse(fs.readFileSync(path.join(home, "app", "space.json"), "utf8")).pages[0].markdown).toBe(source.replace("[ ] Later", "[x] Later"));
  } finally { await app.close(); }
});

test("Space creates and edits pages, survives navigation and relaunch, and restores trash", async () => {
  const { home } = seedHome();
  let { app, page } = await launch(home);
  try {
    await tid(page, "composer-input").fill("Keep my chat draft");
    await tid(page, "rail-space").click();
    await page.getByRole("button", { name: "New page", exact: true }).click();
    await page.getByRole("textbox", { name: "Page title" }).fill("Launch notes");
    await page.getByRole("textbox", { name: "Block 1" }).fill("A **durable** idea.");
    await page.getByRole("textbox", { name: "Block 1" }).press("Enter");
    await page.getByRole("textbox", { name: "Block 2" }).fill("/check");
    await page.getByRole("option", { name: /Checklist/ }).click();
    await page.getByRole("textbox", { name: "Block 2" }).fill("- [ ] Ship Space");
    await page.getByRole("textbox", { name: "Page title" }).click();
    await page.getByRole("checkbox", { name: "Ship Space" }).check();
    await expect(page.getByRole("status", { name: "Save status" })).toHaveText("Saved locally");
    await tid(page, "rail-chat").click();
    await expect(tid(page, "composer-input")).toHaveValue("Keep my chat draft");
    await tid(page, "rail-space").click();
    await expect(page.getByRole("textbox", { name: "Page title" })).toHaveValue("Launch notes");
    await app.close();
    ({ app, page } = await launch(home));
    await tid(page, "rail-space").click();
    await page.getByRole("button", { name: "Open Launch notes", exact: true }).click();
    await expect(page.getByRole("checkbox", { name: "Ship Space" })).toBeChecked();
    await page.getByRole("button", { name: "Page actions" }).click();
    await page.getByRole("menuitem", { name: "Move to trash" }).click();
    await page.getByRole("button", { name: "Trash", exact: true }).click();
    await page.getByRole("button", { name: "Restore Launch notes" }).click();
    await page.getByRole("button", { name: "All pages", exact: true }).click();
    await page.getByRole("button", { name: "Open Launch notes", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Page title" })).toHaveValue("Launch notes");
  } finally { await app.close(); }
});

test("Space imports Markdown, nests pages, finds content, and exports the current draft", async () => {
  const { home } = seedHome();
  const { app, page } = await launch(home);
  try {
    await tid(page, "rail-space").click();
    await page.getByRole("button", { name: /Project brief From/ }).click();
    await page.getByRole("textbox", { name: "Page title" }).fill("The next chapter");
    await expect(page.getByRole("heading", { name: "The idea" })).toBeVisible();
    await page.getByRole("button", { name: "Add to favorites" }).click();
    await page.getByRole("button", { name: "Page actions" }).click();
    await page.getByRole("menuitem", { name: "Add subpage" }).click();
    await page.getByRole("textbox", { name: "Page title" }).fill("Small details");
    await page.getByRole("textbox", { name: "Block 1" }).fill("A searchable constellation.");
    // Immediately switch pages while the save queue owns the child's final edit.
    await page.getByRole("button", { name: "Open The next chapter", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Page title" })).toHaveValue("The next chapter");
    await page.getByRole("searchbox", { name: "Search pages" }).fill("constellation");
    await page.getByRole("button", { name: "Open Small details", exact: true }).click();
    await expect(page.getByText("A searchable constellation.", { exact: true })).toBeVisible();
    await page.getByLabel("Import Markdown file").setInputFiles({ name: "notes.md", mimeType: "text/markdown", buffer: Buffer.from("# Imported notes\n\n## A useful heading\n\n**Bold** and `code`.\n\n| Task | Owner |\n| --- | --- |\n| Build Space | Val |") });
    await expect(page.getByRole("textbox", { name: "Page title" })).toHaveValue("Imported notes");
    await expect(page.getByRole("cell", { name: "Build Space" })).toBeVisible();
    const exportPath = path.join(home, "export.md");
    await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, exportPath);
    await page.getByRole("button", { name: "Page actions" }).click();
    await page.getByRole("menuitem", { name: "Export Markdown" }).click();
    await expect(page.getByText("Markdown exported", { exact: true })).toBeVisible();
    expect(fs.readFileSync(exportPath, "utf8")).toContain("| Build Space | Val |");
    await page.getByRole("button", { name: "All pages", exact: true }).click();
    await page.getByRole("button", { name: "Open The next chapter", exact: true }).click();
    await expect(page.getByRole("status", { name: "Save status" })).toHaveText("Saved locally");
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setBounds({ width: 1280, height: 900 }));
    const screenshots = path.join(appDir, ".probes", "space");
    await page.screenshot({ path: path.join(screenshots, "space-page.png") });
    await page.getByRole("button", { name: "Add a block", exact: true }).click();
    await expect(page.getByRole("listbox", { name: "Insert a block" })).toBeVisible();
    await page.screenshot({ path: path.join(screenshots, "space-block-menu.png") });
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "All pages", exact: true }).click();
    await page.screenshot({ path: path.join(screenshots, "space-overview.png") });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setBounds({ width: 900, height: 620 }));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole("button", { name: "Open Imported notes", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Page title" })).toBeVisible();
    await page.screenshot({ path: path.join(screenshots, "space-narrow.png") });
    await expect(page.getByRole("status", { name: "Save status" })).toHaveText("Saved locally");
  } finally { await app.close(); }
});

test("Space reports save failures and retains text for retry; imported links stay inert", async () => {
  const { home } = seedHome();
  const { app, page } = await launch(home);
  // Electron's will-prevent-unload owns this veto. Playwright's default CDP dismissal
  // races the native decision and fails with "No dialog is showing".
  page.on("dialog", dialog => { if (dialog.type() !== "beforeunload") void dialog.dismiss(); });
  try {
    await tid(page, "rail-space").click();
    await page.getByRole("button", { name: "New page", exact: true }).click();
    // Replace the storage target with a directory to provoke a real filesystem write failure.
    const file = path.join(home, "app", "space.json");
    fs.renameSync(file, `${file}.backup`);
    fs.mkdirSync(file);
    await page.getByRole("textbox", { name: "Block 1" }).fill("Never lose this draft.");
    await expect(page.getByRole("status", { name: "Save status" })).toHaveText("Not saved");
    await expect(page.getByRole("textbox", { name: "Block 1" })).toHaveValue("Never lose this draft.");
    // A rejected quit must leave the app usable so the user can retry saving.
    await app.evaluate(({ app, BrowserWindow }) => new Promise<void>(resolve => {
      BrowserWindow.getAllWindows()[0]!.webContents.once("will-prevent-unload", () => resolve());
      app.quit();
    }));
    await expect(page.getByRole("textbox", { name: "Block 1" })).toHaveValue("Never lose this draft.");
    await expect.poll(() => page.evaluate(() => window.modex.invoke("space:list", undefined).then(() => "ready", error => error.message))).not.toContain("shutting down");
    fs.rmdirSync(file); fs.renameSync(`${file}.backup`, file);
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(page.getByRole("status", { name: "Save status" })).toHaveText("Saved locally");
    expect(fs.readFileSync(file, "utf8")).toContain("Never lose this draft.");
    await page.getByLabel("Import Markdown file").setInputFiles({ name: "unsafe.md", mimeType: "text/markdown", buffer: Buffer.from("[Local file](file:///etc/passwd)\n\n[Run](javascript:alert)\n\n<script>alert(1)</script>") });
    await expect(page.getByRole("textbox", { name: "Page title" })).toHaveValue("unsafe");
    await expect(tid(page, "space").locator('a[href^="file:"], a[href^="javascript:"], script')).toHaveCount(0);
  } finally {
    // A failed assertion must not leave a test process held open by unsaved text.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(window => window.destroy()));
    await app.close();
  }
});

test("editing imported Markdown preserves nested content and Enter keeps text after a list marker", async () => {
  const { home } = seedHome();
  const { app, page } = await launch(home);
  try {
    await tid(page, "rail-space").click();
    const body = "- parent\n  - child\n  - child two\n\nHere is ![logo](https://example.com/logo.png) inline.\n\n- Keep this text\n\n[Docs](https://example.com/docs)";
    await page.getByLabel("Import Markdown file").setInputFiles({ name: "preserve.md", mimeType: "text/markdown", buffer: Buffer.from(body) });
    await expect(page.getByRole("textbox", { name: "Page title" })).toHaveValue("preserve");
    await expect(page.getByText("child", { exact: true })).toBeVisible();
    await expect(page.getByText("child two", { exact: true })).toBeVisible();
    await page.getByLabel("Edit block 3", { exact: true }).click();
    await page.getByRole("textbox", { name: "Block 3" }).evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(2, 2));
    await page.keyboard.press("Enter");
    await page.getByRole("textbox", { name: "Page title" }).click();
    await expect(page.getByText("Keep this text", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Docs", exact: true })).toHaveAttribute("target", "_blank");
    await expect(page.getByRole("status", { name: "Save status" })).toHaveText("Saved locally");
    const saved = JSON.parse(fs.readFileSync(path.join(home, "app", "space.json"), "utf8")).pages[0].markdown;
    expect(saved).toContain("  - child\n  - child two");
    expect(saved).toContain("![logo](https://example.com/logo.png)");
    expect(saved).toContain("Keep this text");
  } finally { await app.close(); }
});

test("Space continues numbered lists and renders URL images", async () => {
  const { home } = seedHome();
  const { app, page } = await launch(home);
  try {
    await tid(page, "rail-space").click();
    await page.getByRole("button", { name: "New page", exact: true }).click();
    const input = page.getByRole("textbox", { name: "Block 1" });
    await input.fill("1. First");
    await input.press("End");
    await input.press("Enter");
    await page.keyboard.insertText("Second");
    await page.getByRole("textbox", { name: "Page title" }).click();
    await expect(tid(page, "space").locator("ol")).toHaveCount(1);
    await expect(tid(page, "space").locator("ol > li")).toHaveText(["First", "Second"]);
    await page.route("https://images.example.test/pixel.png", route => route.fulfill({ contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP1sAAAAASUVORK5CYII=", "base64") }));
    await page.getByLabel("Import Markdown file").setInputFiles({ name: "image.md", mimeType: "text/markdown", buffer: Buffer.from("![A tiny image](https://images.example.test/pixel.png)") });
    const image = page.getByRole("img", { name: "A tiny image" });
    await expect(image).toBeVisible();
    await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1);
  } finally { await app.close(); }
});
