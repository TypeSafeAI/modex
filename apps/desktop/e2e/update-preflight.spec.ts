import { test, expect, type ElectronApplication } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { launch, seedHome, tid } from "./support";
import { blockNoteWrites, savedNotes, unblockNoteWrites } from "./notes-support";

// Exercise the production preload and renderer barrier. No native update is staged.
function prepare(app: ElectronApplication, id: string) {
  return app.evaluate(({ BrowserWindow, ipcMain }, token) => new Promise<{ revision?: number; error?: string }>((resolve, reject) => {
    const window = BrowserWindow.getAllWindows()[0]!;
    const timeout = setTimeout(() => { ipcMain.removeListener("updates:prepared", listener); reject(new Error("Preparation reply missing")); }, 10_000);
    const listener = (_event: unknown, reply: { id: string; revision?: number; error?: string }) => {
      if (reply.id !== token) return;
      clearTimeout(timeout); ipcMain.removeListener("updates:prepared", listener); resolve(reply);
    };
    ipcMain.on("updates:prepared", listener);
    window.webContents.send("updates:prepare", { type: "prepare", id: token });
  }), id);
}
function release(app: ElectronApplication, id: string) {
  return app.evaluate(({ BrowserWindow }, token) => {
    BrowserWindow.getAllWindows()[0]!.webContents.send("updates:prepare", { type: "release", id: token });
  }, id);
}

test("restart preparation saves drafts and fences pointer and keyboard edits until main releases it", async () => {
  const seeded = seedHome(); const home = fs.realpathSync(seeded.home), repo = seeded.repo;
  const { app, page } = await launch(home);
  console.log(JSON.stringify({ fixtureHome: home, fixtureRepo: repo, electronPid: app.process().pid }));
  try {
    await tid(page, "composer-input").fill("Draft retained across restart");
    const reply = await prepare(app, "save-drafts");
    expect(reply.error).toBeUndefined();
    const saved = JSON.parse(fs.readFileSync(path.join(home, "app", "update-recovery.json"), "utf8"));
    expect(reply.revision).toBe(saved.revision);
    expect(saved.drafts.projects[0].text).toBe("Draft retained across restart");
    await expect.poll(() => page.locator(".app").evaluate(element => Boolean(element.querySelector(":scope > [inert]")))).toBe(true);
    await page.keyboard.press("Meta+n");
    await page.keyboard.type("must not append");
    await expect(tid(page, "composer-input")).toHaveValue("Draft retained across restart");
    await release(app, "old-token");
    await expect.poll(() => page.locator(".app").evaluate(element => Boolean(element.querySelector(":scope > [inert]")))).toBe(true);
    await release(app, "save-drafts");
    await expect.poll(() => page.locator(".app").evaluate(element => Boolean(element.querySelector(":scope > [inert]")))).toBe(false);
    await tid(page, "composer-input").fill("Editing works after refusal");
  } finally { await release(app, "save-drafts"); await app.close(); fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(repo, { recursive: true, force: true }); }
});

test("open Settings and failed Space saves refuse preparation without discarding drafts", async () => {
  const seeded = seedHome(); const home = fs.realpathSync(seeded.home), repo = seeded.repo;
  const { app, page } = await launch(home);
  console.log(JSON.stringify({ fixtureHome: home, fixtureRepo: repo, electronPid: app.process().pid }));
  try {
    await tid(page, "open-settings").click();
    expect((await prepare(app, "settings")).error).toMatch(/dialog/i);
    await release(app, "settings");
    await expect.poll(() => page.locator(".app").evaluate(element => Boolean(element.querySelector(":scope > [inert]")))).toBe(false);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Settings" })).toHaveCount(0);
    await page.getByRole("button", { name: "Space", exact: true }).click();
    await page.getByRole("button", { name: "New page", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Page title" })).toBeVisible();
    blockNoteWrites(home);
    await page.getByRole("textbox", { name: "Page title" }).fill("Unsaved Space title");
    await expect(page.getByLabel("Save status")).toHaveText("Not saved");
    expect((await prepare(app, "space")).error).toBeTruthy();
    await release(app, "space");
    await expect(page.getByRole("textbox", { name: "Page title" })).toHaveValue("Unsaved Space title");
    unblockNoteWrites(home);
    const ready = await prepare(app, "space-retry");
    expect(ready.error).toBeUndefined();
    expect(savedNotes(home)[0]?.title).toBe("Unsaved Space title");
    await release(app, "space-retry");
  } finally {
    for (const id of ["settings", "space", "space-retry"]) await release(app, id);
    try { unblockNoteWrites(home); } catch { /* Not blocked. */ }
    await app.close(); fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("a Markdown import finishes after a refused restart releases editing", async () => {
  const seeded = seedHome(); const home = fs.realpathSync(seeded.home), repo = seeded.repo;
  const { app, page } = await launch(home);
  console.log(JSON.stringify({ fixtureHome: home, fixtureRepo: repo, electronPid: app.process().pid }));
  try {
    await page.getByRole("button", { name: "Space", exact: true }).click();
    await expect(page.getByRole("button", { name: "New page", exact: true })).toBeEnabled();
    await page.evaluate(() => {
      const original = File.prototype.text;
      File.prototype.text = async function () {
        const text = await original.call(this);
        return new Promise<string>(resolve => {
          (window as unknown as { finishImport: () => void }).finishImport = () => resolve(text);
        });
      };
    });
    await page.getByLabel("Import Markdown file").setInputFiles({ name: "preserved.md", mimeType: "text/markdown", buffer: Buffer.from("# Preserved import\n\nKeep this text.") });
    await expect.poll(() => page.evaluate(() => typeof (window as unknown as { finishImport?: unknown }).finishImport)).toBe("function");
    expect((await prepare(app, "import")).error).toMatch(/Space action/);
    await page.evaluate(() => (window as unknown as { finishImport: () => void }).finishImport());
    expect(savedNotes(home)).toEqual([]);
    await release(app, "import");
    await expect(page.getByRole("textbox", { name: "Page title" })).toHaveValue("Preserved import");
    expect(savedNotes(home)[0]?.markdown).toContain("Keep this text.");
  } finally { await release(app, "import"); await app.close(); fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(repo, { recursive: true, force: true }); }
});
