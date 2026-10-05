import { cliHealth, resolveCli } from "./engine/cli-path.js";
import { THEMES } from "../shared/theme.js";
import { ReleaseChecker } from "./engine/updates.js";
import { app, BrowserWindow, clipboard, dialog, ipcMain, shell, nativeTheme, safeStorage, screen, Menu, MenuItem } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Store } from "./engine/store.js";
import { saveSettings } from "./engine/settings-update.js";
import { ThreadRunner } from "./engine/runner.js";
import { ChatGPTAuth } from "./engine/chatgpt-auth.js";
import { AccountCodexBackend } from "./engine/backends/account-codex.js";
import { ClaudeLogin } from "./engine/claude-login.js";
import * as gitx from "./engine/git.js";
import { runDemo } from "./engine/demo.js";
import { openTerminal } from "./engine/open-terminal.js";
import { TerminalManager, isTrustedTerminalSender } from "./engine/terminal.js";
import { SecretStore, electronCipher, testCipher } from "./engine/secrets.js";
import { hydratePath } from "./engine/shell-env.js";
import { initialBounds, readWindowState, writeWindowState } from "./engine/window-state.js";
import { CompanionServer } from "./engine/companion.js";
import { DesktopHost } from "./engine/desktop-host.js";
import { desktopSystem } from "./engine/desktop-discovery.js";
import QRCode from "qrcode";
import type { BackendId, BridgeCommands, CompanionStatus, ThreadEvent } from "../shared/types.js";
import { describeFailure } from "../shared/failures.js";
import { previewApproval, validateRules } from "./engine/approvals/preview.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(1);
const flag = (name: string): string | undefined => {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  return hit.includes("=") ? hit.slice(hit.indexOf("=") + 1) : "true";
};

const demo = flag("demo");
const screenshotDir = flag("screenshot");
// Electron resolves app.getName() from the packaged metadata, which can still be the
// shared Modex product name even when this bundle is the signed Host Preview. The
// executable path is stable for this companion bundle and keeps the host self-starting
// when it is opened directly from Finder or by the Store client.
const hostPreview = app.isPackaged && (app.getName() === "Modex Host Preview" || /Modex Host Preview\.app[\\/]/.test(process.execPath));
const hostPreviewHome = path.join(os.homedir(), "Library", "Application Support", "Modex Host Preview");
const home = demo ? fs.mkdtempSync(path.join(os.tmpdir(), "modex-demo-")) : process.env.MODEX_HOME ?? (hostPreview ? hostPreviewHome : path.join(os.homedir(), ".modex"));
fs.mkdirSync(home, { recursive: true });
// The scripted demo and screenshots must never discover a real Jev key or call the network.
if (demo) {
  process.env.TYPESAFE_API_KEY = "";
  process.env.JEV_API_KEY = "";
  process.env.JEV_CONFIG = path.join(home, "no-jev-config.json");
  process.env.MODEX_NO_LOGIN_PATH = "1";
}
// An isolated home (e2e, demo) also gets its own Chromium profile, so renderer preferences in
// localStorage (panel layout) and window-state.json never leak between runs or into the user's real app.
if (demo || process.env.MODEX_HOME) app.setPath("userData", path.join(home, "electron"));

if (!demo && !app.requestSingleInstanceLock()) app.exit(0);

// A Finder/Dock launch inherits launchd's minimal PATH, which hides claude, codex, and jev.
// Resolve the user's login-shell PATH once, in the background, and make every channel that
// spawns a CLI wait for it (see SPAWNS below) so the first turn never races it.
const pathReady = hydratePath(process.env).then(
  (r) => { if (r.via === "none") console.error("[modex] could not read the login-shell PATH; using", r.merged); return r; },
  (err: Error) => { console.error("[modex] login-shell PATH failed:", err.message); return null; },
);

process.env.MODEX_VERSION ??= app.getVersion();
const store = new Store(home);
const updates = new ReleaseChecker({
  currentVersion: app.getVersion(), platform: process.platform, arch: process.arch,
  enabled: app.isPackaged && !demo && !process.env.MODEX_E2E,
});
let win: BrowserWindow | null = null;
let shuttingDown = false;
let shutdownComplete = false;
let desktopHost: DesktopHost | undefined;
const emit = (event: ThreadEvent): void => {
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send("thread:event", event);
  desktopHost?.broadcast("thread", event);
};
// The e2e harness has no keychain to unlock; everything else goes through the OS keychain.
const secrets = new SecretStore(home, process.env.MODEX_E2E ? testCipher : electronCipher(safeStorage));
// Settings reads ChatGPT status in packaged e2e too; keep its test home off the OS keychain.
const osCipher = process.env.MODEX_E2E ? testCipher : electronCipher(safeStorage);
const chatgptCipher = { ...osCipher, available: () => osCipher.available() && (process.platform !== "linux" || safeStorage.getSelectedStorageBackend() !== "basic_text") };
const chatgpt = new ChatGPTAuth({ home, cipher: chatgptCipher, openBrowser: (url) => shell.openExternal(url) });
const sessionCliSettings = store.settings;
const accountCodex = new AccountCodexBackend(chatgpt, () => resolveCli("codex", sessionCliSettings.codex_bin));
process.env.MODEX_VERSION = app.getVersion();
const runner = new ThreadRunner({ home, store, emit, secrets, backends: { codex: accountCodex }, beforeDeleteThread: (id) => terminals.close(id) });
const companion = new CompanionServer(home, {
  state: () => store.snapshot(),
  items: (id) => runner.items(id),
  status: (id) => runner.status(id),
  send: async (id, text) => { await pathReady; return startTurn(id, runner.send(id, text)); },
  answer: (id, itemId, answer) => runner.answer(id, itemId, answer),
});
const companionView = async (status: CompanionStatus): Promise<CompanionStatus> => ({
  ...status,
  ...(status.pairingUri ? { qrDataUrl: await QRCode.toDataURL(status.pairingUri, { width: 360, margin: 2, color: { dark: "#17191d", light: "#ffffff" } }) } : {}),
});

type Handler<K extends keyof BridgeCommands> = (req: BridgeCommands[K]["req"]) => Promise<BridgeCommands[K]["res"]> | BridgeCommands[K]["res"];
/** Channels that can start a CLI (claude, codex, jev, a project's worktree script). */
const SPAWNS = new Set<keyof BridgeCommands>(["settings:update", "thread:create", "thread:send", "thread:retry", "thread:followup", "terminal:open", "models:list", "backends:health", "routing:status", "routing:reset", "routing:setKey", "routing:clearKey", "routing:test", "approvals:try"]);
const desktopCommands = new Map<string, (payload: unknown) => unknown>();

function handle<K extends keyof BridgeCommands>(channel: K, fn: Handler<K>): void {
  desktopCommands.set(channel, (payload) => fn(payload as BridgeCommands[K]["req"]));
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
  (event) => {
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send("terminal:event", event);
    desktopHost?.broadcast("terminal", event);
  },
  undefined,
  process.env.MODEX_E2E ? { ...process.env, BASH_SILENCE_DEPRECATION_WARNING: "1" } : process.env,
  // e2e types into the shell: a plain bash, not the user's login shell and its rc files.
  process.env.MODEX_E2E ? { file: "/bin/bash", args: ["--noprofile", "--norc"] } : undefined,
);

handle("updates:check", () => updates.check());

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
handle("thread:followup", ({ threadId }) => runner.followUp(threadId));
/**
 * Starts a turn without waiting for it. A rejection the runner can detect up front (busy thread,
 * missing cwd, nothing to retry) is returned to the caller, as in PR #61. Accepted turns
 * report their failures through the runner's persisted failure card.
 */
async function startTurn(threadId: string, run: Promise<void>): Promise<{ ok: boolean; error?: string }> {
  let accepting = true;
  let earlyError: string | undefined;
  run.catch((err: Error) => {
    if (accepting) { earlyError = err.message; return; }
    const thread = store.thread(threadId);
    const failure = describeFailure({ backend: thread?.backend ?? "mock", message: err.message, context: { at: new Date().toISOString(), modex: process.env.MODEX_VERSION, platform: `${process.platform} ${process.arch}`, threadId, cwd: thread?.cwd } });
    emit({ threadId, type: "item", item: { id: `err-${Date.now()}`, kind: "notice", level: "error", text: failure.summary, failure: { ...failure, retryable: false }, at: new Date().toISOString() } });
  });
  // Give the runner a tick to reject synchronously-detectable problems (busy thread, missing cwd).
  await new Promise((r) => setTimeout(r, 0));
  accepting = false;
  return earlyError !== undefined ? { ok: false, error: earlyError } : { ok: true };
}
handle("thread:send", ({ threadId, text }) => startTurn(threadId, runner.send(threadId, text)));
handle("thread:retry", ({ threadId }) => startTurn(threadId, runner.retry(threadId)));
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
handle("changes:diff", ({ threadId, path: rel, original }) => gitx.diff(cwdFor(threadId), rel, original));
handle("changes:revert", async ({ threadId, path: rel }) => {
  const cwd = cwdFor(threadId);
  await gitx.revert(cwd, rel);
  return gitx.status(cwd);
});
handle("settings:update", async (patch) => {
  const settings = await saveSettings(store, runner.router, {
    ...patch,
    ...(patch.approval_rules !== undefined ? { approval_rules: validateRules(patch.approval_rules) } : {}),
  });
  win?.setBackgroundColor(THEMES[settings.theme].background);
  return settings;
});
handle("approvals:rules:get", () => store.snapshot().settings.approval_rules);
handle("approvals:rules:set", ({ rules }) => store.updateSettings({ approval_rules: validateRules(rules) }).approval_rules);
handle("approvals:try", (req) => previewApproval(req, {
  project: (id) => store.project(id), config: store.snapshot().settings.approval_gate,
  jev: () => runner.router.jev(),
}));
handle("models:list", ({ backend }) => runner.listModels(backend));
handle("chatgpt:status", () => chatgpt.status());
handle("chatgpt:signIn", async ({ accountId }) => {
  try {
    if (accountId) await accountCodex.accountChange(accountId, () => chatgpt.signIn(accountId));
    else await chatgpt.signIn();
    return chatgpt.status();
  } catch { throw new Error("ChatGPT sign-in did not complete. Finish active turns, check protected storage, or retry authorization."); }
});
handle("chatgpt:cancel", () => chatgpt.cancel());
handle("chatgpt:select", ({ accountId }) => { chatgpt.select(accountId); return chatgpt.status(); });
handle("chatgpt:signOut", async ({ accountId }) => {
  const detail = await accountCodex.accountChange(accountId, () => chatgpt.signOut(accountId)); return { status: chatgpt.status(), detail };
});
const claudeLogin = new ClaudeLogin();
SPAWNS.add("claude:login");
handle("claude:login", () => claudeLogin.run(resolveCli("claude", sessionCliSettings.claude_bin)));
handle("claude:cancelLogin", () => claudeLogin.cancel());
handle("routing:status", () => runner.router.status());
handle("routing:reset", () => {
  runner.router.fit.reset();
  return runner.router.status();
});
handle("routing:setKey", ({ key }) => runner.router.setKey(key));
handle("routing:clearKey", () => runner.router.clearKey());
handle("routing:test", () => runner.router.test());
handle("backends:health", async () => {
  const entries = await Promise.all((["claude", "codex", "mock"] as BackendId[]).map(async (id) => {
    const backend = runner.backend(id);
    const status = backend.health ? await (id === "mock" ? backend.health() : cliHealth(id, sessionCliSettings[`${id}_bin`], () => backend.health!())) : { executable: "available" as const, authentication: "unknown" as const, access: "unverified" as const, detail: "Offline demo · no account" };
    return [id, status] as const;
  }));
  return Object.fromEntries(entries) as BridgeCommands["backends:health"]["res"];
});
handle("companion:status", () => companionView(companion.status()));
handle("companion:start", async () => companionView(await companion.start()));
handle("companion:stop", async () => companionView(await companion.stop()));
handle("companion:reset", () => companionView(companion.resetAccess()));
handle("shell:openPath", async ({ path: p }) => {
  const err = await shell.openPath(p);
  if (err) throw new Error(err);
});
handle("shell:openTerminal", ({ path: p }) => openTerminal(p));
handle("clipboard:write", ({ text }) => { clipboard.writeText(String(text).slice(0, 200_000)); });
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
    backgroundColor: THEMES[store.settings.theme].background, // Match the saved canvas before first paint.
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

let startingDesktopHost: Promise<void> | undefined;
function startDesktopHost(): Promise<void> {
  if (demo || desktopHost) return Promise.resolve();
  if (startingDesktopHost) return startingDesktopHost;
  startingDesktopHost = (async () => {
    let discoveryDirectory: string | undefined;
    if (!app.isPackaged && process.env.MODEX_E2E && process.env.MODEX_DESKTOP_DISCOVERY_DIR) discoveryDirectory = process.env.MODEX_DESKTOP_DISCOVERY_DIR;
    else if (app.isPackaged && process.platform === "darwin") {
      try { discoveryDirectory = path.join(await desktopSystem("directory"), "desktop-hosts"); }
      catch { console.warn("[modex] system discovery unavailable; manual desktop links remain available"); }
    }
    desktopHost = new DesktopHost(home, {
      version: app.getVersion(),
      channels: () => [...desktopCommands.keys()],
      authorize: async (confirmationCode, signal) => {
        if (!win || win.isDestroyed()) win = createWindow();
        win.show(); win.focus();
        const result = await dialog.showMessageBox(win, { type: "question", title: "Connect Modex on this Mac", message: `Does your desktop show ${confirmationCode}?`, detail: "Approve only if this code matches the Modex connection screen you just opened. This gives that desktop access to your projects, coding agents, existing CLI sign-ins, terminals, settings and approvals. Access stays saved until you revoke it from Desktop access.", buttons: ["Cancel", "Allow this desktop"], defaultId: 0, cancelId: 0, signal });
        return result.response === 1 && !signal.aborted;
      },
      invoke: async (channel, payload, authorized) => {
        if (SPAWNS.has(channel as keyof BridgeCommands)) await pathReady;
        if (shuttingDown || !authorized()) throw new Error("Desktop host access is unavailable.");
        const command = desktopCommands.get(channel);
        if (!command) throw new Error("Unknown desktop command.");
        return command(payload);
      },
    }, discoveryDirectory);
    try {
      await desktopHost.start();
      const menu = Menu.getApplicationMenu() ?? Menu.buildFromTemplate([{ role: "appMenu" }, { role: "editMenu" }, { role: "viewMenu" }, { role: "windowMenu" }]);
      menu.append(new MenuItem({ label: "Desktop access", submenu: [
        { label: "Pair a desktop…", click: () => { void (async () => {
          const result = await dialog.showMessageBox(win!, { type: "info", title: "Connect a trusted desktop", message: "Allow a desktop to use this Mac host", detail: "A connected desktop can manage projects, run coding agents and terminals, change settings, and review approvals. Copy this link only into a desktop app you trust. The link works once and expires in five minutes. You can revoke access from this menu.", buttons: ["Cancel", "Copy connection link"], defaultId: 0, cancelId: 0 });
          if (result.response === 1) clipboard.writeText(desktopHost!.invite());
        })().catch((error: Error) => dialog.showErrorBox("Desktop pairing failed", error.message)); } },
        { label: "Manage connected desktops…", click: () => { void (async () => {
          const clients = desktopHost!.clients();
          const result = await dialog.showMessageBox(win!, { type: "info", title: "Connected desktops", message: clients.length ? "Remove a desktop's host access" : "No desktops are connected", detail: clients.length ? "Revoking access disconnects that desktop and prevents further commands. Coding turns already accepted by this host remain owned by the host." : "Use Pair a desktop to create a one-time connection link.", buttons: ["Done", ...clients.map((client, i) => `Revoke ${client.name} (${i + 1})`)], defaultId: 0, cancelId: 0 });
          const selected = clients[result.response - 1];
          if (selected) desktopHost!.revoke(selected.id);
        })().catch((error: Error) => dialog.showErrorBox("Desktop access could not be changed", error.message)); } },
      ] }));
      Menu.setApplicationMenu(menu);
    } catch (error) {
      await desktopHost.dispose();
      desktopHost = undefined;
      console.error("[modex] desktop host could not start:", (error as Error).message);
      dialog.showErrorBox("Desktop host could not start", "Its local port may already be in use. Quit the other Modex host and try again.");
    }
  })().finally(() => { startingDesktopHost = undefined; });
  return startingDesktopHost;
}

app.on("second-instance", (_event, args) => {
  void app.whenReady().then(async () => {
    if (!win || win.isDestroyed()) win = createWindow();
    if (args.includes("--desktop-host")) await startDesktopHost();
    win.show(); win.focus();
  });
});

app.whenReady().then(async () => {
  win = createWindow();
  if ((flag("desktop-host") || hostPreview) && !demo) await startDesktopHost();
  if (!demo && companion.shouldStart) void companion.start().catch((err: Error) => console.error("[modex] companion could not start:", err.message));
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
  chatgpt.cancel();
  claudeLogin.cancel();
  if (shutdownComplete) return;
  event.preventDefault();
  if (shuttingDown) return;
  shuttingDown = true;
  void Promise.allSettled([desktopHost?.dispose(), companion.dispose(), terminals.dispose(), runner.dispose()]).then((results) => {
    chatgpt.dispose();
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
