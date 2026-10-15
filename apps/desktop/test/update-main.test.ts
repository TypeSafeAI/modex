import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { test, type TestContext } from "node:test";
import { UpdateInstallation } from "../src/main/engine/update-installation.js";
import { UpdateRestartCoordinator } from "../src/main/engine/update-restart-coordinator.js";
import { MacUpdateHandoff } from "../src/main/engine/update-mac-handoff.js";
import { UpdateRecovery } from "../src/main/engine/update-recovery.js";
import { RestartAdmission } from "../src/main/engine/restart-admission.js";

// Execute main's actual assembly with real lifecycle classes, private feed and disk
// receipt. Signature verification/native events are simulated, not installation proof.
function fixture(t: TestContext, overrides: Record<string, unknown> = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "modex-update-main-"));
  const archive = path.join(home, "candidate.zip"), bytes = Buffer.from("simulated verified update");
  fs.writeFileSync(archive, bytes);
  const recovery = new UpdateRecovery(home), admission = new RestartAdmission();
  const calls: string[] = [], states: any[] = [], holds = new Set<string>();
  const hold = (name: string) => () => { calls.push(`hold:${name}`); holds.add(name); return () => { calls.push(`release:${name}`); holds.delete(name); }; };
  let nativeChecks = 0, constructions = 0, checked!: () => void;
  const nativeReady = new Promise<void>(resolve => { checked = resolve; });
  const native = Object.assign(new EventEmitter(), { feed: "", setFeedURL(value: { url: string }) { this.feed = value.url; },
    checkForUpdates() { nativeChecks++; checked(); }, quitAndInstall() { calls.push("native-quit"); } });
  native.on("error", () => {});
  const release = { version: "0.0.11", url: "https://github.com/TypeSafeAI/modex/releases/tag/v0.0.11" };
  const context: any = { home, path, Error, process: { platform: "darwin", arch: "arm64", env: {}, execPath: "/Applications/Modex.app/Contents/MacOS/Modex" },
    app: { isPackaged: true, getVersion: () => "0.0.10" }, demo: false, hostPreview: false, nativeDraftFailure: undefined, nativeStartup: { recovery: null },
    restartCoordinator: undefined, autoUpdater: native, UpdateRestartCoordinator,
    MacUpdateHandoff: class extends MacUpdateHandoff { constructor(...args: ConstructorParameters<typeof MacUpdateHandoff>) { super(...args); constructions++; } },
    UpdateInstallation: class extends UpdateInstallation { constructor(options: ConstructorParameters<typeof UpdateInstallation>[0]) { super({ ...options,
      download: async (_candidate, opts) => { calls.push("download"); opts.progress(bytes.length); return { file: archive, directory: home, sha512: createHash("sha512").update(bytes).digest("base64"), dispose: async () => {} }; },
      stage: async () => ({ archive, bundle: "/fixture/Modex.app", dispose: async () => {} }), verify: async () => { calls.push("verify"); },
    }); } },
    updates: { check: async () => release, archive: () => ({ version: release.version, arch: "arm64", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }) },
    win: { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: (channel: string, state: any) => { assert.equal(channel, "updates:state"); states.push(state); } } },
    nativeDrafts: { recovery, holdForRestart: hold("drafts") }, restartAdmission: admission,
    runner: { holdForRestart: hold("runner") }, terminals: { holdForRestart: hold("terminals") }, retirer: { holdForRestart: hold("retirer") },
    media: { jobs: { busy: () => false } }, workspaceBrowser: null, workspaceCanvas: null, knowledgeBrowser: null,
    rendererPreflight: { prepare: async () => { calls.push("prepare"); return recovery.saveDrafts({ threads: [], projects: [], selectedThreadId: null, draft: null }); },
      assertPrepared: () => { calls.push("assert"); }, release: () => { calls.push("release-renderer"); } },
    drainServices: async () => { calls.push("drain"); }, currentDraftRecovery: () => null, ...overrides };
  const code = fs.readFileSync(path.resolve(import.meta.dirname, "../src/main/index.js"), "utf8");
  const start = code.indexOf("// Main-owned update lifecycle."), end = code.indexOf('handle("canvas:open",', start);
  assert.ok(start >= 0 && end > start);
  vm.runInNewContext(code.slice(start, end) + "\nglobalThis.installation = typeof updateInstallation === 'undefined' ? undefined : updateInstallation; globalThis.updateState = typeof updateState === 'undefined' ? undefined : updateState;", context);
  t.after(async () => { native.emit("error"); await context.installation?.dispose(); fs.rmSync(home, { recursive: true, force: true }); });
  return { context, calls, states, holds, admission, recovery, native, nativeReady, counts: () => ({ nativeChecks, constructions }) };
}

for (const [name, override] of Object.entries({ unpackaged: { app: { isPackaged: false, getVersion: () => "0.0.10" } },
  windows: { process: { platform: "win32", arch: "x64", env: {}, execPath: "C:/Modex.exe" } },
  linux: { process: { platform: "linux", arch: "x64", env: {}, execPath: "/opt/Modex" } },
  architecture: { process: { platform: "darwin", arch: "other", env: {}, execPath: "/Modex" } },
  e2e: { process: { platform: "darwin", arch: "arm64", env: { MODEX_E2E: "1" }, execPath: "/Modex" } },
  demo: { demo: "fixture" }, host: { hostPreview: true }, drafts: { nativeDrafts: undefined },
  unreadable: { nativeDraftFailure: "unreadable" }, recovery: { nativeStartup: { recovery: { outcome: "staged" } } },
})) test(`main disables native installation for ${name}`, async t => {
  const h = fixture(t, override);
  assert.equal(h.context.installation.state().phase, "disabled");
  await assert.rejects(h.context.installation.download(), /disabled/);
  assert.deepEqual(h.counts(), { nativeChecks: 0, constructions: 0 });
  assert.deepEqual(h.calls, []);
});

test("main assembly fences services, saves before drain, stages once and broadcasts the outcome", { timeout: 15_000 }, async t => {
  const h = fixture(t), install = h.context.installation as UpdateInstallation;
  assert.equal((await install.download()).phase, "ready");
  const pending = install.install(); await h.nativeReady;
  assert.equal(h.admission.held, true); assert.deepEqual([...h.holds], ["runner", "terminals", "retirer", "drafts"]);
  assert.ok(h.calls.indexOf("prepare") < h.calls.indexOf("drain"));
  assert.equal(h.recovery.read().attempt?.outcome, "uncertain");
  const feed = await (await fetch(h.native.feed)).json() as { name: string; url: string };
  h.native.emit("update-downloaded", {}, "", feed.name, new Date(), feed.url);
  assert.equal((await pending).phase, "staged"); assert.equal(h.recovery.read().attempt?.outcome, "staged");
  assert.equal(h.calls.filter(x => x === "native-quit").length, 1);
  assert.equal(h.states.at(-1).phase, "staged"); assert.deepEqual(h.counts(), { constructions: 1, nativeChecks: 1 });
});

for (const guest of ["workspaceBrowser", "workspaceCanvas", "knowledgeBrowser"]) test(`main refuses restart with an open ${guest} and releases reversible holds`, async t => {
  const h = fixture(t, { [guest]: { hasOpenPages: true } }), install = h.context.installation as UpdateInstallation;
  await install.download(); assert.equal((await install.install()).phase, "ready");
  assert.match(install.state().message!, /close/i); assert.equal(h.admission.held, false); assert.equal(h.holds.size, 0);
  assert.equal(h.calls.includes("prepare"), false); assert.equal(h.calls.includes("drain"), false);
  assert.equal(h.counts().nativeChecks, 0);
});

test("main retains all holds after partial disposal and exposes recovery without a native attempt", async t => {
  const h = fixture(t, { drainServices: async () => { throw new Error("partial disposal"); } }), install = h.context.installation as UpdateInstallation;
  await install.download(); assert.equal((await install.install()).phase, "recovery");
  assert.equal(h.admission.held, true); assert.equal(h.holds.size, 4); assert.equal(h.recovery.read().attempt, null);
  assert.equal(h.counts().nativeChecks, 0); assert.equal(h.calls.includes("native-quit"), false); assert.equal(h.states.at(-1).phase, "recovery");
});

test("state reports process recovery even without native drafts or an enabled installer", t => {
  const h = fixture(t, { nativeDrafts: undefined, currentDraftRecovery: () => ({ outcome: "recovery", message: "Restart recovery required." }) });
  assert.equal(h.context.updateState().phase, "recovery"); assert.equal(h.context.updateState().canRestart, false);
  assert.equal(h.context.updateState().message, "Restart recovery required.");
});


test("main refuses restart while image jobs are active before acquiring service holds", async t => {
  const h = fixture(t, { media: { jobs: { busy: () => true } } }), install = h.context.installation as UpdateInstallation;
  await install.download();
  assert.equal((await install.install()).phase, "ready");
  assert.match(install.state().message!, /image jobs/i);
  assert.equal(h.admission.held, false);
  assert.equal(h.holds.size, 0);
  assert.equal(h.calls.includes("prepare"), false);
  assert.equal(h.calls.includes("drain"), false);
});
