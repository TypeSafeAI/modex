import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// node-pty's published Unix helpers can lose their executable bit in the npm archive.
// Set it before packaging so signed application resources never need to be modified at runtime.
if (process.platform !== "win32") {
  const supervisor = fileURLToPath(new URL("../dist/src/main/engine/terminal-supervisor", import.meta.url));
  fs.mkdirSync(path.dirname(supervisor), { recursive: true });
  // Match Electron's macOS 13 minimum; universal output also supports arm64 releases
  // built on an Intel host. Compilation and permissions are settled before signing.
  const target = process.platform === "darwin" ? ["-arch", "arm64", "-arch", "x86_64", "-mmacosx-version-min=13.0"] : [];
  execFileSync("cc", [...target, "-O2", "-Wall", "-Wextra", "-Werror", fileURLToPath(new URL("../src/main/engine/terminal-supervisor.c", import.meta.url)), "-o", supervisor], { stdio: "inherit" });
  const require = createRequire(import.meta.url);
  const root = path.dirname(require.resolve("node-pty/package.json"));
  const prebuilds = path.join(root, "prebuilds");
  const dirs = fs.existsSync(prebuilds) ? fs.readdirSync(prebuilds).map((dir) => path.join(prebuilds, dir)) : [];
  dirs.push(path.join(root, "build", "Release"));
  for (const dir of dirs) {
    const helper = path.join(dir, "spawn-helper");
    if (fs.existsSync(helper)) fs.chmodSync(helper, fs.statSync(helper).mode | 0o111);
  }
}
