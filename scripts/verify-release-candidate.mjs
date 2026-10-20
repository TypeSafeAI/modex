import assert from "node:assert/strict";

/** The signed tag, package and workflow must describe one release candidate. A rehearsal
 * tag `v<version>-rc.<N>` runs the same workflow for the same package version; its draft is
 * deleted afterwards and never published. */
export function releaseIdentity({ tag, version, sourceSha, runId }) {
  assert.match(version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  assert.equal(version.trim(), version);
  assert.notEqual(version, "0.0.0", "Synthetic baselines cannot be released");
  const rehearsal = `v${version}-rc.`;
  assert.ok(tag === `v${version}` || (tag.startsWith(rehearsal) && /^[1-9]\d*$/.test(tag.slice(rehearsal.length))),
    "Release tag must match desktop package version");
  assert.match(sourceSha, /^[0-9a-f]{40}$/);
  assert.equal(sourceSha.length, 40);
  assert.match(runId, /^[1-9]\d*$/);
  assert.equal(runId.trim(), runId);
  return { tag, version, sourceSha, runId };
}

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { readNativePackages } from "../apps/desktop/scripts/read-native-packages.mjs";

const scenarios = ["upgrade", "native-failure", "interrupted"];
function directoryAt(directory) {
  assert.ok(fs.lstatSync(directory).isDirectory(), `Regular directory required: ${directory}`);
}
function metadata(file) {
  const stat = fs.lstatSync(file);
  assert.ok(stat.isFile() && stat.size <= 1024 * 1024, `Bounded regular metadata required: ${file}`);
  return fs.readFileSync(file, "utf8");
}
function exactFiles(directory, names) {
  directoryAt(directory);
  assert.deepEqual(fs.readdirSync(directory).sort(), [...names].sort(), `Unexpected candidate files: ${directory}`);
}
async function fileDigest(file) {
  assert.ok(fs.lstatSync(file).isFile(), `Regular installer required: ${file}`);
  const hash = createHash("sha256"); let bytes = 0;
  for await (const chunk of fs.createReadStream(file)) { bytes += chunk.length; hash.update(chunk); }
  assert.ok(bytes > 0, "Installer must not be empty");
  return { bytes, sha256: hash.digest("hex") };
}
function readResult(directory) {
  directoryAt(directory);
  return JSON.parse(metadata(path.join(directory, "result.json")));
}

/** Read-only verification. Native execution is performed by the prerequisite jobs. */
export async function verifyReleaseCandidate(directory, expected) {
  const identity = releaseIdentity(expected);
  const { version, sourceSha, runId } = identity;
  directoryAt(directory);
  const names = {
    macos: [`Modex-${version}-arm64.dmg`, `Modex-${version}-arm64.zip`],
    win32: [`Modex-${version}-windows-x64.exe`],
    linux: [`Modex-${version}-linux-x86_64.AppImage`, `Modex-${version}-linux-amd64.deb`],
  };
  const artifacts = [], acceptance = {};
  const macDirectory = path.join(directory, "macos");
  exactFiles(macDirectory, [...names.macos, "SHA256SUMS.txt"]);
  const checksums = new Map();
  for (const line of metadata(path.join(macDirectory, "SHA256SUMS.txt")).trimEnd().split("\n")) {
    const match = /^([0-9a-f]{64}) [ *](\S+)$/.exec(line);
    assert.ok(match && names.macos.includes(match[2]), "Unexpected macOS checksum entry");
    assert.ok(!checksums.has(match[2]), "Duplicate macOS checksum entry");
    checksums.set(match[2], match[1]);
  }
  assert.equal(checksums.size, names.macos.length);
  for (const name of names.macos) {
    const digest = await fileDigest(path.join(macDirectory, name));
    assert.equal(digest.sha256, checksums.get(name), `macOS checksum mismatch: ${name}`);
    artifacts.push({ platform: "macos", name, ...digest });
  }
  const zip = artifacts.find(artifact => artifact.name.endsWith(".zip"));
  for (const scenario of scenarios) {
    const proof = readResult(path.join(directory, `macos-${scenario}`));
    const fields = { schema: 1, scenario, sourceVersion: "0.0.0", targetVersion: version, sourceSha, run: runId,
      arch: "arm64", bytes: zip.bytes, sha256: zip.sha256, passed: true, nativeEventsSimulated: false };
    for (const [key, value] of Object.entries(fields)) assert.equal(proof[key], value, `macOS ${scenario} receipt ${key}`);
    assert.ok(!("failure" in proof) && !("finalizationFailures" in proof), "Native macOS acceptance reported a failure");
  }
  acceptance.macos = { scenarios, sourceVersion: "0.0.0", historicalMigrationVerified: false };
  for (const platform of ["win32", "linux"]) {
    const folder = path.join(directory, platform);
    exactFiles(folder, [...names[platform], "native-packages.json"]);
    // Check metadata identity before the shared native validator reads it.
    metadata(path.join(folder, "native-packages.json"));
    const { manifest } = await readNativePackages(folder, { platform, arch: "x64", sourceSha, runId, version, baseline: false });
    const report = readResult(path.join(directory, `installed-${platform}`));
    for (const [key, value] of Object.entries({ schema: 1, platform, arch: "x64", sourceSha, runId, nativeChecksPassed: true, installerAcceptance: "pending" })) {
      assert.equal(report[key], value, `${platform} receipt ${key}`);
    }
    assert.ok(!("error" in report), "Native acceptance reported an error");
    assert.deepEqual(report.candidate, manifest, "Acceptance receipt must bind the exact installer manifest");
    assert.ok(Array.isArray(report.remaining) && report.remaining.length > 0 && report.remaining.every(value => typeof value === "string" && value.length > 0), "Remaining native acceptance limits are required");
    for (const name of names[platform]) {
      const entry = manifest.artifacts.find(artifact => artifact.name === name);
      assert.ok(entry, `Missing expected ${platform} artifact ${name}`);
      assert.ok(Number.isSafeInteger(entry.bytes) && entry.bytes > 0);
      assert.match(entry.sha256, /^[0-9a-f]{64}$/); assert.equal(entry.sha256.length, 64);
      artifacts.push({ platform, name, bytes: entry.bytes, sha256: entry.sha256 });
    }
    acceptance[platform] = { nativeChecksPassed: true, installerAcceptance: "pending", remaining: report.remaining };
  }
  return { schema: 1, identity, artifacts, acceptance };
}

/** Reserve a fresh private output directory; a failed collection is never uploadable. */
export async function collectReleaseCandidate(directory, expected, output) {
  const report = await verifyReleaseCandidate(directory, expected);
  directoryAt(path.dirname(output));
  // mkdir is the no-overwrite boundary, including for dangling symlinks.
  fs.mkdirSync(output, { mode: 0o700 });
  try {
    for (const artifact of report.artifacts) {
      const target = path.join(output, artifact.name);
      fs.copyFileSync(path.join(directory, artifact.platform, artifact.name), target, fs.constants.COPYFILE_EXCL);
      assert.deepEqual(await fileDigest(target), { bytes: artifact.bytes, sha256: artifact.sha256 }, "Copied installer bytes changed");
    }
    fs.writeFileSync(path.join(output, "SHA256SUMS.txt"), report.artifacts.map(a => `${a.sha256}  ${a.name}\n`).join(""), { flag: "wx" });
    fs.writeFileSync(path.join(output, "RELEASE-MANIFEST.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
    return report;
  } catch (error) {
    fs.rmSync(output, { recursive: true, force: true });
    throw error;
  }
}

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = fileURLToPath(new URL("../", import.meta.url));
    assert.equal(process.env.GITHUB_REF_TYPE, "tag", "A tagged workflow is required");
    const version = JSON.parse(metadata(path.join(root, "apps/desktop/package.json"))).version;
    const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    assert.equal(sourceSha, process.env.GITHUB_SHA, "Checkout must match workflow source");
    const identity = releaseIdentity({ tag: process.env.GITHUB_REF_NAME, version, sourceSha, runId: process.env.GITHUB_RUN_ID });
    const [command, ...args] = process.argv.slice(2);
    if (command === "identity") {
      assert.equal(args.length, 0, "identity takes no arguments");
      console.log(JSON.stringify(identity));
    } else {
      assert.ok(command === "collect" && args.length === 2, "Expected collect <candidate-directory> <fresh-output-directory>");
      console.log(JSON.stringify(await collectReleaseCandidate(path.resolve(args[0]), identity, path.resolve(args[1]))));
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
