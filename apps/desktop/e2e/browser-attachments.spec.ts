import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import fs from "node:fs";
import path from "node:path";
import { appDir, seedHome } from "./support";

// A real development browser + HTTP bridge + store. The mock backend is transport evidence only.
let server: ViteDevServer; let context: BrowserContext; let page: Page; let home: string; let repo: string; let origin: string;
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const large = Buffer.alloc(2 * 1024 * 1024, 73);
const chips = () => page.getByTestId("composer-attachments").getByTestId("attachment-chip");
const staging = () => fs.readdirSync(path.join(home, "attachments", "staging"));

test.beforeAll(async ({ browser }) => {
  ({ home, repo } = seedHome());
  const script = path.join(home, "browser-script.json"); fs.writeFileSync(script, JSON.stringify([{ content: "Browser transport complete." }]));
  const stateFile = path.join(home, "app/state.json"); const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  state.settings.mock_script = script; fs.writeFileSync(stateFile, JSON.stringify(state));
  process.env.MODEX_BROWSER_HOME = home; process.env.MODEX_NO_LOGIN_PATH = "1";
  server = await createServer({ configFile: path.join(appDir, "vite.config.ts"), server: { host: "127.0.0.1", port: 0, open: false } });
  await server.listen(); origin = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}`;
  context = await browser.newContext();
  await context.addInitScript(() => {
    const create = URL.createObjectURL.bind(URL); const revoke = URL.revokeObjectURL.bind(URL);
    const state = globalThis as unknown as { attachmentURLs: string[]; revokedAttachmentURLs: string[] };
    state.attachmentURLs = []; state.revokedAttachmentURLs = [];
    URL.createObjectURL = (blob) => { const url = create(blob); state.attachmentURLs.push(url); return url; };
    URL.revokeObjectURL = (url) => { state.revokedAttachmentURLs.push(url); revoke(url); };
  });
  page = await context.newPage(); await page.goto(origin);
  await page.keyboard.press("Meta+n"); await expect(page.getByTestId("draft-view")).toBeVisible();
});
test.afterAll(async () => {
  await context?.close(); await server?.close();
  if (home) fs.rmSync(home, { recursive: true, force: true }); if (repo) fs.rmSync(repo, { recursive: true, force: true });
});

test("development browser attachments: actual picker, paste, drop, remove, authenticated thumbnails and attachment-only send", async () => {
  const image = path.join(repo, "picked.png"); const binary = path.join(repo, "large.bin"); fs.writeFileSync(image, png); fs.writeFileSync(binary, large);
  const imageRequests: { url: string; token?: string }[] = [];
  page.on("request", request => { if (request.url().includes("/__modex/attachments/image")) imageRequests.push({ url: request.url(), token: request.headers()["x-modex-token"] }); });
  const choosing = page.waitForEvent("filechooser"); await page.getByTestId("composer-attach").click();
  await (await choosing).setFiles([image, binary]);
  await expect(chips()).toHaveCount(2);
  const thumb = chips().first().getByTestId("attachment-thumb");
  await expect(thumb).toHaveAttribute("src", /^blob:/);
  await expect.poll(() => thumb.evaluate(img => (img as HTMLImageElement).naturalWidth)).toBe(1);
  const stagedURL = await thumb.getAttribute("src");
  await page.evaluate(b64 => {
    const dt = new DataTransfer(); dt.items.add(new File([Uint8Array.from(atob(b64), c => c.charCodeAt(0))], "pasted.png", { type: "image/png" }));
    document.querySelector('[data-testid="composer-input"]')!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, png.toString("base64"));
  await expect(chips()).toHaveCount(3);
  await page.evaluate(() => {
    const dt = new DataTransfer(); dt.items.add(new File(["drop bytes"], "drop.txt", { type: "text/plain" }));
    window.dispatchEvent(new DragEvent("dragenter", { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await expect(page.getByTestId("drop-overlay")).toBeVisible();
  await page.evaluate(() => {
    const dt = new DataTransfer(); dt.items.add(new File(["drop bytes"], "drop.txt", { type: "text/plain" }));
    window.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await expect(chips()).toHaveCount(4);
  await chips().filter({ hasText: "drop.txt" }).getByRole("button", { name: "Remove drop.txt" }).click();
  await expect(chips()).toHaveCount(3); await expect.poll(() => staging().length).toBe(3);
  await expect(page.getByTestId("send")).toBeEnabled(); await page.getByTestId("send").click();
  const user = page.locator('[data-item-kind="user"]').first();
  await expect(user.getByTestId("attachment-chip")).toHaveCount(3);
  await expect(user.getByTestId("item-text")).toHaveCount(0);
  const sentThumb = user.getByTestId("attachment-thumb").first();
  await expect.poll(() => sentThumb.evaluate(img => (img as HTMLImageElement).naturalWidth)).toBe(1);
  await expect.poll(() => staging().length).toBe(0);
  const state = JSON.parse(fs.readFileSync(path.join(home, "app/state.json"), "utf8"));
  const transcript = JSON.parse(fs.readFileSync(path.join(home, "app/threads", `${state.threads[0].id}.json`), "utf8"));
  const files = transcript.find((item: { kind: string }) => item.kind === "user").attachments;
  for (const file of files) expect(fs.readFileSync(path.join(home, "attachments", file.rel))).toEqual(file.name === "large.bin" ? large : png);
  expect(imageRequests.length).toBeGreaterThanOrEqual(3);
  for (const request of imageRequests) { expect(request.token).toBeTruthy(); expect(request.url).not.toContain(request.token!); }
  await expect.poll(() => page.evaluate(url => (globalThis as unknown as { revokedAttachmentURLs: string[] }).revokedAttachmentURLs.includes(url!), stagedURL)).toBe(true);
});

test("development browser picker cancellation releases the composer reservation", async () => {
  await page.keyboard.press("Meta+n"); await expect(page.getByTestId("draft-view")).toBeVisible();
  await page.getByTestId("composer-input").fill("after cancellation");
  const choosing = page.waitForEvent("filechooser"); await page.getByTestId("composer-attach").click(); await choosing;
  await expect(page.getByTestId("send")).toBeDisabled();
  // The browser emits cancel when its native dialog closes without a selection.
  await page.locator('input[type="file"]').evaluate(input => input.dispatchEvent(new Event("cancel")));
  await expect(page.locator('input[type="file"]')).toHaveCount(0);
  await expect(page.getByTestId("send")).toBeEnabled();
  await expect(chips()).toHaveCount(0); expect(staging()).toHaveLength(0);
});
