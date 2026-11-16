import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { launch, seedHome, tid } from "./support.js";
import { observeElectronErrors, recordElectronStderr } from "../test/support/electron-errors.js";

test("a Codex input pipe failure leaves Settings responsive and reports model discovery failure", async () => {
  const { home } = seedHome({ default_backend: "codex" });
  const statePath = path.join(home, "app/state.json"), state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  const cli = path.join(home, "closed-input-codex.cjs"), calls = path.join(home, "codex-methods.jsonl");
  state.settings.codex_bin = cli;
  for (const family of ["claude", "opencode", "mimo"]) state.settings[`${family}_bin`] = path.join(home, `missing-${family}`);
  fs.writeFileSync(statePath, JSON.stringify(state));
  fs.writeFileSync(cli, `#!${process.execPath}
const fs = require('node:fs');
if (process.argv.includes('--version')) { console.log('codex-cli 0.164.0'); process.exit(0); }
if (!process.argv.includes('app-server')) process.exit(2);
let line = ''; const byte = Buffer.alloc(1);
while (!line.endsWith('\\n')) {
 try { if (!fs.readSync(0, byte, 0, 1, null)) process.exit(0); line += byte.toString(); }
 catch (error) { if (error.code !== 'EAGAIN') throw error; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1); }
}
const request = JSON.parse(line);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({method:request.method})+'\\n');
fs.closeSync(0);
console.log(JSON.stringify({id:request.id,result:{userAgent:'synthetic-closed-input'}}));
setInterval(() => {}, 1000);
`, { mode: 0o755 });
  const { app, page } = await launch(home);
  const stderr = path.join(test.info().outputDir, `electron-${app.process().pid}.stderr.log`);
  recordElectronStderr(app.process(), test.info().outputDir);
  await app.evaluate(observeElectronErrors);
  try {
    const result = await page.evaluate(() => window.modex!.invoke("models:list", { backend: "codex" }));
    expect(result.models).toEqual([]);
    expect(result.error).toContain("input transport failed");
    await tid(page, "open-settings").click();
    await expect(tid(page, "settings")).toBeVisible();
    await page.getByRole("button", { name: "Coding CLIs", exact: true }).click();
    await expect(page.getByText(/Account status unavailable · check in Codex CLI/)).toBeVisible();
    await page.getByRole("button", { name: "General", exact: true }).click();
    await page.screenshot({ path: test.info().outputPath("settings-after-input-failure.png"), animations: "disabled" });
    await tid(page, "settings").getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(tid(page, "settings")).toHaveCount(0);
    await tid(page, "open-settings").click();
    await expect(tid(page, "settings")).toBeVisible();
    const methods = fs.readFileSync(calls, "utf8").trim().split("\n").map(line => JSON.parse(line).method);
    expect(methods.length).toBeGreaterThan(0);
    expect(methods.every(method => method === "initialize")).toBe(true);
  } finally { await app.close(); }
  expect(fs.readFileSync(stderr, "utf8")).not.toContain("MODEX_E2E_MAIN_EXCEPTION");
});
