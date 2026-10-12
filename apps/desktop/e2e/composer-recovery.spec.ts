import { test, expect, type ElectronApplication } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { createThread, launch, seedHome, tid } from "./support";

function logFixture(app: ElectronApplication, home: string, repo: string) {
  console.log(JSON.stringify({ fixtureHome: home, fixtureRepo: repo, electronPid: app.process().pid }));
}

test("independent unsent thread and worktree drafts survive a full relaunch and clearing remains saved", async () => {
  const { home, repo } = seedHome(); let { app, page } = await launch(home); logFixture(app, home, repo);
  const file = path.join(home, "app/update-recovery.json"), read = () => JSON.parse(fs.readFileSync(file, "utf8"));
  const threadText = "  Unsent existing thread\nkeep every line 😀  ", projectText = "  Keep this new worktree chat 😀  ";
  try {
    const threadId = await createThread(page, "Recovery test thread");
    await tid(page, "composer-input").fill(threadText);
    await page.keyboard.press("Meta+Shift+n"); await expect(tid(page, "draft-view")).toHaveAttribute("data-worktree", "true");
    await tid(page, "composer-input").fill(projectText);
    await expect.poll(() => { try { return read().drafts.projects.find((row: any) => row.projectId === "p1")?.text; } catch { return null; } }).toBe(projectText);
    const saved = read(); expect(saved.schema).toBe(2);
    expect(saved.drafts.threads).toContainEqual({ threadId, text: threadText, attachments: [] });
    expect(saved.drafts.draft.worktree).toBe(true); expect(saved.drafts.selectedThreadId).toBeNull();
    await app.close(); ({ app, page } = await launch(home)); logFixture(app, home, repo);
    await expect(tid(page, "draft-view")).toHaveAttribute("data-worktree", "true");
    await expect(tid(page, "composer-input")).toHaveValue(projectText);
    expect(read().drafts.draft).toEqual(saved.drafts.draft);
    await page.locator(`[data-testid="thread-row"][data-thread-id="${threadId}"] .thread-main`).click();
    await expect(tid(page, "composer-input")).toHaveValue(threadText);
    await tid(page, "composer-input").fill("");
    await expect.poll(() => read().drafts.threads).toEqual([{ threadId, text: "", attachments: [] }]);
    await app.close(); ({ app, page } = await launch(home)); logFixture(app, home, repo);
    await expect(tid(page, "thread-view")).toHaveAttribute("data-thread-id", threadId);
    await expect(tid(page, "composer-input")).toHaveValue("");
    expect(read().drafts.projects).toEqual(saved.drafts.projects); expect(read().drafts.draft).toEqual(saved.drafts.draft);
  } finally { await app.close(); fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(repo, { recursive: true, force: true }); }
});

test("failed ordinary draft persistence vetoes native window close until retry saves newer text", async () => {
  const { home, repo } = seedHome(), { app, page } = await launch(home); logFixture(app, home, repo);
  const file = path.join(home, "app/update-recovery.json"), read = () => JSON.parse(fs.readFileSync(file, "utf8"));
  let closed = false; app.on("close", () => { closed = true; });
  page.on("dialog", dialog => { if (dialog.type() !== "beforeunload") void dialog.dismiss(); });
  try {
    await tid(page, "composer-input").fill("First saved draft");
    await expect.poll(() => { try { return read().drafts.projects[0]?.text; } catch { return null; } }).toBe("First saved draft");
    fs.renameSync(file, `${file}.saved`); fs.mkdirSync(file);
    const raw = "  Newer unsaved draft 😀\n  "; await tid(page, "composer-input").fill(raw);
    await expect(tid(page, "toast-message")).toContainText("Could not save your draft");
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]!; (globalThis as any).__draftCloseVetoes = 0;
      window.webContents.on("will-prevent-unload", () => { (globalThis as any).__draftCloseVetoes++; }); window.close();
    });
    await expect.poll(() => app.evaluate(() => (globalThis as any).__draftCloseVetoes)).toBe(1);
    expect(closed).toBe(false); await expect(tid(page, "composer-input")).toHaveValue(raw);
    fs.rmdirSync(file); fs.renameSync(`${file}.saved`, file);
    await tid(page, "toast-retry").click();
    await expect.poll(() => read().drafts.projects[0]?.text).toBe(raw);
    const before = fs.readFileSync(file), exited = app.waitForEvent("close");
    await app.evaluate(({ app }) => app.quit()); await exited;
    expect(fs.readFileSync(file)).toEqual(before);
    const receipt = test.info().outputPath("ordinary-draft-close.json"); fs.writeFileSync(receipt, JSON.stringify({ nativeCloseVetoes: 1, ordinaryQuit: true, rawDraftPreserved: true }));
    await test.info().attach("ordinary-draft-close", { path: receipt, contentType: "application/json" });
  } finally {
    if (fs.existsSync(`${file}.saved`)) { fs.rmSync(file, { recursive: true, force: true }); fs.renameSync(`${file}.saved`, file); }
    if (!closed) await app.close();
    fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(repo, { recursive: true, force: true });
  }
});
