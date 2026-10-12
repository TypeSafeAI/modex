import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

assert.ok(["win32", "linux"].includes(process.platform) && process.arch === "x64");
assert.equal(process.env.GITHUB_ACTIONS, "true");
assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
assert.ok(process.env.RUNNER_TEMP && path.isAbsolute(process.env.RUNNER_TEMP));
assert.match(process.env.GITHUB_SHA ?? "", /^[0-9a-f]{40}$/);
assert.match(process.env.GITHUB_RUN_ID ?? "", /^[0-9]+$/);
const npm = process.env.npm_execpath;
assert.ok(npm && path.isAbsolute(npm), "Run through npm run prepare:native-clis");
const prefix = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP, "modex-cli-tools-"));
const packages = { "@openai/codex": "0.162.1", "@anthropic-ai/claude-code": "2.1.296" };
fs.writeFileSync(path.join(prefix, "package.json"), JSON.stringify({ name: "modex-native-cli-acceptance", private: true, dependencies: packages }));
execFileSync(process.execPath, [npm, "install", "--prefix", prefix, "--no-audit", "--no-fund"], { timeout: 180000, stdio: "inherit" });
for (const [name, version] of Object.entries(packages)) {
  assert.equal(JSON.parse(fs.readFileSync(path.join(prefix, "node_modules", name, "package.json"), "utf8")).version, version);
}
fs.writeFileSync(path.join(prefix, "acceptance.json"), JSON.stringify({ sourceSha: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID, packages }));
assert.ok(process.env.GITHUB_ENV, "Runner environment file required");
assert.ok(!/[\r\n]/.test(prefix));
fs.appendFileSync(process.env.GITHUB_ENV, `MODEX_NATIVE_CLI_PREFIX=${prefix}\n`);
