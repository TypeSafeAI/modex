import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** Serialized by Playwright into the owned main process. Observe; never handle its exception. */
export function observeElectronErrors(_electron: unknown): void {
  const files = process.getBuiltinModule("node:fs") as typeof import("node:fs");
  let records = 0;
  process.on("uncaughtExceptionMonitor", (error, origin) => {
    if (records++ >= 8) return;
    try {
      files.writeSync(2, `MODEX_E2E_MAIN_EXCEPTION ${JSON.stringify({ origin, stack: String(error.stack ?? error).slice(0, 4096) })}\n`);
    } catch { /* Diagnostic failure must not replace Electron's original exception handling. */ }
  });
}

/** A bounded private artifact, written as data arrives so worker teardown need not finish. */
export function recordElectronStderr(child: ChildProcess, outputDir: string): () => void {
  const stream = child.stderr;
  if (!stream || !Number.isSafeInteger(child.pid) || child.pid! <= 0) return () => {};
  let fd: number;
  try {
    fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
    fd = fs.openSync(path.join(outputDir, `electron-${child.pid}.stderr.log`), "wx", 0o600);
  } catch { return () => {}; }
  let remaining = 256 * 1024;
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    stream.removeListener("data", data);
    child.removeListener("close", stop);
    try { fs.closeSync(fd); } catch { /* Retain the original child outcome. */ }
  };
  const data = (chunk: Buffer | string) => {
    try {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const bounded = bytes.subarray(0, remaining);
      let offset = 0;
      while (offset < bounded.length) {
        const wrote = fs.writeSync(fd, bounded, offset, bounded.length - offset);
        if (wrote <= 0) { stop(); return; }
        offset += wrote;
      }
      remaining -= bounded.length;
      if (remaining === 0) stop();
    } catch { stop(); }
  };
  stream.on("data", data);
  child.once("close", stop);
  return stop;
}
