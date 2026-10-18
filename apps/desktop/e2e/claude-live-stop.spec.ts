import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch, seedHome, tid, items } from "./support";

// Live acceptance for #275: the real `claude -p` and a real model, driven through the app. Each run spends usage on
// the signed-in Claude account, so it runs only with MODEX_CLAUDE_LIVE=1. MODEX_CLAUDE_BIN picks the executable
// (default ~/.local/bin/claude) and MODEX_CLAUDE_MODEL the model (default haiku). Start it from a shell without
// CLAUDE*/ANTHROPIC* variables, so the CLI does not run as a nested session. MODEX_LIVE_REPORT names a file for the
// timings and outcomes it observed.
test.skip(process.env.MODEX_CLAUDE_LIVE !== "1", "live Claude acceptance is opt-in (MODEX_CLAUDE_LIVE=1)");

type Item = { id: string; kind: string; text?: string; level?: string; answer?: string; withdrawn?: string; status?: string; outcome?: string; failure?: unknown };
const currentRow = (page: Page) => page.locator('[data-testid="thread-row"][aria-current="true"]');
const threadItems = async (page: Page): Promise<Item[]> => {
  const threadId = await currentRow(page).getAttribute("data-thread-id");
  return page.evaluate((id) => window.modex!.invoke("thread:items", { threadId: id }), threadId) as Promise<Item[]>;
};
async function newChat(page: Page, text: string): Promise<void> {
  await page.keyboard.press("Meta+n");
  await expect(tid(page, "draft-view")).toBeVisible();
  await tid(page, "composer-input").fill(text);
  await tid(page, "send").click();
}
/** Stop, then how long until the thread was idle again and what the turn's last notice said. */
async function stop(page: Page): Promise<{ ms: number; notice: string | undefined; failures: number }> {
  const at = Date.now();
  await tid(page, "stop").click();
  await expect(currentRow(page)).toHaveAttribute("data-status", "idle", { timeout: 20_000 });
  const ms = Date.now() - at;
  const list = await threadItems(page);
  return { ms, notice: list.filter((i) => i.kind === "notice").at(-1)?.text, failures: list.filter((i) => i.kind === "notice" && i.failure).length };
}

test("live Claude: Stop with a waiting card, Stop mid-command, resume after Stop, Stop mid-stream", async () => {
  test.setTimeout(420_000);
  const bin = process.env.MODEX_CLAUDE_BIN ?? path.join(os.homedir(), ".local/bin/claude");
  const model = process.env.MODEX_CLAUDE_MODEL ?? "haiku";
  const { home, repo } = seedHome({ default_backend: "claude", default_mode: "chat", default_model: { codex: "", claude: model, mock: "mock" } });
  const statePath = path.join(home, "app/state.json");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  state.settings.claude_bin = bin;
  fs.writeFileSync(statePath, JSON.stringify(state));
  const report: Record<string, unknown> = { bin, version: execFileSync(bin, ["--version"]).toString().trim(), model, at: new Date().toISOString() };
  let app: ElectronApplication | undefined;
  try {
    const opened = await launch(home); app = opened.app;
    const page = opened.page;

    // 1. Stop while a permission card waits: the card closes as stopped and the command never runs.
    await newChat(page, "Use the Bash tool to run exactly this command and nothing else: touch live-a.txt");
    const card = items(page, "approval").last();
    await expect(card.getByRole("button", { name: "Approve" })).toBeVisible({ timeout: 120_000 });
    const pendingStop = await stop(page);
    report.pendingCard = pendingStop;
    await expect(tid(card, "approval-answer")).toHaveText("Not answered — the turn was stopped");
    expect(pendingStop.failures).toBe(0);
    expect(pendingStop.notice).toMatch(/^Stopped\./);
    expect(fs.existsSync(path.join(repo, "live-a.txt"))).toBe(false);

    // 2. Approve a long command, then Stop while it runs: the call ends Stopped and its file is never written.
    // (Claude Code itself refuses a long foreground `sleep`, so the wait is in Python.)
    await newChat(page, `Use the Bash tool to run exactly this command and nothing else: python3 -c "import time; time.sleep(30); open('live-b.txt', 'w')"`);
    const second = items(page, "approval").last();
    await second.getByRole("button", { name: "Approve" }).click({ timeout: 120_000 });
    await expect(tid(second, "approval-answer")).toHaveText("Approved");
    await page.waitForTimeout(3000);
    const runningStop = await stop(page);
    const tools = (await threadItems(page)).filter((i) => i.kind === "tool");
    const tool = tools.at(-1);
    report.runningTool = { ...runningStop, tools: tools.map((t) => ({ title: (t as { title?: string }).title, status: t.status, outcome: t.outcome })) };
    expect(runningStop.failures).toBe(0);
    expect(runningStop.notice).toMatch(/^Stopped\./);
    expect(tool?.status).toBe("done");
    expect(tool?.outcome, "the call Stop interrupted reads interrupted").toBe("interrupted");
    await page.waitForTimeout(31_000);
    expect(fs.existsSync(path.join(repo, "live-b.txt")), "the stopped command never finished").toBe(false);

    // 3. The stopped thread answers its next message: its session resumes cleanly after the interrupt.
    const before = (await threadItems(page)).filter((i) => i.kind === "assistant").length;
    await tid(page, "composer-input").fill("Reply with the single word: resumed");
    await tid(page, "send").click();
    await expect.poll(async () => (await threadItems(page)).filter((i) => i.kind === "assistant").length, { timeout: 120_000 }).toBeGreaterThan(before);
    await expect(currentRow(page)).toHaveAttribute("data-status", "idle", { timeout: 120_000 });
    const resumed = await threadItems(page);
    report.resume = { reply: resumed.filter((i) => i.kind === "assistant").at(-1)?.text, failures: resumed.filter((i) => i.kind === "notice" && i.failure).length };
    expect(resumed.filter((i) => i.kind === "assistant").at(-1)?.text ?? "").toMatch(/resumed/i);

    // 4. Stop while the reply streams: the text so far is kept, and nothing reads as a failure.
    // Long enough that Stop lands while it streams, so the turn is really stopped rather than already done.
    await newChat(page, "Write a 2000-word story about a lighthouse keeper, in plain prose. Do not use any tools.");
    await expect(items(page, "assistant").last()).toBeVisible({ timeout: 120_000 });
    const streamingStop = await stop(page);
    const story = (await threadItems(page)).filter((i) => i.kind === "assistant").at(-1);
    report.streaming = { ...streamingStop, keptChars: story?.text?.length ?? 0 };
    expect(streamingStop.failures).toBe(0);
    expect(streamingStop.notice, "Stop ended the streaming turn").toMatch(/^Stopped\./);
    expect(story?.text?.length ?? 0).toBeGreaterThan(0);
    await page.screenshot({ path: test.info().outputPath("claude-live-stop.png") });
  } finally {
    const out = JSON.stringify(report, null, 2);
    fs.writeFileSync(test.info().outputPath("live-report.json"), out);
    if (process.env.MODEX_LIVE_REPORT) fs.writeFileSync(process.env.MODEX_LIVE_REPORT, out);
    if (app) await app.close();
    // Keep what the app recorded, for the evidence receipt.
    if (fs.existsSync(path.join(home, "app/threads"))) fs.cpSync(path.join(home, "app/threads"), test.info().outputPath("threads"), { recursive: true });
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
