import fs from "node:fs";
import path from "node:path";
import { WriteStream } from "node:tty";
const directory = process.argv[2];
let freshSize;
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
  if (!freshSize && fs.existsSync(path.join(directory, "inspect-size"))) {
    // A new public TTY stream queries the OS once, independently of stdout's
    // cached resize-event fields. Diagnostic only; it does not change stdout.
    const sample = new WriteStream(1);
    freshSize = sample.getWindowSize();
    sample.unref();
  }
  fs.writeFileSync(path.join(directory, "dimensions.json"), JSON.stringify({
    columns: process.stdout.columns, rows: process.stdout.rows,
    stdin: process.stdin.isTTY, stdout: process.stdout.isTTY,
    freshSize,
  }));
}, 50);
