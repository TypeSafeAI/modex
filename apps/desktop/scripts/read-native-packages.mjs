import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

/** Verify every installer before either version is allowed to modify the host. */
export async function readNativePackages(directory, expected) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, "native-packages.json"), "utf8"));
  assert.equal(manifest.schema, 1);
  for (const key of ["platform", "arch", "sourceSha", "runId", "version", "baseline"]) assert.equal(manifest[key], expected[key], `Manifest ${key}`);
  assert.equal(manifest.installerAcceptance, "pending");
  const artifacts = new Map();
  for (const artifact of manifest.artifacts) {
    assert.equal(path.basename(artifact.name), artifact.name);
    const file = path.join(directory, artifact.name);
    assert.ok(fs.lstatSync(file).isFile(), "Installer must be a regular file");
    assert.equal(fs.statSync(file).size, artifact.bytes);
    const hash = createHash("sha256");
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
    assert.equal(hash.digest("hex"), artifact.sha256);
    const extension = path.extname(file);
    assert.ok(!artifacts.has(extension), "Duplicate package type");
    artifacts.set(extension, file);
  }
  const extensions = expected.platform === "win32" ? [".exe"] : [".AppImage", ".deb"];
  assert.deepEqual([...artifacts.keys()].sort(), extensions.sort());
  return { manifest, artifacts };
}
