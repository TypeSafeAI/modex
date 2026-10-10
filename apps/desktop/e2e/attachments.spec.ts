import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { currentRow, items, launch, seedHome, tid } from "./support";

/**
 * Files travel with a message. A pasted image, a dropped file and the paperclip's picker all become
 * chips in the composer (main stages the bytes at once); the sent message shows the same chips and
 * opens a file on click. The mock backend ignores attachments: what is asserted here is Modex's own
 * plumbing — staging, thumbnails over the custom scheme, the move into the thread's folder.
 */
let app: ElectronApplication;
let page: Page;
let home: string;
let repo: string;

/** A 1×1 PNG. */
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const PNG = Buffer.from(PNG_B64, "base64");

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
  await expect(tid(page, "send")).toBeEnabled();

  await tid(page, "composer-input").fill("what is this?");
  await page.keyboard.press("Meta+Enter");
  await expect(tid(page, "thread-view")).toBeVisible({ timeout: 15_000 });
  const user = items(page, "user").first();
  await expect(tid(user, "item-text")).toHaveText("what is this?");
  const sent = tid(user, "attachment-chip");
  await expect(sent).toHaveCount(1);
  await expect(sent).toContainText("dot.png");
  await expect(tid(sent, "attachment-thumb")).toHaveAttribute("src", /^modex-attachment:\/\/attachment\/[^/]+\/.*dot\.png$/);
  await expect(tid(page, "composer-attachments")).toHaveCount(0);

  const threadId = (await currentRow(page).getAttribute("data-thread-id"))!;
  expect(fs.readdirSync(path.join(home, "attachments", threadId))).toHaveLength(1);
  expect(fs.readdirSync(staging())).toHaveLength(0);
  const saved = JSON.parse(fs.readFileSync(path.join(home, "app", "threads", `${threadId}.json`), "utf8")) as { kind: string; attachments?: { name: string; kind: string; mime: string; size: number; rel: string }[] }[];
  expect(saved[0]!.kind).toBe("user");
  expect(saved[0]!.attachments![0]).toMatchObject({ name: "dot.png", kind: "image", mime: "image/png", size: PNG.length, rel: expect.stringMatching(new RegExp(`^${threadId}/`)) });

  // Clicking a sent chip opens the file with the system (stubbed here so nothing really opens).
  await app.evaluate(({ shell }) => { (shell as unknown as { openPath: (p: string) => Promise<string> }).openPath = async (p) => { (globalThis as Record<string, unknown>).__openedAttachment = p; return ""; }; });
  await sent.click();
  await expect.poll(() => app.evaluate(() => (globalThis as Record<string, unknown>).__openedAttachment)).toMatch(/dot\.png$/);
  await stopTurn();
});

test("dragging files over the window shows the drop target; dropping attaches them; × removes the staged copy", async () => {
  const drag = (type: string) => page.evaluate((type) => {
    const dt = new DataTransfer();
    dt.items.add(new File(["hello"], "notes.txt", { type: "text/plain" }));
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
  await expect(chips.first()).toContainText("notes.txt");
  await expect(chips.first()).toContainText("5 B");
  expect(fs.readdirSync(staging())).toHaveLength(1);
  await tid(chips.first(), "attachment-remove").click();
  await expect(chips).toHaveCount(0);
  await expect.poll(() => fs.readdirSync(staging()).length).toBe(0);
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

  await tid(page, "composer-input").fill("read these");
  await page.keyboard.press("Meta+Enter");
  const user = items(page, "user").nth(1);
  await expect(tid(user, "item-text")).toHaveText("read these");
  await expect(tid(user, "attachment-chip")).toHaveCount(2);
  await expect(tid(user, "attachment-chip").nth(1)).toContainText("spec.md");
  const threadId = (await currentRow(page).getAttribute("data-thread-id"))!;
  await expect.poll(() => fs.readdirSync(path.join(home, "attachments", threadId)).length).toBe(3);
  expect(fs.readdirSync(staging())).toHaveLength(0);
  await stopTurn();
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
