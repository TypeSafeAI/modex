import { _electron as electron, expect, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * Shared setup for the Electron e2e specs. Specs select elements by `data-testid` and ARIA
 * state, never by CSS class, so the UI can be restyled without rewriting the tests.
 */
export const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const mockScript = path.join(appDir, "demo", "mock-script.json");

/**
 * A throwaway MODEX_HOME with one git project and no threads, on the offline mock backend in Chat mode.
 * `settings` is merged over the seeded settings (e.g. approval rules).
 */
export function seedHome(settings: Record<string, unknown> = {}): { home: string; repo: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "modex-e2e-home-"));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "modex-e2e-repo-"));
  const env = { ...process.env, GIT_AUTHOR_NAME: "e2e", GIT_AUTHOR_EMAIL: "e2e@modex.local", GIT_COMMITTER_NAME: "e2e", GIT_COMMITTER_EMAIL: "e2e@modex.local" };
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "e2e-repo", private: true }, null, 2) + "\n");
  fs.writeFileSync(path.join(repo, "README.md"), "# e2e\n");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo, env });
  execFileSync("git", ["add", "."], { cwd: repo, env });
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "baseline"], { cwd: repo, env });
  fs.mkdirSync(path.join(home, "app", "threads"), { recursive: true });
  fs.writeFileSync(
    path.join(home, "app", "state.json"),
    JSON.stringify({
      version: 1,
      projects: [{ id: "p1", name: path.basename(repo), path: repo, addedAt: new Date().toISOString() }],
      threads: [],
      // Chat mode is read-only, so the scripted apply_patch must be approved — that is the card we click.
      // HTTPS transport so a real `jev` on the machine's PATH never changes what the judge reports.
      settings: { default_backend: "mock", default_mode: "chat", default_model: { codex: "", claude: "", mock: "mock" }, claude_bin: "claude", codex_bin: "codex", mock_script: mockScript, routing: { jev_transport: "http" }, ...settings },
    }),
  );
  return { home, repo };
}

/** Launches the built app against `home`. MODEX_E2E keeps the secret store on the test cipher: CI runners have no unlocked keychain. */
export async function launch(home: string): Promise<{ app: ElectronApplication; page: Page }> {
  // Release verification runs the same flows against the installed bundle, including its ASAR and native modules.
  const executablePath = process.env.MODEX_PACKAGED_APP;
  const app = await electron.launch({
    executablePath,
    args: executablePath ? [] : [appDir],
    cwd: appDir,
    env: { ...process.env, MODEX_HOME: home, MODEX_E2E: "1", MODEX_NO_LOGIN_PATH: "1", TYPESAFE_API_KEY: "", JEV_API_KEY: "", JEV_CONFIG: path.join(os.tmpdir(), "modex-e2e-no-jev-config.json") },
  });
  // Main records the actual native `show` when it creates the hidden window;
  // attaching here can miss the event after electron.launch() has resolved.
  // isVisible() is insufficient: macOS can report it before emitting `show`.
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  // resizeWindow separately waits for native and renderer geometry to settle before layout measurements.
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    const shown = (globalThis as { __modexE2EShown?: Set<number> }).__modexE2EShown;
    return { shown: !!w && (shown?.has(w.id) ?? false), windowId: w?.id, visible: w?.isVisible(), recorded: [...(shown ?? [])] };
  }), { message: "the window never reported its native show" }).toMatchObject({ shown: true });
  return { app, page };
}

/** Wait for native and renderer geometry to settle after macOS restores launch bounds. */
export async function resizeWindow(app: ElectronApplication, page: Page, width: number, height: number): Promise<void> {
  let matchedSince: number | undefined;
  let staleSince: number | undefined, staleViewport: number[] | undefined;
  let resynchronized = false, waitingForTransition = false;
  const target = [width, height], transition = [width + 1, height + 1];
  const matches = (size: number[], expected = target) => size[0] === expected[0] && size[1] === expected[1];
  try {
    await expect.poll(async () => {
      const requested = waitingForTransition ? transition : target;
      const before = await app.evaluate(({ BrowserWindow }, size) => {
        const window = BrowserWindow.getAllWindows()[0]!;
        const current = window.getContentSize();
        if (current[0] !== size.width || current[1] !== size.height) window.setContentSize(size.width, size.height);
        return current;
      }, { width: requested[0]!, height: requested[1]! });
      const viewport = await page.evaluate(() => [window.innerWidth, window.innerHeight]);
      const native = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getContentSize());
      if (waitingForTransition) {
        // Observe the intermediate size in both processes before restoring the target.
        if (matches(before, transition) && matches(viewport, transition) && matches(native, transition)) waitingForTransition = false;
        matchedSince = undefined;
        return { native, viewport, settled: false };
      }
      if (!resynchronized && matches(before) && matches(native) && !matches(viewport)) {
        if (!staleViewport || !matches(viewport, staleViewport)) { staleViewport = viewport; staleSince = Date.now(); }
        if (Date.now() - staleSince! >= 500) {
          // A same-size request need not notify a stale renderer. One upward transition
          // avoids the minimum window size and stays within the original polling budget.
          resynchronized = true;
          waitingForTransition = true;
        }
      } else { staleSince = undefined; staleViewport = undefined; }
      if (matches(before) && matches(viewport) && matches(native)) matchedSince ??= Date.now();
      else matchedSince = undefined;
      return { native, viewport, settled: matchedSince !== undefined && Date.now() - matchedSince >= 200 };
    }, { timeout: 15_000, intervals: [50], message: "window content size must settle before layout measurements" })
      .toEqual({ native: [width, height], viewport: [width, height], settled: true });
  } finally {
    // A permanently mismatched renderer must fail without leaving the temporary size.
    if (resynchronized) await app.evaluate(({ BrowserWindow }, size) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window || window.isDestroyed()) return;
      const current = window.getContentSize();
      if (current[0] !== size.width || current[1] !== size.height) window.setContentSize(size.width, size.height);
    }, { width, height });
  }
}

/** `data-testid` lookup, scoped to a page or a parent locator. */
export const tid = (scope: Page | Locator, id: string): Locator => scope.locator(`[data-testid="${id}"]`);

/** Transcript items of one kind (`user`, `assistant`, `tool`, `approval`, `notice`, `thinking`, `route`). */
export const items = (page: Page, kind?: string): Locator =>
  page.locator(kind ? `[data-testid="item"][data-item-kind="${kind}"]` : `[data-testid="item"]`);

/**
 * New chats are drafts until their first send, so a test that needs a real thread sends one:
 * ⌘N (or ⇧⌘N for a worktree) → type → ⌘⏎, then stops the scripted turn once it has started.
 * Returns the new thread's id; it is selected and idle.
 */
export async function createThread(page: Page, prompt: string, opts: { worktree?: boolean } = {}): Promise<string> {
  await page.keyboard.press(opts.worktree ? "Meta+Shift+n" : "Meta+n");
  await expect(tid(page, "draft-view")).toBeVisible();
  if (opts.worktree) await expect(tid(page, "context-kind")).toHaveAttribute("data-kind", "worktree");
  await expect(tid(page, "composer-input")).toBeFocused();
  // fill, not type: this helper needs a thread, not keystroke realism (the main flow test types for real).
  await tid(page, "composer-input").fill(prompt);
  await page.keyboard.press("Meta+Enter");
  // The draft gives way to the new, selected thread. (Counting rows would not do: "Show more" caps them at five.)
  await expect(tid(page, "thread-view")).toBeVisible({ timeout: 15_000 });
  await expect(tid(page, "draft-view")).toHaveCount(0);
  await expect(items(page, "user").first()).toHaveText(prompt);
  // Stop only once the turn is really under way (a ⌘. that lands before the run starts is a no-op and
  // the script carries on to its approval), and press again if a stop raced the next step.
  const status = currentRow(page);
  await expect(status).toHaveAttribute("data-status", /running|waiting/);
  await expect(async () => {
    if ((await status.getAttribute("data-status")) !== "idle") await page.keyboard.press("Meta+.");
    await expect(status).toHaveAttribute("data-status", "idle", { timeout: 2_000 });
  }).toPass({ timeout: 15_000 });
  return (await page.locator('[data-testid="thread-row"][aria-current="true"]').getAttribute("data-thread-id"))!;
}

/** The selected thread's sidebar row; its data-status is the thread's status (idle, running, waiting, error). */
export const currentRow = (page: Page): Locator => page.locator('[data-testid="thread-row"][aria-current="true"]');
