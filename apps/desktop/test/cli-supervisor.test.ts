import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cliSpawn } from "../src/main/engine/cli-launch.js";

const fixture = fileURLToPath(new URL("../../test/fixtures/cli-process-tree.mjs", import.meta.url));
const cleanup = fileURLToPath(new URL("../../test/fixtures/cleanup-cli-tree.ps1", import.meta.url));
async function until(check: () => boolean, label: string) {
  const deadline = Date.now() + 10000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
function gone(pid: number) {
  try { process.kill(pid, 0); return false; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return true; throw error; }
}
function closed(child: ChildProcess) {
  return once(child, "close", { signal: AbortSignal.timeout(12000) });
}

for (const mode of ["natural", "cancel", "owner-exit"] as const) {
  test(`native Windows CLI job removes detached descendants on ${mode}`, { skip: process.platform !== "win32", timeout: 30000 }, async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "modex-cli-tree-"));
    let child: ChildProcess;
    let supervisor: number | undefined;
    if (mode === "owner-exit") {
      const owner = path.join(directory, "owner.mjs");
      fs.writeFileSync(owner, `import fs from 'node:fs';\nimport {cliSpawn} from ${JSON.stringify(new URL("../src/main/engine/cli-launch.js", import.meta.url).href)};\nconst child=cliSpawn(process.execPath,${JSON.stringify([fixture, directory, "root", mode])},{stdio:['ignore','ignore','inherit']});\nfs.writeFileSync(${JSON.stringify(path.join(directory, "supervisor.pid"))},String(child.pid));\nsetInterval(()=>{},1000);\n`);
      child = spawn(process.execPath, [owner], { stdio: ["ignore", "pipe", "pipe"] });
    } else {
      child = cliSpawn(process.execPath, [fixture, directory, "root", mode], { stdio: ["ignore", "pipe", "pipe"] });
      if (child.pid) fs.writeFileSync(path.join(directory, "supervisor.pid"), String(child.pid));
    }
    let stderr = "";
    child.stderr?.on("data", chunk => { stderr += String(chunk); });
    child.stdout?.resume();
    const exited = closed(child);
    void exited.catch(() => {});
    t.after(async () => {
      if (stderr) t.diagnostic(stderr);
      if (child.exitCode === null && child.signalCode === null) child.kill();
      // Independent fallback: the owner-death test must not rely on its own
      // behavior under test to clean a failed run. Verify recorded PID ownership.
      execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", cleanup, "-Directory", directory], { timeout: 8000, windowsHide: true });
      await exited.catch(() => {});
      fs.rmSync(directory, { recursive: true, force: true });
    });
    await until(() => {
      const receipt = path.join(directory, "supervisor.pid");
      const pid = fs.existsSync(receipt) ? Number(fs.readFileSync(receipt, "utf8")) : 0;
      return fs.existsSync(path.join(directory, "grandchild.heartbeat")) && Number.isSafeInteger(pid) && pid > 0;
    }, `three generations start with a valid supervisor receipt (${stderr})`);
    const pids = ["root", "child", "grandchild"].map(role => Number(fs.readFileSync(path.join(directory, `${role}.pid`), "utf8")));
    assert.ok(pids.every(pid => Number.isSafeInteger(pid) && pid > 0));
    if (mode === "owner-exit") supervisor = Number(fs.readFileSync(path.join(directory, "supervisor.pid"), "utf8"));
    if (mode !== "natural") child.kill("SIGKILL");
    const [code] = await exited;
    if (mode === "natural") assert.equal(code, 0, stderr);
    await until(() => [...pids, ...(supervisor ? [supervisor] : [])].every(gone), "all owned processes exit");
    for (const role of ["root", "child", "grandchild"]) {
      const file = path.join(directory, `${role}.heartbeat`);
      if (!fs.existsSync(file)) continue;
      const before = fs.readFileSync(file, "utf8");
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(fs.readFileSync(file, "utf8"), before, `${role} stopped writing`);
    }
  });
}
