import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { IPty } from "node-pty";
import { TerminalManager } from "../src/main/engine/terminal.js";
import { spawnTerminal, stopTerminalProcess } from "../src/main/engine/terminal-process.js";
import { tmpdir } from "./helpers.js";

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function alive(pid: number): boolean {
  assert.ok(Number.isSafeInteger(pid) && pid > 1, "expected a fixture process ID");
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// Cleanup only: the process can exit between the liveness check and the kill (e.g. a shell whose pty
// was just SIGKILLed), so a vanished PID is fine. Anything else still fails the test.
function killIfAlive(pid: number, signal: NodeJS.Signals = "SIGKILL"): void {
  if (!alive(pid)) return;
  try { process.kill(pid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
}

// Exited means a zombie or already reaped (ps exits 1 for an unknown PID).
function exited(pid: number): boolean {
  try { return execFileSync("/bin/ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim().startsWith("Z"); }
  catch (error) { if ((error as { status?: number }).status === 1) return true; throw error; }
}

async function waitForPid(file: string): Promise<number> {
  for (let i = 0; i < 300; i++) {
    const pid = fs.existsSync(file) ? Number(fs.readFileSync(file, "utf8")) : 0;
    if (Number.isSafeInteger(pid) && pid > 1) return pid;
    await delay(10);
  }
  throw new Error(`Fixture did not publish a process ID: ${file}`);
}

for (const shell of ["/bin/bash", "/bin/zsh"]) {
  test(`${shell} retains foreground Ctrl-Z, fg and Ctrl-C job control`, { skip: !fs.existsSync(shell) }, async () => {
    const cwd = tmpdir("terminal-keys-");
    const file = path.join(cwd, "pid");
    const worker = path.join(cwd, "worker.cjs");
    fs.writeFileSync(worker, `require('node:fs').writeFileSync(${JSON.stringify(file)}, String(process.pid)); setInterval(() => {}, 100);`);
    const pty = spawnTerminal(shell, shell.endsWith("bash") ? ["--noprofile", "--norc"] : ["-f"], { cwd, cols: 80, rows: 24, env: { ...process.env, TERM: "xterm-256color" } });
    let output = "";
    pty.onData((text) => { output += text; });
    let child: number | undefined;
    try {
      pty.write(`${quote(process.execPath)} ${quote(worker)}\r`);
      child = await waitForPid(file);
      pty.write("\x1a");
      for (let i = 0; i < 300 && !/stopped|suspended/i.test(output); i++) await delay(10);
      assert.match(output, /stopped|suspended/i);
      assert.equal(alive(pty.pid), true);
      pty.write("fg\r");
      for (let i = 0; i < 300; i++) {
        if (!execFileSync("/bin/ps", ["-p", String(child), "-o", "stat="], { encoding: "utf8" }).trim().startsWith("T")) break;
        await delay(10);
      }
      pty.write("\x03");
      for (let i = 0; i < 300 && alive(child); i++) await delay(10);
      assert.equal(alive(child), false, "Ctrl-C did not reach the foreground job");
      pty.write("printf '\\137\\137SHELL_READY\\137\\137\\n'\r");
      for (let i = 0; i < 300 && !output.includes("__SHELL_READY__"); i++) await delay(10);
      assert.ok(output.includes("__SHELL_READY__"), "shell did not regain foreground input");
    } finally {
      try { await stopTerminalProcess(pty); }
      finally { if (child) killIfAlive(child); fs.rmSync(cwd, { recursive: true, force: true }); }
    }
  });
}

test("cleanup timeout retains ownership and a later close can retry", { skip: process.platform === "win32" }, async () => {
  const cwd = tmpdir("terminal-retry-");
  let pty!: IPty;
  const manager = new TerminalManager(() => cwd, () => {}, (_shell, _args, options) => {
    pty = spawnTerminal("/bin/bash", ["--noprofile", "--norc"], options);
    return pty;
  });
  manager.open("one", 80, 24);
  // Freeze only this fixture's supervisor, then exercise its real control-channel timeout.
  process.kill(pty.pid, "SIGSTOP");
  // CI once saw this supervisor gone within 56 ms (#63). Say how it ended rather than failing on
  // the SIGCONT below: exit 143 means it served CLOSE (never stopped), signal 9 that it was killed.
  let exit: { exitCode: number; signal?: number } | undefined;
  pty.onExit((event) => { exit = event; });
  try {
    const outcome = await manager.close("one").then(() => "resolved", (error: Error) => `rejected: ${error.message}`);
    assert.match(outcome, /did not stop/, `a frozen supervisor must time out; close() ${outcome}, exit ${JSON.stringify(exit)}`);
    assert.equal(alive(pty.pid), true);
  } finally { killIfAlive(pty.pid, "SIGCONT"); }
  await manager.close("one");
  assert.equal(alive(pty.pid), false);
  await manager.dispose();
  fs.rmSync(cwd, { recursive: true, force: true });
});

test("supervisor death without a cleanup receipt never authorizes deletion", { skip: process.platform === "win32" }, async () => {
  const cwd = tmpdir("terminal-crash-");
  let pty!: IPty;
  const manager = new TerminalManager(() => cwd, () => {}, (_shell, _args, options) => {
    pty = spawnTerminal("/bin/bash", ["--noprofile", "--norc"], options);
    return pty;
  });
  const session = manager.open("one", 80, 24);
  const file = path.join(cwd, "shell.pid");
  manager.write("one", session.sessionId, `printf '%s' "$$" > ${quote(file)}\r`);
  const shell = await waitForPid(file);
  try {
    process.kill(pty.pid, "SIGKILL");
    await assert.rejects(manager.close("one"), /without confirming cleanup/);
    await assert.rejects(manager.dispose(), /without confirming cleanup/);
  } finally {
    killIfAlive(shell);
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("supervisor death seen as a failed CLOSE write still reports a missing cleanup receipt", { skip: process.platform === "win32" }, async () => {
  const cwd = tmpdir("terminal-epipe-");
  let pty!: IPty;
  const manager = new TerminalManager(() => cwd, () => {}, (_shell, _args, options) => {
    pty = spawnTerminal("/bin/bash", ["--noprofile", "--norc"], options);
    return pty;
  });
  const session = manager.open("one", 80, 24);
  const file = path.join(cwd, "shell.pid");
  manager.write("one", session.sessionId, `printf '%s' "$$" > ${quote(file)}\r`);
  const shell = await waitForPid(file);
  try {
    process.kill(pty.pid, "SIGKILL");
    // Block without yielding until the supervisor is gone: its EOF stays unread, so close() writes
    // CLOSE into a dead peer and sees EPIPE rather than an already-closed socket.
    const pause = new Int32Array(new SharedArrayBuffer(4));
    for (let i = 0; i < 300 && !exited(pty.pid); i++) Atomics.wait(pause, 0, 0, 10);
    assert.ok(exited(pty.pid), "the supervisor survived SIGKILL");
    await assert.rejects(manager.close("one"), /without confirming cleanup/);
  } finally {
    killIfAlive(shell);
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

for (const action of ["close", "dispose", "shell exit"] as const) {
  test(`terminal ${action} waits for HUP-resistant foreground and background commands`, { skip: process.platform === "win32" }, async () => {
    const cwd = tmpdir("terminal-cleanup-");
    const ptys: IPty[] = [];
    const children: number[] = [];
    const manager = new TerminalManager(() => cwd, () => {}, (_shell, _args, options) => {
      const pty = spawnTerminal("/bin/bash", ["--noprofile", "--norc"], options);
      ptys.push(pty);
      return pty;
    });
    const fixture = path.join(cwd, "worker.cjs");
    fs.writeFileSync(fixture, `process.on('SIGHUP', () => {}); process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(process.argv[2], String(process.pid)); setInterval(() => {}, 100);`);
    const parent = path.join(cwd, "parent.cjs");
    fs.writeFileSync(parent, `require('node:child_process').spawn(process.execPath, [${JSON.stringify(fixture)}, process.argv[2]], {stdio: 'ignore'}).unref();`);
    try {
      const session = manager.open("one", 80, 24);
      const sibling = manager.open("two", 80, 24);
      const command = (name: string) => `${quote(process.execPath)} ${quote(name === "background" ? parent : fixture)} ${quote(path.join(cwd, name))}`;
      manager.write("one", session.sessionId, `${command("background")} & ${command("foreground")}${action === "shell exit" ? " &" : ""}\r`);
      for (const name of ["foreground", "background"]) {
        const file = path.join(cwd, name);
        children.push(await waitForPid(file));
      }
      assert.ok(children.every(alive));
      const groups = execFileSync("/bin/ps", ["-o", "pgid=", "-p", [ptys[0]!.pid, ...children].join(",")], { encoding: "utf8" }).trim().split(/\s+/);
      assert.equal(new Set(groups).size, 3, "the fixture must exercise distinct shell, foreground and background process groups");
      if (action === "shell exit") {
        manager.write("one", session.sessionId, "exit\r");
        for (let i = 0; i < 300 && manager.open("one", 80, 24).exitCode === null; i++) await delay(10);
        assert.notEqual(manager.open("one", 80, 24).exitCode, null, "shell never exited");
        await manager.close("one", session.sessionId);
      } else if (action === "close") await manager.close("one", session.sessionId);
      else await manager.dispose();
      assert.deepEqual(children.filter(alive), [], "terminal teardown returned while a command was still running");
      assert.equal(alive(ptys[0]!.pid), false, "terminal teardown returned before shell exit");
      if (action === "close") {
        assert.equal(alive(ptys[1]!.pid), true, "closing one terminal killed another session");
        manager.write("two", sibling.sessionId, "echo still-running\r");
      }
    } finally {
      // A failing regression must never leave its intentionally stubborn workers behind.
      try { await manager.dispose(); }
      finally {
        for (const pid of children) killIfAlive(pid);
        for (const pty of ptys) if (alive(pty.pid)) pty.kill("SIGKILL");
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    }
  });
}

test("closing terminals releases every PTY they opened", { skip: process.platform !== "darwin" }, async () => {
  // node-pty 1.1.0 left one unused /dev/ptmx open per spawn, and macOS allows 511 machine-wide.
  const masters = () => execFileSync("/usr/sbin/lsof", ["-p", String(process.pid)], { encoding: "utf8" }).split("\n").filter((line) => line.includes("/dev/ptmx")).length;
  const cwd = tmpdir("terminal-pty-");
  const manager = new TerminalManager(() => cwd, () => {}, (_shell, _args, options) => spawnTerminal("/bin/bash", ["--noprofile", "--norc"], options));
  const before = masters();
  try {
    for (let i = 0; i < 5; i++) {
      manager.open("one", 80, 24);
      await manager.close("one");
    }
    assert.equal(masters(), before, "closed terminals still hold PTY masters");
  } finally {
    await manager.dispose();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
