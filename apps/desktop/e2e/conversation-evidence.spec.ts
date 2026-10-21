import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { currentRow, items, launch, seedHome, tid } from "./support";

/**
 * What a turn's evidence shows (docs/conversation-evidence.md): the command that actually ran and how
 * it ended, output bounded with a visible note, a patch labelled as this turn's, a native memory
 * citation, and model-written links labelled as such. Items are sent to the window as main would.
 */
let app: ElectronApplication;
let page: Page;
let home: string;
let repo: string;
let threadId: string;

const at = () => new Date().toISOString();
const origin = (item: string) => ({ thread: threadId, turn: "u-evidence", attempt: "E1", backend: "codex", native: { runtime: "R", thread: "nt", turn: "nu", item } });
async function send(events: Record<string, unknown>[]): Promise<void> {
  await app.evaluate(({ BrowserWindow }, list) => {
    for (const event of list) BrowserWindow.getAllWindows()[0]!.webContents.send("thread:event", event);
  }, events);
}
const item = (event: Record<string, unknown>) => ({ type: "item", threadId, item: event });
/** The memory file the citation in "Use the build flags" points to: its lines 3–5 are cited. */
const MEMORY_FILE = "# Build\n\nUse --frozen-lockfile ✓\nwith pnpm 10\nthen run the build\n\nunrelated line\n";

test.beforeEach(async () => {
  ({ home, repo } = seedHome());
  // A Codex home of this test's own: citations read its memory file, never the developer's.
  const codexHome = path.join(home, "codex-home");
  fs.mkdirSync(path.join(codexHome, "memories", "notes"), { recursive: true });
  fs.writeFileSync(path.join(codexHome, "memories", "notes", "build.md"), MEMORY_FILE);
  fs.writeFileSync(path.join(codexHome, "secret.txt"), "outside the memories folder\n");
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  try { ({ app, page } = await launch(home)); }
  finally { if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous; }
  const script = path.join(home, "evidence-script.json");
  fs.writeFileSync(script, JSON.stringify([{ content: "Ready." }]));
  await page.evaluate((mock_script) => window.modex!.invoke("settings:update", { mock_script }), script);
  await page.keyboard.press("Meta+n");
  await expect(tid(page, "composer-input")).toBeFocused();
  await tid(page, "composer-input").fill("start");
  await page.keyboard.press("Meta+Enter");
  await expect(tid(page, "thread-view")).toBeVisible({ timeout: 15_000 });
  await expect(currentRow(page)).toHaveAttribute("data-status", "idle");
  threadId = (await currentRow(page).getAttribute("data-thread-id"))!;
  const tool = (id: string, title: string, extra: Record<string, unknown>) => item({ id, kind: "tool", name: "shell", title, args: {}, status: "done", durationMs: 1200, origin: origin(id), at: at(), ...extra });
  await send([
    item({ id: "u-evidence", kind: "user", text: "evidence turn", at: at() }),
    tool("t-fail", "$ npm test", { exec: { command: "/bin/zsh -lc 'npm test -- --grep \"a b\"'", cwd: "/repo/pkg" }, exitCode: 2, outcome: "failed", ok: false,
      output: "…last lines\n1 failing\n", outputBytes: 3 * 1024 * 1024, outputTruncated: true }),
    tool("t-denied", "$ rm -rf build", { exec: { command: "/bin/zsh -lc 'rm -rf build'", cwd: "/repo" }, exitCode: null, outcome: "denied", ok: false }),
    tool("t-claude", "$ ls", { exec: { command: "ls" }, outcome: "succeeded", ok: true, output: "src\n" }),
    item({ id: "t-patch", kind: "tool", name: "apply_patch", title: "edit NOTE.md", args: { patch: "*** Begin Patch\n*** Add File: NOTE.md\n+hi\n*** End Patch" }, status: "done", outcome: "succeeded", ok: true, origin: origin("t-patch"), at: at() }),
    // A Codex web search as main sends it once completed (shape from test/fixtures/codex-websearch-0.163.0.json),
    // and one stored before structured results, whose output was the JSON string "".
    item({ id: "t-search", kind: "tool", name: "webSearch", title: "search site:github.com/openai/codex changelog codex cli", args: {}, status: "done", outcome: "succeeded", ok: true, origin: origin("t-search"), at: at(),
      search: { source: "codex", query: "site:github.com/openai/codex changelog codex cli", action: { kind: "search", queries: ["site:github.com/openai/codex changelog codex cli"] }, dropped: 1, results: [
        { title: "codex/CHANGELOG.md at main · openai/codex · GitHub", url: "https://github.com/openai/codex/blob/main/CHANGELOG.md", domain: "github.com", snippet: "The changelog can be found on the releases page." },
        { title: "Releases · openai/codex · GitHub", url: "https://github.com/openai/codex/releases", domain: "github.com" },
        // Not something main would keep: a stored thread is checked again before a result becomes a link.
        { title: "Tampered", url: "javascript:alert(1)", domain: "example.com" },
      ] } }),
    item({ id: "t-search-old", kind: "tool", name: "webSearch", title: "search ", args: {}, output: '""', status: "done", outcome: "succeeded", ok: true, origin: origin("t-search-old"), at: at() }),
    item({ id: "a-escape", kind: "assistant", text: "A citation that points outside memory.", phase: "commentary", outcome: "succeeded", origin: origin("a-escape"), at: at(),
      evidence: [{ kind: "memory", source: "codex", path: "../secret.txt", lineStart: 1, lineEnd: 1, note: "escape" }] }),
    item({ id: "a-final", kind: "assistant", text: "Use the build flags from memory.\n\nSources:\n- [Node.js](https://nodejs.org/)\n- [npm docs](https://docs.npmjs.com/)", phase: "final", outcome: "succeeded", origin: origin("a-final"), at: at(),
      evidence: [{ kind: "memory", source: "codex", path: "notes/build.md", lineStart: 3, lineEnd: 5, note: "Build flags 🛠" }] }),
    { type: "status", threadId, status: "idle" },
  ]);
  // Sending IPC does not wait for React to render it. Wait for this turn's final
  // item, then select its disclosure button, not the preceding turn's plain label.
  await expect(items(page, "assistant").filter({ hasText: "Use the build flags" })).toBeVisible();
  const history = page.locator('button[data-testid="turn-label"]').last();
  await expect(history).toHaveAttribute("aria-expanded", "false");
  await history.click();
  await expect(history).toHaveAttribute("aria-expanded", "true");
});

test.afterEach(async () => {
  await app?.close();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

test("a command shows what actually ran, where, and how it ended, apart from its title", async () => {
  const failed = items(page, "tool").filter({ hasText: "$ npm test" });
  await tid(failed, "item-toggle").click();
  await expect(tid(failed, "tool-command")).toHaveText("/bin/zsh -lc 'npm test -- --grep \"a b\"'");
  await expect(tid(failed, "tool-cwd")).toHaveText("in /repo/pkg");
  await expect(tid(failed, "tool-exit")).toHaveText("Exit code 2");
  const denied = items(page, "tool").filter({ hasText: "$ rm -rf build" });
  await tid(denied, "item-toggle").click();
  await expect(tid(denied, "tool-exit")).toHaveText("No exit code");
  const claude = items(page, "tool").filter({ hasText: "$ ls" });
  await tid(claude, "item-toggle").click();
  await expect(tid(claude, "tool-exit")).toHaveText("Exit code not reported");
  await expect(tid(claude, "tool-cwd")).toHaveCount(0);
});

test("output past the preview says how much is shown", async () => {
  const failed = items(page, "tool").filter({ hasText: "$ npm test" });
  await tid(failed, "item-toggle").click();
  await expect(tid(failed, "tool-truncated")).toHaveText("Showing the last 256 KB of 3.0 MB.");
  await expect(tid(failed, "tool-output")).toContainText("1 failing");
});

test("a patch is labelled as this turn's, apart from the working tree now", async () => {
  const patch = items(page, "tool").filter({ hasText: "edit NOTE.md" });
  await tid(patch, "item-toggle").click();
  await expect(tid(patch, "tool-patch-note")).toHaveText("The patch as this turn applied it. The working tree may have changed since; Changes shows it now.");
});

test("a native memory citation is shown as one; links the model wrote are labelled as its own", async () => {
  const answer = items(page, "assistant").filter({ hasText: "Use the build flags" });
  const memory = tid(answer, "evidence-memory");
  await expect(memory).toContainText("Codex memory");
  await expect(memory).toContainText("notes/build.md · lines 3–5");
  await expect(memory).toContainText("Build flags 🛠");
  const sources = tid(answer, "sources");
  await expect(sources).toHaveAttribute("data-provenance", "reply-text");
  await expect(sources).toContainText("Links in the reply · 2");
  await expect(sources).toHaveAttribute("title", "Links the model wrote in its reply. Modex has not checked them.");
});

test("a memory citation's lines can be shown and copied, read from Codex's memories folder and nothing else", async () => {
  const answer = items(page, "assistant").filter({ hasText: "Use the build flags" });
  const memory = tid(answer, "evidence-memory");
  const tools = await items(page, "tool").count();
  await tid(memory, "evidence-show").click();
  await expect(tid(memory, "evidence-excerpt")).toHaveText("Use --frozen-lockfile ✓\nwith pnpm 10\nthen run the build");
  await expect(tid(memory, "evidence-range")).toHaveText("Lines 3–5 of 7");
  await expect(async () => {
    await tid(memory, "evidence-copy").click();
    await expect(tid(memory, "evidence-copy")).toHaveText("Copied", { timeout: 1000 });
  }).toPass({ timeout: 15_000 });
  expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe("Use --frozen-lockfile ✓\nwith pnpm 10\nthen run the build");
  // Reading a citation runs nothing and adds nothing to the turn.
  await expect(items(page, "tool")).toHaveCount(tools);
  await expect(currentRow(page)).toHaveAttribute("data-status", "idle");
});

test("a citation that points outside Codex's memories folder is refused and shows nothing from it", async () => {
  const answer = items(page, "assistant").filter({ hasText: "A citation that points outside memory." });
  const memory = tid(answer, "evidence-memory");
  await tid(memory, "evidence-show").click();
  await expect(tid(memory, "evidence-error")).toContainText("does not point inside Codex's memory folder");
  await expect(tid(memory, "evidence-excerpt")).toHaveCount(0);
  await expect(answer).not.toContainText("outside the memories folder");
});

test("a Codex web search shows its query and the results Codex reported, labelled as unchecked; an older one shows no empty output", async () => {
  const search = items(page, "tool").filter({ hasText: "search site:github.com/openai/codex changelog codex cli" });
  await expect(tid(search, "tool-meta")).toContainText("2 results");
  await tid(search, "item-toggle").click();
  const results = tid(search, "search-results");
  await expect(results).toHaveAttribute("data-provenance", "codex-search");
  await expect(tid(results, "search-label")).toHaveText("Results Codex reported. Modex has not checked them.");
  await expect(tid(results, "search-result")).toHaveCount(2);
  await expect(results.locator('a[href^="javascript:"]')).toHaveCount(0);
  await expect(results).not.toContainText("Tampered");
  await expect(tid(results, "search-result").first()).toHaveAttribute("href", "https://github.com/openai/codex/blob/main/CHANGELOG.md");
  await expect(tid(results, "search-snippet")).toHaveCount(1);
  await expect(tid(results, "search-snippet")).toHaveText("The changelog can be found on the releases page.");
  await expect(tid(results, "search-dropped")).toHaveText("1 more result had no web link and is not shown.");
  await expect(tid(search, "tool-output")).toHaveCount(0);
  const old = items(page, "tool").filter({ has: page.locator('[data-testid="tool-summary"]', { hasText: /^search$/ }) });
  await tid(old, "item-toggle").click();
  await expect(tid(old, "item-body")).toBeVisible();
  await expect(tid(old, "tool-output")).toHaveCount(0);
});
