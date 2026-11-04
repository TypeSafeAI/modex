import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "./helpers.js";

const native = { skip: process.platform !== "darwin" && "the offline launcher is macOS-only" };
const noNetwork = "data:text/javascript,globalThis.fetch=()=>{throw new Error('metadata-request-before-evidence-check')}";

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
