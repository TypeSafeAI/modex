import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const target = process.argv[2];
if (!["win32", "linux"].includes(target) || process.platform !== target || process.arch !== "x64") {
  throw new Error("Native installer builds require the selected Windows/Linux x64 host.");
}
if (target === "win32" && (process.env.CSC_LINK || process.env.WIN_CSC_LINK)) {
  throw new Error("Windows installer signing is currently disabled; remove signing credentials from this build environment.");
}
const projectDir = fileURLToPath(new URL("..", import.meta.url));
const acceptancePair = process.env.MODEX_NATIVE_UPGRADE_ACCEPTANCE === "1";
if (acceptancePair && (process.env.GITHUB_ACTIONS !== "true" || process.env.RUNNER_ENVIRONMENT !== "github-hosted")) {
  throw new Error("Synthetic upgrade baselines are restricted to disposable hosted acceptance.");
}
const npm = process.env.npm_execpath;
if (!npm || !path.isAbsolute(npm)) throw new Error("Run this through npm run dist:windows or dist:linux.");
for (const workspace of ["@modex/core", "@modex/desktop"]) {
  execFileSync(process.execPath, [npm, "run", "build", "-w", workspace], { cwd: projectDir, stdio: "inherit" });
}
const { build, Platform, Arch } = await import("electron-builder");
const targets = (target === "win32" ? Platform.WINDOWS : Platform.LINUX).createTarget(undefined, Arch.x64);
if (acceptancePair) {
  // Same source and app identity, distinct installed version. This establishes
  // package replacement/data retention, not migration from historical source.
  await build({ projectDir, publish: "never", targets,
    config: { directories: { output: `release/native-${target}-baseline` }, extraMetadata: { version: "0.0.0" } },
  });
}
await build({ projectDir, publish: "never",
  targets,
  config: { directories: { output: `release/native-${target}` } },
});
