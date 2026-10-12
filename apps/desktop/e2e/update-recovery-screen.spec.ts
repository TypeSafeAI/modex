import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { launch, seedHome, tid } from "./support";

for (const outcome of ["uncertain", "staged"] as const) test(`interrupted ${outcome} update preserves raw drafts read-only and permits recovery Quit`, async () => {
  const seeded = seedHome(), home = fs.realpathSync(seeded.home), repo = seeded.repo;
  const file = path.join(home, "app", "update-recovery.json");
  const receipt = { schema: 2, revision: 1, drafts: {
    threads: [{ threadId: "past-thread", text: "  Preserve the thread draft\n", attachments: [] }], selectedThreadId: "past-thread",
    projects: [{ key: "draft:0:p1", projectId: "p1", text: "  Preserve the unsent worktree draft 😀  ", attachments: [] }],
    draft: { revision: 0, projectId: "p1", worktree: true, settings: { backend: "mock", mode: "chat", model: "mock", plan: false, auto: false } },
  }, attempt: { id: randomUUID(), from: "0.0.10", to: "999.0.0", sha512: Buffer.alloc(64, 4).toString("base64"), startedAt: new Date().toISOString(), outcome } };
  fs.writeFileSync(file, JSON.stringify(receipt)); const before = fs.readFileSync(file);
  const { app, page } = await launch(home); let closed = false; app.on("close", () => { closed = true; });
  console.log(JSON.stringify({ fixtureHome: home, fixtureRepo: repo, electronPid: app.process().pid }));
  try {
    await expect(tid(page, "update-recovery")).toBeVisible({ timeout: 5000 });
    await expect(page.getByLabel("New chat draft for p1", { exact: true })).toHaveValue(receipt.drafts.projects[0]!.text);
    await expect(page.getByLabel("Draft for past-thread", { exact: true })).toHaveValue(receipt.drafts.threads[0]!.text);
    await expect(page.getByLabel("New chat draft for p1", { exact: true })).toHaveAttribute("readonly", "");
    await expect(tid(page, "composer-input")).toHaveCount(0);
    expect(await page.evaluate(async () => {
      try { await window.modex!.invoke("thread:create", { projectId: "p1" }); return "allowed"; }
      catch (error) { return String(error); }
    })).toMatch(/update|recovery|preserved/i);
    await page.keyboard.press("Meta+n"); await expect(tid(page, "composer-input")).toHaveCount(0);
    expect(await page.evaluate(() => {
      const event = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented;
    })).toBe(false);
    expect(fs.readFileSync(file)).toEqual(before);
    await expect(page.getByRole("link", { name: "Open release page" })).toHaveAttribute("href", "https://github.com/TypeSafeAI/modex/releases/tag/v999.0.0");
    await expect(page.getByRole("button", { name: "Restart Modex", exact: true })).toHaveCount(0);
    const exited = app.waitForEvent("close");
    await page.getByRole("button", { name: "Quit Modex", exact: true }).click(); await exited;
    expect(fs.readFileSync(file)).toEqual(before);
  } finally {
    if (!closed) { await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close(); }
    fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("unreadable recovery preserves the original file and permits recovery Quit", async () => {
  const seeded = seedHome(), home = fs.realpathSync(seeded.home), repo = seeded.repo;
  const file = path.join(home, "app", "update-recovery.json"); fs.writeFileSync(file, "unsupported recovery bytes");
  const { app, page } = await launch(home); let closed = false; app.on("close", () => { closed = true; });
  console.log(JSON.stringify({ fixtureHome: home, fixtureRepo: repo, electronPid: app.process().pid }));
  try {
    await expect(tid(page, "update-recovery")).toContainText("preserved", { timeout: 5000 });
    await expect(page.getByRole("button", { name: "Open recovery folder" })).toBeEnabled();
    await expect(tid(page, "composer-input")).toHaveCount(0);
    expect(fs.readFileSync(file, "utf8")).toBe("unsupported recovery bytes");
    const exited = app.waitForEvent("close");
    await page.getByRole("button", { name: "Quit Modex", exact: true }).click(); await exited;
    expect(fs.readFileSync(file, "utf8")).toBe("unsupported recovery bytes");
  } finally {
    if (!closed) { await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close(); }
    fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("a failed ordinary Quit reopens read-only after partial service disposal and can retry Quit", async () => {
  const seeded = seedHome(), home = fs.realpathSync(seeded.home), repo = seeded.repo;
  const { app, page } = await launch(home); let closed = false; app.on("close", () => { closed = true; });
  console.log(JSON.stringify({ fixtureHome: home, fixtureRepo: repo, electronPid: app.process().pid }));
  const file = path.join(home, "app", "update-recovery.json"), raw = "  Saved through partial ordinary Quit 😀  ";
  try {
    await tid(page, "composer-input").fill(raw);
    await expect.poll(() => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")).drafts?.projects?.[0]?.text : null).toBe(raw);
    await app.evaluate(({ app, dialog }) => {
      const require = process.getBuiltinModule("module").createRequire(`${app.getAppPath()}/package.json`);
      const { PagesAgents } = require("./dist/src/main/engine/pages-agents.js");
      const { ThreadRunner } = require("./dist/src/main/engine/runner.js");
      const { TerminalManager } = require("./dist/src/main/engine/terminal.js");
      const probe = { pages: 0, runner: 0, terminals: 0, errors: 0 };
      (globalThis as unknown as { quitProbe: typeof probe }).quitProbe = probe;
      const disposePages = PagesAgents.prototype.dispose, disposeRunner = ThreadRunner.prototype.dispose, disposeTerminals = TerminalManager.prototype.dispose;
      PagesAgents.prototype.dispose = async function () {
        probe.pages++; if (probe.pages === 1) throw new Error("Injected partial shutdown");
        return disposePages.call(this);
      };
      ThreadRunner.prototype.dispose = async function () { await disposeRunner.call(this); probe.runner++; };
      TerminalManager.prototype.dispose = async function () { await disposeTerminals.call(this); probe.terminals++; };
      dialog.showErrorBox = () => { probe.errors++; };
    });
    const firstWindowClosed = page.waitForEvent("close");
    await app.evaluate(({ app }) => app.quit()); await firstWindowClosed;
    await expect.poll(() => app.evaluate(() => (globalThis as unknown as { quitProbe: { pages: number; runner: number; terminals: number; errors: number } }).quitProbe))
      .toEqual({ pages: 1, runner: 1, terminals: 1, errors: 1 });
    const before = fs.readFileSync(file), opened = app.waitForEvent("window");
    await app.evaluate(({ app }) => app.emit("activate"));
    const recoveryPage = await opened; await recoveryPage.waitForLoadState("domcontentloaded");
    await expect(tid(recoveryPage, "update-recovery")).toBeVisible();
    await expect(recoveryPage.getByLabel("New chat draft for p1", { exact: true })).toHaveValue(raw);
    await expect(tid(recoveryPage, "composer-input")).toHaveCount(0);
    expect(await recoveryPage.evaluate(async () => {
      try { await window.modex!.invoke("thread:create", { projectId: "p1" }); return "allowed"; }
      catch (error) { return String(error); }
    })).toMatch(/restart|recover/i);
    expect(fs.readFileSync(file)).toEqual(before);
    const exited = app.waitForEvent("close");
    await recoveryPage.getByRole("button", { name: "Quit Modex", exact: true }).click(); await exited;
    expect(fs.readFileSync(file)).toEqual(before);
  } finally {
    if (!closed) { await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close(); }
    fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(repo, { recursive: true, force: true });
  }
});
