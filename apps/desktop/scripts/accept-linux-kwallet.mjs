import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

/** Additional real installed-app coverage in the caller's disposable D-Bus session. */
export async function acceptLinuxKwallet({ electron, executablePath, version, root, home, evidence, closeApp, openApps }) {
  assert.equal(process.platform, "linux");
  assert.equal(process.env.GITHUB_ACTIONS, "true");
  assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
  assert.ok(!process.env.MODEX_E2E);
  const relative = path.relative(process.env.RUNNER_TEMP, root);
  assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
  const owned = fs.mkdtempSync(path.join(root, "kwallet-"));
  const config = path.join(owned, "config");
  const data = path.join(owned, "data");
  const appHome = path.join(owned, "modex");
  const probeHome = path.join(owned, "probe");
  for (const directory of [config, data, path.join(appHome, "app")]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.copyFileSync(path.join(home, "app", "state.json"), path.join(appHome, "app", "state.json"));
  fs.writeFileSync(path.join(config, "kwalletrc"), "[Wallet]\nEnabled=true\nFirst Use=false\nUse One Wallet=true\nLocal Wallet=kdewallet\nDefault Wallet=kdewallet\nLeave Open=true\nClose When Idle=false\nPrompt on Open=false\nLaunch Manager=false\n[org.freedesktop.secrets]\napiEnabled=false\n", { mode: 0o600 });
  const env = { ...process.env, XDG_CONFIG_HOME: config, XDG_DATA_HOME: data,
    XDG_CURRENT_DESKTOP: "KDE", KDE_SESSION_VERSION: "5", DESKTOP_SESSION: "plasma",
    MODEX_HOME: appHome, MODEX_NO_LOGIN_PATH: "1", TYPESAFE_API_KEY: "", JEV_API_KEY: "",
    JEV_CONFIG: path.join(owned, "no-jev-config") };
  const key = randomBytes(56);
  const value = `kwallet-acceptance-${randomUUID()}`;
  const file = path.join(probeHome, "app", "secrets.json");
  const service = "org.kde.kwalletd5";
  const report = { backend: "kwallet5", packageVersion: execFileSync("dpkg-query", ["-W", "-f=${Version}", "libkf5wallet-bin"], { encoding: "utf8", timeout: 5000 }).trim(),
    launches: [], daemonPids: [], limitation: "owned PAM key handoff and declared KDE5; not a full graphical login" };
  let daemon;
  let daemonError;
  let hash;
  let failure;
  const dbus = (destination, object, method, ...args) => execFileSync("dbus-send", ["--session", "--print-reply", "--reply-timeout=5000",
    `--dest=${destination}`, object, method, ...args], { env, encoding: "utf8", timeout: 6000 });
  const ownedName = () => /boolean true/.test(dbus("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus.NameHasOwner", `string:${service}`));
  // Unique names cannot auto-activate or be reassigned to another daemon.
  const wallet = (method, ...args) => dbus(assertDaemonOwner(), "/modules/kwalletd5", `org.kde.KWallet.${method}`, ...args);
  function assertDaemonOwner() {
    if (daemonError) throw daemonError;
    assert.equal(daemon.exitCode, null, "Owned KWallet must remain alive");
    assert.equal(daemon.signalCode, null);
    const owner = dbus("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus.GetNameOwner", `string:${service}`);
    const unique = owner.match(/string "(:[0-9.]+)"/)?.[1];
    assert.ok(unique, "KWallet must have a unique bus owner");
    const pid = dbus("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus.GetConnectionUnixProcessID", `string:${unique}`);
    assert.equal(Number(pid.match(/uint32 (\d+)/)?.[1]), daemon.pid, "KWallet bus owner must be the exact exec child");
    return unique;
  }
  async function until(check, description) {
    const deadline = Date.now() + 15000;
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`Timed out: ${description}`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  async function bounded(promise, ms, description) {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(description)), ms); })]); }
    finally { clearTimeout(timer); }
  }
  async function start() {
    assert.equal(ownedName(), false, "Refusing an existing KWallet daemon");
    const launchRoot = fs.mkdtempSync(path.join(owned, "launch-"));
    const log = fs.openSync(path.join(evidence, "kwallet.log"), "a", 0o600);
    daemonError = undefined;
    try { daemon = spawn("python3", [fileURLToPath(new URL("./start-test-kwallet.py", import.meta.url)), launchRoot], { env, stdio: ["pipe", log, log] }); }
    finally { fs.closeSync(log); }
    daemon.on("error", error => { daemonError = error; });
    daemon.stdin.on("error", error => { daemonError = error; });
    daemon.stdin.end(key);
    await until(() => {
      if (daemonError) throw daemonError;
      assert.equal(daemon.exitCode, null, "Owned KWallet exited during startup");
      assert.equal(daemon.signalCode, null);
      return ownedName();
    }, "owned KWallet startup");
    assertDaemonOwner();
    await until(() => {
      assertDaemonOwner();
      // Service registration can precede object registration and PAM unlock.
      try { return /boolean true/.test(wallet("isOpen", "string:kdewallet")); }
      catch { return false; }
    }, "prehashed-key wallet unlock");
    report.daemonPids.push(daemon.pid);
  }
  async function stop() {
    if (!daemon?.pid || daemon.exitCode !== null || daemon.signalCode !== null) return;
    let closeFailure;
    try { assert.match(wallet("close", "string:kdewallet", "boolean:true"), /int32 0\b/, "Flush and close the owned wallet"); }
    catch (error) { closeFailure = error; }
    const closed = once(daemon, "close");
    daemon.kill("SIGTERM");
    try { await bounded(closed, 5000, "Owned KWallet did not stop"); }
    catch (error) {
      daemon.kill("SIGKILL");
      await bounded(closed, 5000, "Owned KWallet survived termination");
      throw error;
    }
    if (closeFailure) throw closeFailure;
    assert.equal(ownedName(), false);
  }
  async function launch(kind, write, automatic = false) {
    assertDaemonOwner();
    const app = await electron.launch({ executablePath, env, args: automatic ? [] : ["--password-store=kwallet5"], timeout: 30000 });
    openApps.add(app.process());
    let appFailure;
    try {
      const page = await app.firstWindow({ timeout: 30000 });
      await page.locator('[data-testid="main"]').waitFor({ state: "visible" });
      const identity = await app.evaluate(({ app, safeStorage }, { home, value, write }) => {
        const require = process.getBuiltinModule("module").createRequire(`${app.getAppPath()}/package.json`);
        const { SecretStore, electronCipher } = require("./dist/src/main/engine/secrets.js");
        const store = new SecretStore(home, electronCipher(safeStorage));
        if (write) store.set("typesafe_api_key", value);
        return { packaged: app.isPackaged, version: app.getVersion(), executable: process.execPath,
          appPath: app.getAppPath(), backend: safeStorage.getSelectedStorageBackend(),
          available: store.available(), matches: store.get("typesafe_api_key") === value };
      }, { home: probeHome, value, write });
      assert.equal(identity.packaged, true);
      assert.equal(identity.version, version);
      assert.equal(identity.executable, executablePath);
      assert.equal(identity.appPath, path.join(path.dirname(executablePath), "resources", "app.asar"));
      assert.equal(identity.backend, "kwallet5");
      assert.equal(identity.available, true);
      assert.equal(identity.matches, true);
      assertDaemonOwner();
      const bytes = fs.readFileSync(file);
      assert.ok(!bytes.includes(value));
      assert.ok(!Buffer.from(JSON.parse(bytes).entries.typesafe_api_key.enc, "base64").includes(value));
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      const current = createHash("sha256").update(bytes).digest("hex");
      if (write) hash = current;
      else assert.equal(current, hash, "Existing credential ciphertext must remain unchanged");
      report.launches.push({ kind, automatic, ...identity });
    } catch (error) { appFailure = error; }
    try { await closeApp(app); }
    catch (error) { appFailure = appFailure ? new AggregateError([appFailure, error], "KWallet app acceptance and cleanup failed") : error; }
    if (appFailure) throw appFailure;
  }
  try {
    await start();
    await launch("write", true);
    await launch("app-restart", false);
    await stop();
    const walletFile = path.join(data, "kwalletd", "kdewallet.kwl");
    assert.ok(fs.statSync(walletFile).size > 0, "Real persisted wallet required");
    assert.ok(!fs.readFileSync(walletFile).includes(value));
    await start();
    await launch("daemon-restart-auto", false, true);
  } catch (error) { failure = error; }
  finally {
    try { await stop(); }
    catch (error) { failure = failure ? new AggregateError([failure, error], "KWallet acceptance and cleanup failed") : error; }
    key.fill(0);
    report.error = failure ? String(failure) : undefined;
    fs.writeFileSync(path.join(evidence, "kwallet-result.json"), JSON.stringify(report, null, 2) + "\n");
  }
  if (failure) throw failure;
  return report;
}
