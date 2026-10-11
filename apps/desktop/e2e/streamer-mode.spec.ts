import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import { appDir, createThread, launch, seedHome, tid } from "./support";
import path from "node:path";

let app: ElectronApplication;
let page: Page;
let home: string;
let repo: string;
const highlighted = () => page.evaluate(() => Array.from(CSS.highlights.get("modex-streamer") ?? [], range => range.toString()).join(""));

test.beforeEach(async () => {
  ({ home, repo } = seedHome());
  ({ app, page } = await launch(home));
});
test.afterEach(async () => {
  await app?.close();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

test("Streamer Mode keeps editing, clipboard and submitted originals intact through relaunch", async () => {
  await tid(page, "new-chat").click();
  const input = tid(page, "composer-input");
  await input.fill("API_KEY=abcdef");
  await tid(page, "streamer-mode-toggle").click();
  await expect(tid(page, "sheet")).toBeVisible();
  await expect(tid(page, "rail")).toBeVisible();
  await expect(input).toHaveValue("API_KEY=abcdef");
  await expect(input).toHaveCSS("-webkit-text-security", "disc");
  // Delete the middle b, whose masked glyph used to be confused with the last character.
  await input.focus();
  await input.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(9, 10));
  await page.keyboard.press("Backspace");
  await expect(input).toHaveValue("API_KEY=acdef");
  await page.keyboard.press("Meta+z");
  await expect(input).toHaveValue("API_KEY=abcdef");
  await input.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(8, 14));
  await page.keyboard.press("Meta+c");
  expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe("abcdef");
  await page.keyboard.press("Meta+x");
  await expect(input).toHaveValue("API_KEY=");
  await page.keyboard.press("Meta+z");
  await expect(input).toHaveValue("API_KEY=abcdef");
  await page.keyboard.press("Meta+Shift+z");
  await expect(input).toHaveValue("API_KEY=");
  await page.keyboard.press("Meta+v");
  await expect(input).toHaveValue("API_KEY=abcdef");
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.imeSetComposition", { text: "秘密", selectionStart: 2, selectionEnd: 2 });
  await cdp.send("Input.insertText", { text: "秘密" });
  await expect(input).toHaveValue("API_KEY=abcdef秘密");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await expect(input).toHaveValue("API_KEY=abcdef");
  await cdp.detach();
  await tid(page, "send").click();
  await expect(tid(page, "item-text").filter({ hasText: "API_KEY=abcdef" })).toBeVisible();
  await expect.poll(highlighted).toContain("abcdef");
  await app.close();
  ({ app, page } = await launch(home));
  await expect(tid(page, "sheet")).toBeVisible();
  await expect.poll(highlighted).toContain("abcdef");
  await tid(page, "streamer-mode-toggle").click();
  expect(await highlighted()).toBe("");
  await expect(tid(page, "item-text").filter({ hasText: "API_KEY=abcdef" })).toBeVisible();
});

test("paint redaction handles inline markup, streaming text and tooltips without changing links or copied text", async () => {
  await tid(page, "streamer-mode-toggle").click();
  await page.evaluate(() => {
    const fixture = document.createElement("section");
    fixture.id = "streamer-fixture";
    fixture.innerHTML = '<p><strong>password</strong>: abcdef</p><a href="https://example.test/?token=secret-value" title="TOKEN=secret-value">TOKEN=secret-value</a><pre>password: |\n  multiline-secret\npublic: yes</pre><p id="streaming-secret">sk-proj-</p>';
    fixture.innerHTML += '<pre><div><span class="line-number">1</span><code>password: |</code></div><div><span class="line-number">2</span><code>  file-secret-body</code></div><div><span class="line-number">3</span><code>public: hello</code></div></pre>';
    fixture.innerHTML += '<span id="updated-title" title="TOKEN=old-secret">Updated label</span>';
    fixture.innerHTML += '<img id="broken-image" src="data:image/png;base64,broken" alt="TOKEN=image-secret">';
    document.querySelector(".app")!.append(fixture);
  });
  await expect.poll(highlighted).toContain("abcdef");
  await expect.poll(highlighted).toContain("multiline-secret");
  await expect.poll(highlighted).toContain("file-secret-body");
  expect(await highlighted()).not.toContain("public");
  await expect(page.locator("#streamer-fixture a")).toHaveAttribute("href", "https://example.test/?token=secret-value");
  await expect(page.locator("#streamer-fixture a")).toHaveAttribute("title", "TOKEN=[redacted]");
  await expect(page.locator("#updated-title")).toHaveAttribute("title", "TOKEN=[redacted]");
  await expect(page.locator("#broken-image")).toHaveAttribute("alt", "TOKEN=[redacted]");
  await expect(page.locator("#broken-image")).toHaveAttribute("src", "data:image/png;base64,broken");
  await page.locator("#updated-title").evaluate(el => el.setAttribute("title", "TOKEN=[redacted]"));
  await page.locator("#streaming-secret").evaluate(el => { el.firstChild!.textContent += "more-chars"; });
  await expect.poll(highlighted).toContain("sk-proj-more-chars");
  const style = await page.locator("#streamer-fixture p").first().evaluate(el => {
    const paint = getComputedStyle(el, "::highlight(modex-streamer)");
    const selection = getComputedStyle(el, "::selection");
    const range = document.createRange(); range.selectNodeContents(el);
    getSelection()!.removeAllRanges(); getSelection()!.addRange(range);
    return { color: paint.color, background: paint.backgroundColor, selection: selection.color };
  });
  expect(style.color).toBe(style.background);
  expect(style.selection).toBe("rgba(0, 0, 0, 0)");
  await page.screenshot({ path: path.join(appDir, ".probes", "streamer-selected-text.png") });
  await page.keyboard.press("Meta+c");
  expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe("password: abcdef");
  await tid(page, "streamer-mode-toggle").click();
  await expect(page.locator("#streamer-fixture a")).toHaveAttribute("title", "TOKEN=secret-value");
  await expect(page.locator("#updated-title")).toHaveAttribute("title", "TOKEN=[redacted]");
  await expect(page.locator("#broken-image")).toHaveAttribute("alt", "TOKEN=image-secret");
});

test("native select labels are redacted while their option values stay original", async () => {
  const state = await page.evaluate(() => window.modex.invoke("state:get", undefined));
  state.projects[0]!.name = "API_KEY=project-secret";
  await app.evaluate(({ ipcMain }, saved) => { ipcMain.removeHandler("state:get"); ipcMain.handle("state:get", () => saved); }, state);
  await page.reload();
  await tid(page, "streamer-mode-toggle").click();
  await tid(page, "open-settings").click();
  await tid(page, "settings-nav").getByRole("button", { name: "Approval rules" }).click();
  const select = page.getByRole("combobox", { name: "Preview project", exact: true });
  const option = select.locator("option").first();
  await expect(option).toHaveAttribute("label", "API_KEY=[redacted]");
  await select.selectOption(state.projects[0]!.id);
  await expect(select).toHaveValue(state.projects[0]!.id);
  await page.screenshot({ path: path.join(appDir, ".probes", "streamer-select.png") });
});

test("Space edits and formats the original Markdown while streaming", async () => {
  await tid(page, "streamer-mode-toggle").click();
  await tid(page, "rail-space").click();
  await page.getByRole("button", { name: "New page", exact: true }).click();
  const title = page.getByRole("textbox", { name: "Page title" });
  await title.fill("Password notes");
  const block = page.getByRole("textbox", { name: "Block 1", exact: true });
  await block.fill("API_KEY=abcdef");
  await expect(block).toHaveCSS("-webkit-text-security", "disc");
  await block.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(8, 14));
  await block.press("Meta+b");
  await expect(block).toHaveValue("API_KEY=**abcdef**");
  await title.click();
  await expect.poll(() => page.evaluate(() => window.modex.invoke("space:list", undefined).then(pages => pages.find(p => p.title === "Password notes")?.markdown))).toBe("API_KEY=**abcdef**");
  await expect.poll(highlighted).toContain("abcdef");
});

test("terminal keeps parser replies, bracketed paste and application cursor mode while masking wrapped output", async () => {
  const threadId = await createThread(page, "Terminal redaction");
  await tid(page, "terminal-toggle").click();
  await expect(page.locator(".xterm-helper-textarea")).toBeAttached();
  const opened = await page.evaluate(id => window.modex.invoke("terminal:open", { threadId: id, cols: 80, rows: 24 }), threadId);
  await app.evaluate(({ ipcMain }) => {
    (globalThis as { streamerWrites?: string[] }).streamerWrites = [];
    ipcMain.removeHandler("terminal:write");
    ipcMain.handle("terminal:write", (_event, args) => { (globalThis as { streamerWrites: string[] }).streamerWrites.push(args.data); });
  });
  await tid(page, "streamer-mode-toggle").click();
  const secret = "private".repeat(45);
  await app.evaluate(({ BrowserWindow }, args) => BrowserWindow.getAllWindows()[0]!.webContents.send("terminal:event", {
    type: "data", threadId: args.threadId, sessionId: args.sessionId, sequence: 1_000_000,
    data: `\x1b[2J\x1b[HAPI_KEY=\x1b[31m${args.secret}\x1b[0m\r\n\x1b[?2004h\x1b[?1h\x1b[6n`,
  }), { threadId, sessionId: opened.sessionId, secret });
  await expect.poll(highlighted).toContain("privateprivate");
  const writes = () => app.evaluate(() => (globalThis as { streamerWrites: string[] }).streamerWrites);
  await expect.poll(async () => (await writes()).some(value => /^\x1b\[\d+;\d+R$/.test(value))).toBe(true);
  await app.evaluate(({ clipboard }) => clipboard.writeText("original-paste"));
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.press("Meta+v");
  await page.keyboard.press("ArrowUp");
  await expect.poll(writes).toContain("\x1b[200~original-paste\x1b[201~");
  await expect.poll(writes).toContain("\x1bOA");
  const row = page.locator(".xterm-rows > div").first();
  const rect = (await row.boundingBox())!;
  await page.mouse.move(rect.x + 1, rect.y + rect.height / 2);
  await page.mouse.down();
  await page.mouse.move(rect.x + rect.width - 2, rect.y + rect.height / 2);
  await page.mouse.up();
  await page.keyboard.press("Meta+c");
  expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toMatch(/^API_KEY=private/);
  await page.screenshot({ path: path.join(appDir, ".probes", "streamer-terminal.png") });
  await app.evaluate(({ BrowserWindow }, args) => BrowserWindow.getAllWindows()[0]!.webContents.send("terminal:event", {
    type: "data", threadId: args.threadId, sessionId: args.sessionId, sequence: 1_000_001,
    data: "\r\n-----BEGIN PRIVATE KEY-----\r\n" + "pem-private-body\r\n".repeat(100) + "-----END PRIVATE KEY-----\r\npassword: |\r\n  yaml-terminal-body\r\npublic: visible\r\n",
  }), { threadId, sessionId: opened.sessionId });
  await expect.poll(highlighted).toContain("pem-private-body");
  await expect.poll(highlighted).toContain("yaml-terminal-body");
  expect(await highlighted()).not.toContain("public");
  await page.screenshot({ path: path.join(appDir, ".probes", "streamer-terminal-multiline.png") });
});

test("saved Streamer Mode masks startup errors before state loads", async () => {
  await tid(page, "streamer-mode-toggle").click();
  const privateError = "Unable to connect with API_KEY=private-startup-key";
  await app.evaluate(({ ipcMain }, message) => {
    ipcMain.removeHandler("state:get");
    ipcMain.handle("state:get", () => { throw new Error(message); });
  }, privateError);
  await page.reload();
  await expect(page.locator(".app")).toContainText(privateError);
  await expect.poll(highlighted).toContain("private-startup-key");
  await tid(page, "streamer-mode-disable").click();
  expect(await highlighted()).toBe("");
});
