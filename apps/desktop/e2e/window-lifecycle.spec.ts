import { test, expect } from "@playwright/test";
import fs from "node:fs";
import { launch, seedHome } from "./support";

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
