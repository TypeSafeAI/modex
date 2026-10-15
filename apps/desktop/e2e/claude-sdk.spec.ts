import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { appDir, currentRow, items, launch, seedHome, tid } from "./support";

test("real Claude SDK: approvals, withdrawal, Stop and CLI failure work through Electron", async () => {
  const { home, repo } = seedHome({ default_backend: "claude" });
  const cli = path.join(home, "sdk-cli.cjs");
  fs.writeFileSync(cli, `#!${process.execPath}\n` + fs.readFileSync(path.join(appDir, "e2e/fixtures/sdk-cli.cjs"), "utf8"), { mode: 0o755 });
  const stateFile = path.join(home, "app/state.json");
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  state.settings.claude_bin = cli;
  fs.writeFileSync(stateFile, JSON.stringify(state));
  const { app, page } = await launch(home);
  const events = () => fs.readFileSync(path.join(home, "sdk-events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const send = async (text: string) => { await tid(page, "composer-input").fill(text); await tid(page, "send").click(); };
  try {
    await send("Approve locally");
    const approval = items(page, "approval").first();
    await expect(approval).toBeVisible();
    expect(events().some((e) => e.initialize === true)).toBe(true);
    await expect(items(page, "tool").first()).toContainText("sdk-approved.txt");
    expect(fs.existsSync(path.join(repo, "sdk-approved.txt"))).toBe(false);
    await approval.getByRole("button", { name: "Approve", exact: true }).click();
    await expect(currentRow(page)).toHaveAttribute("data-status", "idle");
    await expect(items(page, "assistant").last()).toContainText("Approved command completed.");
    expect(fs.readFileSync(path.join(repo, "sdk-approved.txt"), "utf8")).toBe("approved\n");

    await send("Withdraw locally");
    const withdrawn = items(page, "approval").last();
    await expect(withdrawn.getByRole("button", { name: "Approve", exact: true })).toBeVisible();
    fs.writeFileSync(path.join(home, "withdraw"), "go");
    await expect(tid(withdrawn, "approval-answer")).toHaveText("Denied");
    await expect(currentRow(page)).toHaveAttribute("data-status", "running");
    fs.writeFileSync(path.join(home, "finish-withdraw"), "go");
    await expect(currentRow(page)).toHaveAttribute("data-status", "idle");
    expect(events().some((e) => e.prompt === "Withdraw locally" && e.response)).toBe(false);

    await send("Stop locally");
    await expect(items(page, "assistant").last()).toContainText("Counting locally");
    await tid(page, "stop").click();
    await expect(currentRow(page)).toHaveAttribute("data-status", "idle");
    expect(events()).toEqual(expect.arrayContaining([
      expect.objectContaining({ prompt: "Stop locally", interrupt: true }),
      expect.objectContaining({ prompt: "Stop locally", stdinClosed: true }),
    ]));

    await send("Fail locally");
    await expect(currentRow(page)).toHaveAttribute("data-status", "error");
    await expect(items(page, "notice").last()).toContainText("fixture CLI failure");
    const threadId = await tid(page, "thread-view").getAttribute("data-thread-id");
    expect(fs.readFileSync(path.join(home, "app/threads", `${threadId}.json`), "utf8")).toMatch(/"exitCode"\s*:\s*7/);
    await page.screenshot({ path: test.info().outputPath("claude-sdk-local-acceptance.png") });
  } finally {
    await app.close();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
