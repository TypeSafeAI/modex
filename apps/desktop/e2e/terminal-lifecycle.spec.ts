import { test, expect, type ElectronApplication } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { launch, seedHome, tid } from "./support";

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
function alive(pid: number): boolean {
  expect(Number.isSafeInteger(pid) && pid > 1).toBe(true);
  try { process.kill(pid, 0); return true; } catch { return false; }
}

test("terminal sizing reports its actual container limit after a window resize", async () => {
  const { home, repo } = seedHome();
  const { app, page } = await launch(home);
  try {
    await page.evaluate(() => window.modex!.invoke("thread:create", { projectId: "p1", backend: "mock", mode: "chat" }));
    await page.reload();
    await tid(page, "terminal-toggle").click();
    const handle = tid(page, "terminal-resize");
    await handle.focus();
    for (let i = 0; i < 30; i++) await page.keyboard.press("ArrowUp");
    for (const [width, height] of [[1380, 880], [900, 600]]) {
      await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]!.setContentSize(size.width, size.height), { width, height });
      await expect.poll(async () => {
        const limit = await tid(page, "terminal-panel").evaluate((panel) => Math.floor(panel.parentElement!.clientHeight / 2));
        return Number(await handle.getAttribute("aria-valuemax")) - limit;
      }).toBe(0);
      await expect.poll(async () => Number(await handle.getAttribute("aria-valuenow")) - (await tid(page, "terminal-panel").boundingBox())!.height).toBe(0);
    }
    await page.screenshot({ path: test.info().outputPath("terminal-minimum-window.png") });
  } finally {
    await app.close();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

for (const action of ["close", "thread deletion", "project removal", "quit"] as const) {
  test(`${action} waits for terminal commands before removing their context`, async () => {
    const { home, repo } = seedHome();
    let app: ElectronApplication | undefined;
    let pid: number | undefined;
    const pidFile = path.join(home, "terminal.pid");
    const fixture = path.join(home, "terminal-worker.cjs");
    fs.writeFileSync(fixture, `process.on('SIGHUP', () => {}); process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 100);`);
    try {
      const launched = await launch(home);
      app = launched.app;
      const page = launched.page;
      const thread = await page.evaluate(() => window.modex!.invoke("thread:create", { projectId: "p1", backend: "mock", mode: "chat", worktree: true }));
      const session = await page.evaluate((threadId) => window.modex!.invoke("terminal:open", { threadId, cols: 80, rows: 24 }), thread.id);
      await page.evaluate(({ threadId, sessionId, data }) => window.modex!.invoke("terminal:write", { threadId, sessionId, data }), {
        threadId: thread.id, sessionId: session.sessionId, data: `${quote(process.execPath)} ${quote(fixture)}\r`,
      });
      await expect.poll(() => {
        const value = fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, "utf8")) : 0;
        if (!Number.isSafeInteger(value) || value <= 1) return false;
        pid = value;
        return true;
      }).toBe(true);
      expect(alive(pid!)).toBe(true);
      if (action === "quit") await app.close();
      else if (action === "thread deletion") await page.evaluate((threadId) => window.modex!.invoke("thread:delete", { threadId, removeWorktree: true }), thread.id);
      else if (action === "project removal") await page.evaluate(() => window.modex!.invoke("project:remove", { projectId: "p1" }));
      else await page.evaluate(({ threadId, sessionId }) => window.modex!.invoke("terminal:close", { threadId, sessionId }), { threadId: thread.id, sessionId: session.sessionId });
      expect(alive(pid!), `${action} completed with a terminal command still alive`).toBe(false);
      if (action === "thread deletion") expect(fs.existsSync(thread.cwd)).toBe(false);
      if (action === "project removal") {
        const state = JSON.parse(fs.readFileSync(path.join(home, "app/state.json"), "utf8"));
        expect(state.projects).toHaveLength(0);
        expect(state.threads).toHaveLength(0);
      }
    } finally {
      if (pid && alive(pid)) process.kill(pid, "SIGKILL");
      await app?.close();
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
}
