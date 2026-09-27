import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

// node-pty's published Unix helpers can lose their executable bit in the npm archive.
// Set it before packaging so signed application resources never need to be modified at runtime.
if (process.platform !== "win32") {
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
