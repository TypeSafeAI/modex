import { test, expect, type Page } from "@playwright/test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { launch, seedHome, tid } from "./support.js";

// LM-4 (#381), LM Studio first: Settings → Local models and the model menu's local section, through the
// production preload, IPC, store and HTTP transport. Only the runtime is synthetic: an LM Studio-shaped
// server on loopback that records every request, so the spec can show that listing models never loads
// one, downloads one or asks it anything.
function lmStudio() {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    if (req.method !== "GET" || req.url !== "/api/v0/models") { res.writeHead(404); res.end(); return; }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ data: [
      { id: "qwen/qwen3.8-27b", type: "llm", state: "not-loaded", max_context_length: 40960, capabilities: ["tool_use"] },
      { id: "text-embedding-nomic-embed-text-v1.5", type: "embeddings", state: "not-loaded" },
    ] }));
  });
  return {
    hits,
    start: () => new Promise<string>(resolve => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`))),
    stop: () => { server.closeAllConnections(); server.close(); },
  };
}

/** A loopback port nothing listens on. */
async function closedPort(): Promise<string> {
  const probe = http.createServer();
  await new Promise<void>(resolve => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

async function openLocalSettings(page: Page) {
  await tid(page, "open-settings").click();
  await page.getByRole("button", { name: "Local models" }).click();
  await expect(tid(page, "settings-local-section")).toBeVisible();
}

test("Settings adds an LM Studio server, lists its models without loading one, and removes it", async () => {
  const runtime = lmStudio();
  const url = await runtime.start();
  const { home } = seedHome();
  const { app, page } = await launch(home);
  try {
    await openLocalSettings(page);
    // No server yet: the form opens with LM Studio's defaults.
    await expect(tid(page, "local-runtime")).toHaveValue("lmstudio");
    await expect(tid(page, "local-label")).toHaveValue("LM Studio");
    await expect(tid(page, "local-url")).toHaveValue("http://127.0.0.1:1234");
    await expect(tid(page, "settings-local-section")).toContainText("Checking models reads metadata only");
    await tid(page, "local-url").fill(url);
    await tid(page, "local-add").click();

    const card = tid(page, "local-connection");
    await expect(card).toHaveCount(1);
    await expect(card).toHaveAttribute("data-state", "ready");
    await expect(tid(card, "local-connection-status")).toHaveText("Answered · 1 coding candidate");
    await expect(tid(card, "local-model")).toHaveText(["qwen/qwen3.8-27b · not loaded · server advertises 40K context · server advertises tool use · coding capability unverified"]);
    await expect(tid(card, "local-unusable")).toContainText("text-embedding-nomic-embed-text-v1.5 (embedding model)");
    // Listing is one metadata request: no load, chat, completion or download endpoint was touched.
    expect(runtime.hits).toEqual(["GET /api/v0/models"]);

    // A server that is not running is shown as such, with what to do.
    await tid(page, "local-add-open").click();
    await tid(page, "local-label").fill("LM Studio (stopped)");
    await tid(page, "local-url").fill(await closedPort());
    await tid(page, "local-add").click();
    const stopped = tid(page, "local-connection").filter({ hasText: "LM Studio (stopped)" });
    await expect(stopped).toHaveAttribute("data-state", "unavailable");
    await expect(tid(stopped, "local-connection-reason")).toContainText(/Start the server|did not answer/);

    // Refresh lists again; Remove asks first and then deletes the profile in main.
    await tid(card.first(), "local-refresh").click();
    await expect.poll(() => runtime.hits.length).toBe(2);
    page.once("dialog", dialog => void dialog.accept());
    await tid(stopped, "local-remove").click();
    await expect(tid(page, "local-connection")).toHaveCount(1);
    const listed = await page.evaluate(() => window.modex!.invoke("local-models:command", { op: "list" }));
    expect(listed.op === "list" && listed.connections.map(c => c.label)).toEqual(["LM Studio"]);
    expect(runtime.hits.every(hit => hit === "GET /api/v0/models")).toBe(true);
  } finally {
    await app.close();
    runtime.stop();
  }
});

test("the model menu lists LM Studio's models by server and offers context windows within the advertised maximum", async () => {
  const runtime = lmStudio();
  const url = await runtime.start();
  const { home } = seedHome();
  const { app, page } = await launch(home);
  try {
    await page.evaluate(u => window.modex!.invoke("local-models:command", { op: "create", input: { label: "LM Studio", runtime: "lmstudio", url: u } }), url);
    const threadsBefore = (await page.evaluate(() => window.modex!.invoke("state:get", undefined))).threads.length;
    await tid(page, "model-picker").click();
    const section = tid(page, "model-local-section");
    await expect(section).toBeVisible();
    const group = tid(section, "model-local-group");
    await expect(group).toContainText("LM Studio");
    await expect(group).toContainText("reachable");
    // Only the generative model is offered; the embedding model is not.
    await expect(tid(group, "model-local-title")).toHaveText(["qwen/qwen3.8-27b"]);
    await tid(group, "model-local-option").click();
    const context = tid(page, "model-local-context");
    // 40,960 advertised: 8K, 16K, 32K and the maximum itself, nothing larger.
    await expect(context.getByRole("menuitemradio")).toHaveText(["8K", "16K", "32K", "40K"]);

    // A draft with text cannot become a local thread: nothing typed may have been meant for the cloud.
    await page.keyboard.press("Escape");
    await tid(page, "composer-input").fill("hello");
    await tid(page, "model-picker").click();
    await expect(tid(page, "model-local-blocked")).toContainText("Choose a local model before typing");
    await expect(tid(page, "model-local-option")).toBeDisabled();
    await page.keyboard.press("Escape");
    await tid(page, "composer-input").fill("");

    // This product candidate keeps execution unadmitted; selection must refuse and remove its empty thread.
    await tid(page, "model-picker").click();
    await tid(page, "model-local-option").click();
    await tid(page, "model-local-context").getByRole("menuitemradio", { name: /32,768/ }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Local execution is unavailable." })).toBeVisible();
    await expect.poll(async () => (await page.evaluate(() => window.modex!.invoke("state:get", undefined))).threads.length).toBe(threadsBefore);
    expect((await page.evaluate(() => window.modex!.invoke("state:get", undefined))).threads.some(t => t.localTarget !== undefined)).toBe(false);
    expect(runtime.hits.every(hit => hit === "GET /api/v0/models")).toBe(true);

    // Manage opens Settings on Local models.
    await page.keyboard.press("Escape");
    await tid(page, "model-picker").click();
    await tid(page, "model-local-manage").click();
    await expect(tid(page, "settings-local-section")).toBeVisible();
  } finally {
    await app.close();
    runtime.stop();
  }
});
