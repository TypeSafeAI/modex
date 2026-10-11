import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

// This script installs/removes a system package. It must never run on a developer host.
assert.equal(process.platform, "linux", "Hosted Linux acceptance only");
assert.equal(process.env.GITHUB_ACTIONS, "true", "GitHub Actions runner required");
assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted", "Disposable hosted runner required");
assert.ok(process.env.RUNNER_TEMP && path.isAbsolute(process.env.RUNNER_TEMP), "Runner temporary directory required");
assert.match(process.env.GITHUB_SHA ?? "", /^[0-9a-f]{40}$/);
assert.ok(!process.env.MODEX_E2E, "Real packaged runtime required");
assert.ok(process.env.DBUS_SESSION_BUS_ADDRESS, "Run inside a fresh dbus-run-session");

const { _electron: electron } = await import("@playwright/test");
const candidates = fileURLToPath(new URL("../release/native-linux/", import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(candidates, "native-packages.json"), "utf8"));
assert.equal(manifest.platform, "linux");
assert.equal(manifest.arch, process.arch);
assert.equal(manifest.sourceSha, process.env.GITHUB_SHA);
assert.equal(manifest.runId, process.env.GITHUB_RUN_ID);
assert.equal(manifest.installerAcceptance, "pending");
const artifacts = new Map();
for (const artifact of manifest.artifacts) {
  assert.equal(path.basename(artifact.name), artifact.name);
  const file = path.join(candidates, artifact.name);
  assert.ok(fs.lstatSync(file).isFile());
  assert.equal(fs.statSync(file).size, artifact.bytes);
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  assert.equal(hash.digest("hex"), artifact.sha256);
  const extension = path.extname(file);
  assert.ok(!artifacts.has(extension), "Duplicate package type");
  artifacts.set(extension, file);
}
assert.equal(artifacts.size, 2);
assert.ok(artifacts.has(".deb") && artifacts.has(".AppImage"));
const existing = spawnSync("dpkg-query", ["-W", "-f=${Status}", "modex"], { encoding: "utf8" });
assert.ok(!existing.error);
assert.ok(existing.status === 1 || existing.status === 0 && !existing.stdout.includes("installed"), "Refusing to replace an existing Modex installation");

const root = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP, "modex-installed-"));
const evidence = path.resolve("native-installed-linux");
fs.mkdirSync(evidence, { recursive: true });
const home = path.join(root, "home");
const project = path.join(root, "project");
const credentialHome = path.join(root, "credential-probe");
const credentialFile = path.join(credentialHome, "app", "secrets.json");
const freshCredentialHome = path.join(root, "refused-credential-probe");
const credential = `modex-acceptance-${randomUUID()}`;
const keyringData = path.join(root, "keyring-data");
const keyringControl = path.join(root, "keyring-control");
for (const directory of [keyringData, keyringControl]) fs.mkdirSync(directory, { mode: 0o700 });
const keyringEnv = { ...process.env, XDG_DATA_HOME: keyringData, GNOME_KEYRING_CONTROL: keyringControl };
let encryptedHash;
let keyring;
let keyringFailure;
fs.mkdirSync(path.join(home, "app"), { recursive: true });
fs.mkdirSync(project);
fs.writeFileSync(path.join(project, "package.json"), '{"name":"native-acceptance","private":true}\n');
fs.writeFileSync(path.join(home, "app", "state.json"), JSON.stringify({ version: 1, projects: [], threads: [], settings: {
  default_backend: "mock", default_mode: "chat", default_model: { mock: "mock", claude: "", codex: "" },
  claude_bin: path.join(root, "absent-claude"), codex_bin: path.join(root, "absent-codex"),
  routing: { jev_transport: "http" },
} }));
const sentinel = path.join(root, "unrelated-data");
const marker = randomUUID();
fs.writeFileSync(sentinel, marker);
const result = { schema: 1, sourceSha: manifest.sourceSha, runId: manifest.runId,
  platform: process.platform, arch: process.arch, launches: [], uninstall: "pending",
  installerAcceptance: "pending", credentials: "pending", remaining: ["KWallet credential persistence", "distinct-version upgrade", "complete CLI/account acceptance"] };
let installAttempted = false;
let installedBinary;
let failure;
const openApps = new Set();
const command = (file, args, options = {}) => execFileSync(file, args, { timeout: 180000, stdio: "inherit", ...options });
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
async function until(check, description) {
  const deadline = Date.now() + 15000;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${description}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
async function bounded(promise, ms, description) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(description)), ms); })]); }
  finally { clearTimeout(timer); }
}
async function closeApp(app) {
  const child = app.process();
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  try {
    await bounded(app.close(), 20000, "Packaged app did not close");
    if (!exited()) await bounded(once(child, "close"), 5000, "Owned Electron process did not exit");
    openApps.delete(child);
  } catch (closeFailure) {
    try {
      if (!exited()) {
        const closed = once(child, "close");
        child.kill("SIGKILL");
        await bounded(closed, 5000, "Owned Electron process survived termination");
      }
      openApps.delete(child);
      await bounded(app.close(), 5000, "Playwright connection did not close after termination");
    } catch (error) {
      throw new AggregateError([closeFailure, error], "App close and owned-process cleanup failed");
    }
    throw closeFailure;
  }
}

async function startKeyring() {
  // NameHasOwner does not activate another service. Refuse an existing keyring
  // even on the disposable host; only the foreground child below belongs to us.
  const owner = () => execFileSync("gdbus", ["call", "--session", "--dest", "org.freedesktop.DBus",
    "--object-path", "/org/freedesktop/DBus", "--method", "org.freedesktop.DBus.NameHasOwner",
    "org.freedesktop.secrets"], { encoding: "utf8", timeout: 5000 }).trim();
  assert.equal(owner(), "(false,)", "Refusing an existing Secret Service");
  const log = fs.openSync(path.join(evidence, "keyring.log"), "w", 0o600);
  try {
    keyring = spawn("gnome-keyring-daemon", ["--foreground", "--unlock", "--components=secrets", `--control-directory=${keyringControl}`],
      { env: keyringEnv, stdio: ["pipe", log, log] });
  } finally { fs.closeSync(log); }
  keyring.on("error", error => { keyringFailure = error; });
  keyring.stdin.on("error", error => { keyringFailure = error; });
  // A nonempty random password protects the test keyring; never log or persist it.
  keyring.stdin.end(randomUUID());
  await until(() => {
    if (keyringFailure) throw keyringFailure;
    assert.equal(keyring.exitCode, null, "Owned keyring exited during startup");
    assert.equal(keyring.signalCode, null, "Owned keyring stopped during startup");
    return owner() === "(true,)";
  }, "owned Secret Service startup");
}

async function stopKeyring() {
  if (!keyring?.pid || keyring.exitCode !== null || keyring.signalCode !== null) return;
  const closed = once(keyring, "close");
  keyring.kill("SIGTERM");
  try { await bounded(closed, 5000, "Owned keyring did not close"); }
  catch (error) {
    keyring.kill("SIGKILL");
    await bounded(closed, 5000, "Owned keyring survived termination");
    throw error;
  }
}

async function launch(executablePath, kind, credentialAction) {
  const app = await electron.launch({ executablePath, timeout: 30000,
    args: [`--password-store=${credentialAction === "refuse" ? "basic" : "gnome-libsecret"}`],
    env: { ...keyringEnv, MODEX_HOME: home, MODEX_NO_LOGIN_PATH: "1", SHELL: "/bin/bash",
      TYPESAFE_API_KEY: "", JEV_API_KEY: "", JEV_CONFIG: path.join(root, "no-jev-config") } });
  openApps.add(app.process());
  let launchFailure;
  try {
    const page = await app.firstWindow({ timeout: 30000 });
    await page.waitForLoadState("domcontentloaded");
    await page.waitForFunction(() => Boolean(window.modex?.invoke));
    await page.locator('[data-testid="main"]').waitFor({ state: "visible" });
    const identity = await app.evaluate(({ app, safeStorage }) => ({
      packaged: app.isPackaged, version: app.getVersion(), appPath: app.getAppPath(),
      executable: process.execPath, electron: process.versions.electron,
      platform: process.platform, arch: process.arch,
      storageBackend: safeStorage.getSelectedStorageBackend(),
      encryptionAvailable: safeStorage.isEncryptionAvailable(),
    }));
    assert.equal(identity.packaged, true);
    assert.equal(identity.platform, "linux");
    assert.equal(identity.arch, "x64");
    assert.ok(identity.appPath.endsWith("/resources/app.asar"), "Launch must load packaged ASAR");
    assert.equal(identity.storageBackend, credentialAction === "refuse" ? "basic_text" : "gnome_libsecret");
    const stored = await app.evaluate(({ app, safeStorage }, { home, freshHome, value, action }) => {
      const require = process.getBuiltinModule("module").createRequire(`${app.getAppPath()}/package.json`);
      const { SecretStore, electronCipher } = require("./dist/src/main/engine/secrets.js");
      const store = new SecretStore(home, electronCipher(safeStorage));
      if (action === "refuse") {
        const fresh = new SecretStore(freshHome, electronCipher(safeStorage));
        const attempt = target => {
          try { target.set("typesafe_api_key", value); return false; }
          catch (error) { return String(error).includes("encryption is unavailable"); }
        };
        return { available: store.available(), retained: store.has("typesafe_api_key"), value: store.get("typesafe_api_key"),
          refusedExisting: attempt(store), refusedNew: attempt(fresh) };
      }
      if (action === "write") store.set("typesafe_api_key", value);
      return { available: store.available(), backend: store.backend, matches: store.get("typesafe_api_key") === value };
    }, { home: credentialHome, freshHome: freshCredentialHome, value: credential, action: credentialAction });
    if (credentialAction === "refuse") {
      assert.deepEqual(stored, { available: false, retained: true, value: null, refusedExisting: true, refusedNew: true });
      assert.ok(!fs.existsSync(path.join(freshCredentialHome, "app", "secrets.json")), "Refusal must not create a credential file");
    } else {
      assert.equal(identity.encryptionAvailable, true, "Real encrypted keyring required");
      assert.deepEqual(stored, { available: true, backend: "OS keyring", matches: true });
    }
    const encrypted = fs.readFileSync(credentialFile);
    const entry = JSON.parse(encrypted.toString()).entries.typesafe_api_key;
    assert.ok(!encrypted.includes(credential) && !Buffer.from(entry.enc, "base64").includes(credential));
    assert.equal(fs.statSync(credentialFile).mode & 0o777, 0o600);
    const currentHash = createHash("sha256").update(encrypted).digest("hex");
    if (credentialAction === "write") encryptedHash = currentHash;
    else assert.equal(currentHash, encryptedHash, "Read/refusal must preserve existing ciphertext");
    const invoke = (channel, payload) => page.evaluate(({ channel, payload }) => window.modex.invoke(channel, payload), { channel, payload });
    const added = await invoke("project:add", { path: project });
    assert.ok(added?.id);
    const thread = await invoke("thread:create", { projectId: added.id, backend: "mock", auto: false });
    const terminal = await invoke("terminal:open", { threadId: thread.id, cols: 80, rows: 24 });
    const receipt = path.join(project, `${kind}.receipt`);
    const suffix = randomUUID();
    const token = `MODEX_NATIVE_${suffix}`;
    await invoke("terminal:write", { threadId: thread.id, sessionId: terminal.sessionId,
      // Split the token so the echoed command cannot satisfy the output assertion.
      data: `printf '%s%s\\n' 'MODEX_NATIVE_' ${quote(suffix)} | tee ${quote(receipt)}\r` });
    await until(() => fs.existsSync(receipt) && fs.readFileSync(receipt, "utf8") === token + "\n", "packaged terminal input");
    await until(async () => (await invoke("terminal:open", { threadId: thread.id, cols: 80, rows: 24 })).output.includes(token), "packaged terminal output");
    await invoke("terminal:close", { threadId: thread.id, sessionId: terminal.sessionId });
    await page.screenshot({ path: path.join(evidence, `${kind}.png`) });
    result.launches.push({ kind, ...identity, terminal: "input/output/cleanup receipt passed", threadId: thread.id, credentialAction });
  } catch (error) { launchFailure = error; }
  finally {
    try { await closeApp(app); }
    catch (error) { launchFailure = launchFailure ? new AggregateError([launchFailure, error], "Launch acceptance and close failed") : error; }
  }
  if (launchFailure) throw launchFailure;
}
try {
  await startKeyring();
  installAttempted = true;
  command("sudo", ["apt-get", "install", "-y", artifacts.get(".deb")]);
  const files = execFileSync("dpkg-query", ["-L", "modex"], { encoding: "utf8" }).trim().split("\n");
  const binaries = files.filter(file => file.startsWith("/opt/") && file.endsWith("/modex") && fs.statSync(file).isFile());
  assert.equal(binaries.length, 1, "One installed executable required");
  installedBinary = binaries[0];
  await launch(installedBinary, "debian", "write");
  await launch(installedBinary, "debian-restart", "read");
  await launch(installedBinary, "debian-basic-refusal", "refuse");
  const extracted = path.join(root, "appimage");
  fs.mkdirSync(extracted);
  fs.chmodSync(artifacts.get(".AppImage"), 0o755);
  command(artifacts.get(".AppImage"), ["--appimage-extract"], { cwd: extracted, stdio: "ignore" });
  await launch(path.join(extracted, "squashfs-root", "AppRun"), "appimage-extracted", "read");
  result.credentials = "production SecretStore libsecret encryption persisted across restart and package formats; basic_text refused new/overwrite writes and preserved ciphertext";
} catch (error) { failure = error; }
finally {
  try {
    if (installAttempted) {
      assert.equal(openApps.size, 0, "Refusing to uninstall while an owned app may still be alive");
      command("sudo", ["dpkg", "--remove", "modex"]);
      if (installedBinary) assert.ok(!fs.existsSync(installedBinary), "Debian executable survived uninstall");
      assert.equal(fs.readFileSync(sentinel, "utf8"), marker);
      if (encryptedHash) assert.equal(createHash("sha256").update(fs.readFileSync(credentialFile)).digest("hex"), encryptedHash);
      const state = JSON.parse(fs.readFileSync(path.join(home, "app", "state.json"), "utf8"));
      for (const launch of result.launches) assert.ok(state.threads.some(thread => thread.id === launch.threadId));
      result.uninstall = "package removed; recorded threads, probe ciphertext and unrelated data retained";
    }
  } catch (error) { failure = failure ? new AggregateError([failure, error], "Acceptance and cleanup failed") : error; }
  try { await stopKeyring(); }
  catch (error) { failure = failure ? new AggregateError([failure, error], "Acceptance and keyring cleanup failed") : error; }
  result.error = failure ? String(failure) : undefined;
  fs.writeFileSync(path.join(evidence, "result.json"), JSON.stringify(result, null, 2) + "\n");
}
if (failure) throw failure;
console.log(JSON.stringify(result, null, 2));
