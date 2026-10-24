import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { appDir, resizeWindow, seedHome, tid } from "./support.js";
import { WORLD_GH, type GhWorld } from "../test/fixtures/code-review-gh-world.js";

export { baseWorld, FIELD_GUIDE, FIELD_GUIDE_73, FIELD_GUIDE_91, LENDING, LENDING_73 } from "../test/fixtures/code-review-gh-world.js";

/**
 * CR-8 (#327): the built app with its production preload, `code-review:read` registration, read service and
 * gh transport. Only `gh` is synthetic (WORLD_GH); no ipcMain handler is replaced. `claude` and `codex` on
 * PATH are recorders, so a test can prove Code Review started no provider. MODEX_E2E is unset, as in
 * e2e/code-review-ipc.spec.ts, because it disables the read service; the home and gh configuration are
 * throwaway and token variables are removed, so the person's own GitHub login is never read.
 */
export interface Harness {
  app: ElectronApplication;
  page: Page;
  home: string;
  repo: string;
  /** Rewrites the world the next gh call reads. */
  world: (change: (world: GhWorld) => void) => void;
  /** Endpoints gh was asked for, in order. */
  calls: () => string[];
  /** Arguments `claude` or `codex` were started with, one line per start. */
  providerStarts: () => string[];
  /** Rewrites gh's hosts.yml, as `gh auth switch` does. */
  switchHosts: (login: string) => void;
  /** Lets every call held under this name answer. */
  release: (hold: string) => void;
  close: () => Promise<void>;
}

const RECORDER = (log: string) => `#!/bin/sh\nprintf '%s %s\\n' "$(basename "$0")" "$*" >> '${log}'\nexit 1\n`;

export async function launchWithGh(initial: GhWorld): Promise<Harness> {
  const { home, repo } = seedHome();
  const bin = path.join(home, "bin"), config = path.join(home, "gh-config");
  fs.mkdirSync(bin);
  fs.mkdirSync(config);
  const worldFile = path.join(home, "gh-world.json"), log = path.join(home, "gh-calls.log"), starts = path.join(home, "provider-starts.log");
  const holds = path.join(home, "holds");
  fs.mkdirSync(holds);
  fs.writeFileSync(log, "");
  fs.writeFileSync(starts, "");
  fs.writeFileSync(path.join(bin, "gh"), WORLD_GH, { mode: 0o755 });
  for (const name of ["claude", "codex"]) fs.writeFileSync(path.join(bin, name), RECORDER(starts), { mode: 0o755 });
  let current: GhWorld = structuredClone(initial);
  const write = () => { const tmp = `${worldFile}.tmp`; fs.writeFileSync(tmp, JSON.stringify(current)); fs.renameSync(tmp, worldFile); };
  write();
  const switchHosts = (login: string) => fs.writeFileSync(path.join(config, "hosts.yml"), `github.com:\n    user: ${login}\n    git_protocol: https\n`);
  switchHosts(initial.user?.login ?? "nobody");
  const env: Record<string, string | undefined> = { ...process.env, MODEX_HOME: home, MODEX_NO_LOGIN_PATH: "1", PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
    FAKE_GH_WORLD: worldFile, FAKE_GH_LOG: log, FAKE_GH_HOLDS: holds, GH_CONFIG_DIR: config, JEV_API_KEY: "", TYPESAFE_API_KEY: "", JEV_CONFIG: path.join(home, "no-jev.json") };
  for (const name of ["MODEX_E2E", "MODEX_DEMO", "GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]) delete env[name];
  const app = await electron.launch({ args: [appDir], cwd: appDir, env: env as Record<string, string> });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  // waitForWindowReady needs MODEX_E2E's paint hooks; without them, wait for a visible window whose sizes agree.
  await expect.poll(async () => {
    const native = await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; return w && !w.isDestroyed() && w.isVisible() ? w.getContentSize() : null; });
    const inner = await page.evaluate(() => [window.innerWidth, window.innerHeight]);
    return native !== null && native[0]! > 0 && native[0] === inner[0] && native[1] === inner[1];
  }, { timeout: 15_000, intervals: [100] }).toBe(true);
  // A built app hides the unfinished destination behind its local switch (src/renderer/code-review/feature.ts).
  await page.evaluate(() => localStorage.setItem("modex.codeReview", "on"));
  // Row ages and captures read the renderer's clock: pin it to the fixtures' (test/fixtures/code-review.ts NOW).
  await page.clock.setFixedTime(new Date("2026-10-18T20:41:00Z"));
  await page.reload();
  await expect(tid(page, "rail-code-review")).toBeVisible();
  return {
    app, page, home, repo,
    world: (change) => { current = structuredClone(current); change(current); write(); },
    calls: () => fs.readFileSync(log, "utf8").split("\n").filter(Boolean),
    providerStarts: () => fs.readFileSync(starts, "utf8").split("\n").filter(Boolean),
    switchHosts,
    release: (hold) => fs.writeFileSync(path.join(holds, hold), ""),
    close: async () => {
      await app.close().catch(() => {});
      for (const dir of [home, repo]) fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export const prRow = (p: Page, slug: string) => p.locator(`[data-testid="code-review-row"][data-pr="${slug}"]`);

/** Waits until every reply main already sent has reached the renderer (IPC answers arrive in order). */
export const settle = (p: Page) => p.evaluate(() => window.modex!.invoke("code-review:read", { op: "connection", requestId: `settle-${Date.now()}` }));

/** Every endpoint the read service may ask for (docs/design/code-review.md, Read operations). */
export const READ_ENDPOINT = /^(user|search\/issues\?[^/]+|repos\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+(\/(pulls\/\d+(\/files)?|issues\/\d+\/timeline|commits\/[0-9a-f]{40}\/(check-runs|status)|contents\/[^?]+))?(\?[^/]*)?)$/;

/**
 * resizeWindow, but within the display. These launches can't set MODEX_E2E (it disables the read service), so
 * the window can't grow past the screen as e2e/support.ts's launches do. A CI display can be shorter than the
 * references (677 px of content on GitHub's macOS runner), so the height is capped at what the display can take.
 * Returns the size used; callers record it rather than claim the requested one.
 */
export async function fitWindow(h: Pick<Harness, "app" | "page">, width: number, height: number): Promise<{ width: number; height: number }> {
  // macOS keeps a window's frame within the screen vertically only: cap the height at the display's work area,
  // less the window's own frame, and keep the width asked for.
  const most = await h.app.evaluate(({ BrowserWindow, screen }) => {
    const win = BrowserWindow.getAllWindows()[0]!;
    return screen.getDisplayMatching(win.getBounds()).workArea.height - (win.getSize()[1]! - win.getContentSize()[1]!);
  });
  const fitted = { width, height: Math.min(height, most) };
  await resizeWindow(h.app, h.page, fitted.width, fitted.height);
  if (fitted.width !== width || fitted.height !== height) test.info().annotations.push({ type: "display-limited", description: `asked ${width}×${height}, used ${fitted.width}×${fitted.height}` });
  return fitted;
}
