import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { tmpdir } from "./helpers.js";

const native = { skip: process.platform !== "darwin" && "the offline launcher is macOS-only" };
const noNetwork = "data:text/javascript,globalThis.fetch=()=>{throw new Error('metadata-request-before-evidence-check')}";
const { offlineSandboxPolicy, verifyOfflineSandbox } = await import(pathToFileURL(path.resolve("scripts/local-model-network-policy.mjs")).href);

function boundaryFixture(dir: string) {
  const root = fs.realpathSync(dir), cache = path.join(root, "cache"); fs.mkdirSync(cache);
  const outsideProbe = path.join(path.dirname(root), `.${path.basename(root)}-outside-fixture`);
  const profile = offlineSandboxPolicy(root, cache), boundaryId = "sha256:" + createHash("sha256").update(profile).digest("hex");
  fs.writeFileSync(path.join(root, "loopback-only.sb"), profile);
  fs.writeFileSync(path.join(root, "sandbox.json"), JSON.stringify({ root, cache, outsideProbe, outsideWriteControl: "succeeded", boundaryId }));
  fs.mkdirSync(path.join(root, "tmp"));
  return { root, outsideProbe, boundaryId };
}

test("a sandbox receipt cannot claim confinement when the real outside write remains possible", async () => {
  const fixture = boundaryFixture(tmpdir("lm-boundary-not-installed-"));
  await assert.rejects(verifyOfflineSandbox(fixture.root), /did not deny an outside write: allowed/);
  assert.equal(fs.existsSync(fixture.outsideProbe), false, "the disposable negative control was removed");
});

test("an altered sandbox policy is refused before a boundary can be asserted", async () => {
  const fixture = boundaryFixture(tmpdir("lm-boundary-altered-"));
  fs.appendFileSync(path.join(fixture.root, "loopback-only.sb"), "(allow network*)\n");
  await assert.rejects(verifyOfflineSandbox(fixture.root), /boundary receipt is missing or changed/);
});

test("the qualification policy refuses an unbounded filesystem write root", () => {
  assert.throws(() => offlineSandboxPolicy("/", "/tmp/cache"), /bounded absolute directory/);
  assert.throws(() => offlineSandboxPolicy("/tmp/evidence", "/"), /bounded absolute directory/);
});

test("offline qualification preserves an earlier receipt and refuses its directory before any runtime request", native, () => {
  const dir = tmpdir("lm-offline-evidence-");
  const receipt = path.join(dir, "offline.json");
  const original = '{"status":"passed","sha":"an-older-candidate"}\n';
  fs.writeFileSync(receipt, original);
  const checked = spawnSync(process.execPath, ["--import", noNetwork, "scripts/local-model-offline.mjs", "fixture-no-model", dir], { encoding: "utf8" });
  assert.notEqual(checked.status, 0);
  assert.match(checked.stderr, /new empty evidence directory/);
  assert.doesNotMatch(checked.stderr, /metadata-request-before-evidence-check/);
  assert.equal(fs.readFileSync(receipt, "utf8"), original);
  assert.deepEqual(fs.readdirSync(dir), ["offline.json"]);
});

test("offline qualification refuses a linked evidence directory without touching its target", native, () => {
  const dir = tmpdir("lm-offline-link-"), target = path.join(dir, "target"), link = path.join(dir, "evidence");
  fs.mkdirSync(target); fs.symlinkSync(target, link);
  const checked = spawnSync(process.execPath, ["--import", noNetwork, "scripts/local-model-offline.mjs", "fixture-no-model", link], { encoding: "utf8" });
  assert.notEqual(checked.status, 0);
  assert.match(checked.stderr, /new empty evidence directory/);
  assert.doesNotMatch(checked.stderr, /metadata-request-before-evidence-check/);
  assert.deepEqual(fs.readdirSync(target), []);
  assert.equal(fs.readlinkSync(link), target);
});

// Exercise the actual launcher with fake OS/process boundaries. No Ollama, Codex,
// network denial or model inference runs in this ordinary unit test.
function ownedRuntime(before: string | null, after: string | null) {
  const dir = tmpdir("lm-offline-identity-");
  const digest = "a".repeat(64);
  fs.writeFileSync(path.join(dir, "model.json"), JSON.stringify({ name: "fixture-coder", digest }));
  const boundary = boundaryFixture(dir);
  const preload = `
    import fs from 'node:fs';
    import path from 'node:path';
    import net from 'node:net';
    import childProcess from 'node:child_process';
    import { EventEmitter } from 'node:events';
    import { syncBuiltinESMExports } from 'node:module';
    const dir = ${JSON.stringify(dir)};
    const write = fs.writeFileSync;
    fs.writeFileSync = (file, ...args) => {
      if (String(file) === ${JSON.stringify(boundary.outsideProbe)}) throw Object.assign(new Error('scripted outside write denial'), { code: 'EPERM' });
      return write(file, ...args);
    };
    let reads = 0;
    globalThis.fetch = async () => ({ json: async () => ({ models: [
      { name: 'fixture-coder', digest: ++reads === 1 ? ${JSON.stringify(before)} : ${JSON.stringify(after)} }
    ] }) });
    net.connect = () => {
      const socket = new EventEmitter();
      socket.destroy = () => {};
      socket.setTimeout = () => {};
      process.nextTick(() => socket.emit('error', { code: 'EPERM' }));
      return socket;
    };
    childProcess.spawn = () => {
      const child = new EventEmitter();
      child.pid = 12345; child.exitCode = null;
      child.kill = () => { child.exitCode = 0; process.nextTick(() => child.emit('exit', 0)); return true; };
      return child;
    };
    childProcess.spawnSync = () => {
      fs.writeFileSync(path.join(dir, 'native-invoked'), 'scripted task only');
      return { status: 0, stdout: '', stderr: '' };
    };
    syncBuiltinESMExports();
  `;
  const checked = spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(preload)}`, "scripts/local-model-offline.mjs", "--inside", "fixture-coder", dir], { encoding: "utf8", timeout: 5000 });
  assert.equal(checked.error, undefined, checked.stderr);
  const receipt = JSON.parse(fs.readFileSync(path.join(dir, "offline.json"), "utf8"));
  return { checked, receipt, invoked: fs.existsSync(path.join(dir, "native-invoked")), digest };
}

for (const observed of ["b".repeat(64), null]) {
  test(`offline qualification refuses ${observed ? "different" : "missing"} owned model digest before invoking native inference`, native, () => {
    const { checked, receipt, invoked } = ownedRuntime(observed, observed);
    assert.equal(checked.status, 1);
    assert.equal(receipt.status, "failed");
    assert.match(receipt.error, /digest/i);
    assert.equal(invoked, false);
  });

  test(`offline qualification cannot pass when the model digest is ${observed ? "changed" : "missing"} after the native task`, native, () => {
    const { checked, receipt, invoked } = ownedRuntime("a".repeat(64), observed);
    assert.equal(checked.status, 1);
    assert.equal(receipt.status, "failed");
    assert.match(receipt.error, /digest/i);
    assert.equal(invoked, true);
  });
}

test("offline qualification records the matching approved digest and both owned-server observations", native, () => {
  const { checked, receipt, invoked, digest } = ownedRuntime("a".repeat(64), "a".repeat(64));
  assert.equal(checked.status, 0);
  assert.equal(receipt.status, "passed");
  assert.equal(invoked, true);
  assert.equal(receipt.approvedModelDigest, digest);
  assert.deepEqual(receipt.observedModelDigests, { before: digest, after: digest });
});
