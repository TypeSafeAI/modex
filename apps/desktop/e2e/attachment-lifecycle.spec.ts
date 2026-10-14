import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { createThread, launch, resizeWindow, seedHome, tid } from "./support";

const nativeDrafts = process.platform !== "win32";
const attachmentChannel = (channel: string) => nativeDrafts ? ({ "attachments:stage": "drafts:stage", "attachments:pick": "drafts:pick", "thread:create": "drafts:create", "thread:send": "drafts:send" } as Record<string, string>)[channel] ?? channel : channel;
const savedPending = (home: string) => {
  const directory = path.join(home, "app/pending-sends");
  return fs.existsSync(directory) ? fs.readdirSync(directory).map(file => JSON.parse(fs.readFileSync(path.join(directory, file), "utf8"))) : [];
};
const savedUsers = (home: string, id: string) => {
  try { return JSON.parse(fs.readFileSync(path.join(home, "app/threads", `${id}.json`), "utf8")).filter((item: any) => item.kind === "user"); }
  catch { return []; }
};
const logFixture = (app: ElectronApplication, home: string, repo: string) => console.log(JSON.stringify({ fixtureHome: home, fixtureRepo: repo, electronPid: app.process().pid }));
const chips = (page: Page) => tid(tid(page, "composer-attachments"), "attachment-chip");
async function drop(page: Page, names: string[]) {
  await expect(tid(page, "composer-input")).toBeVisible();
  await expect.poll(() => page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File([], "ready.md", { type: "text/plain" }));
    const event = new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  }), { message: "Composer must accept file drags before dropping files" }).toBe(true);
  await page.evaluate(names => {
    const dt = new DataTransfer();
    for (const name of names) dt.items.add(new File([`bytes:${name}`], name, { type: "text/plain" }));
    window.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, names);
}
// Hold a real IPC handler before it stages anything; release still exercises actual storage/claims.
async function hold(app: ElectronApplication, channel: string, fail = false) {
  await app.evaluate(({ ipcMain }, { channel, fail, actual }) => {
    const ipc = ipcMain as typeof ipcMain & { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> };
    const original = ipc._invokeHandlers.get(actual)!;
    const waits: Array<() => void> = [];
    Object.assign(globalThis, { attachmentPending: () => waits.length, releaseAttachment: (index = 0) => waits.splice(index, 1)[0]?.() });
    Object.assign(globalThis, { restoreAttachmentHandler: () => { ipcMain.removeHandler(actual); ipcMain.handle(actual, original); } });
    ipcMain.removeHandler(actual);
    ipcMain.handle(actual, (...args) => new Promise((resolve, reject) => waits.push(() => {
      if (fail) reject(new Error(`Synthetic ${channel} rejection`));
      else Promise.resolve(original(...args)).then(resolve, reject);
    })));
  }, { channel, fail, actual: attachmentChannel(channel) });
}
const restoreHandler = (app: ElectronApplication) => app.evaluate(() => (globalThis as any).restoreAttachmentHandler());
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

test("drop waits for startup state and stages its file exactly once", async ({}, testInfo) => {
  const { home, repo } = seedHome(); let { app, page } = await launch(home); logFixture(app, home, repo);
  const staging = path.join(home, "attachments", "staging");
  const stagedFiles = () => fs.existsSync(staging) ? fs.readdirSync(staging) : [];
  let dropping: Promise<void> | undefined;
  try {
    await expect(tid(page, "composer-input")).toBeVisible();
    await hold(app, "state:get");
    await app.evaluate(({ ipcMain }, channel) => {
      const ipc = ipcMain as typeof ipcMain & { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> };
      const original = ipc._invokeHandlers.get(channel)!;
      let calls = 0;
      Object.assign(globalThis, { attachmentStageCalls: () => calls });
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, (...args) => { calls++; return original(...args); });
    }, attachmentChannel("attachments:stage"));
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect.poll(() => pending(app)).toBe(1);
    await expect(tid(page, "composer-input")).toHaveCount(0);
    await page.evaluate(() => {
      let drops = 0;
      window.addEventListener("drop", () => { drops++; });
      Object.assign(window, { attachmentDropCount: () => drops });
    });
    const dropCount = () => page.evaluate(() => (window as unknown as { attachmentDropCount: () => number }).attachmentDropCount());
    const stageCalls = () => app.evaluate(() => (globalThis as unknown as { attachmentStageCalls: () => number }).attachmentStageCalls());
    dropping = drop(page, ["startup.md"]);
    void dropping.catch(() => {}); // Cleanup can close the page while the helper is still waiting.
    // This renderer round trip runs after the old helper's raw drop, with state still held.
    const beforeRelease = { drops: await dropCount(), stageCalls: await stageCalls(), files: stagedFiles() };
    await testInfo.attach("held-startup-state", { body: JSON.stringify(beforeRelease), contentType: "application/json" });
    await release(app);
    await dropping;
    await expect(chips(page)).toHaveCount(1);
    await expect(chips(page).first()).toContainText("startup.md");
    expect(beforeRelease).toEqual({ drops: 0, stageCalls: 0, files: [] });
    expect(await dropCount()).toBe(1);
    expect(await stageCalls()).toBe(1);
    expect(stagedFiles()).toHaveLength(1);
    expect(fs.readFileSync(path.join(staging, stagedFiles()[0]!), "utf8")).toBe("bytes:startup.md");
  } finally {
    await app.close();
    await dropping?.catch(() => {});
    fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("Space visualization appends to the active project's attachment draft", async () => {
  const { home, repo } = seedHome({ theme: "graphite" }); addSecondProject(home);
  let { app, page } = await launch(home); logFixture(app, home, repo);
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
    await page.getByRole("textbox", { name: "Describe a visualization", exact: true }).fill("Show the page structure");
    await page.getByRole("button", { name: "Continue in chat", exact: true }).click();
    await expect(tid(page, "space-chat")).toBeVisible();
    await expect(tid(page, "composer-input")).toHaveValue(/Visualize for project B\n\nCreate an interactive visualization for this page: Show the page structure/);
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
  let { app, page } = await launch(home); logFixture(app, home, repo);
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
  let { app, page } = await launch(home); logFixture(app, home, repo);
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
      await expect(tid(page, "composer-input")).toHaveValue(nativeDrafts ? "" : "first message for A");
      if (nativeDrafts) {
        await expect(chips(page)).toHaveCount(0);
        await expect(tid(page, "pending-message")).toContainText("first message for A");
        expect(savedPending(home)).toHaveLength(1);
        expect(savedPending(home)[0]).toMatchObject({ source: { kind: "project", projectId: "p1" }, rawText: "first message for A", files: [{ name: "A.md" }] });
      } else { await expect(chips(page)).toHaveCount(1); await expect(chips(page).first()).toContainText("A.md"); }
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
  let { app, page } = await launch(home); logFixture(app, home, repo);
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
    if (nativeDrafts) {
      const saved = () => JSON.parse(fs.readFileSync(path.join(home, "app/update-recovery.json"), "utf8"));
      await expect.poll(() => fs.existsSync(path.join(home, "app/update-recovery.json")) ? saved().drafts.projects.flatMap((row: any) => row.attachments) : null).toEqual([]);
      const retained = fs.readdirSync(path.join(home, "attachments/staging"));
      expect(retained).toHaveLength(2); // Revocation preserves evidence; it is not a physical-delete authority.
      for (const file of retained) expect(fs.readFileSync(path.join(home, "attachments/staging", file), "utf8")).toMatch(/^bytes:[AB]\.md$/);
      await page.reload(); await expect(tid(page, "draft-view")).toBeVisible();
      await expect(chips(page)).toHaveCount(0);
      await switchProject(page, "p1"); await expect(chips(page)).toHaveCount(0);
      await switchProject(page, "p2"); await expect(chips(page)).toHaveCount(0);
    } else await expect.poll(() => fs.readdirSync(path.join(home, "attachments", "staging")).length).toBe(0);
  } finally { await app.close(); fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(repo, { recursive: true, force: true }); }
});

for (const existing of [false, true]) test(`${existing ? "thread" : "draft"}: pending stage blocks button and keyboard send; rejection releases it`, async () => {
  const { home, repo } = seedHome(); let { app, page } = await launch(home); logFixture(app, home, repo);
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
  const { home, repo } = seedHome(); let { app, page } = await launch(home); logFixture(app, home, repo);
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

test("failed creation restores files while keeping newer text and other drafts usable", async ({}, testInfo) => {
  const { home, repo } = seedHome(); let { app, page } = await launch(home); logFixture(app, home, repo);
  try {
    await drop(page, ["old.md"]); await expect(chips(page)).toHaveCount(1);
    await hold(app, "thread:create", true);
    await tid(page, "composer-input").fill("old text"); await tid(page, "send").click();
    await expect.poll(() => pending(app)).toBe(1);
    // Main receiving create does not establish that the renderer has released its
    // temporary input hold. Accept one real edit before testing failure recovery.
    const input = tid(page, "composer-input");
    await input.evaluate(element => {
      const events: Array<{ value: string; focused: boolean; inert: boolean; trusted: boolean }> = [];
      Object.assign(window, { heldCreationInputs: events });
      element.addEventListener("input", event => events.push({
        value: (element as HTMLTextAreaElement).value,
        focused: document.activeElement === element,
        inert: Boolean(element.closest("[inert]")), trusted: event.isTrusted,
      }));
    });
    await input.click();
    await expect(input).toBeFocused();
    await input.fill("newer text");
    await expect(input).toHaveValue("newer text");
    const inputs = await page.evaluate(() => (window as unknown as {
      heldCreationInputs: Array<{ value: string; focused: boolean; inert: boolean; trusted: boolean }>;
    }).heldCreationInputs);
    expect(inputs).toContainEqual({ value: "newer text", focused: true, inert: false, trusted: true });
    let savedNewer: string | undefined;
    if (nativeDrafts) {
      const key = savedPending(home)[0].source.key;
      await expect.poll(() => {
        const saved = JSON.parse(fs.readFileSync(path.join(home, "app/update-recovery.json"), "utf8"));
        savedNewer = saved.drafts.projects.find((row: any) => row.key === key)?.text;
        return savedNewer;
      }).toBe("newer text");
    }
    expect(await pending(app)).toBe(1);
    const receipt = testInfo.outputPath("accepted-newer-draft.json");
    fs.mkdirSync(path.dirname(receipt), { recursive: true });
    fs.writeFileSync(receipt, JSON.stringify({ inputs, rawText: await input.inputValue(), savedNewer, heldCreates: 1 }, null, 2));
    await input.press("Meta+Enter");
    await expect.poll(() => pending(app)).toBe(1);
    await release(app);
    if (nativeDrafts) {
      await expect(tid(page, "toast")).toContainText("Synthetic thread:create rejection");
      await expect(chips(page)).toHaveCount(0);
      await expect(tid(page, "composer-input")).toHaveValue("newer text");
      await expect(tid(page, "send")).toBeDisabled();
      const original = savedPending(home)[0];
      expect(original).toMatchObject({ rawText: "old text", files: [{ name: "old.md" }] });
      await tid(page, "pending-message-retry").click(); await expect.poll(() => pending(app)).toBe(1);
      await page.keyboard.press("Meta+n"); await tid(page, "composer-input").fill("another draft");
      await expect(tid(page, "send")).toBeEnabled();
      await release(app); await expect(tid(page, "pending-message-retry")).toBeEnabled();
      expect(savedPending(home)[0].id).toBe(original.id);
      expect(fs.readFileSync(path.join(home, "attachments", original.files[0].rel), "utf8")).toBe("bytes:old.md");
      await app.close(); ({ app, page } = await launch(home)); logFixture(app, home, repo);
      await expect(tid(page, "composer-input")).toHaveValue("another draft");
      await expect(tid(page, "thread-row")).toHaveCount(0);
      expect(savedPending(home)[0].id).toBe(original.id);
      await tid(page, "pending-message-retry").click();
      await expect(tid(page, "thread-row")).toHaveCount(1);
      const id = (await tid(page, "thread-row").getAttribute("data-thread-id"))!;
      await expect.poll(() => savedUsers(home, id)).toMatchObject([{ id: original.id, text: "old text", attachments: [{ name: "old.md" }] }]);
      expect(savedPending(home)).toEqual([]);
      await expect(tid(page, "composer-input")).toHaveValue("another draft");
      await expect(chips(page)).toHaveCount(0);
      await page.evaluate(id => window.modex!.invoke("thread:stop", { threadId: id }), id);
      return;
    }
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
  const { home, repo } = seedHome(); let { app, page } = await launch(home); logFixture(app, home, repo);
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
    if (nativeDrafts) {
      const savedFiles = () => JSON.parse(fs.readFileSync(path.join(home, "app/update-recovery.json"), "utf8")).drafts.threads.find((row: any) => row.threadId === id)?.attachments;
      await expect.poll(() => savedFiles()?.map((file: any) => file.name)).toEqual(["late.md", "new.md"]);
      const retained = fs.readdirSync(path.join(home, "attachments/staging"));
      expect(retained).toHaveLength(3);
      const old = retained.find(file => file.endsWith("-old.md"))!;
      expect(fs.readFileSync(path.join(home, "attachments/staging", old), "utf8")).toBe("bytes:old.md");
      await page.reload(); await expect(chips(page)).toHaveText([/late.md/, /new.md/]);
      expect(savedFiles().map((file: any) => file.name)).toEqual(["late.md", "new.md"]);
    } else expect(fs.readdirSync(path.join(home, "attachments", "staging"))).toHaveLength(2);
  } finally { await app.close(); fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(repo, { recursive: true, force: true }); }
});

test("failed early send keeps its 19-file reservation across remount and restores alongside newer input", async () => {
  const { home, repo } = seedHome(); let { app, page } = await launch(home); logFixture(app, home, repo);
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
    await release(app);
    if (nativeDrafts) {
      await expect(tid(page, "toast")).toContainText("Synthetic thread:send rejection");
      await expect(chips(page)).toHaveCount(1); await expect(chips(page).first()).toContainText("new.md");
      await expect(tid(page, "composer-input")).toHaveValue("newer text");
      await expect(tid(page, "send")).toBeDisabled();
      const original = savedPending(home)[0];
      expect(original.rawText).toBe("old text"); expect(original.files).toHaveLength(19);
      for (const file of original.files) expect(fs.readFileSync(path.join(home, "attachments", file.rel), "utf8")).toBe(`bytes:${file.name}`);
      await tid(page, "pending-message-retry").click(); await expect.poll(() => pending(app)).toBe(1);
      await page.keyboard.press("Meta+n"); await page.locator(`[data-testid="thread-row"][data-thread-id="${id}"] .thread-main`).click();
      await tid(page, "composer-input").fill("typing during retry");
      await expect(tid(page, "send")).toBeDisabled();
      await tid(page, "send").dispatchEvent("click"); await tid(page, "composer-input").press("Meta+Enter");
      await expect.poll(() => pending(app)).toBe(1);
      await release(app); await expect(tid(page, "pending-message-retry")).toBeEnabled();
      expect(savedPending(home)[0].id).toBe(original.id);
      await restoreHandler(app); await app.close(); ({ app, page } = await launch(home)); logFixture(app, home, repo);
      await expect(tid(page, "composer-input")).toHaveValue("typing during retry");
      await expect(chips(page)).toHaveCount(1); await expect(chips(page).first()).toContainText("new.md");
      expect(savedPending(home)[0].id).toBe(original.id);
      expect(savedUsers(home, id).some((row: any) => row.id === original.id)).toBe(false);
      await tid(page, "pending-message-retry").click();
      await expect.poll(() => savedUsers(home, id).filter((row: any) => row.id === original.id)).toHaveLength(1);
      const sent = savedUsers(home, id).find((row: any) => row.id === original.id);
      expect(sent.text).toBe("old text"); expect(sent.attachments).toEqual(original.files);
      await expect(tid(page, "pending-message")).toHaveCount(0);
      await expect(tid(page, "composer-input")).toHaveValue("typing during retry"); await expect(chips(page)).toHaveCount(1);
      await page.evaluate(id => window.modex!.invoke("thread:stop", { threadId: id }), id);
      return;
    }
    await expect(chips(page)).toHaveCount(20);
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
  const { home, repo } = seedHome(); let { app, page } = await launch(home); logFixture(app, home, repo);
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
  const { home, repo } = seedHome(); let { app, page } = await launch(home); logFixture(app, home, repo);
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
    if (nativeDrafts) {
      await expect.poll(() => fs.existsSync(path.join(home, "app/update-recovery.json"))).toBe(true);
      const savedFiles = () => JSON.parse(fs.readFileSync(path.join(home, "app/update-recovery.json"), "utf8")).drafts.projects.flatMap((row: any) => row.attachments);
      await expect.poll(() => savedFiles().length).toBe(20);
      expect(new Set(savedFiles().map((file: any) => file.id)).size).toBe(20);
      for (const file of savedFiles()) expect(fs.readFileSync(path.join(home, "attachments", file.rel), "utf8")).toBe(path.join(repo, file.name));
      await page.reload(); await expect(chips(page)).toHaveCount(20);
    } else await expect.poll(() => fs.readdirSync(path.join(home, "attachments", "staging")).length).toBe(20);
  } finally { await app.close(); fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(repo, { recursive: true, force: true }); }
});

test("composer is 960 by 109 wide and stays contained at 900", async () => {
  const { home, repo } = seedHome(); let { app, page } = await launch(home); logFixture(app, home, repo);
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
