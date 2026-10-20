import { test } from "node:test";
import assert from "node:assert/strict";

const release = await import("../verify-release-candidate.mjs").catch(error => {
  if (error.code === "ERR_MODULE_NOT_FOUND") return {};
  throw error;
});
const input = { tag: "v0.0.11", version: "0.0.11", sourceSha: "a".repeat(40), runId: "123" };

test("release identity requires exact stable tag/package/source/run agreement", () => {
  assert.equal(typeof release.releaseIdentity, "function", "Release identity validation is required");
  assert.deepEqual(release.releaseIdentity(input), input);
  for (const mutation of [
    { tag: "v0.0.10" }, { tag: "refs/tags/v0.0.11" }, { version: "0.0.0", tag: "v0.0.0" },
    { version: "0.0.11-beta", tag: "v0.0.11-beta" }, { version: "01.0.0", tag: "v01.0.0" },
    { version: "0.0.11" + String.fromCharCode(10), tag: "v0.0.11" + String.fromCharCode(10) }, { sourceSha: "a".repeat(40) + String.fromCharCode(10) }, { runId: "123" + String.fromCharCode(10) }, { sourceSha: "main" }, { sourceSha: "A".repeat(40) }, { runId: "" }, { runId: "123\\n" },
  ]) assert.throws(() => release.releaseIdentity({ ...input, ...mutation }));
});

test("a rehearsal tag names the package version and an rc number", () => {
  for (const tag of ["v0.0.11-rc.1", "v0.0.11-rc.12"]) assert.deepEqual(release.releaseIdentity({ ...input, tag }), { ...input, tag });
  for (const tag of ["v0.0.10-rc.1", "v0.0.11-rc.0", "v0.0.11-rc.01", "v0.0.11-rc", "v0.0.11-rc.", "v0.0.11-beta.1",
    "v0.0.11-rc.1-x", "v0.0.11-RC.1", "v0.0.11-rc.1" + String.fromCharCode(10), "refs/tags/v0.0.11-rc.1"]) {
    assert.throws(() => release.releaseIdentity({ ...input, tag }), undefined, tag);
  }
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const writeJSON = (file, value) => fs.writeFileSync(file, JSON.stringify(value));
function fixture(t, identity = input) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "modex-release-candidate-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const manifests = {}, reports = {}, proofs = {}, artifacts = [];
  const names = {
    macos: [`Modex-${identity.version}-arm64.dmg`, `Modex-${identity.version}-arm64.zip`],
    win32: [`Modex-${identity.version}-windows-x64.exe`],
    linux: [`Modex-${identity.version}-linux-x86_64.AppImage`, `Modex-${identity.version}-linux-amd64.deb`],
  };
  for (const [platform, files] of Object.entries(names)) {
    const folder = path.join(directory, platform); fs.mkdirSync(folder);
    const entries = files.map(name => {
      const bytes = Buffer.from(`synthetic installer: ${name}`); fs.writeFileSync(path.join(folder, name), bytes);
      const entry = { name, bytes: bytes.length, sha256: sha256(bytes) }; artifacts.push({ platform, ...entry }); return entry;
    });
    if (platform === "macos") {
      fs.writeFileSync(path.join(folder, "SHA256SUMS.txt"), entries.map(e => `${e.sha256}  ${e.name}\n`).join(""));
    } else {
      manifests[platform] = { schema: 1, platform, arch: "x64", sourceSha: identity.sourceSha, runId: identity.runId, version: identity.version, baseline: false, installerAcceptance: "pending", artifacts: entries };
      writeJSON(path.join(folder, "native-packages.json"), manifests[platform]);
      const evidence = path.join(directory, `installed-${platform}`); fs.mkdirSync(evidence);
      reports[platform] = { schema: 1, platform, arch: "x64", sourceSha: identity.sourceSha, runId: identity.runId, nativeChecksPassed: true, installerAcceptance: "pending", remaining: ["complete CLI/account acceptance"], candidate: structuredClone(manifests[platform]) };
      writeJSON(path.join(evidence, "result.json"), reports[platform]);
    }
  }
  const zip = artifacts.find(e => e.name.endsWith(".zip"));
  for (const scenario of ["upgrade", "native-failure", "interrupted"]) {
    const folder = path.join(directory, `macos-${scenario}`); fs.mkdirSync(folder);
    proofs[scenario] = { schema: 1, scenario, sourceVersion: "0.0.0", targetVersion: identity.version, sourceSha: identity.sourceSha, run: identity.runId, arch: "arm64", bytes: zip.bytes, sha256: zip.sha256, passed: true, nativeEventsSimulated: false };
    writeJSON(path.join(folder, "result.json"), proofs[scenario]);
  }
  return { directory, artifacts, manifests, reports, proofs, names,
    saveManifest: p => writeJSON(path.join(directory, p, "native-packages.json"), manifests[p]),
    saveReport: p => writeJSON(path.join(directory, `installed-${p}`, "result.json"), reports[p]),
    saveProof: p => writeJSON(path.join(directory, `macos-${p}`, "result.json"), proofs[p]),
  };
}
const verify = (directory, identity = input) => {
  assert.equal(typeof release.verifyReleaseCandidate, "function", "Artifact/acceptance validation is required");
  return release.verifyReleaseCandidate(directory, identity);
};

test("release verification binds all five real files to exact native acceptance receipts", async t => {
  const f = fixture(t); const result = await verify(f.directory);
  assert.deepEqual(result.artifacts, f.artifacts);
  assert.deepEqual(result.identity, input);
  assert.deepEqual(result.acceptance.win32.remaining, ["complete CLI/account acceptance"]);
  assert.equal(result.acceptance.win32.installerAcceptance, "pending");
});

for (const [name, mutate] of [
  ["same-length installer tampering", f => { const file = path.join(f.directory, "win32", f.names.win32[0]); const bytes = fs.readFileSync(file); bytes[0] ^= 1; fs.writeFileSync(file, bytes); }],
  ["missing package", f => fs.unlinkSync(path.join(f.directory, "linux", f.names.linux[1]))],
  ["unexpected package", f => fs.writeFileSync(path.join(f.directory, "win32", "unverified.exe"), "unverified")],
  ["symlinked installer", f => { const file = path.join(f.directory, "win32", f.names.win32[0]); fs.renameSync(file, path.join(f.directory, "outside.exe")); fs.symlinkSync("../outside.exe", file); }],
  ["symlinked manifest", f => { const file = path.join(f.directory, "win32", "native-packages.json"); fs.renameSync(file, path.join(f.directory, "outside.json")); fs.symlinkSync("../outside.json", file); }],
  ["synthetic baseline", f => { f.manifests.win32.baseline = true; f.saveManifest("win32"); }],
  ["stale native source", f => { f.reports.win32.sourceSha = "b".repeat(40); f.saveReport("win32"); }],
  ["stale native run", f => { f.reports.linux.runId = "124"; f.saveReport("linux"); }],
  ["failed native acceptance", f => { f.reports.win32.nativeChecksPassed = false; f.saveReport("win32"); }],
  ["contradictory native error", f => { f.reports.win32.error = "uninstall failed"; f.saveReport("win32"); }],
  ["receipt for different artifact bytes", f => { f.reports.linux.candidate.artifacts[0].sha256 = "0".repeat(64); f.saveReport("linux"); }],
  ["missing macOS scenario", f => fs.unlinkSync(path.join(f.directory, "macos-interrupted", "result.json"))],
  ["failed macOS scenario", f => { f.proofs.upgrade.passed = false; f.saveProof("upgrade"); }],
  ["simulated macOS native events", f => { f.proofs.upgrade.nativeEventsSimulated = true; f.saveProof("upgrade"); }],
  ["stale macOS version", f => { f.proofs["native-failure"].targetVersion = "0.0.10"; f.saveProof("native-failure"); }],
  ["macOS proof for different ZIP", f => { f.proofs.interrupted.sha256 = "0".repeat(64); f.saveProof("interrupted"); }],
  ["macOS checksums naming outside files", f => fs.appendFileSync(path.join(f.directory, "macos", "SHA256SUMS.txt"), `${"0".repeat(64)}  ../outside\n`)],
]) test(`release verification rejects ${name}`, async t => {
  const f = fixture(t); mutate(f);
  assert.equal(typeof release.verifyReleaseCandidate, "function", "Artifact/acceptance validation is required");
  await assert.rejects(verify(f.directory));
});

const collect = (directory, output) => {
  assert.equal(typeof release.collectReleaseCandidate, "function", "Verified candidate collection is required");
  return release.collectReleaseCandidate(directory, input, output);
};
test("collection copies only verified installers and writes matching public manifests", async t => {
  const f = fixture(t); const output = path.join(f.directory, "verified");
  await collect(f.directory, output);
  assert.deepEqual(fs.readdirSync(output).sort(), [...f.artifacts.map(a => a.name), "SHA256SUMS.txt", "RELEASE-MANIFEST.json"].sort());
  const report = JSON.parse(fs.readFileSync(path.join(output, "RELEASE-MANIFEST.json")));
  assert.deepEqual(report.artifacts, f.artifacts);
  for (const artifact of report.artifacts) assert.equal(sha256(fs.readFileSync(path.join(output, artifact.name))), artifact.sha256);
  assert.equal(fs.readFileSync(path.join(output, "SHA256SUMS.txt"), "utf8"), f.artifacts.map(a => `${a.sha256}  ${a.name}\n`).join(""));
});
test("collection refuses existing output without deleting it", async t => {
  const f = fixture(t); const output = path.join(f.directory, "verified"); fs.mkdirSync(output);
  fs.writeFileSync(path.join(output, "keep"), "original");
  assert.equal(typeof release.collectReleaseCandidate, "function", "Verified candidate collection is required");
  await assert.rejects(collect(f.directory, output));
  assert.equal(fs.readFileSync(path.join(output, "keep"), "utf8"), "original");
});
test("collection refuses broken output symlinks and leaves rejected inputs untouched", async t => {
  const f = fixture(t); const output = path.join(f.directory, "verified"); fs.symlinkSync("missing-target", output);
  assert.equal(typeof release.collectReleaseCandidate, "function", "Verified candidate collection is required");
  await assert.rejects(collect(f.directory, output)); assert.ok(fs.lstatSync(output).isSymbolicLink());
  fs.unlinkSync(output); f.reports.win32.nativeChecksPassed = false; f.saveReport("win32");
  await assert.rejects(collect(f.directory, output)); assert.ok(!fs.existsSync(output));
  assert.ok(fs.existsSync(path.join(f.directory, "win32", f.names.win32[0])));
});

import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const project = fileURLToPath(new URL("../../", import.meta.url));
const cli = fileURLToPath(new URL("../verify-release-candidate.mjs", import.meta.url));
function cliEnvironment() {
  const version = JSON.parse(fs.readFileSync(path.join(project, "apps/desktop/package.json"))).version;
  const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: project, encoding: "utf8" }).trim();
  return { ...process.env, GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: `v${version}`, GITHUB_SHA: sourceSha, GITHUB_RUN_ID: "123" };
}
test("identity CLI binds the checked-out package and commit to the tagged workflow", () => {
  const env = cliEnvironment(); const result = spawnSync(process.execPath, [cli, "identity"], { cwd: project, env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.trim(), "CLI must produce a verified identity");
  assert.deepEqual(JSON.parse(result.stdout), { tag: env.GITHUB_REF_NAME, version: env.GITHUB_REF_NAME.slice(1), sourceSha: env.GITHUB_SHA, runId: "123" });
});
test("identity CLI accepts a rehearsal tag for the checked-out package version", () => {
  const env = { ...cliEnvironment() }; env.GITHUB_REF_NAME += "-rc.2";
  const result = spawnSync(process.execPath, [cli, "identity"], { cwd: project, env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { tag: env.GITHUB_REF_NAME, version: env.GITHUB_REF_NAME.slice(1, -"-rc.2".length), sourceSha: env.GITHUB_SHA, runId: "123" });
});
test("identity CLI refuses mismatched tags, commits, non-tag events and unsupported commands", () => {
  const env = cliEnvironment();
  for (const override of [{ GITHUB_REF_NAME: "v0.0.0" }, { GITHUB_SHA: "b".repeat(40) }, { GITHUB_REF_TYPE: "branch" }]) {
    const result = spawnSync(process.execPath, [cli, "identity"], { cwd: project, env: { ...env, ...override }, encoding: "utf8" });
    assert.notEqual(result.status, 0, "Invalid release identity must fail");
  }
  assert.notEqual(spawnSync(process.execPath, [cli, "publish"], { cwd: project, env, encoding: "utf8" }).status, 0);
});

test("collect CLI verifies the workflow candidate and emits only the upload allowlist", t => {
  const env = cliEnvironment();
  const identity = { tag: env.GITHUB_REF_NAME, version: env.GITHUB_REF_NAME.slice(1), sourceSha: env.GITHUB_SHA, runId: env.GITHUB_RUN_ID };
  const f = fixture(t, identity); const output = path.join(f.directory, "verified");
  const result = spawnSync(process.execPath, [cli, "collect", f.directory, output], { cwd: project, env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).identity, identity);
  assert.deepEqual(fs.readdirSync(output).sort(), [...f.artifacts.map(a => a.name), "SHA256SUMS.txt", "RELEASE-MANIFEST.json"].sort());
  for (const args of [["collect"], ["collect", f.directory], ["collect", f.directory, output, "extra"], ["identity", "extra"]]) {
    assert.notEqual(spawnSync(process.execPath, [cli, ...args], { cwd: project, env, encoding: "utf8" }).status, 0);
  }
});
