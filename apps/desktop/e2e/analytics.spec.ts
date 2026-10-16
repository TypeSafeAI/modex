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
    // It fits the window like the app's other surfaces, in the app's theme: the page never scrolls.
    const fit = await app.evaluate(({ webContents }) => webContents.getAllWebContents().find(w => w.getURL().startsWith("modex-analytics://app/"))!
      .executeJavaScript("({ theme: document.documentElement.dataset.theme, scroll: document.documentElement.scrollHeight - innerHeight, title: document.querySelector('h1')?.textContent })"));
    expect(fit).toEqual({ theme: "graphite", scroll: 0, title: "Overview" });
    expect(await app.evaluate(({ webContents }) => webContents.getAllWebContents().find(w => w.getURL().startsWith("modex-analytics://app/"))!.executeJavaScript("[typeof window.modex, typeof require]"))).toEqual(["undefined", "undefined"]);

    await tid(page, "open-settings").click();
    // Settings opens on Auto routing; the rail option is under General.
    await tid(page, "settings-nav").getByRole("button", { name: "General", exact: true }).click();
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

test("Analytics CSV export completes a native download containing recorded rows", async () => {
  const { home, repo } = seedHome();
  fs.writeFileSync(path.join(home, "app", "usage.jsonl"), `${JSON.stringify(row)}\n`, { mode: 0o600 });
  const { app, page } = await launch(home);
  try {
    await tid(page, "rail-analytics").click();
    await expect.poll(() => app.evaluate(({ webContents }) => {
      const guest = webContents.getAllWebContents().find(w => w.getURL().startsWith("modex-analytics://app/"));
      return guest?.executeJavaScript("document.body.innerText") ?? "";
    })).toContain("1 turn from Claude Code and Codex threads");
    const target = path.join(home, "export.csv");
    const result = await app.evaluate(async ({ webContents }, target) => {
      const guest = webContents.getAllWebContents().find(w => w.getURL().startsWith("modex-analytics://app/"))!;
      return new Promise<string>(resolve => {
        const timer = setTimeout(() => resolve("no download"), 10_000);
        guest.session.once("will-download", (event, item) => {
          if (event.defaultPrevented) { clearTimeout(timer); resolve("cancelled by policy"); return; }
          item.setSavePath(target);
          item.once("done", (_event, state) => { clearTimeout(timer); resolve(state); });
        });
        void guest.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Export CSV')).click()`, true);
      });
    }, target);
    expect(result).toBe("completed");
    const csv = fs.readFileSync(target, "utf8");
    expect(csv).toContain("claude-code");
    expect(csv).toContain("opus");
    expect(csv).toContain("30500");
  } finally {
    await app.close();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
