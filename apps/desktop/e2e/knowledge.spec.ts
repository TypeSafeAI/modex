import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { appDir, launch, seedHome, tid } from "./support";

const screenshots = path.join(appDir, ".probes", "space");

async function openKnowledgeFile(guest: Page, name: string) {
  // OpenKnowledge collapses its file tree below 1024px, including Graphite's wider rail.
  const navigation = guest.getByRole("group", { name: "Workspace navigation" });
  await expect(navigation).toBeVisible();
  const showFiles = navigation.getByRole("button", { name: /^Show Files/ });
  if (await showFiles.count()) await showFiles.click();
  const file = guest.getByText(name, { exact: true }).first();
  await expect(file).toBeInViewport();
  await file.click();
}

test("Space connects to an existing Open Knowledge editor and leaves it running on disconnect and quit", async () => {
  test.skip(process.env.MODEX_TEST_OPEN_KNOWLEDGE !== "1", "Requires the real Open Knowledge runtime");
  test.setTimeout(240_000);
  const { home, repo } = seedHome();
  fs.writeFileSync(path.join(home, "app", "knowledge.json"), JSON.stringify({ version: 1, folder: fs.realpathSync(repo) }));
  fs.writeFileSync(path.join(repo, "Existing.md"), "# Already running\n\nThis server belongs to another window.\n");
  const { app, page } = await launch(home);
  let child: ReturnType<typeof spawn> | undefined;
  let closed: Promise<unknown> | undefined;
  let url = "";
  try {
    await tid(page, "rail-space").click();
    await page.getByRole("button", { name: "Knowledge base", exact: true }).click();
    await page.getByRole("button", { name: "Install Open Knowledge" }).click();
    await expect(page.getByRole("button", { name: "Open knowledge base", exact: true })).toBeEnabled({ timeout: 180_000 });
    fs.mkdirSync(path.join(repo, ".ok"));
    fs.writeFileSync(path.join(repo, ".ok", "config.yml"), "content:\n  dir: .\nautoSync:\n  default: off\n");
    const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1", OK_OPEN_BROWSER: "false", OK_RECLAIM_DISABLE: "1" };
    delete env.FORCE_COLOR;
    child = spawn(process.execPath, [path.join(home, "integrations", "open-knowledge", "node_modules", "@inkeep", "open-knowledge", "dist", "cli.mjs"), "--cwd", repo, "--no-color", "start", "--mode", "browser", "--bind", "127.0.0.1", "--port", "0", "--no-open-browser", "--idle-shutdown", "off"], { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] });
    closed = once(child, "close");
    let output = "";
    const collect = (data: Buffer) => { output += data.toString(); url = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0] ?? ""; };
    child.stdout?.on("data", collect); child.stderr?.on("data", collect);
    await expect.poll(async () => url && fetch(`${url}/readyz`).then(r => r.json()).then(r => r.ready).catch(() => false), { timeout: 60_000 }).toBe(true);
    const open = async () => {
      await page.getByRole("button", { name: "Open knowledge base", exact: true }).click();
      await expect(page.getByText("Connected locally", { exact: true })).toBeVisible({ timeout: 60_000 });
      await expect(page.getByRole("button", { name: "Disconnect", exact: true })).toBeVisible();
      const state = await page.evaluate(() => window.modex.invoke("knowledge:state", undefined));
      expect(state.url).toBe(url);
      expect(state.external).toBe(true);
    };
    await open();
    await expect.poll(() => app.context().pages().length).toBeGreaterThan(1);
    const guest = app.context().pages().find(p => p !== page)!;
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.contentView.children.some(view => view.getVisible()))).toBe(true);
    await openKnowledgeFile(guest, "Existing");
    const editor = guest.locator('.tiptap[contenteditable="true"]').filter({ hasText: "Already running" });
    await expect(editor).toBeVisible();
    await editor.click();
    await guest.keyboard.press("ControlOrMeta+End");
    await guest.keyboard.press("Enter");
    await guest.keyboard.insertText("Connected from Modex without restarting.");
    await expect.poll(() => fs.readFileSync(path.join(repo, "Existing.md"), "utf8")).toContain("Connected from Modex without restarting.");
    await page.screenshot({ path: path.join(screenshots, "knowledge-reused.png") });
    await guest.screenshot({ path: path.join(screenshots, "knowledge-reused-editor.png") });
    await page.getByRole("button", { name: "Disconnect", exact: true }).click();
    await expect(page.getByRole("button", { name: "Open knowledge base", exact: true })).toBeVisible();
    expect((await fetch(`${url}/readyz`)).ok).toBe(true);
    expect(child.exitCode).toBe(null);
    await open();
    await app.close();
    expect((await fetch(`${url}/readyz`)).ok).toBe(true);
    expect(child.exitCode).toBe(null);
  } finally {
    await app.close();
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await closed;
  }
});

test("Knowledge is reachable below Home and keeps the chat draft", async () => {
  const { home } = seedHome();
  const { app, page } = await launch(home);
  try {
    await tid(page, "composer-input").fill("Keep this thought");
    await tid(page, "rail-space").click();
    await page.getByRole("button", { name: "Knowledge base", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Give your knowledge a home." })).toBeVisible();
    await expect(page.getByRole("button", { name: "Choose knowledge folder" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Install Open Knowledge" })).toBeVisible();
    await tid(page, "rail-chat").click();
    await expect(tid(page, "composer-input")).toHaveValue("Keep this thought");
    await tid(page, "rail-space").click();
    await expect(page.getByRole("heading", { name: "Give your knowledge a home." })).toBeVisible();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setBounds({ width: 1280, height: 900 }));
    await page.screenshot({ path: path.join(screenshots, "knowledge-setup.png") });
  } finally { await app.close(); }
});

test("Knowledge remembers the selected folder and reports a missing runtime", async () => {
  const { home, repo } = seedHome();
  fs.writeFileSync(path.join(home, "app", "knowledge.json"), JSON.stringify({ version: 1, folder: fs.realpathSync(repo) }));
  const { app, page } = await launch(home);
  try {
    await tid(page, "rail-space").click();
    await page.getByRole("button", { name: "Knowledge base", exact: true }).click();
    await expect(page.getByTestId("knowledge-folder")).toContainText(path.basename(repo));
    await expect(page.getByRole("button", { name: "Open knowledge base", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Install Open Knowledge" })).toBeVisible();
  } finally { await app.close(); }
});

// Opt in because this exercises the separately downloaded upstream application, not a fixture.
test("real Open Knowledge installs, edits local files, hides for privacy, and stops with Modex", async () => {
  test.skip(process.env.MODEX_TEST_OPEN_KNOWLEDGE !== "1", "Requires Node 24+, Git, and the npm download");
  test.setTimeout(240_000);
  const { home, repo } = seedHome();
  fs.writeFileSync(path.join(repo, "Welcome.md"), "# Welcome to Modex knowledge\n\nA connected home for our decisions.\n");
  const { app, page } = await launch(home);
  let url = "";
  try {
    await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, repo);
    await tid(page, "rail-space").click();
    await page.getByRole("button", { name: "Knowledge base", exact: true }).click();
    await page.getByRole("button", { name: "Choose knowledge folder" }).click();
    await expect(page.getByTestId("knowledge-folder")).toContainText(path.basename(repo));
    await page.getByRole("button", { name: "New page", exact: true }).click();
    await page.getByRole("textbox", { name: "Page title" }).fill("Decisions from Space");
    await page.getByRole("textbox", { name: "Block 1" }).fill("Bring this decision into the knowledge base.");
    await page.getByRole("button", { name: "Page actions" }).click();
    await page.getByRole("menuitem", { name: "Copy to knowledge base" }).click();
    await expect(page.getByText("Page copied to your knowledge base", { exact: true })).toBeVisible();
    const copied = fs.readdirSync(repo).find(name => name.startsWith("space-") && name.endsWith(".md"))!;
    expect(fs.readFileSync(path.join(repo, copied), "utf8")).toContain("Bring this decision into the knowledge base.");
    await page.getByRole("button", { name: "Knowledge base", exact: true }).click();
    await page.getByRole("button", { name: "Install Open Knowledge" }).click();
    await expect(page.getByRole("button", { name: "Open knowledge base", exact: true })).toBeEnabled({ timeout: 180_000 });
    await page.getByRole("button", { name: "Open knowledge base", exact: true }).click();
    await expect(page.getByText("Running locally", { exact: true })).toBeVisible({ timeout: 60_000 });
    await expect.poll(() => app.context().pages().length).toBeGreaterThan(1);
    const guest = app.context().pages().find(p => p !== page)!;
    await guest.waitForLoadState("domcontentloaded");
    url = new URL(guest.url()).origin;
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    await expect(guest.getByText("Welcome", { exact: true }).first()).toBeVisible({ timeout: 30_000 });
    await openKnowledgeFile(guest, "Welcome");
    await expect(guest.getByText("Welcome to Modex knowledge", { exact: true }).first()).toBeVisible();
    expect(await guest.evaluate(() => typeof (window as unknown as { modex: unknown }).modex)).toBe("undefined");
    const editor = guest.locator('.tiptap[contenteditable="true"]').filter({ hasText: "Welcome to Modex knowledge" });
    await expect(editor).toBeVisible();
    const visibleGuest = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.contentView.children.some(view => view.getVisible()));
    for (const [theme, name, background, foreground] of [["graphite", "Graphite", "rgb(15, 15, 17)", "rgb(227, 228, 230)"], ["jev", "Jev", "rgb(11, 15, 27)", "rgb(248, 243, 250)"], ["coven", "OpenCoven", "rgb(28, 27, 29)", "rgb(250, 250, 250)"]] as const) {
      await tid(page, "open-settings").click();
      await expect.poll(visibleGuest).toBe(false);
      await tid(page, "settings-nav").getByRole("button", { name: "General", exact: true }).click();
      await page.getByRole("radio", { name, exact: true }).check();
      await tid(page, "settings").getByRole("button", { name: "Save", exact: true }).click();
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect.poll(visibleGuest).toBe(true);
      await expect.poll(() => guest.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(background);
      await expect.poll(() => guest.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(true);
      await expect.poll(() => editor.evaluate(el => {
        let surface: Element | null = el;
        while (surface && ["rgba(0, 0, 0, 0)", "transparent"].includes(getComputedStyle(surface).backgroundColor)) surface = surface.parentElement;
        return { text: getComputedStyle(el).color, background: surface && getComputedStyle(surface).backgroundColor };
      })).toEqual({ text: foreground, background });
      await guest.screenshot({ path: path.join(screenshots, `knowledge-theme-${theme}.png`) });
    }
    let resumeReload!: () => void;
    const reloadGate = new Promise<void>(resolve => { resumeReload = resolve; });
    await guest.route(`${url}/`, async route => { await reloadGate; await route.continue(); });
    try {
      await page.getByRole("button", { name: "Reload knowledge base" }).click();
      await expect.poll(visibleGuest).toBe(false);
    } finally { resumeReload(); }
    await guest.waitForLoadState("domcontentloaded");
    await guest.unroute(`${url}/`);
    await expect(editor).toBeVisible();
    await expect.poll(visibleGuest).toBe(true);
    await expect.poll(() => guest.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe("rgb(28, 27, 29)");
    await editor.click();
    await guest.keyboard.press("ControlOrMeta+End");
    await guest.keyboard.press("Enter");
    await guest.keyboard.insertText("Edited inside Modex, saved as Markdown.");
    await expect.poll(() => fs.readFileSync(path.join(repo, "Welcome.md"), "utf8")).toContain("Edited inside Modex, saved as Markdown.");
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setBounds({ width: 1280, height: 900 }));
    await expect.poll(() => page.getByTestId("knowledge-canvas").evaluate(el => el.getBoundingClientRect().width)).toBeLessThan(1280);
    await guest.screenshot({ path: path.join(screenshots, "knowledge-editor.png") });
    await expect.poll(visibleGuest).toBe(true);
    await tid(page, "rail-chat").click();
    await expect.poll(visibleGuest).toBe(false);
    await tid(page, "rail-space").click();
    await expect.poll(visibleGuest).toBe(true);
    await page.getByRole("button", { name: /Streamer Mode/ }).click();
    await expect.poll(visibleGuest).toBe(false);
    await tid(page, "streamer-mode-disable").click();
    await expect.poll(visibleGuest).toBe(true);
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(page.getByRole("button", { name: "Open knowledge base", exact: true })).toBeVisible();
    await expect.poll(() => fetch(`${url}/readyz`).then(() => true, () => false)).toBe(false);
    await page.getByRole("button", { name: "Open knowledge base", exact: true }).click();
    await expect(page.getByText("Running locally", { exact: true })).toBeVisible({ timeout: 60_000 });
    url = await page.evaluate(async () => (await (window as any).modex.invoke("knowledge:state")).url);
    expect(fs.readFileSync(path.join(repo, "Welcome.md"), "utf8")).toContain("Edited inside Modex, saved as Markdown.");
  } finally { await app.close(); }
  await expect.poll(() => fetch(`${url}/readyz`).then(() => true, () => false)).toBe(false);
});
