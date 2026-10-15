import { test, expect, _electron as electron } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { appDir, seedHome, tid } from "./support";
import { blockNoteWrites, savedNotes, unblockNoteWrites } from "./notes-support";

test("renderer reload after an updater partial drain opens read-only and ordinary Quit preserves saved bytes", async () => {
  test.skip(process.platform !== "darwin", "macOS updater main assembly");
  const seeded = seedHome({ auto_retire: false }), home = fs.realpathSync(seeded.home), repo = seeded.repo;
  const env = { ...process.env, MODEX_HOME: home, MODEX_NO_LOGIN_PATH: "1", TYPESAFE_API_KEY: "", JEV_API_KEY: "", JEV_CONFIG: path.join(home, "no-jev.json") };
  delete env.MODEX_E2E; delete env.MODEX_PACKAGED_APP; delete env.MODEX_DEV_URL;
  const app = await electron.launch({ args: [path.join(appDir, "e2e/fixtures/update-main.mjs")], cwd: appDir, env });
  let closed = false; app.on("close", () => { closed = true; });
  console.log(JSON.stringify({ fixtureHome: home, fixtureRepo: repo, electronPid: app.process().pid }));
  const file = path.join(home, "app/update-recovery.json"), raw = "  Reload preserves this updater draft 😀\n  ";
  try {
    const page = await app.firstWindow(); await page.waitForLoadState("domcontentloaded");
    page.on("dialog", dialog => { if (dialog.type() !== "beforeunload") void dialog.dismiss(); });
    await tid(page, "composer-input").fill(raw);
    await page.getByRole("button", { name: "Download update", exact: true }).click();
    await page.getByRole("button", { name: "Restart to update", exact: true }).click();
    await expect(tid(page, "update-restart-status")).toContainText("could not finish preparing to restart");
    const before = fs.readFileSync(file); expect(JSON.parse(before.toString()).drafts.projects[0].text).toBe(raw);
    await page.reload();
    await expect(tid(page, "update-recovery")).toBeVisible();
    await expect(page.getByLabel("New chat draft for p1", { exact: true })).toHaveValue(raw);
    await expect(page.getByLabel("New chat draft for p1", { exact: true })).toHaveAttribute("readonly", "");
    await expect(tid(page, "composer-input")).toHaveCount(0);
    expect(await page.evaluate(async () => {
      try { await window.modex!.invoke("thread:create", { projectId: "p1" }); return "allowed"; }
      catch (error) { return String(error); }
    })).toMatch(/recover|restart/i);
    await page.keyboard.press("Meta+n"); await expect(tid(page, "composer-input")).toHaveCount(0);
    expect(fs.readFileSync(file)).toEqual(before);
    const proof = await app.evaluate(() => (globalThis as any).__updateMainFixture);
    expect(proof.nativeCalls).toBe(0); expect(proof.pageDisposals).toBe(1); expect(proof.admissionHeld).toBe(true);
    const exited = app.waitForEvent("close");
    await page.getByRole("button", { name: "Quit Modex", exact: true }).click(); await exited;
    expect(fs.readFileSync(file)).toEqual(before);
    const final = JSON.parse(fs.readFileSync(path.join(home, "final-evidence.json"), "utf8"));
    expect(final.nativeCalls).toBe(0); expect(final.pageDisposals).toBe(2);
    expect(final.quitPrepared).toHaveLength(0); // New read-only document uses main-owned close authority.
    const receipt = test.info().outputPath("updater-reload-evidence.json");
    fs.writeFileSync(receipt, JSON.stringify({ final, readOnlyAfterReload: true, ordinaryQuit: true, unchangedDraftBytes: true }));
    await test.info().attach("updater-reload-evidence", { path: receipt, contentType: "application/json" });
  } finally {
    if (!closed) { await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close(); }
    fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("actual main restart retains drafts after partial drain and retries fresh recovery Quit after a close veto", async () => {
  test.skip(process.platform !== "darwin", "macOS updater main assembly");
  const seeded = seedHome({ auto_retire: false }), home = fs.realpathSync(seeded.home), repo = seeded.repo;
  const env = { ...process.env, MODEX_HOME: home, MODEX_NO_LOGIN_PATH: "1", TYPESAFE_API_KEY: "", JEV_API_KEY: "", JEV_CONFIG: path.join(home, "no-jev.json") };
  delete env.MODEX_E2E; delete env.MODEX_PACKAGED_APP; delete env.MODEX_DEV_URL;
  const app = await electron.launch({ args: [path.join(appDir, "e2e/fixtures/update-main.mjs")], cwd: appDir, env });
  let closed = false; app.on("close", () => { closed = true; });
  console.log(JSON.stringify({ fixtureHome: home, fixtureRepo: repo, electronPid: app.process().pid }));
  const receipt = path.join(home, "app/update-recovery.json");
  try {
    const page = await app.firstWindow(); await page.waitForLoadState("domcontentloaded");
    // Electron owns beforeunload. Playwright's default dismissal races that
    // native decision (see the existing Space failure/retry fixture).
    page.on("dialog", dialog => { if (dialog.type() !== "beforeunload") void dialog.dismiss(); });
    await expect(tid(page, "composer-input")).toBeVisible();
    await tid(page, "composer-input").fill("  Main-owned restart preserves this draft 😀\n");
    await page.getByRole("button", { name: "Space", exact: true }).click();
    await page.getByRole("button", { name: "New page", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Page title" })).toBeVisible();
    blockNoteWrites(home);
    await page.getByRole("textbox", { name: "Page title" }).fill("Dirty page saved through main restart admission");
    await expect(page.getByLabel("Save status")).toHaveText("Not saved");
    await page.getByRole("button", { name: "Chat", exact: true }).click();
    await page.getByRole("button", { name: "Download update", exact: true }).click();
    unblockNoteWrites(home);
    await page.getByRole("button", { name: "Restart to update", exact: true }).click();
    const panel = tid(page, "update-restart-status");
    await expect(panel).toContainText("could not finish preparing to restart");
    const before = fs.readFileSync(receipt), saved = JSON.parse(before.toString());
    expect(saved.drafts.projects[0].text).toBe("  Main-owned restart preserves this draft 😀\n"); expect(saved.attempt).toBeNull();
    expect(await page.evaluate(async () => {
      try { await window.modex!.invoke("thread:create", { projectId: "p1" }); return "allowed"; }
      catch (error) { return String(error); }
    })).toMatch(/recover|restart/i);
    await page.evaluate(() => {
      (globalThis as any).__closeVetoed = false;
      window.addEventListener("beforeunload", event => { (globalThis as any).__closeVetoed = true; event.preventDefault(); event.returnValue = ""; }, { once: true });
    });
    await page.getByRole("button", { name: "Quit Modex", exact: true }).click();
    await expect.poll(() => page.evaluate(() => (globalThis as any).__closeVetoed)).toBe(true);
    await expect(page.getByRole("button", { name: "Quit Modex", exact: true })).toBeEnabled();
    expect(fs.readFileSync(receipt)).toEqual(before);
    const proof = await app.evaluate(() => (globalThis as any).__updateMainFixture);
    expect(proof.nativeCalls).toBe(0); expect(proof.pageDisposals).toBe(1);
    expect(proof.pageSaves).toContainEqual({ held: true, title: "Dirty page saved through main restart admission" });
    expect(savedNotes(home)[0]?.title).toBe("Dirty page saved through main restart admission");
    expect(proof.prepared.some((reply: any) => reply.revision === saved.revision)).toBe(true);
    expect(proof.quitPrepared.filter((reply: any) => reply.revision === saved.revision)).toHaveLength(1);
    // Record the second fresh acknowledgment before the actual process exits.
    await app.evaluate(({ ipcMain }, file) => {
      const fs = process.getBuiltinModule("node:fs");
      ipcMain.on("updates:quit-prepared", () => fs.writeFileSync(file, JSON.stringify((globalThis as any).__updateMainFixture)));
    }, path.join(home, "quit-evidence.json"));
    const exited = app.waitForEvent("close");
    await page.getByRole("button", { name: "Quit Modex", exact: true }).click(); await exited;
    expect(fs.readFileSync(receipt)).toEqual(before);
    const final = JSON.parse(fs.readFileSync(path.join(home, "final-evidence.json"), "utf8"));
    const evidenceFile = test.info().outputPath("main-restart-evidence.json");
    fs.mkdirSync(path.dirname(evidenceFile), { recursive: true });
    fs.writeFileSync(evidenceFile, JSON.stringify({ final, receipt: saved }, null, 2));
    await test.info().attach("main-restart-evidence", { path: evidenceFile, contentType: "application/json" });
    const positives = final.quitPrepared.filter((reply: any) => reply.revision === saved.revision);
    expect(positives).toHaveLength(2); expect(positives[0].id).not.toBe(positives[1].id); expect(final.nativeCalls).toBe(0); expect(final.pageDisposals).toBe(2);
  } finally {
    if (!closed) { await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close(); }
    fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(repo, { recursive: true, force: true });
  }
});
