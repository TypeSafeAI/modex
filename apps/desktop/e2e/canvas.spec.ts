import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { createThread, launch, seedHome, tid } from "./support";

let app: ElectronApplication;
let page: Page;
let home: string;
let repo: string;
// A guest can disappear while executeJavaScript waits for a document or promise.
// Polling reads can retry transient lifecycle states; imperative calls must fail.
const observeGuest = (app: ElectronApplication, code: string) => app.evaluate(async ({ BrowserWindow }, source) => {
  type Observation = { state: "ready"; value: unknown } | { state: "absent" | "loading" | "destroyed" | "timed out" }
    | { state: "error"; message: string };
  const contents = BrowserWindow.getAllWindows().flatMap(window => window.contentView.children)
    .filter((view): view is import("electron").WebContentsView => "webContents" in view)
    .map(view => view.webContents).find(w => !w.isDestroyed() && w.getURL().startsWith("modex-canvas:"));
  if (!contents) return { state: "absent" } as Observation;
  if (contents.isLoadingMainFrame()) return { state: "loading" } as Observation;
  let timer: ReturnType<typeof setTimeout>;
  let destroyed: () => void;
  try {
    const interrupted = new Promise<Observation>(resolve => {
      destroyed = () => resolve({ state: "destroyed" });
      contents.once("destroyed", destroyed);
      timer = setTimeout(() => resolve({ state: "timed out" }), 1_500);
    });
    const script = contents.executeJavaScript(source, true).then(
      value => ({ state: "ready", value }) as Observation,
      error => contents.isDestroyed() ? { state: "destroyed" } as Observation
        : { state: "error", message: String(error) } as Observation);
    return await Promise.race([script, interrupted]);
  } finally {
    clearTimeout(timer!);
    contents.removeListener("destroyed", destroyed!);
  }
}, code);
const guest = async (app: ElectronApplication, code: string): Promise<any> => {
  const result = await observeGuest(app, code);
  if (result.state !== "ready") throw new Error(`Canvas guest ${result.state}${result.state === "error" ? `: ${result.message}` : ""}`);
  return result.value;
};
const readGuest = async (app: ElectronApplication, code: string) => {
  const result = await observeGuest(app, code);
  if (result.state === "error") throw new Error(`Canvas guest error: ${result.message}`);
  return result.state === "ready" ? result.value : result;
};
const guestCount = (app: ElectronApplication) => app.evaluate(({ webContents }) =>
  webContents.getAllWebContents().filter(w => !w.isDestroyed() && w.getURL().startsWith("modex-canvas:")).length);


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
  await expect.poll(() => readGuest(app, 'document.querySelector("#count")?.textContent')).toBe("0");
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
  await expect.poll(() => readGuest(app, 'document.querySelector("#count").textContent')).toBe("1");
  expect(await guest(app, 'getComputedStyle(document.querySelector("#count")).color')).toBe("rgb(12, 34, 56)");
  const prefs = await app.evaluate(({ webContents }) => webContents.getAllWebContents().find(w => w.getURL().startsWith("modex-canvas:"))!.getLastWebPreferences());
  expect(prefs).toMatchObject({ nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true });
  await tid(page, "workspace-full").click();
  await expect(tid(page, "main")).toBeHidden();
  fs.writeFileSync(path.join(repo, "preview.css"), "button { color: rgb(65, 43, 21); }");
  await expect.poll(() => readGuest(app, 'getComputedStyle(document.querySelector("#count")).color')).toBe("rgb(65, 43, 21)");
  fs.writeFileSync(path.join(repo, "preview.html"), "<h1>Updated by the agent</h1>");
  await expect.poll(() => readGuest(app, 'document.querySelector("h1")?.textContent')).toBe("Updated by the agent");
  await tid(page, "workspace-full").click();
  await expect(tid(page, "main")).toBeVisible();
  await tid(page, "open-settings").click();
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.contentView.children.some(v => 'webContents' in v && (v as import('electron').WebContentsView).webContents.getURL().startsWith('modex-canvas:') && v.getVisible()))).toBe(false);
});

test("Canvas renders SVG and Markdown and recovers after the selected file is deleted", async () => {
  await page.getByLabel("Canvas file").selectOption("shape.svg");
  await expect.poll(() => readGuest(app, 'document.querySelector("circle")?.getAttribute("fill")')).toBe("pink");
  await page.getByLabel("Canvas file").selectOption("README.md");
  await expect.poll(() => readGuest(app, 'document.querySelector("h1")?.textContent')).toBe("e2e");
  fs.writeFileSync(path.join(repo, "README.md"), '# Updated note\n\n**Strong** and `code`.\n\n<script>window.injected=true</script>');
  await expect.poll(() => readGuest(app, 'document.querySelector("h1")?.textContent')).toBe("Updated note");
  expect(await guest(app, 'typeof window.injected')).toBe("undefined");
  expect(await guest(app, 'document.querySelector("strong")?.textContent')).toBe("Strong");
  fs.unlinkSync(path.join(repo, "README.md"));
  await expect(tid(page, "canvas-error")).toBeVisible();
  fs.writeFileSync(path.join(repo, "README.md"), '# Restored');
  await expect.poll(() => readGuest(app, 'document.querySelector("h1")?.textContent')).toBe("Restored");
  await expect(tid(page, "canvas-error")).toHaveCount(0);
  await page.getByRole("button", { name: "Close Canvas tab", exact: true }).click();
  await expect.poll(() => guestCount(app)).toBe(0);
});

test("Canvas observations settle when a loading guest is replaced", async () => {
  await page.getByLabel("Canvas file").selectOption("shape.svg");
  await expect.poll(() => readGuest(app, 'document.querySelector("circle")?.getAttribute("fill")')).toBe("pink");
  await app.evaluate(({ app, webContents }) => {
    const require = process.getBuiltinModule("module").createRequire(`${app.getAppPath()}/package.json`);
    const { CanvasResources } = require("./dist/src/main/engine/canvas.js");
    const original = CanvasResources.prototype.respond;
    const state = (globalThis as any).__canvasResponse = { held: false, started: false, release: undefined };
    CanvasResources.prototype.respond = async function (request: Request) {
      if (this.selected === "shape.svg") {
        CanvasResources.prototype.respond = original;
        state.held = true;
        await new Promise<void>(resolve => { state.release = resolve; });
      }
      return original.call(this, request);
    };
    const contents = webContents.getAllWebContents().find(w => w.getURL().startsWith("modex-canvas:"))!;
    const execute = contents.executeJavaScript.bind(contents);
    contents.executeJavaScript = (...args) => { state.started = true; return execute(...args); };
    contents.reload();
  });
  try {
    await expect.poll(() => app.evaluate(() => (globalThis as any).__canvasResponse.held)).toBe(true);
    let settled = false;
    const pending = guest(app, 'document.querySelector("h1")?.textContent').then(
      () => "unexpected success", error => String(error)).finally(() => { settled = true; });
    // Observe the old guest query entering executeJavaScript, or an immediate loading
    // refusal, before selection changes through the renderer's separate CDP target.
    await expect.poll(async () => settled || await app.evaluate(() => (globalThis as any).__canvasResponse.started)).toBe(true);
    await page.getByLabel("Canvas file").selectOption("README.md");
    await expect.poll(() => readGuest(app, 'document.querySelector("h1")?.textContent')).toBe("e2e");
    let timer: ReturnType<typeof setTimeout>;
    try {
      const outcome = await Promise.race([pending, new Promise<string>(resolve => {
        timer = setTimeout(() => resolve("query remained pending after replacement"), 2_000);
      })]);
      expect(outcome).toMatch(/Canvas guest (loading|destroyed)/);
    } finally { clearTimeout(timer!); }
  } finally {
    await app.evaluate(() => (globalThis as any).__canvasResponse.release?.());
  }
});

test("Canvas observations reject when an executing guest is destroyed", async () => {
  await page.getByLabel("Canvas file").selectOption("preview.html");
  await expect.poll(() => readGuest(app, 'document.querySelector("#count")?.textContent')).toBe("0");
  const pending = guest(app, "window.__canvasScriptStarted = true; new Promise(() => {})").then(
    () => "unexpected success", error => String(error));
  await expect.poll(() => readGuest(app, "window.__canvasScriptStarted")).toBe(true);
  await page.getByRole("button", { name: "Close Canvas tab", exact: true }).click();
  let timer: ReturnType<typeof setTimeout>;
  try {
    const outcome = await Promise.race([pending, new Promise<string>(resolve => {
      timer = setTimeout(() => resolve("query remained pending after destruction"), 3_000);
    })]);
    expect(outcome).toContain("Canvas guest destroyed");
  } finally { clearTimeout(timer!); }
});

test("Canvas imperative scripts fail visibly when they never settle", async () => {
  await page.getByLabel("Canvas file").selectOption("preview.html");
  await expect.poll(() => readGuest(app, 'document.querySelector("#count")?.textContent')).toBe("0");
  const listeners = () => app.evaluate(({ webContents }) => webContents.getAllWebContents()
    .find(w => w.getURL().startsWith("modex-canvas:"))!.listenerCount("destroyed"));
  const before = await listeners();
  const pending = guest(app, "new Promise(() => {})").then(
    () => "unexpected success", error => String(error));
  let timer: ReturnType<typeof setTimeout>;
  try {
    const outcome = await Promise.race([pending, new Promise<string>(resolve => {
      timer = setTimeout(() => resolve("query remained pending beyond its bound"), 3_000);
    })]);
    expect(outcome).toContain("Canvas guest timed out");
  } finally { clearTimeout(timer!); }
  expect(await listeners()).toBe(before);
  await expect(readGuest(app, 'throw new Error("canvas-script-sentinel")')).rejects.toThrow("Canvas guest error");
  expect(await listeners()).toBe(before);
  expect(await guest(app, 'document.querySelector("#count")?.textContent')).toBe("0");
  expect(await listeners()).toBe(before);
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
    await expect.poll(() => readGuest(app, 'document.querySelector("h1")?.textContent')).toBe("Isolated");
    expect(await guest(app, `fetch('http://127.0.0.1:${port}/secret').then(() => 'allowed', () => 'denied')`)).toBe("denied");
    const url = await guest(app, "location.href");
    await guest(app, "window.open('file:///etc/passwd'); location.href='file:///etc/passwd'; undefined");
    expect(await guest(app, "location.href")).toBe(url);
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
    expect(requests).toBe(0);
    await tid(page, "workspace-full").click();
    // Escape can only leave full view once it is entered; sent earlier, the click wins the race.
    await expect(tid(page, "main")).toBeHidden();
    await app.evaluate(({ webContents }) => {
      const contents = webContents.getAllWebContents().find(w => w.getURL().startsWith("modex-canvas:"))!;
      contents.focus(); contents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
    });
    await expect(tid(page, "main")).toBeVisible();
    await page.getByRole("button", { name: "Close Canvas tab", exact: true }).click();
    await expect.poll(() => guestCount(app)).toBe(0);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("Canvas retries an initially invalid file when it becomes previewable", async () => {
  fs.writeFileSync(path.join(repo, "preview.html"), "x".repeat(1024 * 1024 + 1));
  await page.getByLabel("Canvas file").selectOption("preview.html");
  await expect(tid(page, "canvas-error")).toBeVisible();
  fs.writeFileSync(path.join(repo, "preview.html"), "<h1>Recovered initial selection</h1>");
  await expect.poll(() => readGuest(app, 'document.querySelector("h1")?.textContent')).toBe("Recovered initial selection");
  await expect(tid(page, "canvas-error")).toHaveCount(0);
});

test("Canvas clears a transient file listing error without losing the running preview", async () => {
  await page.getByLabel("Canvas file").selectOption("preview.html");
  await expect.poll(() => readGuest(app, 'document.querySelector("#count")?.textContent')).toBe("0");
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

test("Streamer Mode covers only Canvas and preserves its live guest and selection", async () => {
  await page.getByLabel("Canvas file").selectOption("preview.html");
  await expect.poll(() => readGuest(app, 'document.querySelector("#count")?.textContent')).toBe("0");
  await guest(app, 'document.querySelector("#count").click()');
  const nativeState = () => app.evaluate(({ BrowserWindow }) => {
    const view = BrowserWindow.getAllWindows()[0]!.contentView.children.find(v => "webContents" in v &&
      (v as import("electron").WebContentsView).webContents.getURL().startsWith("modex-canvas:")) as import("electron").WebContentsView;
    return { id: view.webContents.id, visible: view.getVisible() };
  });
  const before = await nativeState();
  await tid(page, "streamer-mode-toggle").click();
  await expect(tid(page, "streamer-canvas-cover")).toBeVisible();
  await expect.poll(nativeState).toEqual({ id: before.id, visible: false });
  await expect(tid(page, "sheet")).toBeVisible();
  await tid(page, "composer-input").fill("An unsent draft while the preview is covered");
  await expect(tid(page, "composer-input")).toHaveValue("An unsent draft while the preview is covered");
  await expect(page.getByLabel("Canvas file")).toHaveValue("preview.html");
  await tid(page, "streamer-mode-toggle").click();
  await expect(tid(page, "streamer-canvas-cover")).toHaveCount(0);
  await expect.poll(nativeState).toEqual({ id: before.id, visible: true });
  expect(await guest(app, 'document.querySelector("#count").textContent')).toBe("1");
});

test("Canvas masks secret filename labels while opening their original paths", async () => {
  const filename = "TOKEN=canvas-secret.html";
  fs.writeFileSync(path.join(repo, filename), "<h1>Original file opened</h1>");
  const select = page.getByLabel("Canvas file");
  const option = select.locator("option").filter({ hasText: filename });
  await expect(option).toHaveCount(1);
  await tid(page, "streamer-mode-toggle").click();
  await expect(option).toHaveAttribute("label", "TOKEN=[redacted]");
  await select.selectOption(filename);
  await expect(select).toHaveValue(filename);
  await expect.poll(() => readGuest(app, 'document.querySelector("h1")?.textContent')).toBe("Original file opened");
  expect(await guest(app, "decodeURIComponent(location.pathname.slice(1))")).toBe(filename);
  fs.unlinkSync(path.join(repo, filename));
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler("files:list");
    ipcMain.handle("files:list", () => ({ paths: [], truncated: false }));
  });
  await expect(tid(page, "canvas-error")).toBeVisible();
  await expect(select.locator("option")).toHaveCount(2);
  await expect(select).toHaveValue(filename);
  await expect(option).toHaveAttribute("label", "TOKEN=[redacted]");
});

test("an explicit Canvas reload is honored while a refresh poll is pending", async () => {
  await page.getByLabel("Canvas file").selectOption("preview.html");
  await expect.poll(() => readGuest(app, 'document.querySelector("#count")?.textContent')).toBe("0");
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
  await expect.poll(() => readGuest(app, 'document.querySelector("#count")?.textContent')).toBe("0");
});

test("a late Canvas reload response cannot restore a cleared selection", async () => {
  await page.getByLabel("Canvas file").selectOption("preview.html");
  await expect.poll(() => readGuest(app, 'document.querySelector("#count")?.textContent')).toBe("0");
  await app.evaluate(({ app, ipcMain }) => {
    const require = process.getBuiltinModule("module").createRequire(`${app.getAppPath()}/package.json`);
    const { WorkspaceCanvas } = require("./dist/src/main/workspace-canvas.js");
    const original = WorkspaceCanvas.prototype.state;
    let held = false;
    let release: (() => void) | undefined;
    WorkspaceCanvas.prototype.state = async function (id: string, reload: boolean) {
      if (!reload) return original.call(this, id, reload);
      WorkspaceCanvas.prototype.state = original;
      held = true;
      await new Promise<void>(resolve => { release = resolve; });
      return { path: "preview.html", loading: false, error: "stale reload failure" };
    };
    ipcMain.handle("test:canvas-reload-held", () => held);
    ipcMain.handle("test:canvas-reload-release", () => { release?.(); });
  });
  await page.getByRole("button", { name: "Reload Canvas", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.modex.invoke("test:canvas-reload-held" as never))).toBe(true);
  await page.getByLabel("Canvas file").selectOption("");
  await page.evaluate(() => window.modex.invoke("test:canvas-reload-release" as never));
  // Drain the IPC response and a renderer paint before asserting stale state stays absent.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.getByLabel("Canvas file")).toHaveValue("");
  await expect(tid(page, "canvas-error")).toHaveCount(0);
});
