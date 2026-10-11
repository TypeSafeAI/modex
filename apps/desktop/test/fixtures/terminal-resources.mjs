import assert from "node:assert/strict";
import { createRequire } from "node:module";
import os from "node:os";
const { spawnTerminal, stopTerminalProcess } = await import(process.argv[2]);
const addon = createRequire(import.meta.url)("node-pty/lib/utils.js").loadNativeModule("conpty").module;
assert.equal(addon.modexCleanupPatch, 1);
const snapshot = () => {
  const resources = process.getActiveResourcesInfo();
  return { messagePorts: resources.filter(r => r === "MessagePort").length,
    pipeWraps: resources.filter(r => r === "PipeWrap").length, ownedConsoles: addon.modexActiveConsoles() };
};
async function until(check, label) {
  const deadline = Date.now() + 10000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}: ${JSON.stringify(snapshot())}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
async function cycle(mode) {
  const script = mode === "natural" ? "process.stdout.write('ready\\n'); setTimeout(()=>{process.exitCode=23},100)" : "process.stdout.write('ready\\n'); setInterval(()=>{},1000)";
  const pty = spawnTerminal(process.execPath, ["-e", script], { cwd: os.tmpdir(), cols: 80, rows: 24, env: { ...process.env } });
  let output = "", exited = false, exitCode;
  pty.onData(data => { output += data; });
  pty.onExit(event => { exited = true; exitCode = event.exitCode; });
  await until(() => output.includes("ready"), `${mode} output`);
  const typing = setInterval(() => pty.write("late keystroke\r"), 5);
  try {
    if (mode === "natural") await until(() => exited, "natural exit");
    if (mode === "failure") {
      process.kill(pty.pid, "SIGKILL");
      await assert.rejects(stopTerminalProcess(pty), /without confirming cleanup|before connecting/);
    } else await stopTerminalProcess(pty);
    await until(() => exited && snapshot().ownedConsoles === 0 && snapshot().messagePorts === 0, `${mode} native cleanup`);
    if (mode === "natural") assert.equal(exitCode, 23, "native exit code must survive output EOF ordering");
  } finally { clearInterval(typing); }
}
// Warm the dependency, console/stdio setup and worker runtime before comparing.
await cycle("natural");
await new Promise(resolve => setTimeout(resolve, 100));
const baseline = snapshot();
for (let index = 0; index < 6; index++) await cycle(["natural", "close", "failure"][index % 3]);
await until(() => snapshot().pipeWraps <= baseline.pipeWraps, "pipe handles return to baseline");
console.log(JSON.stringify({ cycles: 6, baseline, ...snapshot() }));
