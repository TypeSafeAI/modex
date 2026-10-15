import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { launch, seedHome, tid } from "./support";

const row = {
  id: "row-1", at: "2026-10-15T08:00:00.000Z", tool: "claude-code", model: "opus", session: "t1", project: "modex", account: "",
  kind: "main", input: 9, cached: 30_500, cacheWrite: 30_100, output: 420, reasoning: 0, cost: null, uncachedCost: null,
};

test("Analytics opens from the rail with the usage recorded on this Mac, and Settings can hide it", async () => {
  const { home, repo } = seedHome();
  fs.writeFileSync(path.join(home, "app", "usage.jsonl"), `${JSON.stringify(row)}\n`, { mode: 0o600 });
  const { app, page } = await launch(home);
  try {
    await tid(page, "rail-analytics").click();
    await expect(tid(page, "rail-analytics")).toHaveAttribute("aria-current", "page");
    await expect(tid(page, "analytics")).toBeVisible();
    await expect(tid(page, "main")).toBeHidden();
    // The dashboard is its own document in a native view; read it from main.
    const text = () => app.evaluate(({ webContents }) => {
      const view = webContents.getAllWebContents().find(w => w.getURL().startsWith("modex-analytics://app/"));
      return view ? view.executeJavaScript("document.body.innerText") as Promise<string> : null;
    });
    await expect.poll(text, { timeout: 20_000 }).toContain("Recorded on this Mac");
    const shown = (await text())!;
    expect(shown).toContain("1 turn from Claude Code and Codex threads");
    expect(shown).not.toContain("Demo Data");
    expect(await app.evaluate(({ webContents }) => webContents.getAllWebContents().find(w => w.getURL().startsWith("modex-analytics://app/"))!.executeJavaScript("[typeof window.modex, typeof require]"))).toEqual(["undefined", "undefined"]);

    await tid(page, "open-settings").click();
    await tid(page, "analytics-in-rail").uncheck();
    await page.keyboard.press("Escape");
    await expect(tid(page, "rail-analytics")).toHaveCount(0);
    await expect(tid(page, "analytics")).toHaveCount(0);
    await expect(tid(page, "main")).toBeVisible();
  } finally {
    await app.close();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
