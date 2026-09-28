import { app, BrowserWindow, dialog, ipcMain, shell, nativeTheme, safeStorage, screen } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Store } from "./engine/store.js";
import { ThreadRunner } from "./engine/runner.js";
import * as gitx from "./engine/git.js";
import { runDemo } from "./engine/demo.js";
import { openTerminal } from "./engine/open-terminal.js";
import { TerminalManager, isTrustedTerminalSender } from "./engine/terminal.js";
import { SecretStore, electronCipher, testCipher } from "./engine/secrets.js";
import { hydratePath } from "./engine/shell-env.js";
import { initialBounds, readWindowState, writeWindowState } from "./engine/window-state.js";
import type { BackendId, BridgeCommands, ThreadEvent } from "../shared/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(1);
const flag = (name: string): string | undefined => {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  return hit.includes("=") ? hit.slice(hit.indexOf("=") + 1) : "true";
};

const demo = flag("demo");
const screenshotDir = flag("screenshot");
const home = demo ? fs.mkdtempSync(path.join(os.tmpdir(), "modex-demo-")) : process.env.MODEX_HOME ?? path.join(os.homedir(), ".modex");
fs.mkdirSync(home, { recursive: true });
// An isolated home (e2e, demo) also gets its own Chromium profile, so renderer preferences in
// localStorage (panel layout) and window-state.json never leak between runs or into the user's real app.
if (demo || process.env.MODEX_HOME) app.setPath("userData", path.join(home, "electron"));

// A Finder/Dock launch inherits launchd's minimal PATH, which hides claude, codex, and jev.
// Resolve the user's login-shell PATH once, in the background, and make every channel that
// spawns a CLI wait for it (see SPAWNS below) so the first turn never races it.
const pathReady = hydratePath(process.env).then(
  (r) => { if (r.via === "none") console.error("[modex] could not read the login-shell PATH; using", r.merged); return r; },
  (err: Error) => { console.error("[modex] login-shell PATH failed:", err.message); return null; },
);

process.env.MODEX_VERSION ??= app.getVersion();
const store = new Store(home);
let win: BrowserWindow | null = null;
let shuttingDown = false;
let shutdownComplete = false;
const emit = (event: ThreadEvent): void => {
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send("thread:event", event);
};
// The e2e harness has no keychain to unlock; everything else goes through the OS keychain.
const secrets = new SecretStore(home, process.env.MODEX_E2E ? testCipher : electronCipher(safeStorage));
const runner = new ThreadRunner({ home, store, emit, secrets, beforeDeleteThread: (id) => terminals.close(id) });

type Handler<K extends keyof BridgeCommands> = (req: BridgeCommands[K]["req"]) => Promise<BridgeCommands[K]["res"]> | BridgeCommands[K]["res"];
/** Channels that can start a CLI (claude, codex, jev, a project's worktree script). */
const SPAWNS = new Set<keyof BridgeCommands>(["thread:create", "thread:send", "terminal:open", "models:list", "backends:health", "routing:status", "routing:reset", "routing:setKey", "routing:clearKey", "routing:test"]);

function handle<K extends keyof BridgeCommands>(channel: K, fn: Handler<K>): void {
  ipcMain.handle(channel, async (event, req) => {
    if (shuttingDown) throw new Error("Modex is shutting down.");
    if (SPAWNS.has(channel)) await pathReady;
    if (shuttingDown) throw new Error("Modex is shutting down.");
    // A shell is full user authority: only the app's own window, top frame, may drive one.
    if (channel.startsWith("terminal:") && !isTrustedTerminalSender(event, win)) throw new Error("Untrusted terminal request.");
    return fn(req as BridgeCommands[K]["req"]);
  });
}

function cwdFor(threadId: string): string {
  const t = store.thread(threadId);
  if (!t) throw new Error(`unknown thread ${threadId}`);
  return t.cwd;
}

/** Embedded shells, one per thread, started in the thread's working directory. */
const terminals = new TerminalManager(
  (id) => { runner.assertThreadAvailable(id); return cwdFor(id); },
  (event) => { if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send("terminal:event", event); },
  undefined,
  process.env.MODEX_E2E ? { ...process.env, BASH_SILENCE_DEPRECATION_WARNING: "1" } : process.env,
  // e2e types into the shell: a plain bash, not the user's login shell and its rc files.
  process.env.MODEX_E2E ? { file: "/bin/bash", args: ["--noprofile", "--norc"] } : undefined,
);

handle("state:get", () => {
  const state = store.snapshot();
  return { ...state, threads: state.threads.map((t) => ({ ...t, status: runner.status(t.id) })) };
});
handle("project:add", async (req) => {
  let dir = req?.path;
  if (!dir) {
    const r = await dialog.showOpenDialog(win!, { properties: ["openDirectory", "createDirectory"], title: "Open a project folder" });
    if (r.canceled || !r.filePaths[0]) return null;
    dir = r.filePaths[0];
  }
  return store.addProject(dir);
});
handle("project:remove", async ({ projectId }) => {
  await runner.removeProject(projectId);
  return store.snapshot();
});
handle("thread:create", ({ projectId, worktree, mode, model, backend, auto }) => runner.createThread(projectId, { worktree, mode, model, backend, auto }));
handle("thread:items", ({ threadId }) => runner.items(threadId));
handle("thread:send", async ({ threadId, text }) => {
  try {
    void runner.send(threadId, text).catch((err: Error) => emit({ threadId, type: "item", item: { id: `err-${Date.now()}`, kind: "notice", level: "error", text: err.message, at: new Date().toISOString() } }));
    // Give the runner a tick to reject synchronously-detectable problems (busy thread, missing cwd).
    await new Promise((r) => setTimeout(r, 0));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
});
handle("thread:stop", ({ threadId }) => runner.stop(threadId));
handle("thread:answer", ({ threadId, itemId, answer }) => runner.answer(threadId, itemId, answer));
handle("thread:update", ({ threadId, patch }) => runner.updateThread(threadId, patch));
handle("thread:delete", async ({ threadId, removeWorktree }) => {
  await runner.deleteThread(threadId, removeWorktree);
  return store.snapshot();
});
handle("project:branch", async ({ projectId }) => {
  const p = store.project(projectId);
  return p && (await gitx.isRepo(p.path)) ? gitx.currentBranch(p.path) : null;
});
handle("changes:status", ({ threadId }) => gitx.status(cwdFor(threadId)));
handle("changes:diff", ({ threadId, path: rel }) => gitx.diff(cwdFor(threadId), rel));
handle("changes:revert", async ({ threadId, path: rel }) => {
  const cwd = cwdFor(threadId);
  await gitx.revert(cwd, rel);
  return gitx.status(cwd);
});
handle("settings:update", (patch) => store.updateSettings(patch));
handle("models:list", ({ backend }) => runner.listModels(backend));
handle("routing:status", () => runner.router.status());
handle("routing:reset", () => {
  runner.router.fit.reset();
  return runner.router.status();
});
handle("routing:setKey", ({ key }) => runner.router.setKey(key));
handle("routing:clearKey", () => runner.router.clearKey());
handle("routing:test", () => runner.router.test());
handle("backends:health", async () => {
  const out = {} as Record<BackendId, { ok: boolean; detail: string }>;
  for (const id of ["claude", "codex", "mock"] as BackendId[]) {
    const r = await runner.listModels(id);
    out[id] = r.error ? { ok: false, detail: r.error } : { ok: true, detail: `${r.models.length} model${r.models.length === 1 ? "" : "s"}` };
  }
  return out;
});
handle("shell:openPath", async ({ path: p }) => {
  const err = await shell.openPath(p);
  if (err) throw new Error(err);
});
handle("shell:openTerminal", ({ path: p }) => openTerminal(p));
handle("terminal:open", ({ threadId, cols, rows }) => terminals.open(threadId, cols, rows));
handle("terminal:write", ({ threadId, sessionId, data }) => terminals.write(threadId, sessionId, data));
handle("terminal:resize", ({ threadId, sessionId, cols, rows }) => terminals.resize(threadId, sessionId, cols, rows));
handle("terminal:close", ({ threadId, sessionId }) => terminals.close(threadId, sessionId));

function createWindow(): BrowserWindow {
  nativeTheme.themeSource = "dark";
  const devUrl = process.env.MODEX_DEV_URL;
  const appPage = devUrl ? new URL(devUrl) : pathToFileURL(path.join(here, "..", "..", "renderer", "index.html"));
  // The demo captures fixed-size screenshots, so only real (and e2e) launches restore geometry.
  const min = { width: 900, height: 600 };
  const saved = demo ? null : readWindowState(home);
  const bounds = initialBounds(saved, screen.getAllDisplays().map((d) => d.workArea), min);
  const w = new BrowserWindow({
    ...bounds,
    minWidth: min.width,
    minHeight: min.height,
    title: "Modex",
    backgroundColor: "#0f0f11", // --bg-main: no colour flash before the renderer paints
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    // e2e captures run at the 1786×1049 reference size; CI runners have smaller displays, and macOS
    // otherwise clamps the window to the screen (1024×677 on the GitHub macOS runner).
    enableLargerThanScreen: Boolean(process.env.MODEX_E2E),
    trafficLightPosition: { x: 14, y: 14 }, // centred in the 42 px titlebar (reference: lights at y 14–25)
    show: false,
    webPreferences: { preload: path.join(here, "preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  if (devUrl) void w.loadURL(devUrl);
  else void w.loadFile(path.join(here, "..", "..", "renderer", "index.html"));
  w.once("ready-to-show", () => {
    if (saved?.maximized) w.maximize();
    if (saved?.fullscreen) w.setFullScreen(true);
    // Under test the window must not take the keyboard: Playwright drives it over CDP, and a test
    // window that becomes active swallows whatever the developer is typing elsewhere (it reached a
    // real shell in the terminal panel). showInactive still emits "show", which the launch helper awaits.
    if (process.env.MODEX_E2E) w.showInactive();
    else w.show();
  });
  // getNormalBounds: a maximized or full-screen window remembers the size it returns to.
  if (!demo) w.on("close", () => {
    try {
      writeWindowState(home, { ...w.getNormalBounds(), maximized: w.isMaximized(), fullscreen: w.isFullScreen() });
    } catch (err) {
      console.error("[modex] could not save window state:", (err as Error).message);
    }
  });
  w.on("closed", () => { if (win === w) win = null; });
  w.webContents.on("render-process-gone", () => { if (!w.isDestroyed()) w.destroy(); });
  // The window keeps its preload (and so terminal access) across navigations: never leave the app page.
  w.webContents.on("will-navigate", (event, url) => {
    const next = new URL(url);
    const sameAppPage = next.protocol === appPage.protocol
      && next.pathname === appPage.pathname
      && (appPage.protocol === "file:" || next.origin === appPage.origin);
    if (!sameAppPage) event.preventDefault();
  });
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  return w;
}

app.whenReady().then(async () => {
  win = createWindow();
  if (demo) {
    if (screenshotDir) setTimeout(() => { console.error("[modex] demo watchdog fired"); app.exit(2); }, 45_000).unref();
    await new Promise<void>((r) => win!.webContents.once("did-finish-load", () => r()));
    await runDemo({ store, runner, home, repoPath: path.resolve(here, "..", "..", "..", "..", ".."), screenshotDir, answer: flag("demo-answer"), capture: (name) => capture(name) });
    if (screenshotDir) app.quit();
  }
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) win = createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin" || screenshotDir) app.quit();
});
app.on("before-quit", (event) => {
  if (shutdownComplete) return;
  event.preventDefault();
  if (shuttingDown) return;
  shuttingDown = true;
  void Promise.allSettled([terminals.dispose(), runner.dispose()]).then((results) => {
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") {
      shuttingDown = false;
      console.error("[modex] shutdown failed:", failure.reason);
      dialog.showErrorBox("Modex could not finish quitting", "A running command could not be stopped. Your working directories have been preserved. Quit again to retry.");
      return;
    }
    shutdownComplete = true;
    app.quit();
  });
});

async function capture(name: string): Promise<string> {
  if (!win || !screenshotDir) return "";
  fs.mkdirSync(screenshotDir, { recursive: true });
  const image = await win.webContents.capturePage();
  const file = path.join(screenshotDir, `${name}.png`);
  fs.writeFileSync(file, image.toPNG());
  return file;
}
