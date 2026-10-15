import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { appDir, launch, resizeWindow, seedHome, waitForWindowReady } from "./support";

test("paint is captured before attachment and supports an inactive window without claiming a show event", async () => {
  const { home, repo } = seedHome();
  const executablePath = process.env.MODEX_PACKAGED_APP;
  const app = await electron.launch({
    executablePath, args: executablePath ? [] : [appDir], cwd: appDir,
    env: { ...process.env, MODEX_HOME: home, MODEX_E2E: "1", MODEX_NO_LOGIN_PATH: "1", TYPESAFE_API_KEY: "", JEV_API_KEY: "", JEV_CONFIG: path.join(home, "no-jev.json") },
  });
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    // Main must retain real paint before the test connects, independently of show.
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      return !!w && ((globalThis as { __modexE2EPainted?: Set<number> }).__modexE2EPainted?.has(w.id) ?? false);
    })).toBe(true);
    // Isolate missing-show evidence even if a delayed real show updates main's captured set.
    await app.evaluate(() => { (globalThis as { __modexE2EShown?: Set<number> }).__modexE2EShown = new Set<number>(); });
    await waitForWindowReady(app, page);
    expect(await app.evaluate(() => [...((globalThis as { __modexE2EShown?: Set<number> }).__modexE2EShown ?? [])])).toEqual([]);
    // Visibility and matching dimensions must not pass without either observation.
    await app.evaluate(() => { (globalThis as { __modexE2EPainted?: Set<number> }).__modexE2EPainted?.clear(); });
    await expect(waitForWindowReady(app, page, 500)).rejects.toThrow("the window must paint");
  } finally {
    await app.close();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("readiness stability restarts when matching native and renderer dimensions change together", async () => {
  let samples = 0, width = 900, lastChange = Date.now();
  const app = { evaluate: async () => {
    if (samples++ < 6) { width++; lastChange = Date.now(); }
    return { id: 1, shown: false, painted: true, visible: true, size: [width, 600] };
  } } as unknown as ElectronApplication;
  const page = { evaluate: async () => [width, 600] } as unknown as Page;
  await waitForWindowReady(app, page, 3000);
  expect(Date.now() - lastChange).toBeGreaterThanOrEqual(200);
});

test("layout sizing survives a delayed native restoration of launch bounds", async () => {
  const { home, repo } = seedHome();
  const { app, page } = await launch(home);
  try {
    // Reproduce macOS restoring launch bounds after the first renderer resize notification.
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]!;
      const resize = window.setContentSize.bind(window);
      let finish!: () => void;
      (globalThis as { restored?: Promise<void> }).restored = new Promise<void>(resolve => { finish = resolve; });
      window.setContentSize = (width, height, animate) => {
        resize(width, height, animate);
        window.setContentSize = resize;
        setTimeout(() => { resize(1380, 880); finish(); }, 100);
      };
    });
    await resizeWindow(app, page, 1786, 1049);
    await app.evaluate(() => (globalThis as { restored?: Promise<void> }).restored);
    await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([1786, 1049]);
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getContentSize())).toEqual([1786, 1049]);
  } finally {
    await app.close();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("layout sizing rejects a permanently clamped native window", async () => {
  const { home, repo } = seedHome();
  const { app, page } = await launch(home);
  try {
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]!;
      const resize = window.setContentSize.bind(window);
      window.setContentSize = () => resize(1380, 880);
    });
    await expect(resizeWindow(app, page, 1786, 1049)).rejects.toThrow("window content size must settle");
  } finally {
    await app.close();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

async function mismatchRenderer(app: ElectronApplication, page: Page, settleOnResize: boolean) {
  await resizeWindow(app, page, 900, 600);
  await app.evaluate(({ BrowserWindow }, settleOnResize) => {
    const window = BrowserWindow.getAllWindows()[0]!;
    const requests: number[][] = [];
    (globalThis as { resizeRequests?: number[][] }).resizeRequests = requests;
    const resize = window.setContentSize.bind(window);
    window.setContentSize = (width, height, animate) => { requests.push([width, height]); resize(width, height, animate); };
    // A controlled real viewport mismatch. This models a renderer requiring another
    // native resize, without claiming zoom caused the observed macOS restoration race.
    window.webContents.setZoomFactor(1.25);
    if (settleOnResize) {
      const release = () => {
        const [width, height] = window.getContentSize();
        if (width !== 901 || height !== 601) return;
        window.removeListener("resize", release);
        window.webContents.setZoomFactor(1);
      };
      window.on("resize", release);
    }
  }, settleOnResize);
  await expect.poll(() => page.evaluate(() => innerWidth)).toBeLessThan(900);
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getContentSize())).toEqual([900, 600]);
}

test("layout sizing resynchronizes a stale renderer once at the minimum size", async () => {
  const { home, repo } = seedHome();
  const { app, page } = await launch(home);
  try {
    await mismatchRenderer(app, page, true);
    await resizeWindow(app, page, 900, 600);
    expect(await app.evaluate(() => (globalThis as { resizeRequests?: number[][] }).resizeRequests)).toEqual([[901, 601], [900, 600]]);
    expect(await page.evaluate(() => [innerWidth, innerHeight])).toEqual([900, 600]);
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getContentSize())).toEqual([900, 600]);
  } finally {
    await app.close();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("layout sizing leaves an independently settling renderer alone", async () => {
  const { home, repo } = seedHome();
  const { app, page } = await launch(home);
  const evaluate = page.evaluate;
  let observedMismatch = false;
  try {
    await mismatchRenderer(app, page, false);
    page.evaluate = (async (...args: Parameters<Page["evaluate"]>) => {
      const value = await evaluate.call(page, ...args);
      if (!observedMismatch && Array.isArray(value) && value.length === 2 && value[0] < 900) {
        observedMismatch = true;
        // Deliver this real mismatching sample to the helper, then let subsequent
        // observations settle independently of any native resize request.
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.setZoomFactor(1));
      }
      return value;
    }) as Page["evaluate"];
    await resizeWindow(app, page, 900, 600);
    expect(observedMismatch).toBe(true);
    expect(await app.evaluate(() => (globalThis as { resizeRequests?: number[][] }).resizeRequests)).toEqual([]);
  } finally {
    page.evaluate = evaluate;
    await app.close();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("layout sizing rejects a permanent renderer mismatch and restores native bounds", async () => {
  const { home, repo } = seedHome();
  const { app, page } = await launch(home);
  try {
    await mismatchRenderer(app, page, false);
    await expect(resizeWindow(app, page, 900, 600)).rejects.toThrow("window content size must settle");
    expect(await app.evaluate(() => (globalThis as { resizeRequests?: number[][] }).resizeRequests)).toEqual([[901, 601], [900, 600]]);
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getContentSize())).toEqual([900, 600]);
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.getZoomFactor())).toBe(1.25);
    expect(await page.evaluate(() => innerWidth)).toBeLessThan(900);
  } finally {
    await app.close();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("closed windows ignore late native visibility notifications", async () => {
  test.skip(process.platform !== "darwin", "macOS keeps the app alive after the last window closes");
  const { home, repo } = seedHome();
  const { app } = await launch(home);
  try {
    const errors = await app.evaluate(({ BrowserWindow }) => new Promise<string[]>((resolve) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.once("closed", () => setImmediate(() => {
        const errors: string[] = [];
        // macOS can deliver visibility notifications after destroying the native window.
        for (const event of ["show", "hide", "minimize", "maximize", "restore"] as const) {
          try { window.emit(event); } catch (error) { errors.push((error as Error).message); }
        }
        const state = globalThis as { __modexE2EShown?: Set<number>; __modexE2EPainted?: Set<number> };
        if (state.__modexE2EShown?.has(window.id) || state.__modexE2EPainted?.has(window.id)) errors.push("closed window retained readiness evidence");
        resolve(errors);
      }));
      window.close();
    }));
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
