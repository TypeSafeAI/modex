import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { requireHostedMac, requireAbsent, appEnvironment } from "../scripts/native-update-acceptance.mjs";
import { withSourceFixture } from "../scripts/update-acceptance-fixture.mjs";
import * as acceptance from "../scripts/native-update-acceptance.mjs";

test("native acceptance reads the exact schema2 project draft and rejects stale or ambiguous owners", () => {
  const saved = { schema: 2, drafts: { projects: [
    { key: "draft:7:p2", projectId: "p2", text: "other owner", attachments: [] },
    { key: "draft:7:p1", projectId: "p1", text: "  keep raw text 😀\n", attachments: [] },
  ], draft: { revision: 7, projectId: "p1" } } };
  assert.equal(acceptance.savedProjectDraft(saved, "p1"), "  keep raw text 😀\n");
  for (const mutate of [
    value => { value.schema = 1; value.drafts.draft.text = "old schema"; },
    value => { value.drafts.projects[1].key = "draft:6:p1"; },
    value => { value.drafts.projects.pop(); },
    value => { value.drafts.projects.push({ ...value.drafts.projects[1] }); },
    value => { value.drafts.projects[1].text = null; },
  ]) {
    const invalid = structuredClone(saved); mutate(invalid);
    assert.throws(() => acceptance.savedProjectDraft(invalid, "p1"));
  }
});

const hosted = { GITHUB_ACTIONS: "true", CI: "true", MODEX_RUNNER_ENVIRONMENT: "github-hosted", RUNNER_TEMP: "/runner/temp" };
test("native acceptance refuses local/self-hosted/foreign-platform execution before app work", () => {
  for (const [env, platform, arch] of [[{}, "darwin", "arm64"], [{ ...hosted, MODEX_RUNNER_ENVIRONMENT: "self-hosted" }, "darwin", "arm64"], [hosted, "linux", "arm64"], [hosted, "darwin", "x64"], [{ ...hosted, RUNNER_TEMP: "relative" }, "darwin", "arm64"]]) {
    assert.throws(() => requireHostedMac(env, platform, arch), /GitHub-hosted macOS/);
  }
  requireHostedMac(hosted, "darwin", "arm64");
});
test("native app environment retains account identity but excludes credentials and test-cipher flags", () => {
  const env = appEnvironment({ ...hosted, HOME: "/runner/home", PATH: "/usr/bin", APPLE_API_KEY: "private", GH_TOKEN: "private", MODEX_E2E: "1", MODEX_HOME: "/other/home", NODE_OPTIONS: "--require private", MODEX_VERSION: "wrong" });
  assert.equal(env.HOME, "/runner/home");
  assert.equal(env.PATH, "/usr/bin");
  for (const key of ["APPLE_API_KEY", "GH_TOKEN", "MODEX_E2E", "MODEX_HOME", "NODE_OPTIONS", "MODEX_VERSION"]) assert.equal(key in env, false);
});
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "modex-native-acceptance-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const packageFile = path.join(root, "package.json");
  const releaseDirectory = path.join(root, "release");
  const work = path.join(root, "owned");
  fs.mkdirSync(work); fs.mkdirSync(releaseDirectory);
  const original = '{"version":"0.0.11","name":"@modex/desktop"}\n';
  fs.writeFileSync(packageFile, original);
  fs.writeFileSync(path.join(releaseDirectory, "candidate.zip"), "real signed B bytes");
  return { root, packageFile, releaseDirectory, work, original };
}
test("existing native state including a dangling symlink is never treated as disposable", t => {
  const f = fixture(t);
  requireAbsent([path.join(f.root, "absent")]);
  assert.throws(() => requireAbsent([f.work]), /existing Modex state/);
  const dangling = path.join(f.root, "dangling"); fs.symlinkSync("missing", dangling);
  assert.throws(() => requireAbsent([dangling]), /existing Modex state/);
});
test("fixture build failure restores exact package bytes and preserves B and partial A artifacts", async t => {
  const f = fixture(t);
  await assert.rejects(withSourceFixture({ ...f, build: async () => {
    assert.equal(JSON.parse(fs.readFileSync(f.packageFile, "utf8")).version, "0.0.0");
    fs.mkdirSync(f.releaseDirectory); fs.writeFileSync(path.join(f.releaseDirectory, "partial-A"), "diagnostic");
    throw new Error("notary failure");
  } }, async () => assert.fail("must not run native acceptance")), /notary failure/);
  assert.equal(fs.readFileSync(f.packageFile, "utf8"), f.original);
  assert.equal(fs.readFileSync(path.join(f.releaseDirectory, "candidate.zip"), "utf8"), "real signed B bytes");
  assert.equal(fs.readFileSync(path.join(f.work, "failed-source/partial-A"), "utf8"), "diagnostic");
});
test("fixture callback runs with candidate artifacts and package version already restored", async t => {
  const f = fixture(t);
  await assert.rejects(withSourceFixture({ ...f, build: async () => {
    fs.mkdirSync(f.releaseDirectory); fs.writeFileSync(path.join(f.releaseDirectory, "fixture-A"), "private source");
  } }, async source => {
    assert.equal(fs.readFileSync(f.packageFile, "utf8"), f.original);
    assert.equal(fs.readFileSync(path.join(f.releaseDirectory, "candidate.zip"), "utf8"), "real signed B bytes");
    assert.equal(fs.readFileSync(path.join(source, "fixture-A"), "utf8"), "private source");
    throw new Error("native failure");
  }), /native failure/);
  assert.deepEqual(fs.readdirSync(f.releaseDirectory), ["candidate.zip"]);
  assert.equal(fs.readFileSync(f.packageFile, "utf8"), f.original);
});

test("cleanup catches an owned relaunch, escalates a stuck owned PID and waits for a quiet interval", async () => {
  const { stopOwnedProcesses } = await import("../scripts/update-acceptance-cleanup.mjs");
  let time = 0;
  let first = true, late = true;
  const signals = [];
  const stopped = await stopOwnedProcesses({
    list: () => [...(first ? [101] : []), ...(time >= 1000 && late ? [202] : [])],
    signal: (pid, name) => { signals.push([pid, name]); if (pid === 101 || name === "SIGKILL") { if (pid === 101) first = false; else late = false; } },
    now: () => time, sleep: async ms => { time += ms; }, quietMs: 3000, forceAfterMs: 500, timeoutMs: 10000,
  });
  assert.deepEqual(signals, [[101, "SIGTERM"], [202, "SIGTERM"], [202, "SIGKILL"]]);
  assert.deepEqual(stopped, [101, 202]);
  assert.ok(time >= 4500);
});
test("cleanup fails boundedly if an owned process cannot be stopped", async () => {
  const { stopOwnedProcesses } = await import("../scripts/update-acceptance-cleanup.mjs");
  let time = 0;
  await assert.rejects(stopOwnedProcesses({ list: () => [303], signal: () => {}, now: () => time, sleep: async ms => { time += ms; }, quietMs: 100, forceAfterMs: 100, timeoutMs: 500 }), /did not stop/);
  assert.ok(time <= 600);
});
