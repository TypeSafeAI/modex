import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

const require = createRequire(import.meta.url);
const digest = data => createHash("sha256").update(data).digest("hex");

export function prepareWindowsPty() {
  const root = path.dirname(require.resolve("node-pty/package.json"));
  const patch = JSON.parse(fs.readFileSync(new URL("./patches/node-pty-windows.json", import.meta.url), "utf8"));
  assert.equal(require("node-pty/package.json").version, patch.version, "Review Windows PTY cleanup when updating node-pty");
  // Validate every source before changing any file. Already-patched installs are
  // accepted only by their full digest; drift must receive a new reviewed patch.
  const changes = patch.files.map(entry => {
    const file = path.join(root, entry.file);
    const original = fs.readFileSync(file, "utf8");
    if (digest(original) === entry.afterSha256) return { file, original, patched: original };
    assert.equal(digest(original), entry.beforeSha256, `Unexpected node-pty source: ${entry.file}`);
    let patched = original;
    for (const { before, after } of entry.replacements) {
      assert.equal(patched.split(before).length, 2, `Ambiguous node-pty patch: ${entry.file}`);
      patched = patched.replace(before, after);
    }
    assert.equal(digest(patched), entry.afterSha256);
    return { file, original, patched };
  });
  for (const { file, original, patched } of changes) if (original !== patched) fs.writeFileSync(file, patched);
  if (process.platform !== "win32") return;

  const electron = require("../package.json").build.electronVersion;
  const binary = path.join(root, "build", "Release", "conpty.node");
  const receipt = path.join(root, "build", "modex-cleanup.json");
  const source = digest(JSON.stringify(patch));
  let previous;
  try { previous = JSON.parse(fs.readFileSync(receipt, "utf8")); } catch { /* Fresh install/rebuild. */ }
  if (previous?.source !== source || previous.electron !== electron || previous.arch !== process.arch ||
      !fs.existsSync(binary) || previous.binary !== digest(fs.readFileSync(binary))) {
    execFileSync(process.execPath, [require.resolve("node-gyp/bin/node-gyp.js"), "rebuild",
      `--target=${electron}`, `--arch=${process.arch}`, "--dist-url=https://electronjs.org/headers"],
    { cwd: root, stdio: "inherit", env: { ...process.env, npm_config_runtime: "electron" } });
    // Preserve upstream's DLL layout without modifying signed runtime resources.
    execFileSync(process.execPath, [path.join(root, "scripts", "post-install.js")], { cwd: root, stdio: "inherit" });
    fs.writeFileSync(receipt, JSON.stringify({ source, electron, arch: process.arch, binary: digest(fs.readFileSync(binary)) }));
  }
  // node-pty's loader falls back silently to published binaries on load failure.
  // Both this build guard and spawnTerminal's runtime guard reject that fallback.
  const loaded = require("node-pty/lib/utils.js").loadNativeModule("conpty");
  assert.equal(loaded.dir, "../build/Release");
  assert.equal(loaded.module.modexCleanupPatch, 1, "Patched Windows terminal addon required");
}
