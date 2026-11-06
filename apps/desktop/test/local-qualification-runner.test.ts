import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { gitRepo, tmpdir } from "./helpers.js";

const { qualify } = await import(pathToFileURL(path.resolve("scripts/local-model-qualify.mjs")).href);
const digest = "a".repeat(64);

function fixture() {
  const repo = gitRepo(), evidence = tmpdir("lm-terminal-report-");
  const options = { repo, evidence, live: true, model: "fixture-coder", digest };
  const calls: string[] = [];
  const controls = { fail: "", changeSource: false, skippedElectron: false, omitNative: false, checkEnvironment: false };
  const dependencies = {
    platform: "darwin", binaryHash: "fixture-binary", session: () => { calls.push("session"); }, electron: () => "/fixture/electron",
    configuration: async () => { calls.push("configuration"); return { okay: true }; },
    run: async (_command: string, _args: string[], opts: { stdout: string; stderr: string; env: NodeJS.ProcessEnv }) => {
      const name = path.basename(opts.stdout).replace(".stdout.log", ""); calls.push(name);
      if (controls.checkEnvironment) {
        assert.equal(opts.env.MODEX_LM3_LIVE, undefined);
        assert.equal(opts.env.MODEX_LM3_TOKEN, undefined);
        assert.equal(opts.env.NODE_OPTIONS, undefined);
      }
      if (name === "build" && controls.changeSource) fs.appendFileSync(path.join(repo, "README.md"), "changed during build\n");
      if (name === "electron-local") fs.writeFileSync(path.join(evidence, "electron-local.json"), JSON.stringify({ stats: { expected: controls.skippedElectron ? 0 : 4, skipped: controls.skippedElectron ? 4 : 0, unexpected: 0, flaky: 0 } }));
      if (name === "native-offline" && !controls.omitNative) {
        const native = path.join(evidence, "native-offline");
        fs.writeFileSync(path.join(native, "offline.json"), JSON.stringify({ status: "passed", sha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(), externalProbe: "EPERM", approvedModelDigest: digest, observedModelDigests: { before: digest, after: digest } }));
        fs.mkdirSync(path.join(native, "native"));
        fs.writeFileSync(path.join(native, "native/live-workflow.json"), JSON.stringify({ model: "fixture-coder", contextTokens: 65536, stages: [{ name: "read", status: "completed" }, { name: "approved edit and test", status: "completed" }], approvals: [{ command: "fixture approved write", decision: "yes" }], configurationUnchanged: { bytes: true, mtimeMs: true, tree: true }, realConfiguration: { unchanged: true } }));
      }
      return { exitCode: name === controls.fail ? 7 : 0, signal: null, timedOut: false, stdout: `${name} original stdout\n`, stderr: `${name} original stderr\n` };
    },
  };
  return { repo, evidence, options, calls, controls, dependencies };
}

test("terminal qualification refuses previous receipts before any runtime is contacted", async () => {
  const f = fixture(); const original = '{"status":"passed","source":"old"}\n';
  fs.writeFileSync(path.join(f.evidence, "qualification.json"), original);
  await assert.rejects(qualify(f.options, f.dependencies), /new empty evidence directory/);
  assert.equal(fs.readFileSync(path.join(f.evidence, "qualification.json"), "utf8"), original);
  assert.deepEqual(f.calls, []);
});

test("terminal qualification refuses a worktree child whose name starts with two dots", async () => {
  const f = fixture(); const evidence = path.join(f.repo, "..receipts");
  await assert.rejects(qualify({ ...f.options, evidence }, f.dependencies), /outside the worktree/);
  assert.equal(fs.existsSync(evidence), false);
  assert.deepEqual(f.calls, []);
});

test("terminal qualification refuses an outside path linked back into the worktree", async () => {
  const f = fixture(), alias = path.join(tmpdir("lm-terminal-link-"), "checkout");
  fs.symlinkSync(f.repo, alias, "dir");
  await assert.rejects(qualify({ ...f.options, evidence: path.join(alias, "receipts") }, f.dependencies), /outside the worktree/);
  assert.equal(fs.existsSync(path.join(f.repo, "receipts")), false);
  assert.deepEqual(f.calls, []);
});

test("a launcher pinned to another revision stops before contacting any runtime", async () => {
  const f = fixture();
  const result = await qualify({ ...f.options, expectHead: "b".repeat(40) }, f.dependencies);
  assert.equal(result.status, "failed");
  assert.match(result.error, /another source revision/);
  assert.deepEqual(f.calls, []);
});

test("terminal qualification preserves a failed gate and its original logs while collecting independent evidence", async () => {
  const f = fixture(); f.controls.fail = "unit";
  const result = await qualify(f.options, f.dependencies);
  assert.equal(result.status, "failed");
  assert.equal(result.kind, "scripted-runner-test", "a fixture never masquerades as native qualification");
  const unit = result.stages.find((s: { name: string }) => s.name === "unit");
  assert.equal(unit.exitCode, 7);
  assert.equal(fs.readFileSync(unit.stdout, "utf8"), "unit original stdout\n");
  assert.equal(fs.readFileSync(unit.stderr, "utf8"), "unit original stderr\n");
  assert.ok(f.calls.includes("native-offline"));
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.evidence, "qualification.json"), "utf8")).status, "failed");
});

test("terminal qualification stops before another command after tracked source changes", async () => {
  const f = fixture(); f.controls.changeSource = true;
  const result = await qualify(f.options, f.dependencies);
  assert.equal(result.status, "failed");
  assert.ok(f.calls.includes("build"));
  assert.equal(f.calls.includes("unit"), false);
  assert.equal(f.calls.includes("native-offline"), false);
});

test("zero-exit Electron output with every journey skipped cannot qualify", async () => {
  const f = fixture(); f.controls.skippedElectron = true;
  const result = await qualify(f.options, f.dependencies);
  assert.equal(result.status, "failed");
  assert.equal(result.stages.find((s: { name: string }) => s.name === "electron-local").passed, false);
});

test("zero-exit native invocation without the actual workflow receipt cannot qualify", async () => {
  const f = fixture(); f.controls.omitNative = true;
  const result = await qualify(f.options, f.dependencies);
  assert.equal(result.status, "failed");
  assert.equal(result.stages.find((s: { name: string }) => s.name === "native-offline").passed, false);
});

test("the terminal runner clears inherited live-model and test-selection overrides from ordinary stages", async () => {
  const names = ["MODEX_LM3_LIVE", "MODEX_LM3_TOKEN", "NODE_OPTIONS"] as const;
  const prior = Object.fromEntries(names.map(k => [k, process.env[k]]));
  try {
    process.env.MODEX_LM3_LIVE = "1"; process.env.MODEX_LM3_TOKEN = "fixture-secret"; process.env.NODE_OPTIONS = "--test-name-pattern=none";
    const f = fixture(); f.controls.checkEnvironment = true;
    const result = await qualify(f.options, f.dependencies);
    assert.equal(result.status, "passed");
  } finally {
    for (const key of names) { if (prior[key] === undefined) delete process.env[key]; else process.env[key] = prior[key]; }
  }
});

test("a Terminal process without macOS user lookup fails before build or native inference", async () => {
  const f = fixture(); f.dependencies.session = () => { throw new Error("user lookup unavailable"); };
  const result = await qualify(f.options, f.dependencies);
  assert.equal(result.status, "failed");
  assert.equal(f.calls.includes("build"), false);
  assert.equal(f.calls.includes("native-offline"), false);
});

test("the collector accepts complete scripted receipts while labeling them as fixture evidence", async () => {
  const f = fixture(); const result = await qualify(f.options, f.dependencies);
  assert.equal(result.status, "passed");
  assert.equal(result.kind, "scripted-runner-test");
  assert.equal(result.humanAcceptance, "unrun");
  assert.equal(result.source.head, execFileSync("git", ["rev-parse", "HEAD"], { cwd: f.repo, encoding: "utf8" }).trim());
});
