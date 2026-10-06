import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createThread, launch, seedHome, tid } from "./support";

let app: ElectronApplication;
let page: Page;
let repo: string;

test.beforeEach(async () => {
  const seed = seedHome();
  repo = seed.repo;
  fs.mkdirSync(path.join(repo, ".beads"));
  const lines = Array.from({ length: 272 }, (_, i) => JSON.stringify({ id: `int-${i}`, actor: "Val Alexander", field: "status", value: "closed" }));
  lines[269] = JSON.stringify({ id: "int-ccd9a5368cf5a69fd6a20ad46c859702", kind: "field_changed", created_at: "2026-09-17T19:01:47.293574Z", actor: "Val Alexander", issue_id: "threads-vdv", extra: { field: "status", new_value: "closed", old_value: "deferred", reason: "Closed 2026-09-17 on the recorded decision that promotion is a deferred branch of the acceptance criteria (Decision 2 in docs/reviews/2026-09-17-maintainer-decisions.md). Threads-side forward_updated constructor (#75) remains the ready call site; daemon emission stays fail-closed indefinitely per threads-19p." } });
  lines[270] = JSON.stringify({ id: "int-403502afe2173cc75862da1e67bbd364", kind: "field_changed", created_at: "2026-09-17T19:01:47.915541Z", actor: "Val Alexander", issue_id: "threads-xpo", extra: { field: "status", new_value: "closed", old_value: "deferred", reason: "Closed 2026-09-17 on recorded decision to defer the lane (docs/reviews/2026-09-17-maintainer-decisions.md, Decision 1). Channel::Deliberate stays specified and library-implemented but unreachable from the daemon while the authenticated authority path is fail-closed indefinitely. Seam contract (#25) keeps 'coven memory promote' labelled planned. Reopen only with a new daemon-owned scope decision." } });
  lines[271] = JSON.stringify({ id: "int-e6fd2c0d560c61a157fec389cd5cd1c6", kind: "field_changed", created_at: "2026-09-17T19:01:48.484264Z", actor: "Val Alexander", issue_id: "threads-review", extra: { field: "status", new_value: "closed" } });
  fs.writeFileSync(path.join(repo, ".beads/interactions.jsonl"), lines.join("\n") + "\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "user.name=e2e", "-c", "user.email=e2e@modex.local", "commit", "-qm", "review fixture"], { cwd: repo });
  fs.appendFileSync(path.join(repo, ".beads/interactions.jsonl"), '{"id":"int-new","actor":"Val Alexander","field":"status","value":"closed"}\n{"id":"int-next","field":"status","value":"closed"}\n');
  fs.writeFileSync(path.join(repo, ".beads/.beads.gate.lock"), "");
  ({ app, page } = await launch(seed.home));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1540, 1097));
  await expect(tid(page, "draft-view")).toBeVisible();
  await createThread(page, "Review the right workspace");
});
test.afterEach(async () => { await app?.close(); });

test("reference review has a numbered diff and a filterable tree on its right", async ({}, info) => {
  await expect(page.getByRole("tab", { name: "Review", exact: true })).toBeVisible();
  const file = tid(page, "changes-file").filter({ hasText: "interactions.jsonl" });
  await file.getByRole("button", { name: "View diff for .beads/interactions.jsonl", exact: true }).click();
  await expect(tid(page, "diff")).toContainText("int-new");
  const tree = (await tid(page, "review-tree").boundingBox())!;
  const diff = (await tid(page, "changes-diff").boundingBox())!;
  expect(tree.x).toBeGreaterThanOrEqual(diff.x + diff.width - 1);
  await expect(page.getByRole("button", { name: /269 unmodified lines/ })).toBeVisible();
  await page.getByRole("button", { name: /269 unmodified lines/ }).click();
  await expect(tid(page, "diff")).toContainText('"id":"int-0"');
  await tid(page, "review-filter").fill("interactions");
  await expect(tid(page, "changes-file")).toHaveCount(1);
  await tid(page, "review-filter").fill("nothing matches");
  await expect(page.getByText("No matching files.")).toBeVisible();
  await tid(page, "review-filter").clear();
  await page.getByRole("button", { name: "Show all unchanged lines", exact: true }).click();
  await expect(page.getByRole("button", { name: /269 unmodified lines/ })).toBeVisible();
  await page.mouse.move(10, 10);
  await tid(page, "review-filter").blur();
  const workspace = tid(page, "workspace");
  await expect(workspace).toHaveCSS("background-color", "rgb(16, 16, 16)");
  expect(Math.round((await workspace.boundingBox())!.width)).toBe(647);
  expect(Math.round((await tid(page, "review-tree").boundingBox())!.width)).toBe(255);
  await workspace.screenshot({ path: info.outputPath("review.png"), scale: "css" });
});

test("new-tab menu, launcher, full view and Files replace the old panel", async ({}, info) => {
  await tid(page, "workspace-add").click();
  await expect(page.getByRole("menuitem", { name: "New tab ⇧⌘B", exact: true })).toBeVisible();
  expect((await tid(page, "workspace-new-menu").boundingBox())!.width).toBe(241);
  await tid(page, "workspace-new-menu").screenshot({ path: info.outputPath("new-tab-menu.png") });
  await page.keyboard.press("Escape");
  await expect(tid(page, "workspace-add")).toBeFocused();
  await page.keyboard.press("Meta+Shift+b");
  await expect(tid(page, "workspace-address")).toBeFocused();
  await expect(page.getByRole("button", { name: "Review ⌃⇧G", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Terminal ⌃`", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Files ⌘P", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Terminal options", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "Open external terminal", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("tab", { name: "Review", exact: true }).hover();
  await page.getByRole("button", { name: "Close Review tab", exact: true }).click();
  // Keep the active new tab; the inactive initial tab reveals its close action on hover.
  await page.getByRole("tab", { name: "New tab", exact: true }).first().hover();
  await page.getByRole("button", { name: "Close New tab tab", exact: true }).first().click();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1600, 972));
  await page.mouse.move(10, 10);
  await tid(page, "workspace-address").focus();
  expect((await tid(page, "workspace").boundingBox())!.width).toBe(672);
  await tid(page, "workspace").screenshot({ path: info.outputPath("new-tab.png"), caret: "initial" });
  await tid(page, "workspace-full").click();
  await expect(tid(page, "main")).toBeHidden();
  await page.getByRole("button", { name: "Files ⌘P", exact: true }).click();
  await page.getByRole("button", { name: "Open README.md", exact: true }).click();
  await expect(tid(page, "workspace-file-content")).toContainText("# e2e");
  await tid(page, "workspace-full").click();
  await expect(tid(page, "main")).toBeVisible();
  await page.keyboard.press("Meta+Shift+f");
  await expect(tid(page, "main")).toBeHidden();
  await expect(tid(page, "workspace-address")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(tid(page, "main")).toBeVisible();
});

test("browser tabs load a real local page, navigate history and stay isolated from the app", async () => {
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => { res.writeHead(200, { "Content-Type": "text/html" }); res.end(`<title>${req.url === "/second" ? "Second page" : "Local preview"}</title><h1>${req.url}</h1><a href="/second">Next page</a>`); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    await page.keyboard.press("Meta+Shift+b");
    await tid(page, "workspace-address").fill(`http://127.0.0.1:${port}/first`);
    await tid(page, "workspace-address").press("Enter");
    await expect(page.getByRole("tab", { name: "Local preview", exact: true })).toBeVisible();
    const guestState = () => app.evaluate(({ webContents }) => webContents.getAllWebContents().filter((w) => w.getURL().startsWith("http://127.0.0.1:")).map((w) => ({ url: w.getURL(), preferences: w.getLastWebPreferences() })));
    await expect.poll(async () => (await guestState()).length).toBe(1);
    expect((await guestState())[0]!.preferences).toMatchObject({ nodeIntegration: false, sandbox: true, contextIsolation: true });
    const isolated = await app.evaluate(async ({ webContents }) => webContents.getAllWebContents().find((w) => w.getURL().startsWith("http://127.0.0.1:"))!.executeJavaScript("[typeof window.modex, typeof require]"));
    expect(isolated).toEqual(["undefined", "undefined"]);
    // User activation matters: Chromium intentionally skips scripted, unactivated history entries.
    await app.evaluate(({ webContents }) => webContents.getAllWebContents().find((w) => w.getURL().startsWith("http://127.0.0.1:"))!.executeJavaScript("document.querySelector('a').click()", true));
    await expect(page.getByRole("tab", { name: "Second page", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Go back", exact: true }).click();
    await expect(page.getByRole("tab", { name: "Local preview", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Go forward", exact: true }).click();
    await expect(page.getByRole("tab", { name: "Second page", exact: true })).toBeVisible();
    await tid(page, "workspace-address").fill("file:///etc/passwd");
    await tid(page, "workspace-address").press("Enter");
    await expect(page.getByRole("alert")).toContainText("Use an HTTPS URL");
    await page.getByRole("button", { name: "Close Second page tab", exact: true }).click();
    await expect.poll(async () => (await guestState()).length).toBe(0);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("no-final-newline metadata does not shift the changed line numbers", async () => {
  fs.writeFileSync(path.join(repo, "unterminated.txt"), "old");
  execFileSync("git", ["add", "unterminated.txt"], { cwd: repo });
  execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "user.name=e2e", "-c", "user.email=e2e@modex.local", "commit", "-qm", "unterminated fixture"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "unterminated.txt"), "new");
  await tid(page, "changes-refresh").click();
  await page.getByRole("button", { name: "View diff for unterminated.txt", exact: true }).click();
  const addition = tid(page, "diff").locator('[data-line="add"]');
  await expect(addition).toContainText("new");
  await expect(addition.locator(".line-number")).toHaveText("1");
  await expect(tid(page, "diff").locator('[data-line="del"] .line-number')).toHaveText("1");
});

test("Review errors remain visible in full view", async () => {
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler("changes:status");
    ipcMain.handle("changes:status", () => { throw new Error("Review refresh unavailable"); });
  });
  await tid(page, "workspace-full").click();
  await expect(tid(page, "main")).toBeHidden();
  await tid(page, "changes-refresh").click();
  await expect(tid(page, "toast")).toBeVisible();
  await expect(tid(page, "toast-message")).toContainText("Review refresh unavailable");
});

test("superseded navigation, overlays, guest shortcuts and window destruction preserve browser lifecycle", async () => {
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => { if (req.url === "/slow") return; res.writeHead(200, { "Content-Type": "text/html" }); res.end("<title>Fast destination</title><h1>Ready</h1>"); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    await page.keyboard.press("Meta+Shift+b");
    await tid(page, "workspace-address").fill(`http://127.0.0.1:${port}/slow`);
    await tid(page, "workspace-address").press("Enter");
    await expect(tid(page, "workspace-browser")).toBeVisible();
    await tid(page, "workspace-address").fill(`http://127.0.0.1:${port}/fast`);
    await tid(page, "workspace-address").press("Enter");
    await expect(page.getByRole("tab", { name: "Fast destination", exact: true })).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
    const guestVisible = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.contentView.children.some((v) => "webContents" in v && (v as import("electron").WebContentsView).webContents.getURL().includes("/fast") && v.getVisible()));
    await expect.poll(guestVisible).toBe(true);
    await tid(page, "workspace-add").click();
    await expect.poll(guestVisible).toBe(false);
    await page.keyboard.press("Escape");
    await expect.poll(guestVisible).toBe(true);
    await tid(page, "open-settings").click();
    await expect.poll(guestVisible).toBe(false);
    await page.keyboard.press("Escape");
    await expect.poll(guestVisible).toBe(true);
    await tid(page, "streamer-mode-toggle").click();
    await expect.poll(guestVisible).toBe(false);
    await tid(page, "streamer-mode-disable").click();
    await expect.poll(guestVisible).toBe(true);
    await app.evaluate(({ webContents }) => webContents.getAllWebContents().find((w) => w.getURL().includes("/fast"))!.sendInputEvent({ type: "keyDown", keyCode: "L", modifiers: ["meta"] }));
    await expect(tid(page, "workspace-address")).toBeFocused();
    await app.evaluate(async ({ webContents }) => {
      const guest = webContents.getAllWebContents().find((w) => w.getURL().includes("/fast"))!;
      await guest.executeJavaScript("window.lastKey = ''; document.addEventListener('keydown', e => { window.lastKey = e.key; })");
      guest.focus(); guest.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
    });
    await expect.poll(() => app.evaluate(({ webContents }) => webContents.getAllWebContents().find((w) => w.getURL().includes("/fast"))!.executeJavaScript("window.lastKey"))).toBe("Escape");
    await tid(page, "workspace-full").click();
    await expect(tid(page, "main")).toBeHidden();
    await app.evaluate(({ webContents }) => {
      const guest = webContents.getAllWebContents().find((w) => w.getURL().includes("/fast"))!;
      guest.focus(); guest.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
    });
    await expect(tid(page, "main")).toBeVisible();
    // This path is used after an app-renderer crash; destroy skips the normal close event.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.destroy());
    await expect.poll(() => app.evaluate(({ webContents }) => webContents.getAllWebContents().filter((w) => w.getURL().includes("/fast")).length)).toBe(0);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});
