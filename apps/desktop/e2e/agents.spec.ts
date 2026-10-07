import { test, expect, type ElectronApplication } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { launch, seedHome, tid, items } from "./support";

for (const theme of ["jev", "coven"]) test(`${theme}: live agents remain visible across threads and reload; tools stay compact`, async () => {
  const { home, repo } = seedHome({ theme, default_backend: "claude" });
  let app: ElectronApplication | undefined;
  const stage = path.join(home, "stage");
  const cli = path.join(home, "claude-fixture.cjs");
  fs.writeFileSync(cli, `#!${process.execPath}
const fs = require('node:fs');
if (process.argv.includes('--version')) { console.log('2.1.288 (Claude Code)'); process.exit(0); }
const emit = x => console.log(JSON.stringify(x));
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
 if (JSON.parse(line).type !== 'user') return;
 for (const id of ['a','b']) {
  emit({type:'assistant',message:{content:[{type:'tool_use',id,name:'Agent',input:{description:id==='a'?'Review typography':'Check theme colors'}}]}});
  emit({type:'system',subtype:'task_started',task_id:'task-'+id,tool_use_id:id,task_type:'local_agent',is_backgrounded:true,description:id==='a'?'Review typography':'Check theme colors'});
  emit({type:'user',message:{content:[{type:'tool_result',tool_use_id:id,content:'Launched'}]}});
 }
 emit({type:'system',subtype:'task_progress',task_id:'task-a',summary:'Reading font settings'});
 let done = false;
 const timer = setInterval(() => {
  const state = fs.existsSync(${JSON.stringify(stage)}) ? fs.readFileSync(${JSON.stringify(stage)},'utf8') : '';
  if (state==='one' && !done) { done=true; emit({type:'system',subtype:'task_notification',task_id:'task-a',status:'completed',summary:'Typography checked'}); }
  if (state==='finish') { clearInterval(timer); emit({type:'system',subtype:'task_notification',task_id:'task-b',status:'failed',summary:'Usage limit'}); emit({type:'result',is_error:false}); }
 }, 50);
});
`, { mode: 0o755 });
  const statePath = path.join(home, "app/state.json");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  state.settings.claude_bin = cli;
  state.threads = [{ id: "other", projectId: "p1", title: "Another task", backend: "mock", model: "mock", mode: "chat", plan: false, status: "idle", cwd: repo, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }];
  fs.writeFileSync(statePath, JSON.stringify(state));
  try {
    const opened = await launch(home); app = opened.app;
    const page = opened.page;
    await tid(page, "new-chat").click();
    await expect(tid(page, "draft-view")).toBeVisible();
    await tid(page, "composer-input").fill("Review the UI");
    await tid(page, "send").click();
    const agentRows = tid(page, "active-agent");
    await expect(agentRows).toHaveCount(2);
    await expect(agentRows.first()).toContainText("Review typography");
    await expect(agentRows.first()).toContainText("Reading font settings");
    await expect(tid(page, "rail-work")).toHaveAttribute("aria-label", /2 agents/);
    await expect(items(page, "tool").first().getByRole("button")).toHaveAttribute("aria-expanded", "false");
    const parentId = await tid(page, "thread-view").getAttribute("data-thread-id");
    await page.locator('[data-thread-id="other"] .thread-main').click();
    await expect(tid(page, "thread-view")).toHaveAttribute("data-thread-id", "other");
    await expect(agentRows).toHaveCount(2);
    await page.keyboard.press("Meta+n");
    await expect(tid(page, "draft-view")).toBeVisible();
    await expect(agentRows).toHaveCount(2);
    await agentRows.first().click();
    await expect(tid(page, "thread-view")).toHaveAttribute("data-thread-id", parentId!);
    await page.reload();
    await expect(agentRows).toHaveCount(2);
    await tid(page, "sidebar-toggle").click();
    await tid(page, "rail-work").click();
    await expect(tid(page, "sidebar")).toBeVisible();
    await expect(agentRows).toHaveCount(2);
    await expect(tid(page, "workspace")).toHaveCSS("background-color", theme === "jev" ? "rgb(11, 15, 27)" : "rgb(28, 27, 29)");
    const styles = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      const workspace = getComputedStyle(document.querySelector('[data-testid="workspace"]')!);
      const agent = getComputedStyle(document.querySelector(".agent-name")!);
      return { accent: workspace.getPropertyValue("--accent").trim(), expectedAccent: root.getPropertyValue("--accent").trim(), font: agent.fontFamily, size: parseFloat(agent.fontSize) };
    });
    expect(styles.accent).toBe(styles.expectedAccent);
    expect(styles.font).toContain("-apple-system"); expect(styles.size).toBeGreaterThanOrEqual(12);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(agentRows.first().locator(".row-status")).toHaveCSS("animation-name", "none");
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1000, 720));
    await expect(agentRows.first()).toBeVisible();
    expect(await tid(page, "sidebar").evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`${theme}-active-agents.png`) });
    fs.writeFileSync(stage, "one");
    await expect(agentRows).toHaveCount(1);
    await expect(agentRows).toContainText("Check theme colors");
    fs.writeFileSync(stage, "finish");
    await expect(agentRows).toHaveCount(0);
    const failed = items(page, "tool").filter({ hasText: "Check theme colors" });
    await expect(failed).toHaveAttribute("data-ok", "false");
    const toggle = tid(failed, "item-toggle");
    await toggle.focus(); await page.keyboard.press("Enter");
    await expect(tid(failed, "item-body")).toContainText("Usage limit");
    await failed.getByText("Arguments", { exact: true }).click();
    await expect(tid(failed, "tool-arguments")).toBeVisible();
    await expect(tid(failed, "tool-arguments")).toContainText("Check theme colors");
    await toggle.focus(); await page.keyboard.press("Enter");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(await toggle.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.screenshot({ path: test.info().outputPath(`${theme}-agent-results.png`) });
  } finally { await app?.close(); fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(repo, { recursive: true, force: true }); }
});
