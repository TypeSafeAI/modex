import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { stopOwnedProcesses } from "./update-acceptance-cleanup.mjs";

export function requireHostedMac(env = process.env, platform = process.platform, arch = process.arch) {
  if (platform !== "darwin" || arch !== "arm64" || env.GITHUB_ACTIONS !== "true"
    || env.CI !== "true" || env.MODEX_RUNNER_ENVIRONMENT !== "github-hosted"
    || !env.RUNNER_TEMP || !path.isAbsolute(env.RUNNER_TEMP)) {
    throw new Error("Native update acceptance requires an explicitly selected GitHub-hosted macOS arm64 runner.");
  }
}
export function requireAbsent(paths) {
  for (const file of paths) {
    try { fs.lstatSync(file); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    throw new Error(`Refusing to replace existing Modex state: ${file}`);
  }
}
export function appEnvironment(env = process.env) {
  // Do not pass signing credentials, GitHub tokens or test-cipher flags to the app
  // or to Squirrel's relaunched process. HOME retains this disposable user's home.
  const result = {};
  for (const key of ["HOME", "PATH", "SHELL", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "DISPLAY"]) {
    if (env[key] !== undefined) result[key] = env[key];
  }
  return { ...result, MODEX_NO_LOGIN_PATH: "1", TYPESAFE_API_KEY: "", JEV_API_KEY: "", JEV_CONFIG: path.join(env.RUNNER_TEMP, "no-jev-config.json") };
}
/** Assert the current schema and exact owner; never accept a legacy text fallback. */
export function savedProjectDraft(record, projectId) {
  assert.equal(record.schema, 2);
  const config = record.drafts?.draft;
  assert.ok(config && Number.isSafeInteger(config.revision) && config.revision >= 0);
  assert.ok(Array.isArray(record.drafts.projects));
  const rows = record.drafts.projects.filter(row => row.projectId === projectId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].key, `draft:${config.revision}:${projectId}`);
  assert.equal(typeof rows[0].text, "string");
  return rows[0].text;
}
function command(file, args) {
  return execFileSync(file, args, { encoding: "utf8", timeout: 120_000, maxBuffer: 1024 * 1024 }).trim();
}
function runningPids(executable) {
  return command("/bin/ps", ["-axo", "pid=,args="]).split("\n").flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    return match && (match[2] === executable || match[2].startsWith(`${executable} `)) ? [Number(match[1])] : [];
  });
}
async function closeOwnedApp(app, executable) {
  let timer;
  try {
    const closed = await Promise.race([
      app.close().then(() => true),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), 10_000); }),
    ]);
    if (closed) return;
    const pid = app.process().pid;
    if (runningPids(executable).includes(pid)) process.kill(pid, "SIGKILL");
    throw new Error("Owned acceptance app did not close within 10 seconds; native acceptance failed.");
  } finally { clearTimeout(timer); }
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; } }

/** Real signed app/controller/verifier/Squirrel; only unpublished release transport
 * is replaced externally. This is not called by ordinary E2E or local builds. */
export async function runNativeUpdateAcceptance({ sourceApp, candidateArchive, version, work, evidence, scenario = "upgrade" }) {
  requireHostedMac();
  if (!["upgrade", "native-failure", "interrupted"].includes(scenario)) throw new Error("Unknown native acceptance scenario.");
  const { _electron: electron, expect } = await import("@playwright/test");
  const home = path.join(os.homedir(), ".modex");
  requireAbsent([home, path.join(os.homedir(), "Library/Application Support/Modex")]);
  for (const parent of ["Library/Caches", "Library/Preferences", "Library/Application Support"]) {
    const directory = path.join(os.homedir(), parent);
    if (fs.existsSync(directory) && fs.readdirSync(directory).some(name => /modex/i.test(name))) {
      throw new Error(`Refusing existing Modex platform state in ${parent}`);
    }
  }
  assert.match(version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  assert.notEqual(version, "0.0.0");
  const installed = path.join(work, "installed", "Modex.app");
  requireAbsent([installed]);
  fs.mkdirSync(path.dirname(installed), { recursive: true });
  command("/usr/bin/ditto", [sourceApp, installed]);
  const executable = path.join(installed, "Contents/MacOS/Modex");
  const repo = path.join(work, "project");
  fs.mkdirSync(repo);
  command("git", ["-C", repo, "init", "-q", "-b", "main"]);
  fs.writeFileSync(path.join(repo, "README.md"), "# Native update acceptance\n");
  command("git", ["-C", repo, "add", "."]);
  command("git", ["-C", repo, "-c", "commit.gpgsign=false", "-c", "user.name=Modex acceptance", "-c", "user.email=acceptance@modex.local", "commit", "-qm", "fixture"]);
  fs.mkdirSync(path.join(home, "app"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(home, "app/state.json"), JSON.stringify({ version: 1,
    projects: [{ id: "p1", name: "Native update acceptance", path: repo, addedAt: new Date().toISOString() }], threads: [],
    settings: { default_backend: "mock", default_mode: "chat", default_model: { mock: "mock", codex: "", claude: "" }, mock_script: path.join(installed, "Contents/Resources/app.asar/demo/mock-script.json"), routing: { jev_transport: "http" } },
  }), { mode: 0o600 });
  const archiveBytes = fs.readFileSync(candidateArchive);
  const sha256 = createHash("sha256").update(archiveBytes).digest("hex");
  const receiptFile = path.join(home, "app/update-recovery.json");
  const eventsFile = path.join(evidence, "native-events.jsonl");
  const transportFile = path.join(evidence, "release-transport.jsonl");
  const draft = "  Preserve this unsent draft across the real signed upgrade. 😀\n  ";
  const proof = { schema: 1, scenario, sourceVersion: "0.0.0", targetVersion: version, sha256, bytes: archiveBytes.length,
    sourceSha: process.env.GITHUB_SHA, run: process.env.GITHUB_RUN_ID, os: command("/usr/bin/sw_vers", ["-productVersion"]), arch: process.arch,
    transport: "external driver serving the actual signed candidate ZIP", nativeEventsSimulated: false, checks: [] };
  let app, failure;
  const finalizationErrors = [];
  try {
    app = await electron.launch({ executablePath: executable, args: [], cwd: work, env: appEnvironment() });
    let page = await app.firstWindow();
    page.on("dialog", dialog => { if (dialog.type() !== "beforeunload") void dialog.dismiss(); });
    assert.deepEqual(await app.evaluate(({ app }) => ({ packaged: app.isPackaged, version: app.getVersion(), testCipher: !!process.env.MODEX_E2E })), { packaged: true, version: "0.0.0", testCipher: false });
    proof.sourcePid = app.process().pid;
    await app.evaluate(async ({ app, autoUpdater }, input) => {
      const require = process.getBuiltinModule("module").createRequire(`${app.getAppPath()}/package.json`);
      const fs = require("node:fs");
      const { Readable } = require("node:stream");
      const { ReleaseChecker } = require("./dist/src/main/engine/updates.js");
      const originalFetch = globalThis.fetch;
      const scenario = globalThis.__nativeUpdateAcceptance = { corrupt: true };
      const asset = `Modex-${input.version}-arm64.zip`;
      const archiveURL = `https://github.com/TypeSafeAI/modex/releases/download/v${input.version}/${asset}`;
      const recordTransport = details => fs.appendFileSync(input.transportFile, JSON.stringify({ at: new Date().toISOString(), ...details }) + "\n", { mode: 0o600 });
      globalThis.fetch = async (url, init) => {
        if (String(url) === "https://api.github.com/repos/TypeSafeAI/modex/releases/latest") {
          recordTransport({ request: "release-metadata" });
          return Response.json({ draft: false, prerelease: false, published_at: new Date().toISOString(), tag_name: `v${input.version}`, assets: [
            { name: `Modex-${input.version}-arm64.dmg`, state: "uploaded", size: 1 },
            { name: asset, state: "uploaded", size: input.bytes, digest: `sha256:${input.sha256}` },
          ] });
        }
        if (String(url) === archiveURL) {
          const corrupt = scenario.corrupt;
          recordTransport({ request: "candidate-archive", corrupt });
          const source = fs.createReadStream(input.candidateArchive, { signal: init?.signal });
          const stream = Readable.from((async function* () {
            let first = true;
            for await (const chunk of source) {
              if (first && corrupt) { const altered = Buffer.from(chunk); altered[0] ^= 255; yield altered; }
              else yield chunk;
              first = false;
            }
          })());
          return new Response(Readable.toWeb(stream), { status: 200 });
        }
        if (String(url).startsWith("https://api.github.com/repos/TypeSafeAI/modex/releases/")
          || String(url).startsWith("https://github.com/TypeSafeAI/modex/releases/download/")) {
          recordTransport({ request: "unexpected-release-endpoint", refused: true });
          throw new Error("Unexpected release endpoint in native acceptance.");
        }
        return originalFetch(url, init);
      };
      const originalCheck = ReleaseChecker.prototype.check;
      ReleaseChecker.prototype.check = function () {
        ReleaseChecker.prototype.check = originalCheck;
        // Finish an initial public read before refreshing the cache. Do not alter
        // the clock or fake release/controller/verifier/native outcomes.
        return Promise.resolve(this.pending).then(() => { this.nextCheck = 0; return originalCheck.call(this); });
      };
      const record = (event, extra = {}) => fs.appendFileSync(input.eventsFile, JSON.stringify({ event, at: new Date().toISOString(), pid: process.pid, ...extra }) + "\n", { mode: 0o600 });
      if (input.scenario !== "upgrade") {
        const http = require("node:http");
        const { wrapNativeFeed } = require(input.faultModule);
        const createServer = http.createServer;
        http.createServer = function (...args) {
          const index = args.length - 1;
          if (typeof args[index] === "function") args[index] = wrapNativeFeed(args[index], input.scenario === "interrupted" ? "stall" : "refuse", ({ event, ...extra }) => record(event, extra));
          return createServer.apply(this, args);
        };
        require("node:module").syncBuiltinESMExports();
      }
      autoUpdater.on("update-downloaded", (_event, _notes, name) => record("update-downloaded", { version: name }));
      autoUpdater.on("before-quit-for-update", () => record("before-quit-for-update"));
      autoUpdater.on("error", () => record("native-error"));
    }, { version, bytes: archiveBytes.length, sha256, candidateArchive, eventsFile, transportFile, scenario,
      faultModule: fileURLToPath(new URL("./native-update-fault.mjs", import.meta.url)) });
    await page.evaluate(() => window.modex.invoke("updates:check", undefined));
    const banner = page.getByTestId("update-banner");
    await page.getByTestId("composer-input").fill(draft);
    await banner.getByRole("button", { name: "Download update", exact: true }).click();
    await expect(banner).toContainText("could not be downloaded or verified", { timeout: 180_000 });
    assert.equal(JSON.parse(fs.readFileSync(receiptFile, "utf8")).attempt, null);
    assert.equal(fs.existsSync(eventsFile), false);
    proof.checks.push("tampered download refused before native admission");
    await app.evaluate(() => { globalThis.__nativeUpdateAcceptance.corrupt = false; });
    await banner.getByRole("button", { name: "Download update", exact: true }).click();
    await expect(banner.getByRole("button", { name: "Restart to update", exact: true })).toBeEnabled({ timeout: 180_000 });
    proof.checks.push("real ZIP authenticated and ready");
    await page.getByTestId("open-settings").click();
    await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
    await expect(async () => {
      const state = await page.evaluate(() => window.modex.invoke("updates:install", undefined));
      assert.equal(state.phase, "ready"); assert.match(state.message, /Save or close the open dialog/);
    }).toPass({ timeout: 30_000 });
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Settings" })).toHaveCount(0);
    await expect(page.getByTestId("composer-input")).toBeEditable();
    await expect(page.getByTestId("composer-input")).toHaveValue(draft);
    await expect.poll(() => savedProjectDraft(JSON.parse(fs.readFileSync(receiptFile, "utf8")), "p1")).toBe(draft);
    assert.equal(JSON.parse(fs.readFileSync(receiptFile, "utf8")).attempt, null);
    proof.checks.push("open Settings refused before native admission");
    await page.screenshot({ path: path.join(evidence, "ready.png") });
    const readEvents = () => fs.existsSync(eventsFile) ? fs.readFileSync(eventsFile, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
    if (scenario !== "upgrade") {
      await banner.getByRole("button", { name: "Restart to update", exact: true }).click();
      await expect.poll(() => readEvents().some(event => event.event === "native-artifact-request"), { timeout: 180_000 }).toBe(true);
      const admitted = JSON.parse(fs.readFileSync(receiptFile, "utf8"));
      assert.equal(admitted.attempt.to, version);
      assert.equal(savedProjectDraft(admitted, "p1"), draft);
      assert.notEqual(admitted.attempt.outcome, "installed");
      fs.copyFileSync(receiptFile, path.join(evidence, "admitted-receipt.json"));
      if (scenario === "interrupted") {
        // The real native updater has requested its private ZIP. Interrupt the
        // owned A process, retaining its receipt and all OS updater state.
        const exited = app.waitForEvent("close", { timeout: 30_000 });
        assert.ok(runningPids(executable).includes(proof.sourcePid));
        process.kill(proof.sourcePid, "SIGKILL");
        await exited; app = undefined;
        proof.checks.push("owned A interrupted after real native artifact request and durable admission");
      } else {
        await expect.poll(() => readEvents().some(event => event.event === "native-error"), { timeout: 180_000 }).toBe(true);
        await expect(page.getByTestId("update-restart-status")).toBeVisible();
        await expect(page.getByTestId("composer-input")).toHaveValue(draft);
        assert.equal(await page.getByTestId("composer-input").evaluate(element => Boolean(element.closest("[inert]"))), true);
        assert.match(await page.evaluate(async () => {
          try { await window.modex.invoke("thread:create", { projectId: "p1" }); return "unexpected success"; }
          catch (error) { return String(error); }
        }), /recover|restart/i);
        assert.equal(JSON.parse(fs.readFileSync(receiptFile, "utf8")).attempt.outcome, "uncertain");
        await page.screenshot({ path: path.join(evidence, "native-failure.png") });
        const exited = app.waitForEvent("close", { timeout: 30_000 });
        await page.getByRole("button", { name: "Quit Modex", exact: true }).click();
        await exited; app = undefined;
        proof.checks.push("real Squirrel download error enters uncertain recovery and permits Quit");
      }
      await expect.poll(() => alive(proof.sourcePid), { timeout: 30_000 }).toBe(false);
      assert.equal(readEvents().some(event => event.event === "update-downloaded"), false);
      assert.equal(readEvents().some(event => event.event === "before-quit-for-update"), false);
      app = await electron.launch({ executablePath: executable, args: [], cwd: work, env: appEnvironment() });
      page = await app.firstWindow();
      page.on("dialog", dialog => { if (dialog.type() !== "beforeunload") void dialog.dismiss(); });
      assert.equal(await app.evaluate(({ app }) => app.getVersion()), "0.0.0");
      await expect(page.getByTestId("update-recovery")).toBeVisible();
      await expect(page.getByRole("textbox", { name: "New chat draft for p1", exact: true })).toHaveValue(draft);
      await expect(page.getByRole("textbox", { name: "New chat draft for p1", exact: true })).toHaveAttribute("readonly", "");
      const beforeRetry = fs.readFileSync(receiptFile, "utf8");
      const recoveryState = await page.evaluate(() => window.modex.invoke("updates:state", undefined));
      assert.equal(recoveryState.installable, false);
      assert.equal(recoveryState.canRestart, false);
      const retry = await page.evaluate(async () => {
        try { await window.modex.invoke("updates:install", undefined); return "unexpected success"; }
        catch (error) { return String(error); }
      });
      assert.match(retry, /not ready|recovery/i);
      const newWork = await page.evaluate(async () => {
        try { await window.modex.invoke("thread:create", { projectId: "p1", backend: "mock" }); return "unexpected success"; }
        catch (error) { return String(error); }
      });
      assert.match(newWork, /restart|recovery/i);
      assert.equal(fs.readFileSync(receiptFile, "utf8"), beforeRetry);
      await page.screenshot({ path: path.join(evidence, "reopened-A-recovery.png") });
      fs.copyFileSync(receiptFile, path.join(evidence, "reopened-A-receipt.json"));
      proof.checks.push("fresh A preserves read-only drafts and refuses another install without changing the receipt");
      await closeOwnedApp(app, executable); app = undefined;
      await stopOwnedProcesses({ list: () => runningPids(executable), signal: (pid, name) => { if (runningPids(executable).includes(pid)) process.kill(pid, name); } });
      const manual = path.join(work, "manual-recovery");
      requireAbsent([manual]);
      command("/usr/bin/ditto", ["-x", "-k", candidateArchive, manual]);
      const replacement = path.join(manual, "Modex.app");
      command("/usr/bin/codesign", ["--verify", "--deep", "--strict", replacement]);
      command("/usr/sbin/spctl", ["--assess", "--type", "execute", replacement]);
      assert.equal(command("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleShortVersionString", path.join(replacement, "Contents/Info.plist")]), version);
      // Manual installation replaces only the disposable app. Keep the old app,
      // recovery file, home and native updater caches intact for diagnosis.
      fs.renameSync(installed, path.join(work, "failed-installed-A.app"));
      command("/usr/bin/ditto", [replacement, installed]);
      proof.checks.push("manual recovery installs the actual signed B without clearing saved drafts or native updater state");
    } else {
    const exited = app.waitForEvent("close", { timeout: 180_000 });
    await banner.getByRole("button", { name: "Restart to update", exact: true }).click().catch(error => { if (!page.isClosed()) throw error; });
    await exited;
    app = undefined;
    await expect.poll(() => alive(proof.sourcePid), { timeout: 30_000 }).toBe(false);
    await expect.poll(() => {
      try { return JSON.parse(fs.readFileSync(receiptFile, "utf8")).attempt?.outcome; } catch { return null; }
    }, { timeout: 180_000 }).toBe("installed");
    const recovered = JSON.parse(fs.readFileSync(receiptFile, "utf8"));
    assert.equal(recovered.attempt.to, version);
    assert.equal(savedProjectDraft(recovered, "p1"), draft);
    const events = fs.readFileSync(eventsFile, "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.ok(events.some(event => event.event === "update-downloaded" && event.version === version));
    assert.ok(events.some(event => event.event === "before-quit-for-update"));
    await expect.poll(() => runningPids(executable).length, { timeout: 30_000 }).toBe(1);
    const [relaunchedPid] = runningPids(executable);
    assert.notEqual(relaunchedPid, proof.sourcePid);
    proof.relaunchedPid = relaunchedPid;
    assert.equal(command("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleShortVersionString", path.join(installed, "Contents/Info.plist")]), version);
    command("/usr/bin/codesign", ["--verify", "--deep", "--strict", installed]);
    command("/usr/sbin/spctl", ["--assess", "--type", "execute", installed]);
    proof.checks.push("native replacement and automatic new-process relaunch confirmed by exact-version installed receipt and preserved draft");
    // Native relaunch has no inspector. Record that launch first, then stop only
    // its exact owned PID and open B under the driver for separate UI acceptance.
    process.kill(relaunchedPid, "SIGTERM");
    await expect.poll(() => alive(relaunchedPid), { timeout: 30_000 }).toBe(false);
    }
    app = await electron.launch({ executablePath: executable, args: [], cwd: work, env: appEnvironment() });
    page = await app.firstWindow();
    page.on("dialog", dialog => { if (dialog.type() !== "beforeunload") void dialog.dismiss(); });
    assert.equal(await app.evaluate(({ app }) => app.getVersion()), version);
    const recoveredReceipt = JSON.parse(fs.readFileSync(receiptFile, "utf8"));
    assert.equal(recoveredReceipt.attempt.outcome, "installed");
    assert.equal(recoveredReceipt.attempt.to, version);
    await expect(page.getByTestId("composer-input")).toHaveValue(draft);
    await expect(page.getByTestId("update-recovery")).toHaveCount(0);
    await page.getByTestId("composer-input").fill(`${draft} Editing resumed.`);
    await expect.poll(() => savedProjectDraft(JSON.parse(fs.readFileSync(receiptFile, "utf8")), "p1")).toBe(`${draft} Editing resumed.`);
    await page.screenshot({ path: path.join(evidence, "restored.png") });
    proof.checks.push("separate controlled B launch restores drafts and permits durable edits");
    await closeOwnedApp(app, executable); app = undefined;
    proof.passed = true;
  } catch (error) {
    proof.passed = false;
    proof.failure = error instanceof Error ? error.message : String(error);
    failure = error;
  } finally {
    try {
      try { if (app) await closeOwnedApp(app, executable); }
      catch (error) { finalizationErrors.push(error); }
      // Squirrel can relaunch after the Playwright handle has closed. Recheck
      // only our private executable for a quiet interval even without a handle.
      try {
        proof.cleanupPids = await stopOwnedProcesses({
          list: () => runningPids(executable),
          signal: (pid, name) => { if (runningPids(executable).includes(pid)) process.kill(pid, name); },
        });
      } catch (error) { finalizationErrors.push(error); }
    } finally {
      try {
        if (fs.existsSync(receiptFile)) fs.copyFileSync(receiptFile, path.join(evidence, "recovery-receipt.json"));
      } catch (error) { finalizationErrors.push(error); }
      finally {
        if (finalizationErrors.length) {
          proof.passed = false;
          proof.finalizationFailures = finalizationErrors.map(error => error instanceof Error ? error.message : String(error));
        }
        try { fs.writeFileSync(path.join(evidence, "result.json"), JSON.stringify(proof, null, 2) + "\n"); }
        catch (error) { finalizationErrors.push(error); }
      }
    }
  }
  if (failure && finalizationErrors.length) throw new AggregateError([failure, ...finalizationErrors], "Native acceptance and finalization failed.");
  if (failure) throw failure;
  if (finalizationErrors.length) throw new AggregateError(finalizationErrors, "Native acceptance finalization failed.");
}
