import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import { currentRow, items, launch, mockScript, seedHome, tid } from "./support";

/**
 * A turn that fails ends in a card, not a red line: the CLI's words, a Retry that runs the same message
 * again in place, the fix when Modex has one, and Copy details for a bug report. The mock backend fails
 * its turn when no script is configured, which takes the same path a CLI failure does.
 */
let app: ElectronApplication;
let page: Page;
let home: string;
let repo: string;

test.beforeAll(async () => {
  ({ home, repo } = seedHome());
  ({ app, page } = await launch(home));
});

test.afterAll(async () => {
  await app?.close();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

const card = () => page.locator('[data-testid="item"][data-failure-code]');

test("a failed turn becomes a card with the CLI's words, Copy details, and a Retry that reuses the message", async () => {
  await page.evaluate(() => window.modex!.invoke("settings:update", { mock_script: "" }));
  await page.keyboard.press("Meta+n");
  await expect(tid(page, "composer-input")).toBeFocused();
  await tid(page, "composer-input").fill("first try");
  await page.keyboard.press("Meta+Enter");
  await expect(tid(page, "thread-view")).toBeVisible({ timeout: 15_000 });
  await expect(currentRow(page)).toHaveAttribute("data-status", "error");
  await expect(card()).toHaveCount(1);
  await expect(card()).toHaveAttribute("data-failure-code", "unknown");
  await expect(tid(card(), "failure-summary")).toContainText("no mock script is configured");
  await expect(tid(card(), "failure-fix")).toHaveCount(0);
  await expect(items(page, "user")).toHaveCount(1);

  // Details shows the report Copy puts on the clipboard: the message plus where it happened.
  await tid(card(), "failure-toggle").click();
  await expect(tid(card(), "failure-report")).toContainText("Mock backend selected");
  await expect(tid(card(), "failure-report")).toContainText('"cwd":');
  await tid(card(), "failure-copy").click();
  await expect(tid(card(), "failure-copy")).toHaveText("Copied");
  expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toContain("The mock backend turn failed (unknown)");

  // With the script back, Retry runs the same message again: no second bubble, and the card keeps no Retry once work follows it.
  await page.evaluate((mock_script) => window.modex!.invoke("settings:update", { mock_script }), mockScript);
  await tid(card(), "failure-retry").click();
  await expect(currentRow(page)).toHaveAttribute("data-status", /running|waiting/);
  await expect(items(page, "user")).toHaveCount(1);
  await expect(tid(card(), "failure-retry")).toHaveCount(0);
  await expect(async () => {
    if ((await currentRow(page).getAttribute("data-status")) !== "idle") await page.keyboard.press("Meta+.");
    await expect(currentRow(page)).toHaveAttribute("data-status", "idle", { timeout: 2_000 });
  }).toPass({ timeout: 15_000 });
  expect(await items(page).count()).toBeGreaterThan(2);
  await expect(items(page, "user")).toHaveCount(1);
  await expect(tid(card(), "failure-retry")).toHaveCount(0);
});

test("the fix on a sign-in failure opens the thread's terminal and types the login command", async () => {
  const threadId = await currentRow(page).getAttribute("data-thread-id");
  await app.evaluate(({ BrowserWindow }, threadId) => BrowserWindow.getAllWindows()[0]!.webContents.send("thread:event", {
    type: "item",
    threadId,
    item: {
      id: "auth-fail", kind: "notice", level: "error", text: "Codex is signed out.", at: new Date().toISOString(),
      failure: {
        code: "auth", backend: "codex",
        message: "Your access token could not be refreshed because you have since logged out or signed in to another account. Please sign in again.",
        summary: "Codex is signed out, or its sign-in changed since it started.",
        hint: "Sign in to Codex again (codex login), then retry.",
        retryable: true,
        fix: { kind: "login", label: "Sign in to Codex", command: "MODEX_TEST_SIGNINS=$(( ${MODEX_TEST_SIGNINS:-0} + 1 )); echo modex-sign-in-$MODEX_TEST_SIGNINS" },
        debug: {},
      },
    },
  }), threadId);
  const auth = page.locator('[data-testid="item"][data-failure-code="auth"]');
  await expect(tid(auth, "failure-message")).toContainText("could not be refreshed");
  await expect(tid(page, "terminal-panel")).toHaveCount(0);
  await tid(auth, "failure-fix").click();
  await expect(tid(page, "terminal-panel")).toBeVisible();
  // The command ran (the shell expanded the arithmetic), not just echoed back as typed.
  await expect(tid(page, "terminal-screen")).toContainText("modex-sign-in-1", { timeout: 15_000 });
  await tid(page, "terminal-toggle").click();
  await expect(tid(page, "terminal-panel")).toHaveCount(0);
  await tid(page, "terminal-toggle").click();
  await expect(tid(page, "terminal-screen")).toContainText("modex-sign-in-1");
  // A shell reply after remount proves its queued input drained without running sign-in again.
  await page.evaluate(async (threadId) => {
    const terminal = await window.modex!.invoke("terminal:open", { threadId: threadId!, cols: 80, rows: 20 });
    await window.modex!.invoke("terminal:write", { threadId: threadId!, sessionId: terminal.sessionId, data: "echo observed-signins-$MODEX_TEST_SIGNINS\r" });
  }, threadId);
  await expect(tid(page, "terminal-screen")).toContainText("observed-signins-1");
  await expect(tid(page, "terminal-screen")).not.toContainText("modex-sign-in-2");
});

test("early send and retry rejections return errors without adding transcript cards", async () => {
  const t = await page.evaluate(async () => {
    const state = await window.modex!.invoke("state:get", undefined);
    return window.modex!.invoke("thread:create", { projectId: state.projects[0]!.id, backend: "mock" });
  });
  const check = async (channel: "thread:send" | "thread:retry", threadId: string, error: RegExp) => {
    const result = await page.evaluate(async ({ channel, threadId }) => channel === "thread:send"
      ? window.modex!.invoke(channel, { threadId, text: "rejected" })
      : window.modex!.invoke(channel, { threadId }), { channel, threadId });
    expect(result).toEqual({ ok: false, error: expect.stringMatching(error) });
  };
  await check("thread:retry", t.id, /Nothing to retry/);
  await check("thread:send", "unknown-thread", /unknown thread/);
  await check("thread:retry", "unknown-thread", /unknown thread/);
  expect(await page.evaluate((threadId) => window.modex!.invoke("thread:items", { threadId }), t.id)).toEqual([]);
  const busy = await page.evaluate(async (threadId) => {
    await window.modex!.invoke("thread:send", { threadId, text: "first" });
    return window.modex!.invoke("thread:retry", { threadId });
  }, t.id);
  expect(busy).toEqual({ ok: false, error: expect.stringMatching(/still working/) });
  const transcript = await page.evaluate((threadId) => window.modex!.invoke("thread:items", { threadId }), t.id);
  expect(transcript.filter((i) => i.kind === "user")).toHaveLength(1);
  expect(transcript.filter((i) => i.kind === "notice")).toHaveLength(0);
  await page.evaluate((threadId) => window.modex!.invoke("thread:stop", { threadId }), t.id);
});

test("the model-list Retry requests the catalogue again and clears the error", async () => {
  await app.evaluate(({ ipcMain }) => {
    let calls = 0;
    ipcMain.removeHandler("models:list");
    ipcMain.handle("models:list", (_event, { backend }) => backend !== "codex"
      ? { models: [{ id: "mock", label: "Mock", isDefault: true }] }
      : ++calls === 1 ? { models: [], error: "Catalogue temporarily unavailable" }
      : { models: [{ id: "recovered-model", label: "Recovered model", isDefault: true }] });
  });
  await page.evaluate(() => window.modex!.invoke("settings:update", { default_backend: "codex" }));
  await page.reload();
  await page.keyboard.press("Meta+n");
  await expect(tid(page, "models-retry")).toBeVisible();
  await tid(page, "models-retry").click();
  await expect(tid(page, "models-retry")).toHaveCount(0);
  await expect(tid(page, "model-picker")).toContainText("Recovered model");
});
