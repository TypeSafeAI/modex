import fs from "node:fs";
import path from "node:path";
const directory = process.argv[2];
fs.writeFileSync(path.join(directory, "interactive.pid"), String(process.pid));
process.on("SIGINT", () => {
  fs.writeFileSync(path.join(directory, "interrupted"), "yes");
  process.exit(23);
});
process.stdin.on("data", input => {
  if (String(input).includes("modex-input")) fs.writeFileSync(path.join(directory, "input"), "received");
});
process.stdin.resume();
setInterval(() => {
  // Windows delivers SIGWINCH on console writes that move the cursor (or raw
  // input). Keep cooked input so this fixture still tests actual Ctrl-C signals.
  process.stdout.cursorTo(0);
  process.stdout.write("modex-size\r");
  fs.writeFileSync(path.join(directory, "dimensions.json"), JSON.stringify({
    columns: process.stdout.columns, rows: process.stdout.rows,
    stdin: process.stdin.isTTY, stdout: process.stdout.isTTY,
  }));
}, 50);
