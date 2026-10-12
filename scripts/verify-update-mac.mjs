#!/usr/bin/env node
// Only the protected release workflow invokes this. Each acceptance scenario uses
// a fresh hosted runner, its default user home and untouched Squirrel state.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync, execFileSync } from "node:child_process";
import { requireHostedMac, requireAbsent, runNativeUpdateAcceptance } from "../apps/desktop/scripts/native-update-acceptance.mjs";
import { withSourceFixture } from "../apps/desktop/scripts/update-acceptance-fixture.mjs";
import { writeFixtureManifest, verifyFixtureManifest } from "../apps/desktop/scripts/update-acceptance-artifacts.mjs";

requireHostedMac();
const mode = process.argv[2];
if (mode !== "prepare" && mode !== "accept") throw new Error("Use prepare or accept in the release workflow.");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const work = fs.realpathSync(fs.mkdtempSync(path.join(process.env.RUNNER_TEMP, "modex-native-update-")));
const evidence = path.join(process.env.RUNNER_TEMP, "modex-update-acceptance-evidence");
const fixtures = path.join(process.env.RUNNER_TEMP, "modex-update-fixtures");
fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });
try {
  if (mode === "prepare") {
    const desktop = path.join(root, "apps/desktop");
    const releaseDirectory = path.join(desktop, "release");
    const packageFile = path.join(desktop, "package.json");
    const version = JSON.parse(fs.readFileSync(packageFile, "utf8")).version;
    if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version) || version === "0.0.0") throw new Error("Acceptance requires a stable candidate newer than the private source fixture.");
    const candidateArchive = path.join(releaseDirectory, `Modex-${version}-arm64.zip`);
    if (!fs.lstatSync(candidateArchive).isFile()) throw new Error("The signed candidate ZIP is missing.");
    requireAbsent([fixtures]);
    await withSourceFixture({ packageFile, releaseDirectory, work, build: async () => {
      const log = fs.openSync(path.join(evidence, "source-build.log"), "w", 0o600);
      try {
        const result = spawnSync(path.join(root, "scripts/release-mac.sh"), [], { cwd: root, env: process.env, stdio: ["ignore", log, log], timeout: 30 * 60 * 1000 });
        if (result.error) throw result.error;
        if (result.status !== 0) throw new Error(`Private source fixture build failed (${result.status}); see source-build.log.`);
      } finally { fs.closeSync(log); }
    } }, source => {
      fs.mkdirSync(fixtures, { mode: 0o700 });
      fs.copyFileSync(path.join(source, "Modex-0.0.0-arm64.zip"), path.join(fixtures, "source.zip"));
      fs.copyFileSync(candidateArchive, path.join(fixtures, "candidate.zip"));
      writeFixtureManifest(fixtures, version, process.env.GITHUB_SHA);
    });
    console.log("Signed fixtures prepared; candidate artifacts and package version restored.");
  } else {
    const scenario = process.env.MODEX_UPDATE_SCENARIO;
    if (!["upgrade", "native-failure", "interrupted"].includes(scenario)) throw new Error("A supported native acceptance scenario is required.");
    const manifest = verifyFixtureManifest(fixtures, process.env.GITHUB_SHA);
    fs.copyFileSync(path.join(fixtures, "manifest.json"), path.join(evidence, "fixture-manifest.json"));
    const source = path.join(work, "source");
    execFileSync("/usr/bin/ditto", ["-x", "-k", path.join(fixtures, "source.zip"), source], { timeout: 120_000 });
    const sourceApp = path.join(source, "Modex.app");
    execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", sourceApp], { timeout: 120_000 });
    execFileSync("/usr/sbin/spctl", ["--assess", "--type", "execute", sourceApp], { timeout: 120_000 });
    await runNativeUpdateAcceptance({ sourceApp, candidateArchive: path.join(fixtures, "candidate.zip"), version: manifest.version, work, evidence, scenario });
    console.log(`Signed native update acceptance passed: ${scenario}.`);
  }
} catch (error) {
  try { fs.writeFileSync(path.join(evidence, "orchestrator-failure.json"), JSON.stringify({ mode, scenario: process.env.MODEX_UPDATE_SCENARIO, failure: String(error), sourceSha: process.env.GITHUB_SHA }, null, 2) + "\n"); }
  catch (writeError) { throw new AggregateError([error, writeError], "Acceptance failed and evidence could not be saved."); }
  throw error;
}
