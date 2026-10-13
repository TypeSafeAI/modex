import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { spawnTerminal, stopTerminalProcess } from "../src/main/engine/terminal-process.js";

const fixture = fileURLToPath(new URL("../../test/fixtures/cli-process-tree.mjs", import.meta.url));
const cleanup = fileURLToPath(new URL("../../test/fixtures/cleanup-cli-tree.ps1", import.meta.url));
after(async () => {
  if (process.platform !== "win32") return;
  const addon = createRequire(import.meta.url)("node-pty/lib/utils.js").loadNativeModule("conpty").module;
  await until(() => !process.getActiveResourcesInfo().includes("MessagePort") && addon.modexActiveConsoles() === 0, "PTY workers and owned consoles released");
  console.error("Windows PTY resources after cleanup:", JSON.stringify(process.getActiveResourcesInfo()));
});
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
function cleanupFixture(directory: string, cleanupVerified = false) {
  // Emergency cleanup is still required when the independent exit assertions fail.
  if (!cleanupVerified) execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", cleanup, "-Directory", directory], { timeout: 8000, windowsHide: true });
  fs.rmSync(directory, { recursive: true, force: true });
}
for (const mode of ["natural", "close", "owner-exit", "supervisor-failure"] as const) {
  test(`native Windows PTY removes detached descendants on ${mode}`, { skip: process.platform !== "win32", timeout: 30000 }, async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "modex-pty-tree-"));
    let cleanupVerified = false;
    const args = [fixture, directory, "root", mode];
    const options = { cwd: directory, cols: 80, rows: 24, env: { ...process.env } };
    if (mode === "owner-exit") {
      const ownerFile = path.join(directory, "owner.mjs");
      fs.writeFileSync(ownerFile, `import fs from 'node:fs';\nimport {spawnTerminal} from ${JSON.stringify(new URL("../src/main/engine/terminal-process.js", import.meta.url).href)};\nconst pty=spawnTerminal(process.execPath,${JSON.stringify(args)},${JSON.stringify({ cwd: directory, cols: 80, rows: 24 })});\npty.onData(()=>{});\nconst deadline=Date.now()+10000; const receipt=setInterval(()=>{if(Number.isSafeInteger(pty.pid)&&pty.pid>0){fs.writeFileSync(${JSON.stringify(path.join(directory, "supervisor.pid"))},String(pty.pid));clearInterval(receipt);}else if(Date.now()>deadline){console.error("PTY supervisor PID unavailable");process.exit(1);}},25);\nsetInterval(()=>{},1000);\n`);
      const owner = spawn(process.execPath, [ownerFile], { stdio: ["ignore", "ignore", "pipe"] });
      let error = "";
      owner.stderr?.on("data", chunk => { error += String(chunk); });
      t.after(() => { if (error) t.diagnostic(error); if (owner.exitCode === null && owner.signalCode === null) owner.kill(); cleanupFixture(directory, cleanupVerified); });
      await until(() => {
        const receipt = path.join(directory, "supervisor.pid");
        const pid = fs.existsSync(receipt) ? Number(fs.readFileSync(receipt, "utf8")) : 0;
        return fs.existsSync(path.join(directory, "grandchild.heartbeat")) && Number.isSafeInteger(pid) && pid > 0;
      }, "PTY tree starts with a valid supervisor receipt");
      owner.kill("SIGKILL");
    } else {
      const pty = spawnTerminal(process.execPath, args, options);
      let output = "";
      let exited = false;
      pty.onExit(() => { exited = true; });
      pty.onData(data => { output += data; });
      t.after(() => { if (output) t.diagnostic(output); cleanupFixture(directory, cleanupVerified); });
      await until(() => pty.pid > 0, "PTY supervisor starts");
      fs.writeFileSync(path.join(directory, "supervisor.pid"), String(pty.pid));
      await until(() => fs.existsSync(path.join(directory, "grandchild.heartbeat")), "PTY tree starts");
      if (mode === "natural") await until(() => exited, "natural PTY exit");
      // Natural exit also needs an affirmative cleanup receipt, not only PTY exit.
      if (mode === "supervisor-failure") {
        process.kill(pty.pid, "SIGKILL");
        await assert.rejects(stopTerminalProcess(pty), /without confirming cleanup|before connecting/);
      } else await stopTerminalProcess(pty);
    }
    const pids = ["root", "child", "grandchild", "supervisor"].map(role => Number(fs.readFileSync(path.join(directory, `${role}.pid`), "utf8")));
    assert.ok(pids.every(pid => Number.isSafeInteger(pid) && pid > 0));
    await until(() => pids.every(gone), "all PTY-owned descendants exit");
    cleanupVerified = true;
  });
}

test("native Windows PTY preserves input, resize and shell Ctrl-C behavior", { skip: process.platform !== "win32", timeout: 30000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "modex-pty-input-"));
  let cleanupVerified = false;
  const interactive = fileURLToPath(new URL("../../test/fixtures/terminal-interactive.mjs", import.meta.url));
  const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
  const prompt = "MODEX_INTERACTIVE_PROMPT> ";
  const pty = spawnTerminal("powershell.exe", ["-NoLogo", "-NoProfile", "-NoExit", "-Command", `function prompt { ${quote(prompt)} }; & ${quote(process.execPath)} ${quote(interactive)} ${quote(directory)}`], { cwd: directory, cols: 80, rows: 24, env: { ...process.env } });
  let output = "";
  const dimensions = () => {
    try { return JSON.parse(fs.readFileSync(path.join(directory, "dimensions.json"), "utf8")); }
    catch { return {}; } // The live fixture can be midway through its next write.
  };
  pty.onData(data => { output += data; });
  t.after(async () => {
    if (output) t.diagnostic(output);
    t.diagnostic(`Last terminal dimensions: ${JSON.stringify(dimensions())}`);
    try { await stopTerminalProcess(pty); }
    catch (error) { t.diagnostic(`Terminal teardown: ${String(error)}`); }
    finally { cleanupFixture(directory, cleanupVerified); }
  });
  await until(() => pty.pid > 0, "interactive supervisor starts");
  const supervisorPid = pty.pid;
  fs.writeFileSync(path.join(directory, "supervisor.pid"), String(supervisorPid));
  await until(() => dimensions().columns === 80, "initial terminal size");
  assert.equal(dimensions().stdin, true);
  assert.equal(dimensions().stdout, true);
  pty.write("modex-input\r");
  await until(() => fs.existsSync(path.join(directory, "input")), "terminal input reaches child");
  pty.resize(96, 32);
  // Node's stdout columns/rows remain cached on this Windows runner even when
  // ConPTY resized successfully. Query a fresh public TTY stream in the child
  // to test actual OS dimensions, independently of Node's SIGWINCH caching.
  await new Promise(resolve => setTimeout(resolve, 1000));
  fs.writeFileSync(path.join(directory, "inspect-size"), "requested");
  await until(() => dimensions().freshSize?.[0] === 96 && dimensions().freshSize?.[1] === 32, "OS resize reaches child");
  pty.write("\x03");
  await until(() => fs.existsSync(path.join(directory, "interrupted")), "Ctrl-C reaches foreground command");
  // Signal delivery is not process exit or shell readiness. PowerShell may still
  // discard queued input while unwinding the interrupted foreground command.
  await until(() => gone(Number(fs.readFileSync(path.join(directory, "interactive.pid"), "utf8"))) && output.includes(prompt), "shell regains its prompt after foreground exit");
  pty.write("Write-Output ('SHELL_'+'READY')\r");
  await until(() => output.includes("SHELL_READY"), "shell remains interactive after Ctrl-C");
  pty.write("exit\r");
  await stopTerminalProcess(pty);
  await until(() => gone(Number(fs.readFileSync(path.join(directory, "interactive.pid"), "utf8"))) && gone(supervisorPid), "interactive fixture and supervisor exit");
  cleanupVerified = true;
});

// No process.exit or post-exit PTY kill in this fixture: leaked native handles or
// workers prevent natural process exit and fail the bounded parent invocation.
test("native Windows PTY repeated cleanup releases resources and lets its owner exit", { skip: process.platform !== "win32", timeout: 60000 }, async t => {
  const fixture = fileURLToPath(new URL("../../test/fixtures/terminal-resources.mjs", import.meta.url));
  const terminal = new URL("../src/main/engine/terminal-process.js", import.meta.url).href;
  const { stdout } = await promisify(execFile)(process.execPath, [fixture, terminal], { timeout: 55000, windowsHide: true });
  const result = JSON.parse(stdout.trim());
  assert.equal(result.cycles, 6);
  assert.equal(result.ownedConsoles, 0);
  assert.equal(result.messagePorts, result.baseline.messagePorts);
  assert.ok(result.pipeWraps <= result.baseline.pipeWraps);
  t.diagnostic(stdout.trim());
});
