import { app, BrowserWindow, clipboard, ipcMain, nativeTheme, safeStorage, shell, type IpcMainInvokeEvent } from "electron";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DesktopClient, type DesktopCredentials } from "../../../desktop/src/main/engine/desktop-client.js";
import { desktopSystem, discoverDesktops } from "../../../desktop/src/main/engine/desktop-discovery.js";
import { WorkspaceBrowser } from "../../../desktop/src/main/workspace-browser.js";
import type { BridgeCommands } from "../../../desktop/src/shared/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const testing = !app.isPackaged && process.env.MODEX_E2E === "1";
if (testing && process.env.MODEX_STORE_HOME) app.setPath("userData", process.env.MODEX_STORE_HOME);
let win: BrowserWindow | undefined;
let workspaceBrowser: WorkspaceBrowser | undefined;
let client: DesktopClient;
let pairing = false;
let storageError: string | undefined;
let connectedBefore = false;
function trusted(event: IpcMainInvokeEvent): void {
  if (!win || win.isDestroyed() || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error("Untrusted desktop request.");
}
function send(channel: string, value?: unknown): void { if (win && !win.isDestroyed()) win.webContents.send(channel, value); }

app.whenReady().then(() => {
  const home = app.getPath("userData");
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const credentialsFile = path.join(home, "host-access.enc");
  const identityFile = path.join(home, "installation-id");
  let clientId = fs.existsSync(identityFile) ? fs.readFileSync(identityFile, "utf8") : "";
  if (!/^[a-f0-9]{64}$/.test(clientId)) {
    clientId = crypto.randomBytes(32).toString("hex");
    fs.writeFileSync(identityFile, clientId, { mode: 0o600 });
  }
  client = new DesktopClient((credentials) => {
    if (!credentials) { fs.rmSync(credentialsFile, { force: true }); return; }
    if (!testing && !safeStorage.isEncryptionAvailable()) throw new Error("Unlock your Mac keychain before pairing.");
    const data = JSON.stringify(credentials);
    const encrypted = testing ? Buffer.from(data) : safeStorage.encryptString(data);
    fs.writeFileSync(`${credentialsFile}.tmp`, encrypted, { mode: 0o600 });
    fs.renameSync(`${credentialsFile}.tmp`, credentialsFile);
  });
  client.on("status", (status) => {
    if (status.state !== "connected") workspaceBrowser?.show(null);
    send("host:status", status);
  });
  client.on("thread", (event) => send("thread:event", event));
  client.on("terminal", (event) => send("terminal:event", event));
  client.on("connected", () => { if (connectedBefore) send("host:reconnected"); connectedBefore = true; });
  const system = (async () => {
    if (testing) return { directory: process.env.MODEX_DESKTOP_DISCOVERY_DIR, installed: undefined };
    if (!app.isPackaged || process.platform !== "darwin") return { directory: undefined, installed: undefined };
    const directory = await desktopSystem("directory").then((value) => path.join(value, "desktop-hosts")).catch(() => undefined);
    const adjacent = path.resolve(app.getPath("exe"), "../../../..", "Modex Host Preview.app");
    const installed = await desktopSystem("installed", adjacent).catch(() => undefined);
    return { directory, installed };
  })();
  const discover = async () => {
    const { directory, installed } = await system;
    const hosts = directory ? await discoverDesktops(directory) : [];
    return { hosts, installed };
  };
  ipcMain.handle("host:status", (event) => { trusted(event); return storageError ? { state: "unpaired", detail: storageError } : client.status(); });
  ipcMain.handle("host:discover", async (event) => {
    trusted(event);
    const { hosts, installed } = await discover();
    return { available: hosts.length === 1, installed: !!installed && hosts.length === 0,
      detail: hosts.length > 1 ? "More than one host is open. Close the unused host, then check again." : hosts.length === 1 ? "Modex is running on this Mac. Your projects and CLI sign-ins are ready to connect." : installed ? "Modex is installed on this Mac. Open it and connect your workspace." : "Open the current Modex host preview on this Mac, then check again." };
  });
  ipcMain.handle("host:connect", async (event) => {
    trusted(event);
    if (pairing) throw new Error("A connection is already in progress.");
    pairing = true;
    try {
      let { hosts, installed } = await discover();
      if (hosts.length === 0 && installed) {
        await desktopSystem("launch", installed);
        for (let attempt = 0; attempt < 30 && hosts.length === 0; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 300));
          hosts = (await discover()).hosts;
        }
      }
      if (hosts.length !== 1) throw new Error(hosts.length ? "Close the unused host and try again." : "The host is not ready. Open Modex and check again.");
      await client.connectLocal(hosts[0]!, clientId);
      storageError = undefined;
    } finally { pairing = false; }
  });
  ipcMain.handle("host:pair", async (event, uri: unknown) => {
    trusted(event);
    if (typeof uri !== "string" || uri.length > 512) throw new Error("Paste a connection link from the host.");
    if (pairing) throw new Error("A connection is already in progress.");
    pairing = true;
    try { await client.pair(uri, clientId); storageError = undefined; } finally { pairing = false; }
  });
  ipcMain.handle("host:disconnect", (event) => { trusted(event); client.disconnect(); storageError = undefined; });
  ipcMain.handle("store:invoke", async (event, request: { channel?: unknown; payload?: unknown }) => {
    trusted(event);
    if (!request || typeof request.channel !== "string" || request.channel.length > 80) throw new Error("Invalid workspace action.");
    if (request.channel === "browser:command") {
      const payload = request.payload as BridgeCommands["browser:command"]["req"];
      if (payload.action !== "close" && client.status().state !== "connected") throw new Error("Connect to your Mac to use the workspace browser.");
      if (!workspaceBrowser) throw new Error("Browser unavailable.");
      return workspaceBrowser.command(payload.id, payload.action, payload.url);
    }
    if (request.channel === "browser:show") {
      const payload = request.payload as BridgeCommands["browser:show"]["req"];
      return workspaceBrowser?.show(client.status().state === "connected" ? payload.id : null, payload.bounds, payload.fullView);
    }
    if (request.channel === "updates:check") return null; // Store-owned updates only.
    if (request.channel === "clipboard:write") {
      const payload = request.payload as { text?: unknown };
      if (typeof payload?.text !== "string") throw new Error("Invalid clipboard text.");
      clipboard.writeText(payload.text.slice(0, 200_000)); return;
    }
    return client.invoke(request.channel, request.payload);
  });
  function createWindow(): void {
    nativeTheme.themeSource = "dark";
    win = new BrowserWindow({ width: 1380, height: 880, minWidth: 900, minHeight: 600, title: "Modex", backgroundColor: "#080c17", titleBarStyle: "hiddenInset", trafficLightPosition: { x: 14, y: 14 }, show: false,
      webPreferences: { preload: path.join(here, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true } });
    const browser = new WorkspaceBrowser(win);
    workspaceBrowser = browser;
    win.webContents.on("did-start-navigation", () => browser.dispose());
    win.webContents.on("render-process-gone", () => browser.dispose());
    win.on("close", () => browser.dispose());
    win.on("closed", () => { browser.dispose(); if (workspaceBrowser === browser) workspaceBrowser = undefined; });
    win.webContents.on("will-navigate", (event) => event.preventDefault());
    win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) void shell.openExternal(url); return { action: "deny" }; });
    win.once("ready-to-show", () => { if (testing) win?.showInactive(); else win?.show(); });
    win.on("closed", () => { win = undefined; });
    void win.loadFile(path.join(app.getAppPath(), "dist/renderer/index.html"));
  }
  createWindow();
  if (fs.existsSync(credentialsFile)) {
    try {
      if (!testing && !safeStorage.isEncryptionAvailable()) throw new Error("Keychain unavailable");
      const encrypted = fs.readFileSync(credentialsFile);
      if (encrypted.length > 16_384) throw new Error("Invalid access file");
      const credentials = JSON.parse(testing ? encrypted.toString() : safeStorage.decryptString(encrypted)) as DesktopCredentials;
      client.start(credentials);
    } catch { storageError = "Saved host access could not be opened. Unlock your Mac keychain, or pair again."; }
  }
  app.on("activate", () => { if (!win) createWindow(); });
});
app.on("before-quit", () => { workspaceBrowser?.dispose(); client?.dispose(); });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
