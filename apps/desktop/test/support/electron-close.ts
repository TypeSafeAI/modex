import type { ChildProcess } from "node:child_process";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

type Application = { close(): Promise<void>; process(): Pick<ChildProcess, "pid" | "exitCode" | "signalCode"> };
type Sampler = (pid: number, outputDir: string) => Promise<void>;

const nativeSample: Sampler = async (pid, outputDir) => {
  fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  const file = path.join(outputDir, `electron-close-${pid}-${Date.now()}.sample.txt`);
  try {
    await promisify(execFile)("/usr/bin/sample", [String(pid), "1", "1", "-file", file], { timeout: 5000, maxBuffer: 256 * 1024 });
  } catch (error) {
    fs.writeFileSync(`${file}.error.txt`, String(error) + "\n");
  }
};

/** Observe an owned test app's pending close; never settle, retry or force its shutdown. */
export async function closeWithDiagnostics(app: Application, outputDir: string,
  options: { afterMs?: number; sample?: Sampler } = {}): Promise<void> {
  if (process.platform !== "darwin" && !options.sample) return app.close();
  let child: ReturnType<Application["process"]> | undefined;
  try { child = app.process(); } catch { /* Diagnostics cannot replace the original close operation. */ }
  const pid = child?.pid;
  if (!Number.isSafeInteger(pid) || pid! <= 0) return app.close();
  const timer = setTimeout(() => {
    if (child?.exitCode !== null || child.signalCode !== null) return;
    // Do not await sampling: it cannot delay or replace close's original result.
    void Promise.resolve().then(() => (options.sample ?? nativeSample)(pid!, outputDir)).catch(() => {});
  }, options.afterMs ?? 5000);
  try { await app.close(); }
  finally { clearTimeout(timer); }
}
