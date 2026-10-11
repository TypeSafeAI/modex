import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { readNativePackages } from "../scripts/read-native-packages.mjs";

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "modex-manifest-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const bytes = Buffer.from("synthetic installer fixture");
  const file = path.join(directory, "Modex-0.0.0-windows-x64.exe");
  fs.writeFileSync(file, bytes);
  const expected = { platform: "win32", arch: "x64", sourceSha: "a".repeat(40), runId: "123", version: "0.0.0", baseline: true };
  const manifest = { schema: 1, ...expected, installerAcceptance: "pending", artifacts: [{ name: path.basename(file), bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }] };
  const save = () => fs.writeFileSync(path.join(directory, "native-packages.json"), JSON.stringify(manifest));
  save();
  return { directory, file, expected, manifest, save };
}

test("native baseline manifest verifies bytes and exact acceptance identity", async t => {
  const { directory, file, expected } = fixture(t);
  assert.equal((await readNativePackages(directory, expected)).artifacts.get(".exe"), file);
  for (const [key, value] of Object.entries({ sourceSha: "b".repeat(40), runId: "124", version: "0.0.10", baseline: false, arch: "arm64", platform: "linux" })) {
    await assert.rejects(readNativePackages(directory, { ...expected, [key]: value }), new RegExp(`Manifest ${key}`));
  }
});

test("native installer hash rejects same-length tampering", async t => {
  const { directory, file, expected } = fixture(t);
  const bytes = fs.readFileSync(file);
  bytes[0] ^= 1;
  fs.writeFileSync(file, bytes);
  await assert.rejects(readNativePackages(directory, expected), { code: "ERR_ASSERTION" });
});

test("native installer manifest refuses traversal and duplicate package types", async t => {
  const { directory, expected, manifest, save } = fixture(t);
  const artifact = { ...manifest.artifacts[0] };
  manifest.artifacts[0].name = `../${artifact.name}`;
  save();
  await assert.rejects(readNativePackages(directory, expected), { code: "ERR_ASSERTION" });
  manifest.artifacts = [artifact, artifact];
  save();
  await assert.rejects(readNativePackages(directory, expected), /Duplicate package type/);
});

test("native manifest requires the complete package set", async t => {
  const { directory, expected, manifest, save } = fixture(t);
  manifest.artifacts = [];
  save();
  await assert.rejects(readNativePackages(directory, expected), { code: "ERR_ASSERTION" });
});
