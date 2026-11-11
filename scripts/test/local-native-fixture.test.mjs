import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { nativeQualification } from "../../apps/desktop/e2e/fixtures/native-qualification-guard.mjs";
import { MODEL, DIGEST, CONTEXT, CHECK_SOURCE, DELAY_SOURCE, EDITED } from "../../apps/desktop/e2e/fixtures/local-native-spec.mjs";

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "modex-e2e-home-")), repo = fs.mkdtempSync(path.join(os.tmpdir(), "modex-e2e-repo-"));
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(repo, { recursive: true, force: true }); });
  fs.mkdirSync(path.join(home, "app")); fs.writeFileSync(path.join(home, "app/state.json"), JSON.stringify({ settings: { default_backend: "mock" } }));
  const manifest = { version: 1, authorization: "local-native-lifecycle", model: MODEL, digest: DIGEST, contextTokens: CONTEXT, cwd: repo, origin: "http://127.0.0.1:54321" };
  const file = path.join(home, "local-native-qualification.json");
  const write = value => fs.writeFileSync(file, JSON.stringify(value)); write(manifest);
  return { home, repo, manifest, file, write, options: { home, enabled: "1", e2e: "1", packaged: false } };
}

test("native fixture refuses missing opt-in, packaged app and non-mock home before a native process exists", t => {
  const f = fixture(t);
  assert.deepEqual(nativeQualification(f.options), { cwd: fs.realpathSync(f.repo), origin: f.manifest.origin });
  for (const patch of [{ enabled: undefined }, { e2e: "0" }, { packaged: true }]) assert.throws(() => nativeQualification({ ...f.options, ...patch }), /opt-in unpackaged/);
  fs.writeFileSync(path.join(f.home, "app/state.json"), JSON.stringify({ settings: { default_backend: "codex" } }));
  assert.throws(() => nativeQualification(f.options), /disposable mock home/);
});

test("native fixture rejects altered model, digest, context, authority and additional fields", t => {
  const f = fixture(t);
  for (const patch of [{ model: "other" }, { digest: "0".repeat(64) }, { contextTokens: CONTEXT + 1 }, { authorization: "other" }, { allowAll: true }]) {
    f.write({ ...f.manifest, ...patch }); assert.throws(() => nativeQualification(f.options), /approved disposable project and model/);
  }
});

test("native fixture refuses external, credential-bearing or non-root endpoints and projects outside its disposable namespace", t => {
  const f = fixture(t);
  for (const origin of ["https://example.com", "http://localhost:1234", "http://user:pass@127.0.0.1:1234", "http://127.0.0.1:1234/v1", "http://127.0.0.1:1234/?query=1", "http://127.0.0.1:1234/#fragment", "http://127.0.0.1"]) {
    f.write({ ...f.manifest, origin }); assert.throws(() => nativeQualification(f.options), /approved disposable project and model/);
  }
  f.write({ ...f.manifest, cwd: process.cwd() }); assert.throws(() => nativeQualification(f.options), /approved disposable project and model/);
});

test("native fixture refuses oversized and symlinked manifests", t => {
  const f = fixture(t); fs.writeFileSync(f.file, " ".repeat(8193)); assert.throws(() => nativeQualification(f.options), /Invalid native qualification manifest/);
  const other = path.join(f.home, "another.json"); fs.writeFileSync(other, JSON.stringify(f.manifest)); fs.unlinkSync(f.file); fs.symlinkSync(other, f.file);
  assert.throws(() => nativeQualification(f.options), /Invalid native qualification manifest/);
});

test("independent native fixture checker rejects wrong bytes; known fresh command records one dispatch and effect", t => {
  const { repo } = fixture(t); fs.writeFileSync(path.join(repo, "check.cjs"), CHECK_SOURCE);
  fs.writeFileSync(path.join(repo, "result.txt"), "wrong\n"); assert.equal(spawnSync(process.execPath, ["check.cjs"], { cwd: repo }).status, 1);
  fs.writeFileSync(path.join(repo, "result.txt"), EDITED); assert.equal(spawnSync(process.execPath, ["check.cjs"], { cwd: repo }).status, 0);
  const lines = name => fs.readFileSync(path.join(repo, name), "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(lines("checks.jsonl"), [{ ok: false, exitCode: 1 }, { ok: true, exitCode: 0 }]);
  fs.writeFileSync(path.join(repo, "delayed-write.cjs"), DELAY_SOURCE);
  assert.equal(spawnSync(process.execPath, ["delayed-write.cjs", "unknown"], { cwd: repo }).status, 1); assert.equal(fs.existsSync(path.join(repo, "lifecycle-runs.jsonl")), false);
  assert.equal(spawnSync(process.execPath, ["delayed-write.cjs", "after-stop"], { cwd: repo }).status, 0);
  assert.equal(lines("lifecycle-runs.jsonl").length, 1); assert.equal(lines("lifecycle-effects.jsonl").length, 1);
  assert.equal(fs.readFileSync(path.join(repo, "after-stop-effect.txt"), "utf8"), "after-stop:one\n");
});
