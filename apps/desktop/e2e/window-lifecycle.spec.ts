import { test, expect } from "@playwright/test";
import fs from "node:fs";
import { launch, resizeWindow, seedHome } from "./support";

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
