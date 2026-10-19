// Real controller/IPC/UI acceptance with offline transport and simulated verification.
// Never shipped. Native installation is trapped before any side effect.
import { app, autoUpdater, BrowserWindow, safeStorage, shell } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { UpdateInstallation } from "../../dist/src/main/engine/update-installation.js";
import { MacUpdateHandoff } from "../../dist/src/main/engine/update-mac-handoff.js";
import { ReleaseChecker } from "../../dist/src/main/engine/updates.js";

const home = fs.realpathSync(process.env.MODEX_HOME ?? "");
if (!home.startsWith(fs.realpathSync(os.tmpdir()) + path.sep) || !path.basename(home).startsWith("modex-e2e-home-")
  || JSON.parse(fs.readFileSync(path.join(home, "app/state.json"), "utf8")).settings.default_backend !== "mock") {
  throw new Error("The installation fixture requires its own temporary mock workspace.");
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
const scenario = globalThis.__updateScenario = { downloads: 0, downloadedDisposed: 0, stagedDisposed: 0, nativeCalls: 0, quitStages: 0 };
const forbidNative = () => { scenario.nativeCalls++; throw new Error("Native installation is forbidden in this fixture."); };
for (const name of ["setFeedURL", "checkForUpdates", "quitAndInstall"]) autoUpdater[name] = forbidNative;
// Install-on-quit reaches this boundary after the real preflight and drain. Record the
// durable receipt as Squirrel's handoff would, but never touch the native updater.
MacUpdateHandoff.prototype.stage = async (snapshot, recordAttempt) => {
  scenario.quitStages++;
  await recordAttempt({ version: snapshot.version, sha512: snapshot.sha512, startedAt: new Date().toISOString() });
  return "staged";
};
const release = { version: "999.0.0", url: "https://github.com/TypeSafeAI/modex/releases/tag/v999.0.0" };
ReleaseChecker.prototype.check = async () => release;
ReleaseChecker.prototype.archive = () => ({ version: release.version, arch: process.arch, size: 100, sha256: "ab".repeat(32) });
const state = UpdateInstallation.prototype.state, configured = new WeakSet();
UpdateInstallation.prototype.state = function () {
  if (!configured.has(this)) {
    configured.add(this);
    Object.assign(this.options, {
      download: async (_candidate, options) => {
        scenario.downloads++; options.progress(25);
        return new Promise((resolve, reject) => {
          const cancel = () => { delete scenario.finishDownload; reject(new Error("Preparation canceled")); };
          options.signal.addEventListener("abort", cancel, { once: true });
          scenario.finishDownload = () => {
            options.signal.removeEventListener("abort", cancel); delete scenario.finishDownload; options.progress(100);
            resolve({ file: path.join(home, "offline-download.zip"), directory: home, sha512: Buffer.alloc(64).toString("base64"), dispose: async () => { scenario.downloadedDisposed++; } });
          };
        });
      },
      stage: async () => ({ archive: path.join(home, "offline-verified.zip"), bundle: path.join(home, "Offline.app"), dispose: async () => { scenario.stagedDisposed++; } }),
      verify: () => new Promise((resolve, reject) => {
        scenario.finishVerification = success => {
          delete scenario.finishVerification;
          if (success) resolve(); else reject(new Error("Publisher verification failed"));
        };
      }),
    });
  }
  return state.call(this);
};
app.on("will-quit", () => fs.writeFileSync(path.join(home, "final-installation-evidence.json"), JSON.stringify(scenario)));
await import("../../dist/src/main/index.js");
