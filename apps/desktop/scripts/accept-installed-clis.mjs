import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/** Run only identity probes through the real installed app's production launcher. */
export async function acceptInstalledClis(app) {
  const prefix = process.env.MODEX_NATIVE_CLI_PREFIX;
  assert.ok(prefix && path.isAbsolute(prefix));
  const relative = path.relative(process.env.RUNNER_TEMP, prefix);
  assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative), "CLI tools must belong to this runner's temporary directory");
  const manifest = JSON.parse(fs.readFileSync(path.join(prefix, "acceptance.json"), "utf8"));
  assert.equal(manifest.sourceSha, process.env.GITHUB_SHA);
  assert.equal(manifest.runId, process.env.GITHUB_RUN_ID);
  const reports = await app.evaluate(async ({ app }, { prefix, packages }) => {
    const require = process.getBuiltinModule("module").createRequire(`${app.getAppPath()}/package.json`);
    const path = process.getBuiltinModule("path");
    const { resolveCli, verifyCliOverride } = require("./dist/src/main/engine/cli-path.js");
    const { probe } = require("./dist/src/main/engine/backends/health.js");
    const originalPathKey = Object.keys(process.env).sort().find(key => key.toUpperCase() === "PATH");
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "PATH"));
    env.PATH = path.join(prefix, "node_modules", ".bin") + path.delimiter + (process.env[originalPathKey] ?? "");
    env.MODEX_NO_LOGIN_PATH = "1";
    env.CODEX_HOME = path.join(prefix, "codex-profile");
    env.CLAUDE_CONFIG_DIR = path.join(prefix, "claude-profile");
    env.OPENAI_API_KEY = env.ANTHROPIC_API_KEY = env.CLAUDE_CODE_OAUTH_TOKEN = "";
    const reports = [];
    for (const [cli, name] of [["codex", "@openai/codex"], ["claude", "@anthropic-ai/claude-code"]]) {
      const resolvedPath = resolveCli(cli, "", { env });
      const verifiedPath = await verifyCliOverride(cli, resolvedPath, { env, timeoutMs: 15000 });
      const version = await probe(verifiedPath, ["--version"], undefined, 15000, env);
      reports.push({ cli, expectedVersion: packages[name], resolvedPath, verifiedPath, ...version });
    }
    return reports;
  }, { prefix, packages: manifest.packages });
  for (const report of reports) {
    assert.equal(report.failure, undefined);
    assert.equal(report.code, 0);
    assert.equal(path.dirname(report.resolvedPath), path.join(prefix, "node_modules", ".bin"));
    assert.equal(report.verifiedPath, report.resolvedPath);
    assert.match(report.output, new RegExp(`\\b${report.expectedVersion.replaceAll(".", "\\.")}(?:\\s|$)`), "Real CLI version must match the pinned package");
  }
  return reports;
}
