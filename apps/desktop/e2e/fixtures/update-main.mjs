// Isolated main-process acceptance fixture. Never shipped or imported by production.
import { app, autoUpdater, BrowserWindow, ipcMain, safeStorage, shell } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { UpdateInstallation } from "../../dist/src/main/engine/update-installation.js";
import { MacUpdateHandoff } from "../../dist/src/main/engine/update-mac-handoff.js";
import { ReleaseChecker } from "../../dist/src/main/engine/updates.js";
import { PagesAgents } from "../../dist/src/main/engine/pages-agents.js";
import { RestartAdmission } from "../../dist/src/main/engine/restart-admission.js";

const home = fs.realpathSync(process.env.MODEX_HOME ?? "");
const temporary = fs.realpathSync(os.tmpdir()) + path.sep;
if (!home.startsWith(temporary) || !path.basename(home).startsWith("modex-e2e-home-")
  || JSON.parse(fs.readFileSync(path.join(home, "app/state.json"), "utf8")).settings.default_backend !== "mock") {
  throw new Error("The updater fixture requires its own temporary mock workspace.");
}
delete process.env.MODEX_E2E;
Object.defineProperty(app, "isPackaged", { value: true });
app.getVersion = () => "0.0.10";
BrowserWindow.prototype.show = BrowserWindow.prototype.showInactive;
safeStorage.isEncryptionAvailable = () => true;
safeStorage.encryptString = value => Buffer.from(value);
safeStorage.decryptString = value => value.toString();
shell.openExternal = async () => { throw new Error("External navigation is disabled in this fixture."); };
globalThis.fetch = async () => { throw new Error("Network is disabled in this fixture."); };

const evidence = globalThis.__updateMainFixture = { nativeCalls: 0, pageDisposals: 0, prepared: [], quitPrepared: [], admissionHeld: false, pageSaves: [] };
const holdAdmission = RestartAdmission.prototype.holdForRestart;
RestartAdmission.prototype.holdForRestart = function () {
  const release = holdAdmission.call(this); evidence.admissionHeld = true;
  return () => { release(); evidence.admissionHeld = false; };
};
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) => handle(channel, channel === "space:save" ? async (event, page) => {
  const held = evidence.admissionHeld, result = await listener(event, page);
  evidence.pageSaves.push({ held, title: page.title }); return result;
} : listener);
for (const name of ["setFeedURL", "checkForUpdates", "quitAndInstall"]) autoUpdater[name] = () => {
  evidence.nativeCalls++; throw new Error("Native installation is forbidden in this fixture.");
};
MacUpdateHandoff.prototype.stage = async () => { evidence.nativeCalls++; throw new Error("The partial-drain fixture must never reach native staging."); };
const release = { version: "999.0.0", url: "https://github.com/TypeSafeAI/modex/releases/tag/v999.0.0" };
ReleaseChecker.prototype.check = async () => release;
ReleaseChecker.prototype.archive = () => ({ version: release.version, arch: process.arch, size: 1, sha256: "a".repeat(64) });
UpdateInstallation.prototype.prepare = async function () {
  // Only download/signature verification is substituted. The actual install(),
  // coordinator, admission, renderer handshake, service drain and Quit remain intact.
  this.verified = { archive: path.join(home, "never-opened.zip"), version: release.version, size: 1,
    sha512: Buffer.alloc(64, 1).toString("base64"), dispose: async () => {} };
  return this.publish({ phase: "ready", release, installable: true });
};
const disposePages = PagesAgents.prototype.dispose;
PagesAgents.prototype.dispose = async function () {
  if (++evidence.pageDisposals === 1) throw new Error("Synthetic partial service drain");
  return disposePages.call(this);
};
ipcMain.on("updates:prepared", (_event, value) => evidence.prepared.push(value));
ipcMain.on("updates:quit-prepared", (_event, value) => evidence.quitPrepared.push(value));
app.on("will-quit", () => fs.writeFileSync(path.join(home, "final-evidence.json"), JSON.stringify(evidence)));
await import("../../dist/src/main/index.js");
