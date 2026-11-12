// #381 metadata races through production IPC/store/renderer with the existing scripted native fixture.
// These cases request no coding turns and do not qualify ordinary product admission or real models.
import { test, expect, _electron as electron, type ElectronApplication } from "@playwright/test";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { appDir, seedHome, tid } from "./support.js";

async function runtime(initial: string) {
  let model = initial;
  let arrival: (() => void) | undefined;
  let held: http.ServerResponse | undefined;
  const hits: Array<{ method?: string; url?: string; auth: boolean }> = [];
  const heldReleases: Array<{ model: string; destroyedBeforeRelease: boolean }> = [];
  const server = http.createServer((req, res) => {
    hits.push({ method: req.method, url: req.url, auth: Boolean(req.headers.authorization) }); req.resume();
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/tags") {
      if (arrival) { held = res; const resolve = arrival; arrival = undefined; resolve(); }
      else res.end(JSON.stringify({ models: [{ name: model, details: { family: "qwen3moe" } }] }));
    } else if (req.url === "/api/ps") res.end(JSON.stringify({ models: [] }));
    else if (req.url === "/api/show") res.end(JSON.stringify({ capabilities: ["completion", "tools"], model_info: { "qwen3moe.context_length": 65536 } }));
    else { res.writeHead(404); res.end(); }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const release = (next = model) => {
    model = next;
    if (held) {
      heldReleases.push({ model: next, destroyedBeforeRelease: held.destroyed });
      if (!held.destroyed) held.end(JSON.stringify({ models: [{ name: model, details: { family: "qwen3moe" } }] }));
      held = undefined;
    }
  };
  return { hits, heldReleases, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    hold: () => new Promise<void>(resolve => { arrival = resolve; }), release,
    stop: async () => { release(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
async function arrived(barrier: Promise<void>) {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Metadata barrier did not arrive within 10s")), 10000);
    barrier.then(() => { clearTimeout(timer); resolve(); }, error => { clearTimeout(timer); reject(error); });
  });
}

test("profile form survives metadata and endpoint revision never silently rebinds its thread", async ({}, testInfo) => {
  const receipt = testInfo.outputPath("local-model-profile-revision.json"); expect(fs.existsSync(receipt)).toBe(false);
  const out: Record<string, any> = { startedAt: new Date().toISOString(), gitHeadAtRun: execFileSync("git", ["rev-parse", "HEAD"], { cwd: appDir, encoding: "utf8" }).trim(), state: "started", scope: "scripted temporary-home existing workflow bootstrap; no provider inference or product activation" };
  const persist = () => fs.writeFileSync(receipt, JSON.stringify(out, null, 2) + "\n"); persist();
  let old: Awaited<ReturnType<typeof runtime>> | undefined, replacement: Awaited<ReturnType<typeof runtime>> | undefined;
  let app: ElectronApplication | undefined;
  try {
    old = await runtime("Fixture/Beta:Q4_0"); replacement = await runtime("Replacement/Coder:Q8");
    const { home } = seedHome();
    app = await electron.launch({ args: [path.join(appDir, "e2e/fixtures/local-model-preservation.mjs")], cwd: appDir,
      env: { ...process.env, MODEX_HOME: home, MODEX_E2E: "1", MODEX_E2E_NODE: process.execPath, MODEX_LM_NATIVE_E2E: "", MODEX_LM3_LIVE: "", MODEX_LM3_WIRE: "", MODEX_NO_LOGIN_PATH: "1", TYPESAFE_API_KEY: "", JEV_API_KEY: "" } });
    out.mainPid = app.process().pid; persist();
    const page = await app.firstWindow(); await page.waitForLoadState("domcontentloaded"); await expect(tid(page, "composer-input")).toBeVisible();
    out.document = await page.evaluate(() => location.href); expect(out.document).toBe(pathToFileURL(path.join(appDir, "dist/renderer/index.html")).href);
    const created = await page.evaluate(url => window.modex!.invoke("local-models:command", { op: "create", input: { label: "Beta lab", runtime: "ollama", url } }), old.url);
    expect(created.op).toBe("create");
    await tid(page, "model-picker").click(); await tid(page, "model-local-option").click();
    await tid(page, "model-local-context").getByRole("menuitemradio", { name: /65,536/ }).click();
    await expect(tid(page, "model-local-badge")).toBeVisible();
    const thread = await page.evaluate(async () => (await window.modex!.invoke("state:get", undefined)).threads.find(t => t.localTarget)!);
    out.targetBefore = thread.localTarget;
    await tid(page, "composer-input").fill("  pinned draft\nkeep every byte  ");
    await tid(page, "open-settings").click(); await page.getByRole("button", { name: "Local models", exact: true }).click();
    const card = tid(page, "local-connection"); await expect(card).toHaveAttribute("data-state", "ready");
    const first = old.hold(); await tid(card, "local-refresh").click(); await arrived(first);
    await tid(card, "local-edit").click(); const form = tid(card, "local-edit-form");
    const name = form.getByLabel("Name", { exact: true });
    await name.fill("  Edited Beta  "); await form.getByLabel("Extra model IDs (one per line)").fill("Custom/Exact ID:Q4_0"); await name.focus();
    // Establish the range directly: macOS Home does not move this input caret.
    await name.evaluate((el: HTMLInputElement) => el.setSelectionRange(0, 3));
    out.editSelectionBefore = await name.evaluate((el: HTMLInputElement) => ({ start: el.selectionStart, end: el.selectionEnd }));
    expect(out.editSelectionBefore).toEqual({ start: 0, end: 3 });
    old.release("Late/Beta:Q4_0");
    await expect(tid(card, "local-model")).toContainText("Late/Beta:Q4_0");
    await expect(name).toHaveValue("  Edited Beta  "); await expect(name).toBeFocused();
    out.editSelectionAfter = await name.evaluate((el: HTMLInputElement) => ({ start: el.selectionStart, end: el.selectionEnd }));
    expect(out.editSelectionAfter).toEqual({ start: 0, end: 3 });
    await expect(form.getByLabel("Extra model IDs (one per line)")).toHaveValue("Custom/Exact ID:Q4_0");
    out.editDraftBeforeSave = await name.inputValue();
    const beforeSecond = await app.evaluate(() => (globalThis as any).__lm4DiscoveryStarts.length);
    const second = old.hold(); await tid(card, "local-refresh").click(); await arrived(second);
    const secondStarts = await app.evaluate(({}, arg) => (globalThis as any).__lm4DiscoveryStarts.slice(arg.after).filter((r: any) => r.connection.id === arg.ref.id && r.connection.revision === arg.ref.revision), { after: beforeSecond, ref: out.targetBefore.model.connection });
    expect(secondStarts).toHaveLength(1); out.secondHeldRequestId = secondStarts[0].requestId;
    await form.getByLabel("Address", { exact: true }).fill(replacement.url);
    await form.getByRole("button", { name: "Save connection", exact: true }).click();
    await expect(card).toHaveAttribute("data-state", "ready");
    await expect(tid(card, "local-model")).toContainText(["Replacement/Coder:Q8", "Custom/Exact ID:Q4_0"]);
    old.release("Stale/MustNotAppear");
    await expect.poll(() => app!.evaluate(({}, requestId) => (globalThis as any).__lm4DiscoveryResults.some((r: any) => r.requestId === requestId && r.state === "stale"), out.secondHeldRequestId)).toBe(true);
    out.discoveryResults = await app.evaluate(() => (globalThis as any).__lm4DiscoveryResults);
    out.staleIdAbsentAtCheckedPoint = !(await card.innerText()).includes("Stale/MustNotAppear");
    expect(out.staleIdAbsentAtCheckedPoint).toBe(true);
    const profiles = await page.evaluate(() => window.modex!.invoke("local-models:command", { op: "list" }));
    if (profiles.op !== "list") throw new Error("Expected profile list");
    out.currentConnection = profiles.connections[0]; expect(out.currentConnection.revision).toBe(out.targetBefore.model.connection.revision + 1);
    expect(out.currentConnection.origin).toBe(replacement.url); expect(out.currentConnection.manualModels).toEqual(["Custom/Exact ID:Q4_0"]);
    const state = await page.evaluate(() => window.modex!.invoke("state:get", undefined));
    out.targetAfter = state.threads.find(t => t.id === thread.id)!.localTarget; expect(out.targetAfter).toEqual(out.targetBefore);
    await page.keyboard.press("Escape");
    await expect(tid(page, "composer-input")).toHaveValue("  pinned draft\nkeep every byte  ");
    out.rawDraftAfter = await tid(page, "composer-input").inputValue();
    await expect(tid(page, "local-inference-host")).toContainText("an unavailable local server");
    await expect(tid(page, "local-inference-host")).not.toContainText(replacement.url);
    out.provenanceText = await tid(page, "local-inference-host").innerText();
    out.callCounts = await app.evaluate(() => (globalThis as any).__lm4Calls); expect(out.callCounts).toEqual({ localStarts: 0, sends: 0, durableSends: 0, retries: 0 });
    expect(await page.evaluate(threadId => window.modex!.invoke("thread:items", { threadId }), thread.id)).toEqual([]);
    for (const r of [old, replacement]) expect(r.hits.every(h => !h.auth && ((h.method === "GET" && ["/api/tags", "/api/ps"].includes(h.url!)) || (h.method === "POST" && h.url === "/api/show")))).toBe(true);
    out.state = "passed";
  } catch (error) { out.state = "failed"; out.failure = String(error); throw error; }
  finally {
    old?.release(); out.runtime = { old: { hits: old?.hits ?? [], releases: old?.heldReleases ?? [] }, replacement: { hits: replacement?.hits ?? [] } };
    try { if (app) { await app.close(); out.appClose = "returned"; } else out.appClose = "no returned app handle"; }
    catch (error) { out.state = "close-failed"; out.closeError = String(error); throw error; }
    finally { await Promise.all([old, replacement].filter((r): r is Awaited<ReturnType<typeof runtime>> => Boolean(r)).map(r => r.stop())); out.finishedAt = new Date().toISOString(); persist(); await testInfo.attach("local-model-profile-revision.json", { path: receipt, contentType: "application/json" }); }
  }
});
