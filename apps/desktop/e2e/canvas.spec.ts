import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { createThread, launch, seedHome, tid } from "./support";

let app: ElectronApplication;
let page: Page;
let home: string;
let repo: string;
const guest = (app: ElectronApplication, code: string) => app.evaluate(async ({ webContents }, source) => {
  const contents = webContents.getAllWebContents().find(w => w.getURL().startsWith("modex-canvas:"));
  return contents ? contents.executeJavaScript(source, true) : null;
}, code);

test.beforeEach(async () => {
  ({ home, repo } = seedHome());
  fs.writeFileSync(path.join(repo, "preview.html"), '<title>Preview</title><link rel="stylesheet" href="preview.css"><button id="count" onclick="this.textContent=Number(this.textContent)+1">0</button><script>window.privileges=[typeof require, typeof window.modex]</script>');
  fs.writeFileSync(path.join(repo, "preview.css"), "button { color: rgb(12, 34, 56); }");
  fs.writeFileSync(path.join(repo, "shape.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><circle id="shape" cx="50" cy="50" r="40" fill="pink"/></svg>');
  ({ app, page } = await launch(home));
  await createThread(page, "Build an interactive preview");
  await page.keyboard.press("Meta+Shift+b");
  await page.getByRole("button", { name: "Canvas", exact: true }).click();
});
test.afterEach(async () => {
  await app?.close();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

test("Canvas runs local HTML, refreshes document and assets, and preserves browser isolation and full view", async () => {
  await page.getByLabel("Canvas file").selectOption("preview.html");
  await expect.poll(() => guest(app, 'document.querySelector("#count")?.textContent')).toBe("0");
  expect(await guest(app, "window.privileges")).toEqual(["undefined", "undefined"]);
  const host = (await tid(page, "canvas-preview").boundingBox())!;
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.contentView.children.some(v => 'webContents' in v && (v as import('electron').WebContentsView).webContents.getURL().startsWith('modex-canvas:') && v.getVisible()))).toBe(true);
  const button = await guest(app, '(() => { const r = document.querySelector("#count").getBoundingClientRect(); return {x:r.x+r.width/2, y:r.y+r.height/2}; })()');
  // A WebContentsView owns a separate input target; app-page CDP events do not reach it.
  const bounds = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.contentView.children.find(v => 'webContents' in v && (v as import('electron').WebContentsView).webContents.getURL().startsWith('modex-canvas:'))!.getBounds());
  expect(bounds.x).toBeCloseTo(host.x, 0);
  expect(bounds.y).toBeCloseTo(host.y, 0);
  expect(bounds.width).toBeCloseTo(host.width, 0);
  await app.evaluate(({ webContents }, point) => {
    const contents = webContents.getAllWebContents().find(w => w.getURL().startsWith("modex-canvas:"))!;
    contents.focus();
    contents.sendInputEvent({ type: "mouseDown", x: Math.round(point.x), y: Math.round(point.y), button: "left", clickCount: 1 });
    contents.sendInputEvent({ type: "mouseUp", x: Math.round(point.x), y: Math.round(point.y), button: "left", clickCount: 1 });
  }, button);
  await expect.poll(() => guest(app, 'document.querySelector("#count").textContent')).toBe("1");
  expect(await guest(app, 'getComputedStyle(document.querySelector("#count")).color')).toBe("rgb(12, 34, 56)");
  const prefs = await app.evaluate(({ webContents }) => webContents.getAllWebContents().find(w => w.getURL().startsWith("modex-canvas:"))!.getLastWebPreferences());
  expect(prefs).toMatchObject({ nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true });
  await tid(page, "workspace-full").click();
  await expect(tid(page, "main")).toBeHidden();
  fs.writeFileSync(path.join(repo, "preview.css"), "button { color: rgb(65, 43, 21); }");
  await expect.poll(() => guest(app, 'getComputedStyle(document.querySelector("#count")).color')).toBe("rgb(65, 43, 21)");
  fs.writeFileSync(path.join(repo, "preview.html"), "<h1>Updated by the agent</h1>");
  await expect.poll(() => guest(app, 'document.querySelector("h1")?.textContent')).toBe("Updated by the agent");
  await tid(page, "workspace-full").click();
  await expect(tid(page, "main")).toBeVisible();
  await tid(page, "open-settings").click();
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.contentView.children.some(v => 'webContents' in v && (v as import('electron').WebContentsView).webContents.getURL().startsWith('modex-canvas:') && v.getVisible()))).toBe(false);
});

test("Canvas renders SVG and Markdown and recovers after the selected file is deleted", async () => {
  await page.getByLabel("Canvas file").selectOption("shape.svg");
  await expect.poll(() => guest(app, 'document.querySelector("circle")?.getAttribute("fill")')).toBe("pink");
  await page.getByLabel("Canvas file").selectOption("README.md");
  await expect.poll(() => guest(app, 'document.querySelector("h1")?.textContent')).toBe("e2e");
  fs.writeFileSync(path.join(repo, "README.md"), '# Updated note\n\n**Strong** and `code`.\n\n<script>window.injected=true</script>');
  await expect.poll(() => guest(app, 'document.querySelector("h1")?.textContent')).toBe("Updated note");
  expect(await guest(app, 'typeof window.injected')).toBe("undefined");
  expect(await guest(app, 'document.querySelector("strong")?.textContent')).toBe("Strong");
  fs.unlinkSync(path.join(repo, "README.md"));
  await expect(tid(page, "canvas-error")).toBeVisible();
  fs.writeFileSync(path.join(repo, "README.md"), '# Restored');
  await expect.poll(() => guest(app, 'document.querySelector("h1")?.textContent')).toBe("Restored");
  await expect(tid(page, "canvas-error")).toHaveCount(0);
  await page.getByRole("button", { name: "Close Canvas tab", exact: true }).click();
  await expect.poll(() => guest(app, "true")).toBeNull();
});

test("Canvas refuses external requests, privileged navigation and popups; closing destroys its guest", async () => {
  const { createServer } = await import("node:http");
  let requests = 0;
  const server = createServer((_req, res) => { requests++; res.end("private"); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    fs.writeFileSync(path.join(repo, "preview.html"), `<h1>Isolated</h1><img src="http://127.0.0.1:${port}/secret"><iframe src="file:///etc/passwd"></iframe>`);
    await page.getByLabel("Canvas file").selectOption("preview.html");
    await expect.poll(() => guest(app, 'document.querySelector("h1")?.textContent')).toBe("Isolated");
    expect(await guest(app, `fetch('http://127.0.0.1:${port}/secret').then(() => 'allowed', () => 'denied')`)).toBe("denied");
    const url = await guest(app, "location.href");
    await guest(app, "window.open('file:///etc/passwd'); location.href='file:///etc/passwd'; undefined");
    expect(await guest(app, "location.href")).toBe(url);
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
    expect(requests).toBe(0);
    await tid(page, "workspace-full").click();
    await app.evaluate(({ webContents }) => {
      const contents = webContents.getAllWebContents().find(w => w.getURL().startsWith("modex-canvas:"))!;
      contents.focus(); contents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
    });
    await expect(tid(page, "main")).toBeVisible();
    await page.getByRole("button", { name: "Close Canvas tab", exact: true }).click();
    await expect.poll(() => guest(app, "true")).toBeNull();
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("Canvas retries an initially invalid file when it becomes previewable", async () => {
  fs.writeFileSync(path.join(repo, "preview.html"), "x".repeat(1024 * 1024 + 1));
  await page.getByLabel("Canvas file").selectOption("preview.html");
  await expect(tid(page, "canvas-error")).toBeVisible();
  fs.writeFileSync(path.join(repo, "preview.html"), "<h1>Recovered initial selection</h1>");
  await expect.poll(() => guest(app, 'document.querySelector("h1")?.textContent')).toBe("Recovered initial selection");
  await expect(tid(page, "canvas-error")).toHaveCount(0);
});

test("Canvas clears a transient file listing error without losing the running preview", async () => {
  await page.getByLabel("Canvas file").selectOption("preview.html");
  await expect.poll(() => guest(app, 'document.querySelector("#count")?.textContent')).toBe("0");
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler("files:list");
    let calls = 0;
    ipcMain.handle("files:list", () => {
      if (++calls === 1) throw new Error("Temporary file listing failure");
      return { paths: ["preview.html", "README.md", "shape.svg"], truncated: false };
    });
  });
  await expect(tid(page, "canvas-error")).toContainText("Temporary file listing failure");
  await expect(tid(page, "canvas-error")).toHaveCount(0);
  expect(await guest(app, 'document.querySelector("#count").textContent')).toBe("0");
});

test("an explicit Canvas reload is honored while a refresh poll is pending", async () => {
  await page.getByLabel("Canvas file").selectOption("preview.html");
  await expect.poll(() => guest(app, 'document.querySelector("#count")?.textContent')).toBe("0");
  await guest(app, 'document.querySelector("#count").click()');
  await app.evaluate(async ({ app, ipcMain }) => {
    const require = process.getBuiltinModule("module").createRequire(`${app.getAppPath()}/package.json`);
    const { CanvasResources } = require("./dist/src/main/engine/canvas.js");
    const original = CanvasResources.prototype.changed;
    let release: (() => void) | undefined;
    let held = false;
    CanvasResources.prototype.changed = async function () {
      CanvasResources.prototype.changed = original;
      held = true;
      await new Promise<void>(resolve => { release = resolve; });
      return original.call(this);
    };
    ipcMain.handle("test:canvas-held", () => held);
    ipcMain.handle("test:canvas-release", () => { release?.(); });
  });
  await expect.poll(() => page.evaluate(() => window.modex!.invoke("test:canvas-held" as never))).toBe(true);
  await page.getByRole("button", { name: "Reload Canvas", exact: true }).click();
  await page.evaluate(() => window.modex!.invoke("test:canvas-release" as never));
  await expect.poll(() => guest(app, 'document.querySelector("#count")?.textContent')).toBe("0");
});
