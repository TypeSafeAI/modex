import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveCli, verifyCliOverride } from "../src/main/engine/cli-path.js";
import { saveSettings } from "../src/main/engine/settings-update.js";
import { Store } from "../src/main/engine/store.js";

function fixture(t: import("node:test").TestContext) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "modex-cli-path-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = (rel: string, output = "2.1.288 (Claude Code)", executable = true) => {
    const name = path.join(home, rel);
    fs.mkdirSync(path.dirname(name), { recursive: true });
    fs.writeFileSync(name, `#!/bin/sh\n[ "$1" = "--version" ] || exit 9\nprintf '%s\\n' '${output}'\n`, { mode: executable ? 0o755 : 0o644 });
    return name;
  };
  return { home, file, env: { HOME: home, PATH: path.join(home, "bin"), MODEX_NO_LOGIN_PATH: "1" } };
}

test("automatic discovery resolves PATH symlinks and sees installs added after startup", (t) => {
  const { home, file, env } = fixture(t);
  assert.throws(() => resolveCli("claude", "", { env }), /not found/i);
  const real = file("releases/claude");
  fs.mkdirSync(path.join(home, "bin"));
  fs.symlinkSync(real, path.join(home, "bin/claude"));
  assert.equal(resolveCli("claude", "", { env }), path.join(home, "bin/claude"));
  fs.unlinkSync(path.join(home, "bin/claude"));
  assert.throws(() => resolveCli("claude", "claude", { env }), /not found/i);
});

test("automatic discovery finds native and version-manager installs with a minimal PATH", (t) => {
  const { home, file } = fixture(t);
  const native = file(".local/bin/claude");
  assert.equal(resolveCli("claude", "", { env: { HOME: home, PATH: "/usr/bin:/bin" } }), native);
  const nvm = file(".nvm/versions/node/v24.0.0/bin/codex", "codex-cli 0.160.0");
  assert.equal(resolveCli("codex", "codex", { env: { HOME: home, PATH: "/usr/bin:/bin" } }), nvm);
});

test("overrides preserve paths with spaces, expand home, and reject command strings without executing them", async (t) => {
  const { home, file, env } = fixture(t);
  const bin = file("my tools/claude");
  assert.equal(await verifyCliOverride("claude", "~/my tools/claude", { env }), bin);
  for (const value of ["claude --dangerously-skip-permissions", `${bin} --version`, "claude; touch nope", "./claude"]) {
    await assert.rejects(verifyCliOverride("claude", value, { env }), /executable/i);
  }
  assert.equal(fs.existsSync(path.join(home, "nope")), false);
});

test("verification rejects non-executable files, directories, wrong CLIs and hung probes", async (t) => {
  const { home, file, env } = fixture(t);
  for (const bin of [file("plain", "ignored", false), home, file("wrong", "codex-cli 0.160.0"), file("unbranded", "1.2.3")]) {
    await assert.rejects(verifyCliOverride("claude", bin, { env }));
  }
  const hung = file("hung"); fs.writeFileSync(hung, "#!/bin/sh\nexec /bin/sleep 20\n");
  await assert.rejects(verifyCliOverride("claude", hung, { env, timeoutMs: 40 }), /timed out/i);
});

test("settings persist only after all overrides verify, normalize paths, and retain automatic mode", async (t) => {
  const { home, file } = fixture(t);
  const store = new Store(home); const router = { reset() {} };
  const before = store.snapshot();
  const claude = file("Claude Tools/claude");
  await assert.rejects(saveSettings(store, router, { claude_bin: claude, codex_bin: "/missing/codex", theme: "coven" }));
  assert.deepEqual(store.snapshot(), before);
  assert.deepEqual(new Store(home).snapshot(), before);
  await saveSettings(store, router, { claude_bin: `  ${claude}  ` });
  assert.equal(new Store(home).settings.claude_bin, claude);
  await saveSettings(store, router, { claude_bin: "" });
  assert.equal(new Store(home).settings.claude_bin, "claude");
});

test("a version-manager executable can load its adjacent Node runtime from a Finder PATH", async (t) => {
  const { home, file } = fixture(t);
  const cli = file(".nvm/versions/node/v24.0.0/bin/claude");
  fs.writeFileSync(cli, "#!/usr/bin/env modex-fixture-node\n");
  file(".nvm/versions/node/v24.0.0/bin/modex-fixture-node");
  // env passes the script filename before --version; this local runtime models that loader.
  fs.writeFileSync(path.join(path.dirname(cli), "modex-fixture-node"), "#!/bin/sh\nprintf '%s\\n' '2.1.288 (Claude Code)'\n");
  assert.equal(await verifyCliOverride("claude", cli, { env: { HOME: home, PATH: "/usr/bin:/bin" } }), cli);
});

function windowsFiles(t: import("node:test").TestContext, files: string[]) {
  const names = new Set(files.map(file => path.win32.normalize(file).toLowerCase()));
  t.mock.method(fs, "statSync", (file: string) => {
    if (!names.has(path.win32.normalize(file).toLowerCase())) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return { isFile: () => true };
  });
  t.mock.method(fs, "accessSync", (file: string) => {
    if (!names.has(path.win32.normalize(file).toLowerCase())) throw Object.assign(new Error("missing"), { code: "ENOENT" });
  });
}

test("Windows discovery honours PATH casing, PATHEXT order and paths with spaces", t => {
  windowsFiles(t, [String.raw`C:\CLI Tools\claude.exe`, String.raw`C:\CLI Tools\claude.cmd`]);
  const env = { Path: String.raw`relative;\drive-relative;"C:\CLI Tools"`, PATHEXT: ".CMD;.EXE", MODEX_NO_LOGIN_PATH: "1" };
  assert.equal(resolveCli("claude", "", { env, platform: "win32" }), String.raw`C:\CLI Tools\claude.cmd`);
  assert.equal(resolveCli("claude", "", { env: { ...env, PATHEXT: ".PS1;.EXE" }, platform: "win32" }), String.raw`C:\CLI Tools\claude.exe`);
});

test("Windows discovers native and npm installs without Unix fallback locations", t => {
  const home = String.raw`C:\Users\Val`;
  windowsFiles(t, [String.raw`C:\Users\Val\.local\bin\claude.exe`, String.raw`C:\Users\Val\AppData\Roaming\npm\codex.cmd`]);
  const options = { platform: "win32" as const, env: { USERPROFILE: home, APPDATA: String.raw`C:\Users\Val\AppData\Roaming`, Path: String.raw`C:\Windows\System32` } };
  assert.equal(resolveCli("claude", "", options), String.raw`C:\Users\Val\.local\bin\claude.exe`);
  assert.equal(resolveCli("codex", "", options), String.raw`C:\Users\Val\AppData\Roaming\npm\codex.cmd`);
  assert.throws(() => resolveCli("codex", "", { ...options, env: { ...options.env, MODEX_NO_LOGIN_PATH: "1" } }), /not found/i);
});

test("Windows overrides resolve native paths and shims but reject command strings and drive-relative paths", t => {
  windowsFiles(t, [String.raw`C:\Users\Val\CLI Tools\codex.cmd`, String.raw`C:\bin\custom.exe`, String.raw`\\server\tools\claude.exe`]);
  const options = { platform: "win32" as const, env: { USERPROFILE: String.raw`C:\Users\Val`, PATH: String.raw`C:\bin`, MODEX_NO_LOGIN_PATH: "1" } };
  assert.equal(resolveCli("codex", "~/CLI Tools/codex.cmd", options), String.raw`C:\Users\Val\CLI Tools\codex.cmd`);
  assert.equal(resolveCli("codex", "custom", options), String.raw`C:\bin\custom.exe`);
  assert.equal(resolveCli("claude", String.raw`\\server\tools\claude.exe`, options), String.raw`\\server\tools\claude.exe`);
  for (const value of [String.raw`C:custom.exe`, String.raw`\bin\custom.exe`, "codex --version", "codex&echo bad", "./custom.exe", "custom.ps1"]) {
    assert.throws(() => resolveCli("codex", value, options), /executable/i);
  }
});
