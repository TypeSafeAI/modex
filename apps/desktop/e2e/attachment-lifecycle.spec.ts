import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { createThread, launch, resizeWindow, seedHome, tid } from "./support";

const chips = (page: Page) => tid(tid(page, "composer-attachments"), "attachment-chip");
async function drop(page: Page, names: string[]) {
  await expect(tid(page, "attachment-dropzone")).toBeVisible();
  // Native window visibility precedes React's effects. Probe dragover until the
  // mounted handler accepts it; never retry a drop that could stage files twice.
  await expect.poll(() => page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File([""], "ready.txt", { type: "text/plain" }));
    return !window.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true }));
  })).toBe(true);
  await page.evaluate(names => {
    const dt = new DataTransfer();
    for (const name of names) dt.items.add(new File([`bytes:${name}`], name, { type: "text/plain" }));
    window.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, names);
}
// Hold a real IPC handler before it stages anything; release still exercises actual storage/claims.
async function hold(app: ElectronApplication, channel: string, fail = false) {
  await app.evaluate(({ ipcMain }, { channel, fail }) => {
    const ipc = ipcMain as typeof ipcMain & { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> };
    const original = ipc._invokeHandlers.get(channel)!;
    const waits: Array<() => void> = [];
    Object.assign(globalThis, { attachmentPending: () => waits.length, releaseAttachment: (index = 0) => waits.splice(index, 1)[0]?.() });
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, (...args) => new Promise((resolve, reject) => waits.push(() => {
      if (fail) reject(new Error(`Synthetic ${channel} rejection`));
      else Promise.resolve(original(...args)).then(resolve, reject);
    })));
  }, { channel, fail });
}
const pending = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { attachmentPending: () => number }).attachmentPending());
const release = (app: ElectronApplication, index = 0) => app.evaluate((_, index) => (globalThis as unknown as { releaseAttachment: (index: number) => void }).releaseAttachment(index), index);

function addSecondProject(home: string) {
  const file = path.join(home, "app", "state.json");
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  state.projects.push({ ...state.projects[0], id: "p2", name: "Second project" });
  fs.writeFileSync(file, JSON.stringify(state));
}
async function switchProject(page: Page, projectId: string) {
  await tid(page, "draft-project").click();
  await page.locator(`[data-testid="draft-project-option"][data-project-id="${projectId}"]`).click();
  await expect(tid(page, "draft-view")).toHaveAttribute("data-project-id", projectId);
}

test("Space visualization appends to the active project's attachment draft", async () => {
  const { home, repo } = seedHome({ theme: "graphite" }); addSecondProject(home);
  const { app, page } = await launch(home);
  try {
    await tid(page, "composer-input").fill("Keep project A's draft");
    await drop(page, ["A.md"]); await expect(chips(page)).toHaveCount(1);
    await switchProject(page, "p2");
    await tid(page, "composer-input").fill("Visualize for project B");
    await drop(page, ["B.md"]); await expect(chips(page)).toHaveCount(1);
    await tid(page, "rail-space").click();
    await page.getByLabel("Import Markdown file").setInputFiles({
      name: "diagram.md", mimeType: "text/markdown", buffer: Buffer.from("# Diagram\n\nA page to visualize"),
    });
    await expect(page.getByRole("textbox", { name: "Page title" })).toHaveValue("Diagram");
    await page.getByRole("button", { name: "Visualize page", exact: true }).click();
    await expect(tid(page, "space-chat")).toBeVisible();
    await expect(tid(page, "composer-input")).toHaveValue(/Visualize for project B\n\nCreate an interactive visualization of this page\./);
    await expect(tid(page, "composer-input")).toHaveValue(/A page to visualize/);
    await expect(chips(page).first()).toContainText("B.md");
    await expect(tid(page, "thread-row")).toHaveCount(0);
    await switchProject(page, "p1");
    await expect(tid(page, "composer-input")).toHaveValue("Keep project A's draft");
    await expect(chips(page).first()).toContainText("A.md");
  } finally { await app.close(); fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(repo, { recursive: true, force: true }); }
});

test("Streamer masks attachment labels while sending original metadata and bytes", async () => {
  const { home, repo } = seedHome();
  const { app, page } = await launch(home);
  const name = "TOKEN=attachment-secret.md";
  try {
    await tid(page, "streamer-mode-toggle").click();
    await drop(page, [name]);
    await expect(chips(page)).toHaveCount(1);
    await expect(chips(page).first()).toHaveAttribute("title", "TOKEN=[redacted]");
    await expect(chips(page).first()).toContainText(name);
    await expect.poll(() => page.evaluate(() => Array.from(CSS.highlights.get("modex-streamer") ?? [], range => range.toString()).join(""))).toContain("attachment-secret.md");
    await tid(page, "send").click();
    await expect(tid(page, "thread-view")).toBeVisible();
    const readSaved = () => page.evaluate(async () => {
      const state = await window.modex!.invoke("state:get", undefined);
      const thread = state.threads[0]!;
      const items = await window.modex!.invoke("thread:items", { threadId: thread.id });
      return items.find(item => item.kind === "user")?.attachments?.[0];
    });
    await expect.poll(readSaved).toMatchObject({ name });
    const saved = await readSaved();
    expect(saved?.name).toBe(name);
    expect(saved?.rel).toContain(name);
    expect(fs.readFileSync(path.join(home, "attachments", saved!.rel), "utf8")).toBe(`bytes:${name}`);
    await expect(tid(page, "composer-attachments")).toHaveCount(0);
    await tid(page, "streamer-mode-toggle").click();
    await expect(tid(page, "attachments").getByTestId("attachment-chip").first()).toHaveAttribute("title", name);
  } finally { await app.close(); fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(repo, { recursive: true, force: true }); }
});

for (const failure of [false, true]) test(`project switch keeps B input isolated from A's held ${failure ? "failed" : "successful"} creation`, async () => {
  const { home, repo } = seedHome(); addSecondProject(home);
  const { app, page } = await launch(home);
  try {
    await drop(page, ["A.md"]); await expect(chips(page)).toHaveCount(1);
    await tid(page, "composer-input").fill("first message for A");
    await hold(app, "thread:create", failure);
    await tid(page, "send").click(); await expect.poll(() => pending(app)).toBe(1);
    await switchProject(page, "p2");
    await expect(tid(page, "composer-input")).toHaveValue("");
    await expect(chips(page)).toHaveCount(0);
    await tid(page, "composer-input").fill("newer text for B");
    await drop(page, ["B.md"]); await expect(chips(page)).toHaveCount(1);
    await expect(tid(page, "send")).toBeEnabled();
    await release(app);
    if (failure) await expect(tid(page, "toast")).toContainText("Synthetic thread:create rejection");
    else await expect(tid(page, "thread-row")).toHaveCount(1);
    await expect(tid(page, "draft-view")).toHaveAttribute("data-project-id", "p2");
    await expect(tid(page, "composer-input")).toHaveValue("newer text for B");
    await expect(chips(page)).toHaveCount(1); await expect(chips(page).first()).toContainText("B.md");
    if (failure) {
      await switchProject(page, "p1");
      await expect(tid(page, "composer-input")).toHaveValue("first message for A");
      await expect(chips(page)).toHaveCount(1); await expect(chips(page).first()).toContainText("A.md");
      await switchProject(page, "p2");
      await expect(tid(page, "composer-input")).toHaveValue("newer text for B");
      await expect(chips(page).first()).toContainText("B.md");
    } else {
      const readUser = () => page.evaluate(async () => {
        const state = await window.modex!.invoke("state:get", undefined);
        const thread = state.threads.find(t => t.projectId === "p1")!;
        const items = await window.modex!.invoke("thread:items", { threadId: thread.id });
        return items.find(item => item.kind === "user");
      });
      await expect.poll(readUser).toMatchObject({ text: "first message for A" });
      expect((await readUser())?.attachments?.map(file => file.name)).toEqual(["A.md"]);
      await page.evaluate(async () => {
        const state = await window.modex!.invoke("state:get", undefined);
        await window.modex!.invoke("thread:stop", { threadId: state.threads.find(t => t.projectId === "p1")!.id });
      });
    }
  } finally { await app.close(); fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(repo, { recursive: true, force: true }); }
});

test("project switch-back keeps pending staging and ordinary unsent drafts on their own project", async () => {
  const { home, repo } = seedHome(); addSecondProject(home);
  const { app, page } = await launch(home);
  try {
    await tid(page, "composer-input").fill("A draft");
    await hold(app, "attachments:stage");
    await drop(page, ["A.md"]); await expect.poll(() => pending(app)).toBe(1);
    await switchProject(page, "p2");
    await tid(page, "composer-input").fill("B draft");
    await drop(page, ["B.md"]); await expect.poll(() => pending(app)).toBe(1);
    await expect(chips(page)).toHaveCount(0);
    await tid(page, "composer-input").fill("");
    await switchProject(page, "p1");
    await expect(tid(page, "composer-input")).toHaveValue("A draft");
    await expect(tid(page, "send")).toBeDisabled();
    await release(app); await expect(chips(page)).toHaveCount(1);
    await expect(chips(page).first()).toContainText("A.md");
    await expect(tid(page, "send")).toBeEnabled();
    await expect.poll(() => pending(app)).toBe(1);
    await release(app); // B remained reserved while A occupied the byte-upload slot.
    await switchProject(page, "p2");
    await expect(tid(page, "composer-input")).toHaveValue("");
    await expect(chips(page).first()).toContainText("B.md");
    await page.keyboard.press("Meta+n");
    await expect(chips(page)).toHaveCount(0);
    await expect.poll(() => fs.readdirSync(path.join(home, "attachments", "staging")).length).toBe(0);
  } finally { await app.close(); fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(repo, { recursive: true, force: true }); }
});

for (const existing of [false, true]) test(`${existing ? "thread" : "draft"}: pending stage blocks button and keyboard send; rejection releases it`, async () => {
  const { home, repo } = seedHome(); const { app, page } = await launch(home);
  try {
    if (existing) await createThread(page, "existing");
    await hold(app, "attachments:stage", true);
    await tid(page, "composer-input").fill("keep text");
    await drop(page, ["held.md"]);
    await expect.poll(() => pending(app)).toBe(1);
    await expect(tid(page, "send")).toBeDisabled();
    await tid(page, "send").dispatchEvent("click");
    await tid(page, "composer-input").press("Enter");
    await tid(page, "composer-input").press("Meta+Enter");
    await expect(tid(page, "composer-input")).toHaveValue("keep text");
    await expect(tid(page, "thread-row")).toHaveCount(existing ? 1 : 0);
    await release(app);
    await expect(tid(page, "attach-warning")).toContainText("Synthetic attachments:stage rejection");
    await expect(tid(page, "send")).toBeEnabled();
  } finally { await app.close(); fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(repo, { recursive: true, force: true }); }
});

for (const operation of ["picker", "encoding"] as const) for (const existing of [false, true]) test(`${existing ? "thread" : "draft"}: pending ${operation} blocks click and keyboard until rejection`, async () => {
  const { home, repo } = seedHome(); const { app, page } = await launch(home);
  try {
    if (existing) await createThread(page, "existing");
    await tid(page, "composer-input").fill("keep text");
    if (operation === "picker") {
      await hold(app, "attachments:pick", true);
      await tid(page, "composer-attach").click();
      await expect.poll(() => pending(app)).toBe(1);
    } else {
      await page.evaluate(() => {
        File.prototype.arrayBuffer = () => new Promise((_resolve, reject) => Object.assign(window, { rejectEncoding: () => reject(new Error("Synthetic encoding rejection")) }));
      });
      await drop(page, ["encoding.md"]);
    }
    await expect(tid(page, "send")).toBeDisabled();
    await tid(page, "send").dispatchEvent("click");
    await tid(page, "composer-input").press("Enter");
    await tid(page, "composer-input").press("Meta+Enter");
    await expect(tid(page, "composer-input")).toHaveValue("keep text");
    await expect(tid(page, "thread-row")).toHaveCount(existing ? 1 : 0);
    if (operation === "picker") await release(app);
    else await page.evaluate(() => (window as unknown as { rejectEncoding: () => void }).rejectEncoding());
    await expect(tid(page, "attach-warning")).toContainText("rejection");
    await expect(tid(page, "send")).toBeEnabled();
  } finally { await app.close(); fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(repo, { recursive: true, force: true }); }
});

test("failed creation restores files while keeping newer text and other drafts usable", async () => {
  const { home, repo } = seedHome(); const { app, page } = await launch(home);
  try {
    await drop(page, ["old.md"]); await expect(chips(page)).toHaveCount(1);
    await hold(app, "thread:create", true);
    await tid(page, "composer-input").fill("old text"); await tid(page, "send").click();
    await expect.poll(() => pending(app)).toBe(1);
    await tid(page, "composer-input").fill("newer text");
    await tid(page, "composer-input").press("Meta+Enter");
    await expect.poll(() => pending(app)).toBe(1);
    await release(app);
    await expect(chips(page)).toHaveCount(1);
    await expect(tid(page, "composer-input")).toHaveValue("newer text");
    await expect(tid(page, "toast-retry")).toHaveCount(0);
    await expect(tid(page, "send")).toBeEnabled();
    await tid(page, "send").click(); await expect.poll(() => pending(app)).toBe(1);
    await page.keyboard.press("Meta+n");
    await tid(page, "composer-input").fill("another draft");
    await expect(tid(page, "send")).toBeEnabled();
    await release(app);
    await expect(tid(page, "composer-input")).toHaveValue("another draft");
    await expect(chips(page)).toHaveCount(0);
    await expect.poll(() => fs.readdirSync(path.join(home, "attachments", "staging")).length).toBe(0);
  } finally { await app.close(); fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(repo, { recursive: true, force: true }); }
});

test("late staging survives switch/remount without replacing removals or newer chips", async () => {
  const { home, repo } = seedHome(); const { app, page } = await launch(home);
  try {
    const id = await createThread(page, "existing");
    await drop(page, ["old.md"]); await expect(chips(page)).toHaveCount(1);
    await hold(app, "attachments:stage");
    await drop(page, ["late.md"]); await expect.poll(() => pending(app)).toBe(1);
    await page.keyboard.press("Meta+n");
    await expect(tid(page, "draft-view")).toBeVisible();
    await tid(page, "composer-input").fill("another composer is usable");
    await expect(tid(page, "send")).toBeEnabled();
    await page.locator(`[data-thread-id="${id}"]`).click();
    await tid(page, "composer-input").fill("original composer");
    await expect(tid(page, "send")).toBeDisabled();
    await tid(chips(page).first(), "attachment-remove").click();
    await drop(page, ["new.md"]); await expect.poll(() => pending(app)).toBe(1);
    // Byte staging is serialized; the newer file stays reserved until the held one settles.
    await release(app); await expect(chips(page)).toHaveCount(1);
    await expect(chips(page).first()).toContainText("late.md");
    await expect.poll(() => pending(app)).toBe(1);
    await release(app); await expect(chips(page)).toHaveCount(2);
    await expect(chips(page)).toHaveText([/late.md/, /new.md/]);
    await expect(tid(page, "send")).toBeEnabled();
    expect(fs.readdirSync(path.join(home, "attachments", "staging"))).toHaveLength(2);
  } finally { await app.close(); fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(repo, { recursive: true, force: true }); }
});

test("failed early send keeps its 19-file reservation across remount and restores alongside newer input", async () => {
  const { home, repo } = seedHome(); const { app, page } = await launch(home);
  try {
    const id = await createThread(page, "existing");
    await drop(page, Array.from({ length: 19 }, (_, i) => `old${i}.md`)); await expect(chips(page)).toHaveCount(19);
    await hold(app, "thread:send", true);
    await tid(page, "composer-input").fill("old text"); await tid(page, "send").click();
    await expect.poll(() => pending(app)).toBe(1);
    await page.keyboard.press("Meta+n"); await page.locator(`[data-thread-id="${id}"]`).click();
    await tid(page, "composer-input").fill("newer text");
    await tid(page, "composer-input").press("Meta+Enter");
    await expect.poll(() => pending(app)).toBe(1);
    await drop(page, ["new.md", "overflow.md"]); await expect(chips(page)).toHaveCount(1);
    await expect(tid(page, "attach-warning")).toContainText("20");
    await release(app); await expect(chips(page)).toHaveCount(20);
    await expect(tid(page, "composer-input")).toHaveValue("newer text");
    await expect(tid(page, "toast-retry")).toHaveCount(0);
    await expect(tid(page, "send")).toBeEnabled();
    expect(fs.readdirSync(path.join(home, "attachments", "staging"))).toHaveLength(20);
    // Retry only through the restored composer, so the held retry owns capacity after remount.
    await tid(page, "send").click(); await expect.poll(() => pending(app)).toBe(1);
    await page.keyboard.press("Meta+n"); await page.locator(`[data-thread-id="${id}"]`).click();
    await tid(page, "composer-input").fill("typing during retry");
    await expect(tid(page, "send")).toBeDisabled();
    await tid(page, "send").dispatchEvent("click");
    await tid(page, "composer-input").press("Enter");
    await tid(page, "composer-input").press("Meta+Enter");
    await expect.poll(() => pending(app)).toBe(1);
    await release(app); await expect(chips(page)).toHaveCount(20);
    await expect(tid(page, "composer-input")).toHaveValue("typing during retry");
    await expect(tid(page, "toast-retry")).toHaveCount(0);
  } finally { await app.close(); fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(repo, { recursive: true, force: true }); }
});

test("overlapping file arrivals reserve at most 20 slots before their IPC calls finish", async () => {
  const { home, repo } = seedHome(); const { app, page } = await launch(home);
  try {
    await hold(app, "attachments:stage");
    await drop(page, Array.from({ length: 19 }, (_, i) => `held${i}.md`));
    await expect.poll(() => pending(app)).toBe(1);
    await drop(page, ["new.md", "overflow1.md", "overflow2.md"]);
    await expect.poll(() => pending(app)).toBe(1);
    await release(app); // first file from the 19-file batch
    await expect.poll(() => pending(app)).toBe(1);
    await release(app); // overlapping single file gets the next bounded upload slot
    await expect(chips(page)).toHaveCount(1);
    await expect(tid(page, "send")).toBeDisabled();
    for (let i = 0; i < 18; i++) { await expect.poll(() => pending(app)).toBe(1); await release(app); }
    await expect(chips(page)).toHaveCount(20);
    await expect(tid(page, "attach-warning")).toContainText("2 left out");
    await expect(tid(page, "send")).toBeEnabled();
    expect(fs.readdirSync(path.join(home, "attachments", "staging"))).toHaveLength(20);
  } finally { await app.close(); fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(repo, { recursive: true, force: true }); }
});

test("native picker limits 21 files and nearly-full drafts; Plus menu works with keyboard", async () => {
  const { home, repo } = seedHome(); const { app, page } = await launch(home);
  try {
    const files = Array.from({ length: 21 }, (_, i) => path.join(repo, `pick${i}.md`));
    for (const file of files) fs.writeFileSync(file, file);
    // Explicit paths and malformed capacities remain whole-request errors at the main boundary.
    const rejected = await page.evaluate(async files => {
      const invoke = window.modex!.invoke;
      return Promise.all([
        invoke("attachments:pick", { paths: files }),
        invoke("attachments:pick", { paths: files.slice(0, 2), remaining: 1 }),
        invoke("attachments:pick", { remaining: -1 }),
        invoke("attachments:pick", { remaining: 21 }),
        invoke("attachments:pick", { remaining: 1.5 }),
      ]);
    }, files);
    for (const result of rejected) { expect(result.staged).toHaveLength(0); expect(result.errors).toHaveLength(1); }
    expect(fs.readdirSync(path.join(home, "attachments", "staging"))).toHaveLength(0);
    await app.evaluate(({ dialog }, files) => { dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: files })) as typeof dialog.showOpenDialog; }, files);
    await tid(page, "composer-plus").focus(); await page.keyboard.press("Enter");
    const option = page.getByRole("menuitem", { name: "Attach files", exact: true });
    await expect(option).toBeVisible(); await option.focus(); await expect(option).toBeFocused(); await page.keyboard.press("Enter");
    await expect(chips(page)).toHaveCount(20); await expect(tid(page, "attach-warning")).toContainText("20");
    await tid(chips(page).first(), "attachment-remove").click(); await expect(chips(page)).toHaveCount(19);
    await tid(page, "composer-attach").click(); await expect(chips(page)).toHaveCount(20);
    await expect.poll(() => fs.readdirSync(path.join(home, "attachments", "staging")).length).toBe(20);
  } finally { await app.close(); fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(repo, { recursive: true, force: true }); }
});

test("composer is 960 by 109 wide and stays contained at 900", async () => {
  const { home, repo } = seedHome(); const { app, page } = await launch(home);
  try {
    await resizeWindow(app, page, 1728, 1044);
    const wide = await tid(page, "composer-box").boundingBox();
    expect(wide!.width).toBe(960); expect(wide!.height).toBe(109);
    await resizeWindow(app, page, 900, 760);
    const main = (await tid(page, "main").boundingBox())!; const small = (await tid(page, "composer-box").boundingBox())!;
    expect(main.width).toBeGreaterThanOrEqual(350);
    expect(small.x).toBeGreaterThanOrEqual(main.x); expect(small.x + small.width).toBeLessThanOrEqual(main.x + main.width);
    await expect(tid(page, "attachment-dropzone")).toBeVisible();
  } finally { await app.close(); fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(repo, { recursive: true, force: true }); }
});
