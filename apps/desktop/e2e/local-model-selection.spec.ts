import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { launch, seedHome } from "./support.js";

test("Strata selection keeps an unlisted exact model and clearing it discards local resume", async () => {
  const { home, repo } = seedHome();
  const statePath = path.join(home, "app", "state.json");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  state.threads = [{ id: "local-ui", projectId: "p1", title: "Strata task", cwd: repo, backend: "mock", mode: "chat", plan: false, model: "mock", status: "idle", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }];
  fs.writeFileSync(statePath, JSON.stringify(state));
  const { app, page } = await launch(home);
  try {
    await page.getByText("Strata task", { exact: true }).first().click();
    await page.getByTestId("local-model-controls").getByText("Local model", { exact: true }).click();
    await page.getByLabel("Local server URL").fill("http://127.0.0.1:18501/v1");
    await page.getByLabel("Exact local model ID").fill("qwen3.8-flash-next-iq3_s");
    await page.getByRole("button", { name: "Save and use local model" }).click();
    await expect(page.getByTestId("local-model-active")).toContainText("qwen3.8-flash-next-iq3_s");
    await expect.poll(async () => {
      const saved = await page.evaluate(() => window.modex!.invoke("state:get", undefined));
      return saved.threads.find(t => t.id === "local-ui")?.model;
    }).toBe("qwen3.8-flash-next-iq3_s");
    await page.waitForTimeout(200);
    await expect(page.getByTestId("local-model-active")).toContainText("qwen3.8-flash-next-iq3_s");
    await page.getByRole("button", { name: "Use cloud models" }).click();
    await expect(page.getByTestId("local-model-active")).toHaveCount(0);
    const saved = await page.evaluate(() => window.modex!.invoke("state:get", undefined));
    const thread = saved.threads.find(t => t.id === "local-ui")!;
    expect(thread.localTarget).toBeUndefined();
    expect(thread.sessionHandle).toBeUndefined();
    expect(thread.codexAccount).toBeUndefined();
  } finally { await app.close(); }
});

test("saving local selection blocks Send and its keyboard shortcut before connection creation returns", async () => {
  const { home, repo } = seedHome();
  const file = path.join(home, "app", "state.json");
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  state.threads = [{ id: "selection-race", projectId: "p1", title: "Selection race", cwd: repo, backend: "mock", mode: "chat", plan: false, model: "mock", status: "idle", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }];
  fs.writeFileSync(file, JSON.stringify(state));
  const { app, page } = await launch(home);
  try {
    await app.evaluate(({ ipcMain }) => {
      const ipc = ipcMain as unknown as { _invokeHandlers: Map<string, (...args: any[]) => any> };
      const create = ipc._invokeHandlers.get("local-models:command")!;
      ipcMain.removeHandler("local-models:command");
      ipcMain.handle("local-models:command", async (event, request) => {
        if (request.op === "create") await new Promise<void>(resolve => { (globalThis as any).releaseLocalSelection = resolve; });
        return create(event, request);
      });
    });
    await page.getByText("Selection race", { exact: true }).first().click();
    await page.getByTestId("composer-input").fill("Keep this private fixture unsent");
    await page.getByTestId("local-model-controls").getByText("Local model", { exact: true }).click();
    await page.getByLabel("Local server URL").fill("http://127.0.0.1:18501/v1");
    await page.getByRole("button", { name: "Save and use local model" }).click();
    await expect(page.getByTestId("send")).toBeDisabled();
    await page.getByTestId("composer-input").press("Meta+Enter");
    const items = await page.evaluate(() => window.modex!.invoke("thread:items", { threadId: "selection-race" }));
    expect(items).toHaveLength(0);
    await expect(page.getByTestId("composer-input")).toHaveValue("Keep this private fixture unsent");
    await app.evaluate(() => (globalThis as any).releaseLocalSelection());
    await expect(page.getByTestId("local-model-active")).toContainText("qwen3.8-flash-next-iq3_s");
  } finally { await app.close(); }
});
