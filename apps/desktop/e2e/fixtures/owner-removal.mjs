// Temporary-home, mock-only acceptance fixture. Never imported by production.
import { app, BrowserWindow, autoUpdater, safeStorage } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TaskRetirer } from "../../dist/src/main/engine/retire.js";
import { UpdateRecovery } from "../../dist/src/main/engine/update-recovery.js";
import { ThreadContextReader } from "../../dist/src/main/engine/thread-context.js";

const home = fs.realpathSync(process.env.MODEX_HOME ?? "");
if (process.env.MODEX_E2E !== "1" || !home.startsWith(fs.realpathSync(os.tmpdir()) + path.sep)
  || !path.basename(home).startsWith("modex-e2e-home-")
  || JSON.parse(fs.readFileSync(path.join(home, "app/state.json"), "utf8")).settings.default_backend !== "mock") {
  throw new Error("Owner removal acceptance requires a temporary mock workspace.");
}
BrowserWindow.prototype.show = BrowserWindow.prototype.showInactive;
const evidence = globalThis.__ownerRemovalFixture = { retirer: null, pullRequest: { state: "none" }, failAfterCommit: false, failedCommits: 0, nativeCalls: 0 };
if (process.env.MODEX_OWNER_RETIRE_TEST === "1") {
  // Exercise main's real retirement startup hook; E2E normally skips it.
  // Keep credentials, network and packaged updater behavior fixture-local.
  delete process.env.MODEX_E2E;
  Object.defineProperty(app, "isPackaged", { value: false });
  safeStorage.isEncryptionAvailable = () => true;
  safeStorage.encryptString = value => Buffer.from(value);
  safeStorage.decryptString = value => value.toString();
  globalThis.fetch = async () => { throw new Error("Network is disabled in retirement acceptance."); };
  ThreadContextReader.prototype.read = async () => ({ isRepo: true, branch: null, pullRequest: evidence.pullRequest });
}
// Use the real sweep/decision/runner/worktree removal; provide only local PR
// metadata and explicit timing instead of calling GitHub or starting a timer.
TaskRetirer.prototype.start = function () {
  evidence.retirer = this;
  this.deps.context = async () => ({ pullRequest: evidence.pullRequest });
};
const commit = UpdateRecovery.prototype.commitDrafts;
UpdateRecovery.prototype.commitDrafts = function (...args) {
  const revision = commit.apply(this, args);
  if (evidence.failAfterCommit) {
    evidence.failAfterCommit = false; evidence.failedCommits++;
    throw new Error("Synthetic lost owner-removal acknowledgment");
  }
  return revision;
};
for (const name of ["setFeedURL", "checkForUpdates", "quitAndInstall"]) autoUpdater[name] = () => {
  evidence.nativeCalls++; throw new Error("Native installation is forbidden in owner-removal acceptance.");
};
await import("../../dist/src/main/index.js");
