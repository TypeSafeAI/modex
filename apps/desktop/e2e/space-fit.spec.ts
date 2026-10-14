import { test, expect } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";
import { appDir, launch, resizeWindow, seedHome, tid } from "./support";

test("embedded knowledge bounds follow shell zoom", async () => {
  const { home } = seedHome();
  const { app } = await launch(home);
  try {
    for (const zoom of [0.8, 1, 1.25]) {
      const bounds = await app.evaluate(async ({ BrowserWindow }, { module, zoom }) => {
        const require = process.getBuiltinModule("node:module").createRequire(module);
        const { WorkspaceBrowser } = require(module);
        const window = BrowserWindow.getAllWindows()[0]!;
        window.webContents.setZoomFactor(zoom);
        const browser = new WorkspaceBrowser(window, { resolveURL: (url: string) => url, allowURL: () => true });
        try {
          await browser.command("fit", "navigate", "about:blank");
          browser.show("fit", { x: 100, y: 100, width: 400, height: 300 });
          return window.contentView.children.at(-1)!.getBounds();
        } finally { browser.dispose(); }
      }, { module: path.join(appDir, "dist/src/main/workspace-browser.js"), zoom });
      expect(bounds).toEqual({ x: 100 * zoom, y: 100 * zoom, width: 400 * zoom, height: 300 * zoom });
    }
  } finally { await app.close(); }
});

test("page comments reserve document space and keep compact entry and chat visible", async () => {
  const { home } = seedHome();
  const { app, page } = await launch(home);
  try {
    await resizeWindow(app, page, 1000, 900);
    await tid(page, "rail-space").click();
    await page.getByRole("button", { name: /Project brief From a thought/ }).click();
    await page.getByRole("button", { name: "Comments", exact: true }).click();
    const rail = page.getByRole("complementary", { name: "Comments" });
    const document = page.locator(".space-document-scroll");
    const docBox = (await document.boundingBox())!;
    const railBox = (await rail.boundingBox())!;
    expect(docBox.x + docBox.width).toBeLessThanOrEqual(railBox.x + 1);
    await expect(page.getByRole("button", { name: "Open chat", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Add comment", exact: true }).click();
    const entry = page.getByRole("textbox", { name: "Comment", exact: true });
    expect((await entry.boundingBox())!.y).toBeLessThan(railBox.y + 160);
    await entry.fill("Keep the editor readable");
    await page.getByRole("button", { name: "Post comment", exact: true }).click();
    await expect(rail.getByText("Keep the editor readable", { exact: true })).toBeVisible();
    await page.screenshot({ path: path.join(appDir, ".probes/space-fit/comments.png") });
  } finally { await app.close(); }
});

test("rendered page selection has contextual actions without exposing Markdown", async () => {
  const { home } = seedHome();
  const { app, page } = await launch(home);
  try {
    await tid(page, "rail-space").click();
    await page.getByRole("button", { name: /Project brief From a thought/ }).click();
    const text = page.locator(".space-check span").first();
    await text.evaluate(el => {
      el.closest<HTMLElement>(".space-block-preview")?.focus();
      const range = document.createRange(); range.selectNodeContents(el);
      const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
      el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
    const toolbar = page.getByRole("toolbar", { name: "Text formatting" });
    await expect(toolbar).toBeVisible();
    await toolbar.getByRole("button", { name: "Bold", exact: true }).click();
    await expect(text.locator("strong")).toHaveText("Define the outcome");
    await text.evaluate(el => {
      el.closest<HTMLElement>(".space-block-preview")?.focus();
      const range = document.createRange(); range.selectNodeContents(el);
      const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
      el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
    await toolbar.getByRole("button", { name: "Italic", exact: true }).click();
    await expect(text.locator("strong em, em strong")).toHaveText("Define the outcome");
    await expect(page.getByRole("textbox", { name: /^Block / })).toHaveCount(0);
    await text.evaluate(el => {
      el.closest<HTMLElement>(".space-block-preview")?.focus();
      const range = document.createRange(); range.selectNodeContents(el);
      const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
      el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
    await toolbar.getByRole("button", { name: "Ask for change" }).click();
    await page.getByRole("textbox", { name: "Describe the edit" }).fill("Make this more specific");
    await page.getByRole("button", { name: "Send edit request" }).click();
    await expect(tid(page, "composer-input")).toHaveValue(/Selected text: Define the outcome/);
  } finally { await app.close(); }
});

test("page generation takes an inline instruction before opening chat", async () => {
  const { home } = seedHome();
  const { app, page } = await launch(home);
  try {
    await tid(page, "rail-space").click();
    await page.getByRole("button", { name: /Project brief From a thought/ }).click();
    await page.getByRole("button", { name: "Insert", exact: true }).click();
    await page.getByRole("menuitem", { name: /Generate Describe/ }).click();
    const input = page.getByRole("textbox", { name: "What would you like to write?" });
    await expect(input).toBeVisible();
    await expect(tid(page, "space-chat")).toHaveCount(0);
    await input.fill("Add a launch checklist");
    await page.getByRole("button", { name: "Continue in chat" }).click();
    await expect(tid(page, "composer-input")).toHaveValue(/Add a launch checklist/);
    await expect(tid(page, "composer-input")).toHaveValue(/Space page: Project brief/);
    expect((await tid(page, "composer-input").boundingBox())!.height).toBeLessThanOrEqual(120);
  } finally { await app.close(); }
});

test("rendered escaped and code text cannot be formatted as plain Markdown", async () => {
  const { home } = seedHome();
  const { app, page } = await launch(home);
  try {
    await tid(page, "rail-space").click();
    await page.getByLabel("Import Markdown file").setInputFiles({ name: "literal.md", mimeType: "text/markdown", buffer: Buffer.from("a\\*b\n\n`hello`") });
    for (const [block, start, end] of [[1, 1, 2], [2, 0, 5]]) {
      await page.getByLabel(`Edit block ${block}`, { exact: true }).evaluate((el, { start, end }) => {
        const node = document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode()!;
        const range = document.createRange(); range.setStart(node, start); range.setEnd(node, end);
        const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
        el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      }, { start: start!, end: end! });
      await expect(page.getByRole("toolbar", { name: "Text formatting" }).getByRole("button", { name: "Bold", exact: true })).toBeDisabled();
    }
  } finally { await app.close(); }
});

test("generation draft stays reachable when its anchor block is deleted", async () => {
  const { home } = seedHome();
  const { app, page } = await launch(home);
  try {
    await tid(page, "rail-space").click();
    await page.getByRole("button", { name: /Project brief From a thought/ }).click();
    await page.getByRole("button", { name: "Insert", exact: true }).click();
    await page.getByRole("menuitem", { name: /Generate Describe/ }).click();
    const input = page.getByRole("textbox", { name: "What would you like to write?" });
    await input.fill("Keep this instruction");
    await page.getByLabel("Actions for block 1", { exact: true }).click();
    await page.getByRole("button", { name: "Delete block", exact: true }).click();
    await expect(input).toBeVisible();
    await expect(input).toHaveValue("Keep this instruction");
  } finally { await app.close(); }
});

test("page request and generation drafts survive navigation and stage the right page", async () => {
  const { home } = seedHome();
  const { app, page } = await launch(home);
  try {
    await tid(page, "rail-space").click();
    await page.getByRole("textbox", { name: "Ask anything", exact: true }).fill("Plan my notes");
    await page.getByRole("textbox", { name: "Ask anything", exact: true }).press("Enter");
    await expect(tid(page, "composer-input")).toHaveValue("Plan my notes");
    await page.getByRole("button", { name: "Minimize chat" }).click();
    await page.getByRole("button", { name: /Project brief From a thought/ }).click();
    await page.getByRole("textbox", { name: "Work with this page" }).fill("Clarify the success criteria");
    await page.getByRole("button", { name: "Insert", exact: true }).click();
    await page.getByRole("menuitem", { name: /Generate Describe/ }).click();
    await page.getByRole("textbox", { name: "What would you like to write?" }).fill("Add milestones");
    await page.getByRole("button", { name: "Page actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Show pages", exact: true }).click();
    await page.getByRole("button", { name: /To-do list Keep your priorities/ }).click();
    await expect(page.getByRole("textbox", { name: "Work with this page" })).toHaveValue("");
    await expect(page.getByRole("textbox", { name: "What would you like to write?" })).toHaveCount(0);
    await page.getByRole("button", { name: "Open Project brief", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "What would you like to write?" })).toHaveValue("Add milestones");
    await expect(page.getByRole("textbox", { name: "Work with this page" })).toHaveValue("Clarify the success criteria");
    await page.getByRole("textbox", { name: "Work with this page" }).press("Enter");
    await expect(tid(page, "composer-input")).toHaveValue(/Clarify the success criteria\n\nSpace page: Project brief/);
  } finally { await app.close(); }
});

test("selection link entry validates URLs and preserves the rendered label", async () => {
  const { home } = seedHome();
  const { app, page } = await launch(home);
  try {
    await tid(page, "rail-space").click();
    await page.getByRole("button", { name: /Project brief From a thought/ }).click();
    await page.locator(".space-check span").first().evaluate(el => {
      el.closest<HTMLElement>(".space-block-preview")?.focus();
      const range = document.createRange(); range.selectNodeContents(el);
      const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
      el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
    await page.getByRole("toolbar", { name: "Text formatting" }).getByRole("button", { name: "Add link", exact: true }).click();
    await page.getByRole("textbox", { name: "Link URL" }).fill("javascript:alert(1)");
    await expect(page.getByRole("button", { name: "Apply link", exact: true })).toBeDisabled();
    await page.getByRole("textbox", { name: "Link URL" }).fill("https://example.com/launch");
    await page.getByRole("button", { name: "Apply link", exact: true }).click();
    await expect(page.getByRole("link", { name: "Define the outcome", exact: true })).toHaveAttribute("href", "https://example.com/launch");
    await expect(page.getByRole("textbox", { name: /^Block / })).toHaveCount(0);
  } finally { await app.close(); }
});


test("completed work folds while errors, pending approvals and the final answer remain visible", async () => {
  const { home, repo } = seedHome({ theme: "graphite" });
  const file = path.join(home, "app/state.json");
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  const at = new Date().toISOString();
  state.threads = [{ id: "reference-work", projectId: "p1", title: "Review page changes", createdAt: at, updatedAt: at, cwd: repo, backend: "mock", model: "mock", mode: "chat", plan: false, status: "idle" }];
  fs.writeFileSync(file, JSON.stringify(state));
  const { app, page } = await launch(home);
  try {
    await tid(page, "thread-row").first().locator(".thread-main").click();
    await app.evaluate(({ BrowserWindow }, at) => {
      const entries = [
        { id: "user", kind: "user", text: "Review the page changes" },
        { id: "thinking", kind: "thinking", text: "Checking the layout", status: "done", durationMs: 4000 },
        { id: "progress", kind: "assistant", text: "Inspecting the page controls." },
        { id: "tool", kind: "tool", name: "shell", title: "npm run check", args: { command: "npm run check" }, status: "done", ok: true, output: "Checks passed" },
        { id: "error", kind: "tool", name: "shell", title: "npm run missing", args: {}, status: "done", ok: false, output: "Missing script" },
        { id: "approval", kind: "approval", question: "Approve the remaining action?" },
        { id: "warning", kind: "notice", level: "warn", text: "One check remains unresolved." },
        { id: "answer", kind: "assistant", text: "The page layout is ready for review." },
      ];
      for (const item of entries) BrowserWindow.getAllWindows()[0]!.webContents.send("thread:event", { type: "item", threadId: "reference-work", item: { ...item, at } });
    }, at);
    await expect(page.getByText("The page layout is ready for review.", { exact: true })).toBeVisible();
    await expect(page.getByText("Inspecting the page controls.", { exact: true })).not.toBeVisible();
    await expect(page.getByText("One check remains unresolved.", { exact: true })).toBeVisible();
    await expect(tid(page, "approval-question")).toBeVisible();
    await expect(tid(page, "tool-summary").filter({ hasText: "missing" })).toBeVisible();
    const toggle = tid(page, "turn-header").getByRole("button");
    await toggle.press("Enter");
    await expect(page.getByText("Inspecting the page controls.", { exact: true })).toBeVisible();
    await toggle.press("Space");
    await expect(page.getByText("Inspecting the page controls.", { exact: true })).not.toBeVisible();
  } finally { await app.close(); }
});

test("overview layouts and favorites keep their page actions functional", async () => {
  const { home } = seedHome();
  const { app, page } = await launch(home);
  try {
    await tid(page, "rail-space").click();
    await page.getByRole("button", { name: /Project brief From a thought/ }).click();
    await page.getByRole("button", { name: "Page actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Add to favorites", exact: true }).click();
    await page.getByRole("button", { name: "Page actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Show pages", exact: true }).click();
    await page.getByRole("button", { name: "Favorites", exact: true }).click();
    await page.getByRole("button", { name: "Grid view", exact: true }).click();
    await expect(page.getByRole("button", { name: "Grid view", exact: true })).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("searchbox", { name: "Find pages", exact: true }).fill("brief");
    await page.locator(".space-page-list-row").getByRole("button").click();
    await expect(page.getByRole("textbox", { name: "Page title" })).toHaveValue("Project brief");
    await page.getByRole("button", { name: "Page actions", exact: true }).click();
    await expect(page.getByRole("menuitem", { name: "Remove from favorites", exact: true })).toBeVisible();
  } finally { await app.close(); }
});


test("page menus and comments stay within narrow panes", async () => {
  const { home } = seedHome({ theme: "graphite" });
  const { app, page } = await launch(home);
  try {
    await resizeWindow(app, page, 900, 700);
    await tid(page, "rail-space").click();
    await page.getByRole("button", { name: /Project brief From a thought/ }).click();
    await page.getByRole("button", { name: "Insert", exact: true }).click();
    const bounds = (await page.getByRole("menu", { name: "Insert into page" }).boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(900);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Comments", exact: true }).click();
    const document = (await page.locator(".space-document-scroll").boundingBox())!;
    const rail = (await page.getByRole("complementary", { name: "Comments" }).boundingBox())!;
    expect(document.x + document.width).toBeLessThanOrEqual(rail.x + 1);
    await page.getByRole("button", { name: "Close comments" }).click();
    await page.locator(".space-check span").first().evaluate(el => {
      el.closest<HTMLElement>(".space-block-preview")?.focus();
      const range = document.createRange(); range.selectNodeContents(el);
      const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
      el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
    await page.getByRole("combobox", { name: "Block type" }).selectOption("bullet");
    await expect(page.locator(".space-block-preview ul li")).toHaveText(["Define the outcome", "Build the first version", "Share what we learned"]);
    await expect(page.locator(".space-block-preview").filter({ has: page.locator("ul") })).toBeFocused();
    await page.locator(".space-block-preview h2").first().evaluate(el => {
      el.closest<HTMLElement>(".space-block-preview")?.focus();
      const range = document.createRange(); range.selectNodeContents(el);
      const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
      el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
    const toolbar = page.getByRole("toolbar", { name: "Text formatting" });
    await expect(toolbar).toBeVisible();
    const title = page.getByRole("textbox", { name: "Page title" });
    const titleBounds = (await title.boundingBox())!;
    expect((await toolbar.boundingBox())!.y).toBeGreaterThanOrEqual(titleBounds.y + titleBounds.height);
    await title.click();
    await expect(title).toBeFocused();
  } finally { await app.close(); }
});

test("page insertion and generation follow the last active block", async () => {
  const { home } = seedHome(); const { app, page } = await launch(home);
  try {
    await tid(page, "rail-space").click();
    await page.getByRole("button", { name: /Project brief From a thought/ }).click();
    await page.getByLabel("Edit block 2", { exact: true }).click();
    await page.getByRole("button", { name: "Insert", exact: true }).click();
    await page.getByRole("menuitem", { name: /Heading 3/ }).click();
    await expect(page.getByRole("textbox", { name: "Block 3", exact: true })).toBeVisible({ timeout: 2000 });
    await page.getByRole("textbox", { name: "Block 3", exact: true }).fill("### Inserted here");
    await page.getByRole("button", { name: "Generate page content", exact: true }).click();
    const previous = await page.locator(".space-generation").evaluate(el => el.previousElementSibling?.textContent);
    expect(previous).toContain("Inserted here");
  } finally { await app.close(); }
});

test("rendered formatting supports keyboard commands and Escape", async () => {
  const { home } = seedHome(); const { app, page } = await launch(home);
  try {
    await tid(page, "rail-space").click();
    await page.getByRole("button", { name: /Project brief From a thought/ }).click();
    const text = page.locator(".space-check span").first();
    const select = () => text.evaluate(el => {
      el.closest<HTMLElement>(".space-block-preview")?.focus();
      const range = document.createRange(); range.selectNodeContents(el);
      getSelection()!.removeAllRanges(); getSelection()!.addRange(range);
      el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
    await select();
    await page.keyboard.press("Meta+b");
    await expect(text.locator("strong")).toHaveText("Define the outcome", { timeout: 2000 });
    await select();
    await page.keyboard.press("Meta+k");
    await expect(page.getByRole("textbox", { name: "Link URL" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("textbox", { name: "Link URL" })).toBeHidden();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("toolbar", { name: "Text formatting" })).toBeHidden();
    await expect(page.getByLabel("Edit block 4", { exact: true })).toBeFocused();
  } finally { await app.close(); }
});

test("overview sorts pages and retains the chosen grid layout", async () => {
  const { home } = seedHome(); const { app, page } = await launch(home);
  try {
    await tid(page, "rail-space").click();
    for (const title of ["Alpha", "Zulu"]) {
      await page.getByRole("button", { name: "New page", exact: true }).click();
      await page.getByRole("textbox", { name: "Page title" }).fill(title);
      await page.getByRole("button", { name: "Page actions", exact: true }).click();
      await page.getByRole("menuitem", { name: "Show pages", exact: true }).click();
    }
    await expect(page.locator(".space-list-name strong")).toHaveText(["Zulu", "Alpha"]);
    await page.getByRole("button", { name: "Sort pages" }).click({ timeout: 2000 });
    await page.getByRole("menuitemradio", { name: "Name" }).click();
    await expect(page.locator(".space-list-name strong")).toHaveText(["Alpha", "Zulu"]);
    await page.getByRole("button", { name: "Grid view" }).click();
    await page.getByRole("button", { name: "Your items", exact: true }).click();
    await expect(page.getByRole("button", { name: "Grid view" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".space-page-grid .space-list-name strong")).toHaveText(["Alpha", "Zulu"]);
  } finally { await app.close(); }
});

test("contextual comments bound long quotes and replace only empty drafts", async () => {
  const { home } = seedHome(); const { app, page } = await launch(home);
  try {
    await tid(page, "rail-space").click();
    await page.getByRole("button", { name: "New page", exact: true }).click();
    const long = "Long selected paragraph. ".repeat(100);
    await page.getByRole("textbox", { name: "Block 1", exact: true }).fill(long);
    await page.getByRole("textbox", { name: "Page title" }).click();
    const commentOn = async (length: number) => {
      await page.locator(".space-block-preview p").first().evaluate((el, length) => {
        el.closest<HTMLElement>(".space-block-preview")?.focus();
        const range = document.createRange(); range.setStart(el.firstChild!, 0); range.setEnd(el.firstChild!, length);
        getSelection()!.removeAllRanges(); getSelection()!.addRange(range);
        el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      }, length);
      await page.getByRole("toolbar", { name: "Text formatting" }).getByRole("button", { name: "Comment", exact: true }).click();
    };
    await commentOn(long.trim().length);
    const quote = page.locator(".space-comment-form blockquote");
    await expect(quote).toHaveText(long.slice(0, 2000));
    await page.getByRole("button", { name: "Close comments" }).click();
    await commentOn(4);
    await expect(quote).toHaveText("Long");
    await page.getByRole("textbox", { name: "Comment", exact: true }).fill("Preserve this draft");
    await page.getByRole("button", { name: "Close comments" }).click();
    await commentOn(13);
    await expect(quote).toHaveText("Long");
    await page.getByRole("textbox", { name: "Comment", exact: true }).press("Meta+Enter");
    await expect(page.locator(".space-comment")).toContainText("Preserve this draft");
  } finally { await app.close(); }
});
