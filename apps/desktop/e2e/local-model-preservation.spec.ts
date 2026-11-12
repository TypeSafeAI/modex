// #381 metadata races through production IPC/store/renderer with the existing scripted native fixture.
// These cases request no coding turns and do not qualify ordinary product admission or real models.
import { test, expect, _electron as electron, type ElectronApplication } from "@playwright/test";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import { appDir, seedHome, tid } from "./support.js";

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const sha = (bytes: Buffer) => crypto.createHash("sha256").update(bytes).digest("hex");
async function runtime(model: string) {
  let current = model, hold = false, release: (() => void) | undefined;
  let arrived!: () => void;
  const barrier = new Promise<void>(resolve => { arrived = resolve; });
  const hits: Array<{ method?: string; url?: string; auth: boolean }> = [];
  const server = http.createServer((req, res) => {
    hits.push({ method: req.method, url: req.url, auth: Boolean(req.headers.authorization) });
    req.resume(); res.setHeader("content-type", "application/json");
    const tags = () => res.end(JSON.stringify({ models: [{ name: current, details: { family: "qwen3moe" } }] }));
    if (req.url === "/api/tags") {
      if (hold) { hold = false; release = () => { current = "Late/Alpha:Q4_0"; if (!res.destroyed) tags(); }; arrived(); }
      else tags();
    } else if (req.url === "/api/ps") res.end(JSON.stringify({ models: [] }));
    else if (req.url === "/api/show") res.end(JSON.stringify({ capabilities: ["completion", "tools"], model_info: { "qwen3moe.context_length": 65536 } }));
    else { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { hits, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hold: () => { hold = true; }, barrier, release: () => release?.(), stop: async () => { release?.(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

test("delayed metadata preserves two thread drafts, image bytes, target and search focus", async ({}, testInfo) => {
  const receipt = testInfo.outputPath("local-model-preservation.json");
  expect(fs.existsSync(receipt)).toBe(false);
  const out: Record<string, any> = { startedAt: new Date().toISOString(), gitHeadAtRun: execFileSync("git", ["rev-parse", "HEAD"], { cwd: appDir, encoding: "utf8" }).trim(), scope: "existing temporary-home scripted LocalExecution bootstrap; production IPC/store/renderer; no real model or product admission", state: "started" };
  const persist = () => fs.writeFileSync(receipt, JSON.stringify(out, null, 2) + "\n"); persist();
  let app: ElectronApplication | undefined;
  let alpha: Awaited<ReturnType<typeof runtime>> | undefined, beta: Awaited<ReturnType<typeof runtime>> | undefined;
  try {
    alpha = await runtime("Fixture/Alpha:Q4_0"); beta = await runtime("Fixture/Beta:Q4_0");
    const { home } = seedHome();
    app = await electron.launch({ args: [path.join(appDir, "e2e/fixtures/local-model-preservation.mjs")], cwd: appDir, env: { ...process.env, MODEX_HOME: home, MODEX_E2E: "1", MODEX_E2E_NODE: process.execPath, MODEX_LM_NATIVE_E2E: "", MODEX_LM3_LIVE: "", MODEX_LM3_WIRE: "", MODEX_NO_LOGIN_PATH: "1", TYPESAFE_API_KEY: "", JEV_API_KEY: "" } });
    out.mainPid = app.process().pid; persist();
    const page = await app.firstWindow(); await page.waitForLoadState("domcontentloaded");
    await expect(tid(page, "composer-input")).toBeVisible();
    out.document = await page.evaluate(() => location.href); expect(out.document).toBe(pathToFileURL(path.join(appDir, "dist/renderer/index.html")).href);
    for (const [label, url] of [["Alpha lab", alpha.url], ["Beta lab", beta.url]]) await page.evaluate(({ label, url }) => window.modex!.invoke("local-models:command", { op: "create", input: { label, runtime: "ollama", url } }), { label, url });
    await tid(page, "model-picker").click();
    await tid(page, "model-local-option").filter({ hasText: "Fixture/Beta:Q4_0" }).click();
    await tid(page, "model-local-context").getByRole("menuitemradio", { name: /65,536/ }).click();
    await expect(tid(page, "model-local-badge")).toBeVisible();
    const local = await page.evaluate(async () => (await window.modex!.invoke("state:get", undefined)).threads.find(t => t.localTarget)!);
    expect(local.localTarget?.model.id).toBe("Fixture/Beta:Q4_0");
    out.targetBefore = local.localTarget;
    const cloud = await page.evaluate(() => window.modex!.invoke("thread:create", { projectId: "p1", backend: "mock", mode: "chat" }));
    // Direct thread:create returns to its caller; unlike routine creation it does not broadcast a window refresh.
    await page.reload(); await expect(tid(page, "composer-input")).toBeVisible();
    out.setup = "Reload after direct IPC thread creation before the race; production source unchanged";
    const select = async (id: string) => page.locator(`[data-testid="thread-row"][data-thread-id="${id}"] button.thread-main`).click();
    await select(cloud.id);
    await tid(page, "composer-input").fill("  cloud draft with image\nkept exactly  ");
    await page.evaluate(b64 => {
      const dt = new DataTransfer(); dt.items.add(new File([Uint8Array.from(atob(b64), c => c.charCodeAt(0))], "dot.png", { type: "image/png" }));
      document.querySelector('[data-testid="composer-input"]')!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    }, PNG_B64);
    await expect(tid(tid(page, "composer-attachments"), "attachment-chip")).toContainText("dot.png");
    const staging = path.join(home, "attachments", "staging");
    expect(fs.readdirSync(staging)).toHaveLength(1); const staged = path.join(staging, fs.readdirSync(staging)[0]!);
    out.imageBefore = sha(fs.readFileSync(staged)); expect(out.imageBefore).toBe(sha(Buffer.from(PNG_B64, "base64")));
    await tid(page, "open-settings").click(); await page.getByRole("button", { name: "Local models", exact: true }).click();
    const alphaCard = tid(page, "local-connection").filter({ hasText: "Alpha lab" });
    await expect(alphaCard).toHaveAttribute("data-state", "ready");
    alpha.hold();
    await alphaCard.getByTestId("local-refresh").click();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Alpha refresh did not reach its barrier within 10s")), 10000);
      alpha!.barrier.then(() => { clearTimeout(timer); resolve(); }, error => { clearTimeout(timer); reject(error); });
    });
    await page.keyboard.press("Escape");
    await select(local.id);
    await tid(page, "composer-input").fill("  local draft\nkept separately  ");
    await expect(tid(page, "local-inference-host")).toContainText(beta.url);
    await tid(page, "composer-input").evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(1, 5));
    await tid(page, "model-picker").click();
    const search = page.getByRole("searchbox", { name: "Search models" }); await search.fill("late/ALPHA");
    await search.press("Home"); for (let key = 0; key < 4; key++) await search.press("Shift+ArrowRight");
    expect(await search.evaluate((el: HTMLInputElement) => ({ start: el.selectionStart, end: el.selectionEnd }))).toEqual({ start: 0, end: 4 });
    alpha.release();
    await expect(tid(page, "model-local-title")).toHaveText(["Late/Alpha:Q4_0"]);
    await expect(search).toHaveValue("late/ALPHA"); await expect(search).toBeFocused();
    out.searchSelectionAfter = await search.evaluate((el: HTMLInputElement) => ({ start: el.selectionStart, end: el.selectionEnd }));
    expect(out.searchSelectionAfter).toEqual({ start: 0, end: 4 });
    const after = await page.evaluate(() => window.modex!.invoke("state:get", undefined));
    out.targetAfter = after.threads.find(t => t.id === local.id)!.localTarget; expect(out.targetAfter).toEqual(out.targetBefore);
    expect(after.threads.find(t => t.id === cloud.id)!.localTarget).toBeUndefined();
    await page.keyboard.press("Escape"); await expect(tid(page, "composer-input")).toHaveValue("  local draft\nkept separately  ");
    out.localDraftAfter = await tid(page, "composer-input").inputValue();
    await tid(page, "composer-input").focus();
    out.localSelectionAfter = await tid(page, "composer-input").evaluate((el: HTMLTextAreaElement) => ({ start: el.selectionStart, end: el.selectionEnd }));
    expect(out.localSelectionAfter).toEqual({ start: 1, end: 5 });
    await select(cloud.id); await expect(tid(page, "composer-input")).toHaveValue("  cloud draft with image\nkept exactly  ");
    await expect(tid(tid(page, "composer-attachments"), "attachment-chip")).toContainText("dot.png");
    out.cloudDraftAfter = await tid(page, "composer-input").inputValue();
    out.callCounts = await app.evaluate(() => (globalThis as any).__lm4Calls);
    expect(out.callCounts).toEqual({ localStarts: 0, sends: 0, durableSends: 0, retries: 0 });
    for (const id of [local.id, cloud.id]) expect(await page.evaluate(threadId => window.modex!.invoke("thread:items", { threadId }), id)).toEqual([]);
    out.imageAfter = sha(fs.readFileSync(staged)); expect(out.imageAfter).toBe(out.imageBefore);
    for (const r of [alpha, beta]) expect(r.hits.every(h => !h.auth && ((h.method === "GET" && ["/api/tags", "/api/ps"].includes(h.url!)) || (h.method === "POST" && h.url === "/api/show")))).toBe(true);
    out.state = "passed";
  } catch (error) { out.state = "failed"; out.failure = String(error); throw error; }
  finally {
    alpha?.release();
    out.hits = { alpha: alpha?.hits ?? [], beta: beta?.hits ?? [] };
    try { if (app) { await app.close(); out.appClose = "returned"; } else out.appClose = "no returned handle"; }
    catch (error) { out.state = "close-failed"; out.closeError = String(error); throw error; }
    finally { await Promise.all([alpha, beta].filter((r): r is Awaited<ReturnType<typeof runtime>> => Boolean(r)).map(r => r.stop())); out.finishedAt = new Date().toISOString(); persist(); await testInfo.attach("local-model-preservation.json", { path: receipt, contentType: "application/json" }); }
  }
});
