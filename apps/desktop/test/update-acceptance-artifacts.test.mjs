import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeFixtureManifest, verifyFixtureManifest } from "../scripts/update-acceptance-artifacts.mjs";

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "modex-acceptance-artifacts-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, "source.zip"), "signed source bytes");
  fs.writeFileSync(path.join(directory, "candidate.zip"), "signed candidate bytes");
  return directory;
}
const sourceSha = "a".repeat(40);
test("acceptance manifest binds both exact signed archives, version and source commit", t => {
  const directory = fixture(t);
  writeFixtureManifest(directory, "0.0.11", sourceSha);
  assert.equal(verifyFixtureManifest(directory, sourceSha).version, "0.0.11");
  assert.throws(() => verifyFixtureManifest(directory, "b".repeat(40)), /source commit/);
  fs.writeFileSync(path.join(directory, "candidate.zip"), "signed candidate bytex");
  assert.throws(() => verifyFixtureManifest(directory, sourceSha), /integrity/);
});
test("acceptance manifest rejects invalid versions, metadata and symlinked archives", t => {
  const directory = fixture(t);
  for (const version of ["0.0.0", "0.0.11-beta", "../other"]) assert.throws(() => writeFixtureManifest(directory, version, sourceSha), /version/);
  writeFixtureManifest(directory, "0.0.11", sourceSha);
  const file = path.join(directory, "manifest.json");
  const original = fs.readFileSync(file, "utf8");
  const wrong = JSON.parse(original); wrong.archives.source.size = -1;
  fs.writeFileSync(file, JSON.stringify(wrong));
  assert.throws(() => verifyFixtureManifest(directory, sourceSha), /integrity/);
  fs.writeFileSync(file, original);
  fs.renameSync(path.join(directory, "source.zip"), path.join(directory, "real.zip"));
  fs.symlinkSync("real.zip", path.join(directory, "source.zip"));
  assert.throws(() => verifyFixtureManifest(directory, sourceSha), /regular file/);
});
