import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const platform = process.argv[2];
assert.ok(["win32", "linux"].includes(platform) && process.platform === platform && process.arch === "x64", "Native x64 runner required");
const directory = fileURLToPath(new URL(`../release/native-${platform}/`, import.meta.url));
const extensions = platform === "win32" ? [".exe"] : [".AppImage", ".deb"];
assert.match(process.env.GITHUB_SHA ?? "", /^[0-9a-f]{40}$/, "Source commit required");
assert.match(process.env.GITHUB_RUN_ID ?? "", /^[0-9]+$/, "GitHub run required");
const artifacts = [];
for (const extension of extensions) {
  const matches = fs.readdirSync(directory).filter(name => name.startsWith("Modex-") && name.endsWith(extension));
  assert.equal(matches.length, 1, `Exactly one ${extension} installer required`);
  const name = matches[0];
  const file = path.join(directory, name);
  assert.ok(fs.lstatSync(file).isFile(), "Installer must be a regular file");
  const bytes = fs.statSync(file).size;
  assert.ok(bytes > 0, "Installer must not be empty");
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  artifacts.push({ name, bytes, sha256: hash.digest("hex") });
}
const manifest = { schema: 1, platform, arch: process.arch, sourceSha: process.env.GITHUB_SHA,
  runId: process.env.GITHUB_RUN_ID, installerAcceptance: "pending", artifacts };
fs.writeFileSync(path.join(directory, "native-packages.json"), JSON.stringify(manifest, null, 2) + "\n");
