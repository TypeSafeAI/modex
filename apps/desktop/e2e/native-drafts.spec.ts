import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { launch, seedHome, tid } from "./support";

let app: ElectronApplication, page: Page, home: string, repo: string;
test.beforeEach(async () => {
  ({ home, repo } = seedHome());
  home = fs.realpathSync(home);
  ({ app, page } = await launch(home));
  console.log(JSON.stringify({ fixtureHome: home, fixtureRepo: repo, electronPid: app.process().pid }));
});
test.afterEach(async () => {
  await app?.close();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

test("native composer restores exact raw draft text and selected project after document reload", async () => {
  await page.keyboard.press("Meta+n");
  const raw = "  unsent original\n  second line 😀  ";
  await tid(page, "composer-input").fill(raw);
  await expect.poll(() => {
    try { return JSON.parse(fs.readFileSync(path.join(home, "app", "update-recovery.json"), "utf8")).drafts.projects[0]?.text; }
    catch { return null; }
  }).toBe(raw);
  await page.reload();
  await expect(tid(page, "draft-view")).toBeVisible();
  await expect(tid(page, "composer-input")).toHaveValue(raw);
  expect(await page.evaluate(async () => {
    const opened = await window.modex!.nativeDrafts!.open();
    return opened && "session" in opened;
  })).toBe(false);
});

test("autosave reaches disk while unrelated background events keep rendering", async () => {
  await page.keyboard.press("Meta+n");
  await expect(tid(page, "draft-view")).toBeVisible();
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]!;
    let count = 0;
    const timer = setInterval(() => {
      if (window.isDestroyed() || window.webContents.isDestroyed()) { clearInterval(timer); return; }
      window.webContents.send("thread:event", { threadId: "background", type: "item", item: { id: `background-${++count}`, kind: "assistant", text: "streaming", at: new Date().toISOString() } });
    }, 40);
    (globalThis as any).__draftStreamActive = true;
    setTimeout(() => { clearInterval(timer); (globalThis as any).__draftStreamActive = false; }, 5000);
  });
  const raw = "  persist before the stream ends  ";
  await tid(page, "composer-input").fill(raw);
  await expect.poll(() => {
    try { return JSON.parse(fs.readFileSync(path.join(home, "app", "update-recovery.json"), "utf8")).drafts.projects.find((row: any) => row.text === raw)?.text; }
    catch { return null; }
  }, { timeout: 2500 }).toBe(raw);
  expect(await app.evaluate(() => (globalThis as any).__draftStreamActive)).toBe(true);
});

async function pasteAttachment(name: string) {
  await page.evaluate(name => {
    const data = new DataTransfer(); data.items.add(new File(["original attachment bytes"], name, { type: "text/plain" }));
    document.querySelector('[data-testid="composer-input"]')!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, name);
  await expect(tid(page, "composer-attachments")).toContainText(name);
}
const readItems = (threadId: string) => {
  try { return JSON.parse(fs.readFileSync(path.join(home, "app", "threads", `${threadId}.json`), "utf8")); }
  catch { return []; }
};
const readUsers = (threadId: string) => readItems(threadId).filter((item: any) => item.kind === "user");

test("native first send persists exact raw text and attachment identity", async () => {
  await page.keyboard.press("Meta+n");
  const raw = "  raw native message\n  second line 😀  ";
  await tid(page, "composer-input").fill(raw); await pasteAttachment("original.txt");
  await page.keyboard.press("Meta+Enter");
  await expect(tid(page, "thread-view")).toBeVisible();
  const threadId = (await tid(page, "thread-view").getAttribute("data-thread-id"))!;
  await expect.poll(() => readUsers(threadId).length).toBe(1);
  expect(readUsers(threadId)[0].text).toBe(raw);
  const attached = readUsers(threadId)[0].attachments[0];
  expect(attached.rel).toMatch(new RegExp(`^${threadId}/`));
  expect(fs.readFileSync(path.join(home, "attachments", attached.rel), "utf8")).toBe("original attachment bytes");
  expect(fs.readdirSync(path.join(home, "app", "pending-sends"))).toEqual([]);
});

for (const afterUser of [false, true]) test(`failed ${afterUser ? "pending cleanup after durable user" : "user write after transfer"} survives restart and offers one explicit original retry`, async () => {
  const marker = "NATIVE_RECOVERY_EXPLICIT_RETRY_COMPLETED";
  const script = path.join(home, "retry-script.json");
  fs.writeFileSync(script, JSON.stringify({ steps: [{ content: marker }] }));
  await page.evaluate(mock_script => window.modex!.invoke("settings:update", { mock_script }), script);
  await page.keyboard.press("Meta+n");
  const raw = "  preserved original\n😀  ", newer = "  independent newer typing  ";
  await tid(page, "composer-input").fill(raw); await pasteAttachment("original.txt");
  await app.evaluate((_electron, afterUser) => {
    const fs = process.getBuiltinModule("node:fs");
    const home = process.env.MODEX_HOME!;
    (globalThis as any).__draftFaultCount = 0;
    if (afterUser) {
      const original = fs.unlinkSync;
      (globalThis as any).__restoreDraftFault = () => { fs.unlinkSync = original; };
      fs.unlinkSync = ((file: any) => {
        if (String(file).startsWith(`${home}/app/pending-sends/`) && String(file).endsWith(".json")) { (globalThis as any).__draftFaultCount++; throw Object.assign(new Error("injected pending cleanup refusal"), { code: "EACCES" }); }
        return original(file);
      }) as typeof fs.unlinkSync;
    } else {
      const original = fs.openSync;
      (globalThis as any).__restoreDraftFault = () => { fs.openSync = original; };
      fs.openSync = ((...args: Parameters<typeof fs.openSync>) => {
        if (String(args[0]).startsWith(`${home}/app/threads/`) && String(args[0]).endsWith(".tmp")) { (globalThis as any).__draftFaultCount++; throw Object.assign(new Error("injected user write refusal"), { code: "EACCES" }); }
        return Reflect.apply(original, fs, args);
      }) as typeof fs.openSync;
    }
  }, afterUser);
  await page.keyboard.press("Meta+Enter");
  await expect(tid(page, "thread-view")).toBeVisible();
  await expect(tid(page, "toast")).toContainText(afterUser ? /recovery|preserv/i : /injected/);
  expect(await app.evaluate(() => (globalThis as any).__draftFaultCount)).toBe(1);
  await app.evaluate(() => { (globalThis as any).__restoreDraftFault(); delete (globalThis as any).__restoreDraftFault; });
  const threadId = (await tid(page, "thread-view").getAttribute("data-thread-id"))!;
  await tid(page, "composer-input").fill(newer);
  await expect.poll(() => JSON.parse(fs.readFileSync(path.join(home, "app", "update-recovery.json"), "utf8")).drafts.threads.find((row: any) => row.threadId === threadId)?.text).toBe(newer);
  const pendingName = fs.readdirSync(path.join(home, "app", "pending-sends"))[0]!;
  const originalId = JSON.parse(fs.readFileSync(path.join(home, "app", "pending-sends", pendingName), "utf8")).id;
  expect(readUsers(threadId).length).toBe(afterUser ? 1 : 0);
  await app.close(); ({ app, page } = await launch(home));
  console.log(JSON.stringify({ fixtureHome: home, fixtureRepo: repo, electronPid: app.process().pid, relaunched: true }));
  await expect(tid(page, "composer-input")).toHaveValue(newer);
  expect(readUsers(threadId).length).toBe(afterUser ? 1 : 0);
  expect(readItems(threadId).filter((item: any) => ["assistant", "thinking", "tool"].includes(item.kind))).toEqual([]);
  await expect(tid(page, afterUser ? "saved-message-retry" : "pending-message-retry")).toBeVisible();
  await tid(page, afterUser ? "saved-message-retry" : "pending-message-retry").click();
  await expect.poll(() => readUsers(threadId).length).toBe(1);
  await expect.poll(() => readItems(threadId).filter((item: any) => item.kind === "assistant" && item.text === marker).length).toBe(1);
  await expect.poll(() => JSON.parse(fs.readFileSync(path.join(home, "app", "state.json"), "utf8")).threads.find((row: any) => row.id === threadId)?.status).toBe("idle");
  expect(readUsers(threadId)[0].id).toBe(originalId); expect(readUsers(threadId)[0].text).toBe(raw);
  expect(readUsers(threadId)[0].attachments).toHaveLength(1);
  expect(fs.readFileSync(path.join(home, "attachments", readUsers(threadId)[0].attachments[0].rel), "utf8")).toBe("original attachment bytes");
  await expect(tid(page, "composer-input")).toHaveValue(newer);
  await expect(tid(page, "pending-message")).toHaveCount(0);
});

test("retiring a project draft rejects a late native picker without copying its selection", async () => {
  await page.keyboard.press("Meta+n"); await expect(tid(page, "draft-view")).toBeVisible();
  const selected = path.join(home, "selected.txt"); fs.writeFileSync(selected, "selected source remains unchanged");
  await expect.poll(() => {
    try { return typeof JSON.parse(fs.readFileSync(path.join(home, "app", "update-recovery.json"), "utf8")).drafts.draft.revision; }
    catch { return null; }
  }).toBe("number");
  const before = JSON.parse(fs.readFileSync(path.join(home, "app", "update-recovery.json"), "utf8")).drafts.draft.revision;
  await app.evaluate(({ dialog, ipcMain }) => {
    const original = dialog.showOpenDialog;
    (globalThis as any).__restorePicker = () => { dialog.showOpenDialog = original; };
    dialog.showOpenDialog = (() => new Promise(resolve => { (globalThis as any).__finishPicker = resolve; })) as typeof dialog.showOpenDialog;
    const ipc = ipcMain as typeof ipcMain & { _invokeHandlers: Map<string, (...args: any[]) => any> };
    const pick = ipc._invokeHandlers.get("drafts:pick")!;
    (globalThis as any).__pickerSettled = 0;
    ipcMain.removeHandler("drafts:pick");
    ipcMain.handle("drafts:pick", async (...args) => {
      try { return await pick(...args); }
      finally { (globalThis as any).__pickerSettled++; }
    });
  });
  await tid(page, "composer-attach").click();
  await expect.poll(() => app.evaluate(() => typeof (globalThis as any).__finishPicker)).toBe("function");
  await page.keyboard.press("Meta+n");
  await expect.poll(() => JSON.parse(fs.readFileSync(path.join(home, "app", "update-recovery.json"), "utf8")).drafts.draft.revision).toBeGreaterThan(before);
  await app.evaluate((_electron, selected) => {
    (globalThis as any).__restorePicker(); (globalThis as any).__finishPicker({ canceled: false, filePaths: [selected] });
    delete (globalThis as any).__restorePicker; delete (globalThis as any).__finishPicker;
  }, selected);
  await expect.poll(() => app.evaluate(() => (globalThis as any).__pickerSettled)).toBe(1);
  await expect(tid(page, "composer-attachments")).toHaveCount(0);
  expect(fs.readdirSync(path.join(home, "attachments", "staging"))).toEqual([]);
  expect(fs.readFileSync(selected, "utf8")).toBe("selected source remains unchanged");
});
