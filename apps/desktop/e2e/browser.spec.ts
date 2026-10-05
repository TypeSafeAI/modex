import { test, expect, chromium, type Browser } from "@playwright/test";
import { createServer } from "vite";
import fs from "node:fs";
import path from "node:path";
import { appDir, seedHome, tid, items, currentRow } from "./support";

test("browser without preload: add folder, approve a turn, inspect changes, terminal, and reload", async () => {
  const { home, repo } = seedHome();
  const saved = JSON.parse(fs.readFileSync(path.join(home, "app/state.json"), "utf8"));
  saved.projects = [];
  fs.writeFileSync(path.join(home, "app/state.json"), JSON.stringify(saved));
  const previous = { MODEX_BROWSER_HOME: process.env.MODEX_BROWSER_HOME, MODEX_E2E: process.env.MODEX_E2E, MODEX_NO_LOGIN_PATH: process.env.MODEX_NO_LOGIN_PATH, TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY, JEV_CONFIG: process.env.JEV_CONFIG, JEV_API_KEY: process.env.JEV_API_KEY };
  Object.assign(process.env, { MODEX_BROWSER_HOME: home, MODEX_E2E: "1", MODEX_NO_LOGIN_PATH: "1", TYPESAFE_API_KEY: "", JEV_API_KEY: "", JEV_CONFIG: path.join(home, "no-jev-config.json") });
  const server = await createServer({ configFile: path.join(appDir, "vite.config.ts"), server: { port: 0, host: "127.0.0.1", open: false } });
  let browser: Browser | undefined;
  try {
    await server.listen();
    const address = server.httpServer!.address();
    if (!address || typeof address === "string") throw new Error("No browser test listener");
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${address.port}`);
    expect(await page.evaluate(() => window.modex)).toBeUndefined();
    page.once("dialog", (dialog) => dialog.accept(repo));
    await tid(page, "empty-open-project").click();
    await expect(tid(page, "draft-view")).toBeVisible();
    await expect(tid(page, "model-picker")).toContainText("Scripted mock");
    await tid(page, "composer-input").fill("Add a contributing guide");
    await tid(page, "send").click();
    const approval = items(page, "approval").first();
    await expect(approval).toBeVisible();
    await approval.getByRole("button", { name: "Approve", exact: true }).click();
    await expect(currentRow(page)).toHaveAttribute("data-status", "idle");
    await expect(items(page, "assistant").last()).toContainText("added CONTRIBUTING.md");
    await expect(tid(page, "changes-file-path")).toHaveText("CONTRIBUTING.md");
    expect(fs.readFileSync(path.join(repo, "CONTRIBUTING.md"), "utf8")).toContain("# Contributing");

    await page.keyboard.press("Control+Backquote");
    await expect(tid(page, "terminal-panel")).toBeVisible();
    await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
    await page.keyboard.type("printf 'MODEX_%s\\n' BROWSER_TERMINAL");
    await page.keyboard.press("Enter");
    await expect(tid(page, "terminal-panel")).toContainText("MODEX_BROWSER_TERMINAL");
    await page.reload();
    await expect(items(page, "user").first()).toContainText("Add a contributing guide");
    await expect(items(page, "assistant").last()).toContainText("added CONTRIBUTING.md");
    await expect(tid(page, "changes-file-path")).toHaveText("CONTRIBUTING.md");
    expect(errors).toEqual([]);
  } finally {
    await browser?.close();
    await server.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
