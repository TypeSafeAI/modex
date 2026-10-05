import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { seedHome, launch, tid } from "./support.js";

test("static models never make a missing Claude executable ready", async () => {
  const { home, repo } = seedHome();
  const statePath = path.join(home, "app", "state.json");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  state.settings.claude_bin = path.join(home, "missing-claude");
  state.settings.codex_bin = path.join(home, "missing-codex");
  fs.writeFileSync(statePath, JSON.stringify(state));
  const { app, page } = await launch(home);
  try {
    await tid(page, "open-settings").click();
    await page.getByRole("button", { name: "Coding CLIs", exact: true }).click();
    await expect(tid(page, "chatgpt-accounts")).toContainText("Existing conversations keep their original account");
    await expect(page.getByRole("button", { name: "Continue with ChatGPT", exact: true })).toBeVisible();
    await expect(page.getByLabel("Active account for new Codex conversations")).toHaveValue("");
    await expect(page.getByText(/executable is invalid or not executable/)).toHaveCount(2);
    await expect(page.getByText(/^ready ·/)).toHaveCount(0);
    await page.getByRole("button", { name: "Sign in to Claude Code", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Could not start Claude sign-in" })).toHaveCount(1);
    await page.getByLabel("Claude executable").fill("another-cli");
    await expect(page.getByText("Override changed · verified when you save", { exact: true })).toBeVisible();
  } finally {
    await app.close();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("a stale account result cannot replace refresh, and a failed check offers retry", async () => {
  const { home, repo } = seedHome();
  const { app, page } = await launch(home);
  try {
    await app.evaluate(({ ipcMain }) => {
      let calls = 0;
      let releaseFirst: (() => void) | undefined;
      const controls = globalThis as typeof globalThis & { modexHealthCalls?: () => number; modexReleaseHealth?: () => void };
      controls.modexHealthCalls = () => calls;
      controls.modexReleaseHealth = () => releaseFirst?.();
      const status = (detail: string) => ({ executable: "available", version: "2.1.288", authentication: "signed-out", access: "unverified", detail });
      ipcMain.removeHandler("backends:health");
      ipcMain.handle("backends:health", () => {
        calls++;
        if (calls === 1) return new Promise((resolve) => { releaseFirst = () => resolve({ claude: status("Stale account"), codex: status("Stale account"), mock: status("Stale account") }); });
        if (calls === 2) return { claude: status("Signed out"), codex: status("Signed out"), mock: status("Offline demo") };
        throw new Error("Synthetic account check failure");
      });
    });
    await tid(page, "open-settings").click();
    await page.getByRole("button", { name: "Coding CLIs", exact: true }).click();
    await expect.poll(() => app.evaluate(() => (globalThis as typeof globalThis & { modexHealthCalls: () => number }).modexHealthCalls())).toBe(1);
    await page.getByRole("button", { name: "Refresh account status" }).click();
    await expect(page.getByText("v2.1.288 · Signed out", { exact: true })).toHaveCount(2);
    await app.evaluate(() => (globalThis as typeof globalThis & { modexReleaseHealth: () => void }).modexReleaseHealth());
    await expect(page.getByText("Stale account")).toHaveCount(0);
    await page.getByRole("button", { name: "Refresh account status" }).click();
    await expect(page.getByText("Account check unavailable · retry", { exact: true })).toHaveCount(2);
  } finally {
    await app.close();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("CLI overrides are verified before persistence and can return to automatic discovery", async () => {
  const { home, repo } = seedHome();
  const { app, page } = await launch(home);
  const statePath = path.join(home, "app", "state.json");
  const before = fs.readFileSync(statePath, "utf8");
  try {
    await tid(page, "open-settings").click();
    await page.getByRole("button", { name: "Coding CLIs", exact: true }).click();
    await page.getByLabel("Claude executable").fill("claude --dangerously-skip-permissions");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("executable");
    expect(fs.readFileSync(statePath, "utf8")).toBe(before);
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByLabel("Claude executable").fill("");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await tid(page, "open-settings").click();
    await page.getByRole("button", { name: "Coding CLIs", exact: true }).click();
    await expect(page.getByLabel("Claude executable")).toHaveValue("");
  } finally {
    await app.close();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
