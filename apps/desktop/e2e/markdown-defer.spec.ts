import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { items, launch, seedHome, tid } from "./support";

/**
 * Long threads parse only the Markdown near the view (`DeferMarkdown`, Markdown.tsx): the newest
 * turns at once, older answers as written until they scroll near, then parsed for good. Parsing
 * above the view must not move what the reader is looking at.
 */
let app: ElectronApplication | undefined;
let home = "", repo = "";

test.afterEach(async () => {
  await app?.close().catch(() => {});
  app = undefined;
  for (const dir of [home, repo]) if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

const TURNS = 40;

async function openLongThread(): Promise<Page> {
  ({ home, repo } = seedHome());
  const threadId = "long";
  const at = new Date(Date.now() - TURNS * 60_000).toISOString();
  const saved: Record<string, unknown>[] = [];
  for (let turn = 0; turn < TURNS; turn++) {
    const origin = { thread: threadId, turn: `u-${turn}`, attempt: `a-${turn}`, backend: "codex", native: { runtime: "R", thread: "nt", turn: `nu-${turn}`, item: `f-${turn}` } };
    saved.push({ id: `u-${turn}`, kind: "user", text: `Request ${turn}`, at });
    saved.push({ id: `f-${turn}`, kind: "assistant", text: `Answer **${turn}**.\n\n${"A paragraph of explanation that wraps. ".repeat(12)}\n\n\`\`\`ts\nexport const value${turn} = ${turn};\n\`\`\``,
      phase: "final", nativePhase: "final_answer", outcome: "succeeded", origin, at });
  }
  fs.writeFileSync(path.join(home, "app", "threads", `${threadId}.json`), JSON.stringify(saved));
  const statePath = path.join(home, "app", "state.json");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  const now = new Date().toISOString();
  state.threads = [{ id: threadId, projectId: "p1", title: "Long", titleSource: "manual", createdAt: now, updatedAt: now, cwd: repo, backend: "codex", mode: "chat", plan: false, model: "", status: "idle" }];
  fs.writeFileSync(statePath, JSON.stringify(state));
  let page: Page;
  ({ app, page } = await launch(home));
  await page.locator(`[data-testid="thread-row"][data-thread-id="${threadId}"] button.thread-main`).click();
  await expect(items(page, "assistant")).toHaveCount(TURNS);
  return page;
}

test("a long thread parses its newest answers at once and older ones as they near the view", async () => {
  const page = await openLongThread();
  const answers = items(page, "assistant");
  // The newest answer is parsed Markdown, not text as written.
  await expect(answers.last().locator("strong")).toHaveText(String(TURNS - 1));
  await expect(answers.last().locator("[data-markdown-deferred]")).toHaveCount(0);
  // The oldest is far above the view: its text is all there, as written, until it nears.
  const first = answers.first();
  await expect(first.locator("[data-markdown-deferred]")).toHaveCount(1);
  await expect(first).toContainText("Answer **0**.");
  // Scrolling to the top parses it, and it stays parsed after scrolling back down.
  await tid(page, "transcript").evaluate((el) => { el.scrollTop = 0; });
  await expect(first.locator("strong")).toHaveText("0");
  await expect(first.locator("pre code")).toContainText("export const value0 = 0;");
  await tid(page, "transcript").evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await expect(first.locator("[data-markdown-deferred]")).toHaveCount(0);
});

test("answers parsing above the view do not move the answer being read", async () => {
  const page = await openLongThread();
  const answers = items(page, "assistant");
  // Bring a still-deferred middle answer into view; the answers around it parse as it arrives.
  const middle = answers.nth(Math.floor(TURNS / 3));
  await expect(middle.locator("[data-markdown-deferred]")).toHaveCount(1);
  // Its position is read in the same task as the scroll, before any of those parses run.
  const before = await middle.evaluate((el) => { el.scrollIntoView({ block: "start" }); return el.getBoundingClientRect().top; });
  await expect(middle.locator("[data-markdown-deferred]")).toHaveCount(0);
  // The answers above it parse too, and grow; the reader's answer stays where it was.
  await expect(answers.nth(Math.floor(TURNS / 3) - 3).locator("[data-markdown-deferred]")).toHaveCount(0);
  await page.waitForTimeout(300);
  const after = await middle.evaluate((el) => el.getBoundingClientRect().top);
  expect(Math.abs(after - before), `moved from ${before} to ${after}`).toBeLessThanOrEqual(2);
});
