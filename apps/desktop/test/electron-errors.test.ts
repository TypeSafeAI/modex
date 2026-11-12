import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { observeElectronErrors, recordElectronStderr } from "./support/electron-errors.js";

const observer = `(${observeElectronErrors.toString()})(undefined);`;
test("observing a main-process exception retains its message and preserves fatal exit", () => {
  const child = spawnSync(process.execPath, ["-e", observer + `throw new Error("owned-modal-origin");`], { encoding: "utf8", timeout: 5000 });
  assert.equal(child.status, 1);
  assert.match(child.stderr, /MODEX_E2E_MAIN_EXCEPTION.*owned-modal-origin/);
});

test("an existing exception handler remains responsible for its original outcome", () => {
  const child = spawnSync(process.execPath, ["-e", `process.on("uncaughtException", () => { console.log("existing-handler"); process.exit(23); });` + observer + `throw new Error("observed-not-handled");`], { encoding: "utf8", timeout: 5000 });
  assert.equal(child.status, 23);
  assert.equal(child.stdout.trim(), "existing-handler");
  assert.match(child.stderr, /MODEX_E2E_MAIN_EXCEPTION.*observed-not-handled/);
});

test("exception observations bound both record count and stack output", () => {
  const child = spawnSync(process.execPath, ["-e", observer + `for(let n=0;n<20;n++){ const e=new Error("oversized"); e.stack="X".repeat(100000); process.emit("uncaughtExceptionMonitor",e,"uncaughtException"); }`], { encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024 });
  assert.equal(child.status, 0);
  const records = child.stderr.trim().split("\n");
  assert.equal(records.length, 8);
  assert.ok(Buffer.byteLength(child.stderr) < 40000);
  assert.ok(records.every(line => JSON.parse(line.slice("MODEX_E2E_MAIN_EXCEPTION ".length)).stack.length === 4096));
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";

test("owned child stderr survives fatal exit in a private bounded artifact", { timeout: 5000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "modex-electron-errors-"));
  const child = spawn(process.execPath, ["-e", `process.stderr.write("owned-error\\n" + "X".repeat(300000), () => process.exit(19));`]);
  const stop = recordElectronStderr(child, dir);
  child.stderr!.resume();
  try {
    const [code] = await once(child, "close");
    assert.equal(code, 19);
    const file = path.join(dir, `electron-${child.pid}.stderr.log`);
    const bytes = fs.readFileSync(file);
    assert.match(bytes.toString(), /^owned-error/);
    assert.equal(bytes.length, 256 * 1024);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(child.stderr!.listenerCount("data"), 0);
  } finally { stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("unwritable diagnostic destination does not alter child exit", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "modex-electron-errors-"));
  const file = path.join(dir, "not-a-directory"); fs.writeFileSync(file, "");
  const child = spawn(process.execPath, ["-e", `process.stderr.write("preserve-exit"); process.exitCode=17;`]);
  const stop = recordElectronStderr(child, file);
  child.stderr!.resume();
  try { const [code] = await once(child, "close"); assert.equal(code, 17); }
  finally { stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});
