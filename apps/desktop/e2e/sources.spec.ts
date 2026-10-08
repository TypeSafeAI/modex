import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { currentRow, items, launch, seedHome, tid } from "./support";

/**
 * Web answers read as web answers: links in prose are links, a trailing "Sources:" list becomes
 * numbered cards, and a WebSearch call shows what it found instead of the CLI's raw JSON. A link
 * is handed to the system browser; the app window itself never navigates.
 */
let app: ElectronApplication;
let page: Page;
let home: string;
let repo: string;

const ANNOUNCEMENT = "https://www.anthropic.com/news/claude-sonnet-5-5";
const WIKI = "https://en.wikipedia.org/wiki/Claude_(language_model)";
const ANSWER = [
  `Sonnet 5.5 is the newest Sonnet ([announcement](${ANNOUNCEMENT})). Pricing is at https://example.com/pricing.`,
  "",
  "Sources:",
  `- [Introducing Claude Sonnet 5.5](${ANNOUNCEMENT})`,
  `- [Claude (language model)](${WIKI})`,
].join("\n");

test.beforeAll(async () => {
  ({ home, repo } = seedHome());
  ({ app, page } = await launch(home));
  const script = path.join(home, "sources-script.json");
  fs.writeFileSync(script, JSON.stringify([{ content: ANSWER }]));
  await page.evaluate((mock_script) => window.modex!.invoke("settings:update", { mock_script }), script);
  await page.keyboard.press("Meta+n");
  await expect(tid(page, "draft-view")).toBeVisible();
  await expect(tid(page, "composer-input")).toBeFocused();
  await tid(page, "composer-input").fill("what is the latest sonnet model?");
  await page.keyboard.press("Meta+Enter");
  await expect(tid(page, "thread-view")).toBeVisible({ timeout: 15_000 });
  await expect(items(page, "assistant")).toHaveCount(1);
  await expect(currentRow(page)).toHaveAttribute("data-status", "idle");
});

test.afterAll(async () => {
  await app?.close();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

test("links in an answer are links, and its Sources list becomes numbered cards", async () => {
  const answer = items(page, "assistant").first();
  await expect(answer.getByRole("link", { name: "announcement" })).toHaveAttribute("href", ANNOUNCEMENT);
  // The sentence's full stop stays outside the bare URL.
  await expect(answer.getByRole("link", { name: "https://example.com/pricing", exact: true })).toHaveAttribute("href", "https://example.com/pricing");

  const sources = tid(answer, "sources");
  await expect(sources).toContainText("Sources · 2");
  const cards = tid(sources, "source-link");
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(0)).toHaveAttribute("href", ANNOUNCEMENT);
  await expect(cards.nth(0)).toContainText("Introducing Claude Sonnet 5.5");
  await expect(cards.nth(0)).toContainText("anthropic.com");
  await expect(cards.nth(1)).toHaveAttribute("href", WIKI);
  await expect(cards.nth(1)).toContainText("en.wikipedia.org");
  // The list is shown once: as cards, not also as the Markdown it was written in.
  await expect(answer).not.toContainText("Sources:");
  await expect(answer.getByRole("link")).toHaveCount(4);
});

test("a link opens in the system browser and the app stays where it is", async () => {
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]!.webContents.setWindowOpenHandler(({ url }) => {
      ((globalThis as any).__openedLinks ??= []).push(url);
      return { action: "deny" };
    });
  });
  const answer = items(page, "assistant").first();
  await answer.getByRole("link", { name: "announcement" }).click();
  await tid(answer, "source-link").nth(1).click();
  await expect.poll(() => app.evaluate(() => (globalThis as any).__openedLinks)).toEqual([ANNOUNCEMENT, WIKI]);
  expect(app.windows()).toHaveLength(1);
  await expect(tid(page, "thread-view")).toBeVisible();
  await expect(items(page, "assistant")).toHaveCount(1);
});

test("a web search shows its results and summary, not the CLI's raw output", async () => {
  const threadId = await currentRow(page).getAttribute("data-thread-id");
  const output = [
    'Web search results for query: "latest Claude Sonnet model"',
    "",
    `Links: ${JSON.stringify([{ title: "Introducing Claude Sonnet 5.5", url: ANNOUNCEMENT }, { title: "Claude (language model)", url: WIKI }])}`,
    "",
    "Sonnet 5.5 replaces **Sonnet 5** as the mid-sized model.",
    "",
    "REMINDER: You MUST include the sources above in your response to the user using markdown hyperlinks.",
  ].join("\n");
  const tool = (id: string, name: string, title: string, args: Record<string, unknown>, out: string, ok = true) =>
    ({ type: "item", threadId, item: { id, kind: "tool", name, title, args, output: out, ok, status: "done", durationMs: 1200, at: new Date().toISOString() } });
  await app.evaluate(({ BrowserWindow }, events) => {
    for (const event of events) BrowserWindow.getAllWindows()[0]!.webContents.send("thread:event", event);
  }, [
    tool("web-search", "WebSearch", "search latest Claude Sonnet model", { query: "latest Claude Sonnet model" }, output),
    tool("web-fetch", "WebFetch", `fetch ${ANNOUNCEMENT}`, { url: ANNOUNCEMENT, prompt: "summarise" }, "# Sonnet 5.5\n\nFaster, and **cheaper** for most work."),
    tool("web-search-failed", "WebSearch", "search nothing", { query: "nothing" }, "Error: web search is unavailable", false),
    tool("plain", "shell", "$ ls", { command: "ls" }, "README.md"),
  ]);

  const search = items(page, "tool").filter({ hasText: "search latest Claude Sonnet model" });
  await expect(tid(search, "tool-meta")).toHaveText("2 results · 1.2s");
  await tid(search, "item-toggle").click();
  const results = tid(search, "search-result");
  await expect(results).toHaveCount(2);
  await expect(results.nth(0)).toHaveAttribute("href", ANNOUNCEMENT);
  await expect(results.nth(0)).toContainText("Introducing Claude Sonnet 5.5");
  await expect(results.nth(1)).toHaveAttribute("href", WIKI);
  await expect(tid(search, "search-summary")).toHaveText("Sonnet 5.5 replaces Sonnet 5 as the mid-sized model.");
  await expect(tid(search, "item-body")).not.toContainText("Links:");
  await expect(tid(search, "item-body")).not.toContainText("REMINDER");

  // A fetch links the page it read and renders what came back as prose.
  const fetched = items(page, "tool").filter({ hasText: `fetch ${ANNOUNCEMENT}` });
  await expect(tid(fetched, "tool-meta")).toHaveText("done · 1.2s");
  await tid(fetched, "item-toggle").click();
  await expect(tid(fetched, "tool-link")).toHaveAttribute("href", ANNOUNCEMENT);
  await expect(tid(fetched, "tool-output").getByRole("heading", { name: "Sonnet 5.5" })).toBeVisible();
  await expect(tid(fetched, "tool-output")).not.toContainText("**");

  // Anything that is not a result list is shown as the CLI wrote it; other tools are unchanged.
  const failed = items(page, "tool").filter({ hasText: "search nothing" });
  await expect(tid(failed, "tool-meta")).toHaveText("failed · 1.2s");
  await tid(failed, "item-toggle").click();
  await expect(tid(failed, "tool-output")).toHaveText("Error: web search is unavailable");
  const shell = items(page, "tool").filter({ hasText: "$ ls" });
  await expect(tid(shell, "tool-meta")).toHaveText("done · 1.2s");
  await tid(shell, "item-toggle").click();
  await expect(tid(shell, "tool-output")).toHaveText("README.md");
});


test("annotations and multiple citations remain visible in the answer", async () => {
  const threadId = await currentRow(page).getAttribute("data-thread-id");
  const text = "Check the compatibility note.\n\nSources:\n- [Guide](https://a.example/) [Mirror](https://b.example/) — applies only to v2; v1 is unsupported.";
  await app.evaluate(({ BrowserWindow }, event) => {
    BrowserWindow.getAllWindows()[0]!.webContents.send("thread:event", event);
  }, { type: "item", threadId, item: { id: "annotated-answer", kind: "assistant", text, at: new Date().toISOString() } });
  const answer = items(page, "assistant").filter({ hasText: "applies only to v2" });
  await expect(answer).toContainText("v1 is unsupported.");
  await expect(answer.getByRole("link", { name: "Guide", exact: true })).toHaveAttribute("href", "https://a.example/");
  await expect(answer.getByRole("link", { name: "Mirror", exact: true })).toHaveAttribute("href", "https://b.example/");
  await expect(tid(answer, "sources")).toHaveCount(0);
});
