import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

// This script installs/removes a system package. It must never run on a developer host.
assert.equal(process.platform, "win32", "Hosted Windows acceptance only");
assert.equal(process.env.GITHUB_ACTIONS, "true", "GitHub Actions runner required");
assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted", "Disposable hosted runner required");
assert.ok(process.env.RUNNER_TEMP && path.isAbsolute(process.env.RUNNER_TEMP), "Runner temporary directory required");
assert.match(process.env.GITHUB_SHA ?? "", /^[0-9a-f]{40}$/);
assert.ok(!process.env.MODEX_E2E, "Real packaged runtime required");

const commandShell = process.env.ComSpec || process.env.COMSPEC;
assert.ok(commandShell && path.isAbsolute(commandShell) && fs.statSync(commandShell).isFile());
assert.equal(path.basename(commandShell).toLowerCase(), "cmd.exe", "This smoke requires the native command shell");
const launchEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "COMSPEC"));
const { _electron: electron } = await import("@playwright/test");
const candidates = fileURLToPath(new URL("../release/native-win32/", import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(candidates, "native-packages.json"), "utf8"));
assert.equal(manifest.platform, "win32");
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
assert.equal(artifacts.size, 1);
assert.ok(artifacts.has(".exe"));
// Fail before touching a registered installation, including a machine-wide one.
const registryScript = String.raw`
$ErrorActionPreference = 'Stop'
$roots = @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKCU:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall')
$matches = @(foreach ($root in $roots) {
  if (Test-Path $root) {
    Get-ChildItem $root | Get-ItemProperty | Where-Object { $_.DisplayName -eq 'Modex' -or $_.DisplayName -like 'Modex *' } |
      Select-Object PSPath, DisplayName, InstallLocation, UninstallString
  }
})
ConvertTo-Json -InputObject $matches -Compress
`;
function registrations() {
  return JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", registryScript],
    { encoding: "utf8", timeout: 15000, windowsHide: true }).trim());
}
assert.deepEqual(registrations(), [], "Refusing to replace an existing Modex installation");

const root = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP, "modex-installed-"));
const evidence = path.resolve("native-installed-win32");
fs.mkdirSync(evidence, { recursive: true });
const home = path.join(root, "home");
const project = path.join(root, "project");
const install = path.join(root, "install directory");
// NSIS /D= and _?= require a final unquoted path; reject delimiters rather than
// passing them through a shell. No shell is involved in installer execution.
assert.ok(!/["\r\n]/.test(install));
assert.ok(!/["%!\r\n&|<>^]/.test(project), "Unsupported cmd fixture path");
const credentialHome = path.join(root, "credential-probe");
const credentialFile = path.join(credentialHome, "app", "secrets.json");
const credential = `modex-acceptance-${randomUUID()}`;
let encryptedHash;
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
// NSIS normally targets these default Electron data directories. Seed owned
// markers there too so MODEX_HOME isolation cannot conceal data deletion.
assert.ok(process.env.APPDATA && path.isAbsolute(process.env.APPDATA));
const defaultData = [path.join(process.env.APPDATA, "Modex"), path.join(process.env.APPDATA, "@modex", "desktop")];
for (const directory of defaultData) assert.ok(!fs.existsSync(directory), "Refusing existing Modex app data");
const dataMarkers = defaultData.map(directory => {
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, "acceptance-retained-data");
  fs.writeFileSync(file, marker);
  return file;
});
const result = { schema: 1, sourceSha: manifest.sourceSha, runId: manifest.runId,
  platform: process.platform, arch: process.arch, terminalShell: commandShell, launches: [], uninstall: "pending",
  installerAcceptance: "pending", credentials: "pending", remaining: ["distinct-version upgrade", "default Windows shell selection", "complete CLI/account acceptance"] };
let installAttempted = false;
const installedBinary = path.join(install, "Modex.exe");
const uninstaller = path.join(install, "Uninstall Modex.exe");
let failure;
const openApps = new Set();
const command = (file, args, options = {}) => execFileSync(file, args, { timeout: 180000, stdio: "inherit", ...options });
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

async function launch(executablePath, kind, credentialAction) {
  const app = await electron.launch({ executablePath, timeout: 30000,
    env: { ...launchEnv, COMSPEC: commandShell, MODEX_HOME: home, MODEX_NO_LOGIN_PATH: "1",
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
      storageBackend: "Windows DPAPI",
      encryptionAvailable: safeStorage.isEncryptionAvailable(),
    }));
    assert.equal(identity.packaged, true);
    assert.equal(identity.platform, "win32");
    assert.equal(identity.arch, "x64");
    assert.equal(identity.appPath, path.join(install, "resources", "app.asar"));
    assert.equal(path.resolve(identity.executable).toLowerCase(), installedBinary.toLowerCase());
    assert.equal(identity.encryptionAvailable, true, "Real Windows DPAPI required");
    const stored = await app.evaluate(async ({ app, safeStorage }, { home, value, action }) => {
      const require = process.getBuiltinModule("module").createRequire(`${app.getAppPath()}/package.json`);
      const { SecretStore, electronCipher } = require("./dist/src/main/engine/secrets.js");
      const store = new SecretStore(home, electronCipher(safeStorage));
      if (action === "write") store.set("typesafe_api_key", value);
      return { available: store.available(), backend: store.backend, matches: store.get("typesafe_api_key") === value };
    }, { home: credentialHome, value: credential, action: credentialAction });
    assert.deepEqual(stored, { available: true, backend: "Windows DPAPI", matches: true });
    const encrypted = fs.readFileSync(credentialFile);
    const entry = JSON.parse(encrypted.toString()).entries.typesafe_api_key;
    assert.ok(!encrypted.includes(credential) && !Buffer.from(entry.enc, "base64").includes(credential));
    const currentHash = createHash("sha256").update(encrypted).digest("hex");
    if (credentialAction === "write") encryptedHash = currentHash;
    else assert.equal(currentHash, encryptedHash, "Restart must read existing ciphertext unchanged");
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
      data: `set "MODEX_NATIVE_PREFIX=MODEX_NATIVE_"\recho %MODEX_NATIVE_PREFIX%${suffix}>"${receipt}"\rtype "${receipt}"\r` });
    await until(() => fs.existsSync(receipt) && fs.readFileSync(receipt, "utf8").trim() === token, "packaged terminal input");
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
  installAttempted = true;
  command(artifacts.get(".exe"), ["/S", "/currentuser", `/D=${install}`], { windowsVerbatimArguments: true });
  assert.ok(fs.statSync(installedBinary).isFile());
  assert.ok(fs.statSync(uninstaller).isFile());
  const registered = registrations();
  assert.equal(registered.length, 1);
  assert.match(registered[0].PSPath, /HKEY_CURRENT_USER/i, "Per-user installation required");
  assert.ok(registered[0].UninstallString.toLowerCase().startsWith(`"${uninstaller.toLowerCase()}"`), "Registered uninstaller must belong to this installation");
  await launch(installedBinary, "nsis-first", "write");
  await launch(installedBinary, "nsis-restart", "read");
  result.credentials = "production SecretStore encrypted with DPAPI; read across app restart without changing ciphertext";
} catch (error) { failure = error; }
finally {
  try {
    if (installAttempted) {
      assert.equal(openApps.size, 0, "Refusing to uninstall while an owned app may still be alive");
      assert.ok(fs.existsSync(uninstaller), "Partial installation lacks an owned uninstaller");
      // Use the real NSIS uninstaller outside its install directory, suppressing
      // its self-copy so execFileSync waits for the actual uninstall process.
      const ownedUninstaller = path.join(root, "uninstall-run.exe");
      fs.copyFileSync(uninstaller, ownedUninstaller);
      command(ownedUninstaller, ["/S", "/currentuser", `_?=${install}`], { windowsVerbatimArguments: true });
      assert.ok(!fs.existsSync(installedBinary) && !fs.existsSync(path.join(install, "resources")), "Installed application survived uninstall");
      assert.deepEqual(registrations(), [], "Uninstall registration survived removal");
      if (encryptedHash) assert.equal(createHash("sha256").update(fs.readFileSync(credentialFile)).digest("hex"), encryptedHash);
      assert.equal(fs.readFileSync(sentinel, "utf8"), marker);
      for (const file of dataMarkers) assert.equal(fs.readFileSync(file, "utf8"), marker);
      const state = JSON.parse(fs.readFileSync(path.join(home, "app", "state.json"), "utf8"));
      for (const launch of result.launches) assert.ok(state.threads.some(thread => thread.id === launch.threadId));
      result.uninstall = "NSIS removed application and registration; recorded threads, probe ciphertext and unrelated data retained";
    }
  } catch (error) { failure = failure ? new AggregateError([failure, error], "Acceptance and cleanup failed") : error; }
  result.error = failure ? String(failure) : undefined;
  fs.writeFileSync(path.join(evidence, "result.json"), JSON.stringify(result, null, 2) + "\n");
}
if (failure) throw failure;
console.log(JSON.stringify(result, null, 2));
