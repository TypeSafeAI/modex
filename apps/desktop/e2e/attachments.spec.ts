import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { currentRow, items, launch, seedHome, tid } from "./support";

/**
 * Files travel with a message. A pasted image, a dropped file and the paperclip's picker all become
 * chips in the composer (main stages the bytes at once); the sent message shows the same chips and
 * reveals a file on click. The mock backend ignores attachments: what is asserted here is Modex's own
 * plumbing — staging, thumbnails over the custom scheme, and the claimed thread copy.
 */
let app: ElectronApplication;
let page: Page;
let home: string;
let repo: string;

/** A 1×1 PNG. */
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const PNG = Buffer.from(PNG_B64, "base64");

const nativeDrafts = process.platform !== "win32";
const savedDraftFiles = (): Array<{ name: string; rel: string }> => {
  const saved = JSON.parse(fs.readFileSync(path.join(home, "app/update-recovery.json"), "utf8"));
  return [...saved.drafts.threads, ...saved.drafts.projects].flatMap(row => row.attachments);
};
async function expectNoEditableFiles() {
  await expect.poll(savedDraftFiles).toEqual([]);
  await expect.poll(() => fs.readdirSync(path.join(home, "app/pending-sends"))).toEqual([]);
}
const staging = () => path.join(home, "attachments", "staging");
const composerChips = () => tid(tid(page, "composer-attachments"), "attachment-chip");

/** Stops the scripted turn the way createThread does: ⌘. until the thread is idle. */
async function stopTurn() {
  const status = currentRow(page);
  await expect(status).toHaveAttribute("data-status", /running|waiting|idle/);
  await expect(async () => {
    if ((await status.getAttribute("data-status")) !== "idle") await page.keyboard.press("Meta+.");
    await expect(status).toHaveAttribute("data-status", "idle", { timeout: 2_000 });
  }).toPass({ timeout: 15_000 });
}

test.beforeAll(async () => {
  ({ home, repo } = seedHome());
  ({ app, page } = await launch(home));
  console.log(JSON.stringify({ fixture: "attachments", home, repo, pid: app.process().pid }));
  await page.keyboard.press("Meta+n");
  await expect(tid(page, "draft-view")).toBeVisible();
  await expect(tid(page, "composer-input")).toBeFocused();
});

test.afterAll(async () => {
  await app?.close();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

test("a pasted image becomes a chip with a live thumbnail, enables Send on its own, and goes out with the message", async () => {
  await page.evaluate((b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], "dot.png", { type: "image/png" }));
    document.querySelector('[data-testid="composer-input"]')!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, PNG_B64);
  const chips = composerChips();
  await expect(chips).toHaveCount(1);
  await expect(chips.first()).toHaveAttribute("data-kind", "image");
  await expect(chips.first()).toContainText("dot.png");
  await expect(chips.first()).toContainText(`${PNG.length} B`);
  const thumb = tid(chips.first(), "attachment-thumb");
  await expect(thumb).toHaveAttribute("src", /^modex-attachment:\/\/attachment\/staging\//);
  // The thumbnail really loaded: main served the staged file over the custom scheme.
  await expect.poll(() => thumb.evaluate((img) => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth)).toBe(1);
  expect(fs.readdirSync(staging())).toHaveLength(1);
  const stagedImage = path.join(staging(), fs.readdirSync(staging())[0]!);
  await expect(tid(page, "send")).toBeEnabled();

  await page.keyboard.press("Meta+Enter");
  await expect(tid(page, "thread-view")).toBeVisible({ timeout: 15_000 });
  const user = items(page, "user").first();
  await expect(tid(user, "item-text")).toHaveCount(0);
  const sent = tid(user, "attachment-chip");
  await expect(sent).toHaveCount(1);
  await expect(sent).toContainText("dot.png");
  await expect(tid(sent, "attachment-thumb")).toHaveAttribute("src", /^modex-attachment:\/\/attachment\/[^/]+\/.*dot\.png$/);
  await expect(tid(page, "composer-attachments")).toHaveCount(0);

  const threadId = (await currentRow(page).getAttribute("data-thread-id"))!;
  expect(fs.readdirSync(path.join(home, "attachments", threadId))).toHaveLength(1);
  if (nativeDrafts) {
    await expectNoEditableFiles();
    expect(fs.readFileSync(stagedImage)).toEqual(PNG); // The original copy remains recovery evidence.
  } else expect(fs.readdirSync(staging())).toHaveLength(0);
  expect(fs.readFileSync(path.join(home, "attachments", threadId, fs.readdirSync(path.join(home, "attachments", threadId))[0]!))).toEqual(PNG);
  const saved = JSON.parse(fs.readFileSync(path.join(home, "app", "threads", `${threadId}.json`), "utf8")) as { kind: string; attachments?: { name: string; kind: string; mime: string; size: number; rel: string }[] }[];
  expect(saved[0]!.kind).toBe("user");
  expect(saved[0]!.attachments![0]).toMatchObject({ name: "dot.png", kind: "image", mime: "image/png", size: PNG.length, rel: expect.stringMatching(new RegExp(`^${threadId}/`)) });

  // Clicking reveals the file; executing it with its default app is forbidden (including forged image MIME).
  await app.evaluate(({ shell }) => {
    shell.showItemInFolder = (p) => { (globalThis as Record<string, unknown>).__openedAttachment = p; };
    shell.openPath = async (p) => { (globalThis as Record<string, unknown>).__executedAttachment = p; return ""; };
  });
  await sent.click();
  await expect.poll(() => app.evaluate(() => (globalThis as Record<string, unknown>).__openedAttachment)).toMatch(/dot\.png$/);
  expect(await app.evaluate(() => (globalThis as Record<string, unknown>).__executedAttachment)).toBeUndefined();
  await stopTurn();
  if (nativeDrafts) {
    await page.reload();
    await expect(tid(page, "thread-view")).toHaveAttribute("data-thread-id", threadId);
    await expect(composerChips()).toHaveCount(0);
    await expect(tid(items(page, "user").first(), "attachment-chip")).toContainText("dot.png");
  }
});

test("dragging files over the window shows the drop target; dropping attaches them; × removes the draft attachment", async () => {
  const stagedBefore = fs.readdirSync(staging());
  const drag = (type: string) => page.evaluate((type) => {
    const dt = new DataTransfer();
    dt.items.add(new File(["hello"], "reference.md", { type: "text/plain" }));
    window.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, type);
  await drag("dragenter");
  await expect(tid(page, "drop-overlay")).toBeVisible();
  await expect(tid(page, "drop-overlay")).toContainText("Drop to attach");
  await drag("dragleave");
  await expect(tid(page, "drop-overlay")).toHaveCount(0);
  await drag("dragenter");
  await drag("drop");
  await expect(tid(page, "drop-overlay")).toHaveCount(0);
  const chips = composerChips();
  await expect(chips).toHaveCount(1);
  await expect(chips.first()).toHaveAttribute("data-kind", "file");
  await expect(chips.first()).toContainText("reference.md");
  await expect(chips.first()).toContainText("5 B");
  const added = fs.readdirSync(staging()).filter(name => !stagedBefore.includes(name));
  expect(added).toHaveLength(1);
  const stagedFile = path.join(staging(), added[0]!);
  expect(fs.readFileSync(stagedFile, "utf8")).toBe("hello");
  await tid(chips.first(), "attachment-remove").click();
  await expect(chips).toHaveCount(0);
  if (nativeDrafts) {
    await expectNoEditableFiles();
    expect(fs.readFileSync(stagedFile, "utf8")).toBe("hello");
    await page.reload();
    await expect(tid(page, "thread-view")).toBeVisible();
    await expect(composerChips()).toHaveCount(0);
    expect(savedDraftFiles()).toEqual([]);
  } else await expect.poll(() => fs.readdirSync(staging()).length).toBe(0);
  // Text dragged in is not a file drop.
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData("text/plain", "just words");
    window.dispatchEvent(new DragEvent("dragenter", { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await expect(tid(page, "drop-overlay")).toHaveCount(0);
});

test("the paperclip's picker attaches files by path, reports an over-limit file, and the rest are sent together", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "modex-e2e-att-"));
  const img = path.join(dir, "shot.png");
  const doc = path.join(dir, "spec.md");
  const big = path.join(dir, "dump.bin");
  fs.writeFileSync(img, PNG);
  fs.writeFileSync(doc, "# spec\n");
  fs.writeFileSync(big, Buffer.alloc(26 * 1024 * 1024));
  await app.evaluate(({ dialog }, paths) => { (dialog as unknown as { showOpenDialog: () => Promise<unknown> }).showOpenDialog = async () => ({ canceled: false, filePaths: paths }); }, [img, doc, big]);
  await tid(page, "composer-attach").click();
  const chips = composerChips();
  await expect(chips).toHaveCount(2);
  await expect(chips.nth(0)).toHaveAttribute("data-kind", "image");
  await expect(chips.nth(1)).toHaveAttribute("data-kind", "file");
  await expect(chips.nth(1)).toContainText("spec.md");
  await expect(tid(page, "attach-warning")).toContainText("dump.bin is 26 MB; the limit for files is 25 MB.");
  await tid(page, "attach-warning").getByRole("button", { name: "Dismiss" }).click();
  await expect(tid(page, "attach-warning")).toHaveCount(0);

  let stagedFiles: Array<{ name: string; rel: string }> = [];
  if (nativeDrafts) {
    await expect.poll(savedDraftFiles).toHaveLength(2);
    stagedFiles = savedDraftFiles();
  }
  await tid(page, "composer-input").fill("read these");
  await page.keyboard.press("Meta+Enter");
  const user = items(page, "user").nth(1);
  await expect(tid(user, "item-text")).toHaveText("read these");
  await expect(tid(user, "attachment-chip")).toHaveCount(2);
  await expect(tid(user, "attachment-chip").nth(1)).toContainText("spec.md");
  const threadId = (await currentRow(page).getAttribute("data-thread-id"))!;
  await expect.poll(() => fs.readdirSync(path.join(home, "attachments", threadId)).length).toBe(3);
  if (nativeDrafts) {
    await expectNoEditableFiles();
    for (const file of stagedFiles) expect(fs.readFileSync(path.join(home, "attachments", file.rel))).toEqual(file.name === "shot.png" ? PNG : Buffer.from("# spec\n"));
  } else expect(fs.readdirSync(staging())).toHaveLength(0);
  await expect(tid(page, "composer-attach")).toBeDisabled();
  await tid(page, "composer-plus").click();
  await expect(page.getByRole("menuitem", { name: "Attach files", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  await stopTurn();
  if (nativeDrafts) {
    await page.reload();
    await expect(tid(page, "thread-view")).toHaveAttribute("data-thread-id", threadId);
    await expect(composerChips()).toHaveCount(0);
    await expect(items(page, "user")).toHaveCount(2);
    await expect(tid(items(page, "user").nth(1), "attachment-chip")).toHaveText([/shot.png/, /spec.md/]);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("attachments are disabled while the thread works, and the chips survive switching threads", async () => {
  // Attach, then move to a new draft and back: the chip is still there.
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(["x"], "keep.txt", { type: "text/plain" }));
    window.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await expect(composerChips()).toHaveCount(1);
  const threadId = (await currentRow(page).getAttribute("data-thread-id"))!;
  await page.keyboard.press("Meta+n");
  await expect(tid(page, "draft-view")).toBeVisible();
  await expect(composerChips()).toHaveCount(0);
  await page.locator(`[data-testid="thread-row"][data-thread-id="${threadId}"]`).click();
  await expect(tid(page, "thread-view")).toBeVisible();
  await expect(composerChips()).toHaveCount(1);
  await expect(composerChips().first()).toContainText("keep.txt");
  await tid(composerChips().first(), "attachment-remove").click();
  await expect(composerChips()).toHaveCount(0);
});


test("a forged image script chip is revealed and never executed", async () => {
  await app.evaluate(({ shell }) => {
    (globalThis as Record<string, unknown>).__executedAttachment = undefined;
    shell.showItemInFolder = p => { (globalThis as Record<string, unknown>).__openedAttachment = p; };
    shell.openPath = async p => { (globalThis as Record<string, unknown>).__executedAttachment = p; return ""; };
  });
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(["#!/bin/sh\necho should-not-run"], "forged-image.sh", { type: "image/png" }));
    window.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await expect(composerChips()).toHaveCount(1);
  await expect(tid(page, "send")).toBeEnabled();
  await tid(page, "send").click();
  const sent = items(page, "user").getByTestId("attachment-chip").filter({ hasText: "forged-image.sh" });
  await expect(sent).toContainText("forged-image.sh");
  await sent.click();
  await expect.poll(() => app.evaluate(() => (globalThis as Record<string, unknown>).__openedAttachment)).toMatch(/forged-image\.sh$/);
  expect(await app.evaluate(() => (globalThis as Record<string, unknown>).__executedAttachment)).toBeUndefined();
  await stopTurn();
});
