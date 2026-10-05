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
    await expect(page.getByRole("button", { name: "Sign in to Claude Code", exact: true })).toBeDisabled();
    await expect(tid(page, "claude-account")).toContainText("Install Claude Code, then refresh");
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

for (const theme of ["jev", "coven"] as const) test(`${theme}: connection cards guide sign-in, cancellation and terminal recovery`, async ({}, testInfo) => {
  const { home, repo } = seedHome({ theme });
  const { app, page } = await launch(home);
  try {
    await app.evaluate(({ ipcMain, BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]!.setSize(900, 600);
      let claudeAttempts = 0;
      let cancelClaude: (() => void) | undefined;
      let accountSignedIn = false;
      const status = (backend: string) => ({ executable: "available", resolvedPath: `/tmp/Val's tools/${backend}`, version: "2.1.288", authentication: "signed-out", access: "unverified", detail: "Sign in to connect your account." });
      const accountStatus = () => ({ available: true, active: accountSignedIn ? "account-1" : null, signingIn: false, detail: "Model access is unverified until a Codex turn completes.", accounts: accountSignedIn ? [{ id: "account-1", label: "Personal", registration: "Modex", signedIn: true, planEnabled: false }] : [] });
      for (const channel of ["backends:health", "chatgpt:status", "chatgpt:signIn", "claude:login", "claude:cancelLogin"]) ipcMain.removeHandler(channel);
      ipcMain.handle("backends:health", () => ({ claude: status("claude"), codex: status("codex"), mock: status("mock") }));
      ipcMain.handle("chatgpt:status", accountStatus);
      ipcMain.handle("chatgpt:signIn", () => { accountSignedIn = true; return accountStatus(); });
      ipcMain.handle("claude:login", () => {
        if (++claudeAttempts > 1) return { status: "unsupported", detail: "Account commands unavailable. Update Claude Code or sign in from its terminal." };
        return new Promise((resolve) => { cancelClaude = () => resolve({ status: "cancelled", detail: "Sign-in cancelled. Refresh account status before retrying." }); });
      });
      ipcMain.handle("claude:cancelLogin", () => cancelClaude?.());
    });
    await tid(page, "open-settings").click();
    await page.getByRole("button", { name: "Coding CLIs", exact: true }).click();
    const claude = tid(page, "claude-account");
    const codex = tid(page, "chatgpt-accounts");
    await expect(claude).toContainText("Sign in needed");
    await claude.getByRole("button", { name: "Sign in to Claude Code", exact: true }).click();
    await expect(claude.getByRole("button", { name: "Waiting for sign-in…" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Refresh account status" })).toBeDisabled();
    await claude.getByRole("button", { name: "Cancel sign-in", exact: true }).click();
    await expect(claude.getByRole("status").filter({ hasText: "Sign-in cancelled" })).toBeVisible();
    await claude.getByRole("button", { name: "Sign in to Claude Code", exact: true }).click();
    await expect(claude.getByRole("status").filter({ hasText: "Account commands unavailable" })).toBeVisible();
    await claude.locator("summary").click();
    await claude.getByRole("button", { name: "Copy command", exact: true }).click();
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe("'/tmp/Val'\\''s tools/claude' auth login");
    await expect(claude.getByRole("status").filter({ hasText: "Login command copied" })).toHaveCount(1);
    await codex.getByRole("button", { name: "Continue with ChatGPT", exact: true }).click();
    await expect(codex.getByText("Identity verified", { exact: true })).toBeVisible();
    await expect(codex.getByText("Plan authorized", { exact: true })).toHaveCount(0);
    await expect(page.getByLabel("Active account for new Codex conversations")).toHaveValue("account-1");
    await expect(tid(page, "settings-content")).toHaveJSProperty("scrollWidth", await tid(page, "settings-content").evaluate((el) => el.clientWidth));
    await tid(page, "settings-content").evaluate((el) => el.scrollTo(0, 0));
    await page.getByRole("dialog", { name: "Settings" }).screenshot({ path: testInfo.outputPath(`connections-${theme}.png`) });
    await claude.locator("summary").focus();
    for (let index = 0; index < 16; index++) {
      await page.keyboard.press("Tab");
      expect(await page.getByRole("dialog").evaluate((el) => el.contains(document.activeElement))).toBe(true);
    }
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  } finally {
    await app.close();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
