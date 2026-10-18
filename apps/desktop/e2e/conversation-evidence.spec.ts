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

test.beforeAll(async () => {
  ({ home, repo } = seedHome());
  ({ app, page } = await launch(home));
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
    item({ id: "a-final", kind: "assistant", text: "Use the build flags from memory.\n\nSources:\n- [Node.js](https://nodejs.org/)\n- [npm docs](https://docs.npmjs.com/)", phase: "final", outcome: "succeeded", origin: origin("a-final"), at: at(),
      evidence: [{ kind: "memory", source: "codex", path: "notes/build.md", lineStart: 3, lineEnd: 5, note: "Build flags 🛠" }] }),
    { type: "status", threadId, status: "idle" },
  ]);
  // Unfold the evidence turn's work, once it has rendered: before that, the last header is the first turn's.
  await expect(tid(page, "turn-label")).toHaveCount(2);
  await tid(page, "turn-label").last().click();
  await expect(tid(page, "turn-label").last()).toHaveAttribute("aria-expanded", "true");
});

test.afterAll(async () => {
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
