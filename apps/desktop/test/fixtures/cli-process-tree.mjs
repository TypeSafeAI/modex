import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const [directory, role, mode] = process.argv.slice(2);
fs.writeFileSync(path.join(directory, `${role}.pid`), String(process.pid));
if (role !== "grandchild") {
  const next = role === "root" ? "child" : "grandchild";
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), directory, next, mode], { detached: true, stdio: "ignore" });
  child.unref();
}
setInterval(() => {
  fs.writeFileSync(path.join(directory, `${role}.heartbeat`), String(Date.now()));
  if (role === "root" && mode === "natural" && fs.existsSync(path.join(directory, "grandchild.heartbeat"))) process.exit(0);
}, 25);
