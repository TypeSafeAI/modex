import { test, expect, _electron as electron, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { appDir, seedHome, tid } from "./support.js";

// Full app composition with a scripted native transport injected by a temporary-home-only
// bootstrap. This exercises fixture integration, not product admission or a real model.
async function launchFixture(home: string) {
  const app = await electron.launch({ args: [path.join(appDir, "e2e/fixtures/local-model-workflow.mjs")], cwd: appDir,
    env: { ...process.env, MODEX_HOME: home, MODEX_E2E: "1", MODEX_E2E_NODE: process.execPath, MODEX_NO_LOGIN_PATH: "1", TYPESAFE_API_KEY: "", JEV_API_KEY: "" } });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await expect(tid(page, "composer-input")).toBeVisible();
  return { app, page };
}

async function runtime() {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/tags") res.end(JSON.stringify({ models: [{ name: "fixture-coder", details: { family: "qwen3moe" } }] }));
    else if (req.url === "/api/ps") res.end(JSON.stringify({ models: [] }));
    else if (req.url === "/api/show") res.end(JSON.stringify({ capabilities: ["completion", "tools"], model_info: { "qwen3moe.context_length": 65536 } }));
    else { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { hits, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    stop: () => { server.closeAllConnections(); server.close(); } };
}

async function connect(page: Page, url: string) {
  await tid(page, "open-settings").click();
  await page.getByRole("button", { name: "Local models", exact: true }).click();
  await tid(page, "local-runtime").selectOption("ollama");
  await tid(page, "local-label").fill("Ollama fixture");
  await tid(page, "local-url").fill(url);
  await tid(page, "local-add").click();
  await expect(tid(page, "local-connection")).toHaveAttribute("data-state", "ready");
  await page.keyboard.press("Escape");
  await choose(page);
}

async function choose(page: Page) {
  await tid(page, "model-picker").click();
  await tid(page, "model-local-option").click();
  await tid(page, "model-local-context").getByRole("menuitemradio", { name: /65,536/ }).click();
  await expect(tid(page, "model-local-badge")).toHaveText("Ollama");
}

async function send(page: Page, text: string) {
  await tid(page, "composer-input").fill(text);
  await tid(page, "send").click();
}

test("local golden fixture: approved edit, independent check, diff, Stop, continuation, restart and server failure", async () => {
  const r = await runtime();
  const { home, repo } = seedHome();
  fs.writeFileSync(path.join(repo, "greeting.txt"), "hello\n");
  fs.writeFileSync(path.join(repo, "fixture-check.cjs"), `const fs=require('node:fs'); const ok=fs.readFileSync('greeting.txt','utf8')===${JSON.stringify("hello, local\n")}; fs.appendFileSync('checks.txt',String(ok)+${JSON.stringify("\n")}); console.log(ok?'check passed':'check failed'); process.exit(ok?0:1);\n`);

  try {
  let run = await launchFixture(home);
  try {
    await connect(run.page, r.url);
    await expect(tid(run.page, "local-inference-host")).toContainText(r.url);
    await send(run.page, "Edit the greeting and run its check.");
    const approve = run.page.getByRole("button", { name: "Approve", exact: true });
    await expect(approve).toBeVisible();
    expect(fs.readFileSync(path.join(repo, "greeting.txt"), "utf8")).toBe("hello\n");
    await approve.click();
    await expect.poll(() => fs.existsSync(path.join(repo, "checks.txt")) && fs.readFileSync(path.join(repo, "checks.txt"), "utf8")).toBe("true\n");
    await expect(tid(run.page, "stop")).toHaveCount(0);
    expect(fs.readFileSync(path.join(repo, "greeting.txt"), "utf8")).toBe("hello, local\n");
    const state = await run.page.evaluate(() => window.modex!.invoke("state:get", undefined));
    const threadId = state.threads.find(t => t.localTarget)?.id;
    expect(threadId).toBeTruthy();
    const diff = await run.page.evaluate(id => window.modex!.invoke("changes:diff", { threadId: id!, path: "greeting.txt" }), threadId);
    expect(JSON.stringify(diff)).toContain("hello, local");
    await run.page.keyboard.press("Control+Shift+G");
    await tid(run.page, "changes-file").filter({ hasText: "greeting.txt" }).getByRole("button").first().click();
    await expect(tid(run.page, "changes-diff")).toContainText("hello, local");

    await send(run.page, "STOP_FIXTURE");
    await expect.poll(() => fs.existsSync(path.join(repo, "stop-started.txt"))).toBe(true);
    await tid(run.page, "stop").click();
    await expect(tid(run.page, "stop")).toHaveCount(0);
    expect(fs.existsSync(path.join(repo, "late-effect.txt"))).toBe(false);
    await send(run.page, "Continue explicitly.");
    await run.page.getByRole("button", { name: "Approve", exact: true }).click();
    await expect.poll(() => fs.readFileSync(path.join(repo, "edits.txt"), "utf8")).toBe("edit\nedit\n");
    await expect(tid(run.page, "stop")).toHaveCount(0);

    await run.app.close(); run = await launchFixture(home);
    expect(fs.readFileSync(path.join(repo, "edits.txt"), "utf8")).toBe("edit\nedit\n");
    await send(run.page, "An old handle must refuse after restart.");
    await expect(run.page.getByText(/native session is gone/)).toBeVisible();
    expect(fs.readFileSync(path.join(repo, "edits.txt"), "utf8")).toBe("edit\nedit\n");
    await choose(run.page);
    await send(run.page, "SERVER_FAILURE");
    await expect(run.page.getByText(/Local (fixture server unavailable|server reported)/).first()).toBeVisible();
    expect(fs.readFileSync(path.join(repo, "edits.txt"), "utf8")).toBe("edit\nedit\n");
    expect(r.hits.every(hit => /^(GET \/api\/(tags|ps)|POST \/api\/show)$/.test(hit))).toBe(true);
  } finally { await run.app.close(); }
  } finally { r.stop(); }
});

test("editing a connection invalidates its selected revision and cloud return confirms the exact model", async () => {
  const r = await runtime(); const { home } = seedHome();
  try {
  const run = await launchFixture(home);
  try {
    await connect(run.page, r.url);
    await tid(run.page, "open-settings").click();
    await run.page.getByRole("button", { name: "Local models", exact: true }).click();
    await tid(run.page, "local-edit").click();
    await tid(run.page, "local-edit-form").getByLabel("Name", { exact: true }).fill("Renamed fixture");
    await tid(run.page, "local-edit-form").getByLabel("Replacement token (optional)").fill("fixture-token-revision-2");
    await tid(run.page, "local-edit-form").getByRole("button", { name: "Save connection" }).click();
    await expect(tid(run.page, "local-connection")).toContainText("Renamed fixture");
    await pageReady(run.page);
    await send(run.page, "Stale configuration must send nothing.");
    await expect(run.page.getByText(/changed or was deleted|destination changed/).first()).toBeVisible();
    await choose(run.page);
    await tid(run.page, "model-picker").click();
    const dismissed = run.page.waitForEvent("dialog").then(async dialog => {
      expect(dialog.message()).toContain("fixture-cloud"); await dialog.dismiss();
    });
    await tid(run.page, "model-local-clear").click(); await dismissed;
    expect((await run.page.evaluate(() => window.modex!.invoke("state:get", undefined))).threads.some(t => t.localTarget)).toBe(true);
    await tid(run.page, "model-picker").click();
    run.page.once("dialog", dialog => void dialog.accept());
    await tid(run.page, "model-local-clear").click();
    await expect.poll(async () => (await run.page.evaluate(() => window.modex!.invoke("state:get", undefined))).threads.some(t => t.localTarget)).toBe(false);
    expect((await run.page.evaluate(() => window.modex!.invoke("state:get", undefined))).threads[0]?.model).toBe("fixture-cloud");
  } finally { await run.app.close(); }
  } finally { r.stop(); }
});

async function pageReady(page: Page) { await page.keyboard.press("Escape"); await expect(tid(page, "settings")).toHaveCount(0); }
