import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

function archive(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile()) throw new Error("Acceptance archive must be a regular file.");
  if (stat.size < 1 || stat.size > 512 * 1024 * 1024) throw new Error("Acceptance archive integrity limit exceeded.");
  const hash = createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(64 * 1024);
    let bytes;
    while ((bytes = fs.readSync(fd, buffer)) > 0) hash.update(buffer.subarray(0, bytes));
  } finally { fs.closeSync(fd); }
  return { size: stat.size, sha256: hash.digest("hex") };
}
function validateVersion(version) {
  if (typeof version !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version) || version === "0.0.0") throw new Error("Invalid acceptance candidate version.");
}
export function writeFixtureManifest(directory, version, sourceSha) {
  validateVersion(version);
  if (!/^[a-f0-9]{40}$/.test(sourceSha ?? "")) throw new Error("Invalid acceptance source commit.");
  const manifest = { schema: 1, version, sourceVersion: "0.0.0", sourceSha, archives: {
    source: archive(path.join(directory, "source.zip")), candidate: archive(path.join(directory, "candidate.zip")),
  } };
  fs.writeFileSync(path.join(directory, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  return manifest;
}
export function verifyFixtureManifest(directory, sourceSha) {
  const file = path.join(directory, "manifest.json");
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > 16 * 1024) throw new Error("Invalid acceptance manifest.");
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  if (manifest.schema !== 1 || manifest.sourceVersion !== "0.0.0") throw new Error("Invalid acceptance manifest.");
  validateVersion(manifest.version);
  if (!/^[a-f0-9]{40}$/.test(sourceSha ?? "") || manifest.sourceSha !== sourceSha) throw new Error("Acceptance source commit does not match this workflow.");
  for (const name of ["source", "candidate"]) {
    const actual = archive(path.join(directory, `${name}.zip`));
    const expected = manifest.archives?.[name];
    if (actual.size !== expected?.size || actual.sha256 !== expected?.sha256) throw new Error(`Acceptance ${name} archive integrity mismatch.`);
  }
  return manifest;
}
