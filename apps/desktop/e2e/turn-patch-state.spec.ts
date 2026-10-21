import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { currentRow, items, launch, seedHome, tid } from "./support";

/**
 * A turn's patch against the working tree now (docs/conversation-evidence.md). A fake `claude -p`
 * really edits and writes files in a disposable repository, then the test changes them on disk.
 * Compare reads the files in main and says, per file, whether they are still as the turn left them.
 * Nothing runs again, nothing is written, and opening a row reads nothing.
 */

let app: ElectronApplication;
let page: Page;
let home: string;
let repo: string;
let counts: string;

/** A stream-json CLI shaped like Claude Code 2.1.302 that edits, writes, and writes outside the project. */
function fakeClaude(files: { greeting: string; notes: string; outside: string }): string {
  return `#!${process.execPath}
const fs = require('node:fs');
if (process.argv.includes('--version')) { console.log('2.1.302 (Claude Code)'); process.exit(0); }
const emit = (x) => console.log(JSON.stringify(x));
const rl = require('node:readline').createInterface({ input: process.stdin });
rl.on('close', () => process.exit(0));
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'user') return;
  emit({ type: 'system', subtype: 'init', session_id: 'patch-session', claude_code_version: '2.1.302', model: 'fixture' });
  // Modex names the thread with a turn of its own; answer it without touching any file.
  if (JSON.stringify(msg).includes('Name this chat')) {
    emit({ type: 'assistant', message: { id: 'm-title', content: [{ type: 'text', text: 'Edit greeting and notes' }] } });
    emit({ type: 'result', subtype: 'success', is_error: false, session_id: 'patch-session', result: 'Edit greeting and notes', num_turns: 1 });
    return;
  }
  const c = fs.existsSync(${JSON.stringify(counts)}) ? JSON.parse(fs.readFileSync(${JSON.stringify(counts)}, 'utf8')) : {};
  c.edits = (c.edits || 0) + 1; fs.writeFileSync(${JSON.stringify(counts)}, JSON.stringify(c));
  const tool = (id, name, input, apply) => {
    emit({ type: 'assistant', message: { id: 'm-' + id, content: [{ type: 'tool_use', id, name, input }] } });
    apply();
    emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'Done.' }] } });
  };
  tool('edit-1', 'Edit', { file_path: ${JSON.stringify(files.greeting)}, old_string: 'hello', new_string: 'hello, patch 👋' },
    () => fs.writeFileSync(${JSON.stringify(files.greeting)}, 'hello, patch 👋\\n'));
  tool('write-1', 'Write', { file_path: ${JSON.stringify(files.notes)}, content: 'fresh notes\\n' },
    () => fs.writeFileSync(${JSON.stringify(files.notes)}, 'fresh notes\\n'));
  tool('write-2', 'Write', { file_path: ${JSON.stringify(files.outside)}, content: 'outside\\n' },
    () => fs.writeFileSync(${JSON.stringify(files.outside)}, 'outside\\n'));
  emit({ type: 'assistant', message: { id: 'm-final', content: [{ type: 'text', text: 'Edited the greeting and wrote the notes.' }] } });
  emit({ type: 'result', subtype: 'success', is_error: false, session_id: 'patch-session', result: 'Edited the greeting and wrote the notes.', num_turns: 4 });
});
`;
}

const greeting = () => path.join(repo, "greeting.txt");
const notes = () => path.join(repo, "notes.txt");
const outside = () => path.join(home, "outside.txt");
const row = (name: string) => items(page, "tool").filter({ hasText: name });
const file = (name: string) => tid(row(name), "patch-file");
/** How many turns ran the fixture's edits. */
const edits = () => (JSON.parse(fs.readFileSync(counts, "utf8")) as { edits: number }).edits;

test.beforeAll(async () => {
  ({ home, repo } = seedHome({ default_backend: "claude" }));
  counts = path.join(home, "fixture-counts.json");
  fs.writeFileSync(greeting(), "hello\n");
  const cli = path.join(home, "claude-patch.cjs");
  fs.writeFileSync(cli, fakeClaude({ greeting: greeting(), notes: notes(), outside: outside() }), { mode: 0o755 });
  const statePath = path.join(home, "app/state.json");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  state.settings.claude_bin = cli;
  fs.writeFileSync(statePath, JSON.stringify(state));
  ({ app, page } = await launch(home));
  await page.keyboard.press("Meta+n");
  await expect(tid(page, "composer-input")).toBeFocused();
  await tid(page, "composer-input").fill("Edit the greeting and write notes");
  await page.keyboard.press("Meta+Enter");
  await expect(tid(page, "thread-view")).toBeVisible({ timeout: 15_000 });
  // Initial idle does not prove the submitted turn has started or finished.
  const completedTurn = page.locator('button[data-testid="turn-label"]').last();
  await expect(completedTurn).toBeVisible({ timeout: 20_000 });
  await expect(currentRow(page)).toHaveAttribute("data-status", "idle", { timeout: 20_000 });
  expect(fs.readFileSync(greeting(), "utf8")).toBe("hello, patch 👋\n");
  // Work that succeeded folds into its turn; unfold it.
  await completedTurn.click();
  await expect(completedTurn).toHaveAttribute("aria-expanded", "true");
  for (const name of ["greeting.txt", "notes.txt", "outside.txt"]) await tid(row(name), "item-toggle").click();
});

test.afterAll(async () => {
  await app?.close();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

test("opening a patch row reads nothing until Compare is pressed", async () => {
  await expect(tid(row("greeting.txt"), "tool-patch-note")).toBeVisible();
  await expect(tid(row("greeting.txt"), "patch-compare")).toHaveText("Compare with working tree");
  await expect(file("greeting.txt")).toHaveCount(0);
});

test("each file says whether it is as the turn left it, and a file outside the project is not read", async () => {
  await tid(row("greeting.txt"), "patch-compare").click();
  await expect(file("greeting.txt")).toHaveAttribute("data-state", "has-edit");
  await expect(file("greeting.txt")).toContainText("greeting.txt");
  await expect(file("greeting.txt")).toContainText("Still has this turn's edit");
  await expect(tid(row("greeting.txt"), "patch-compare")).toHaveText("Check again");

  await tid(row("notes.txt"), "patch-compare").click();
  await expect(file("notes.txt")).toHaveAttribute("data-state", "as-left");
  await expect(file("notes.txt")).toContainText("As this turn left it");

  await tid(row("outside.txt"), "patch-compare").click();
  await expect(file("outside.txt")).toHaveAttribute("data-state", "unknown");
  await expect(file("outside.txt")).toContainText("outside this thread's folder");
});

test("after later changes on disk, Check again says what changed and what is gone, and nothing runs", async () => {
  fs.writeFileSync(greeting(), "goodbye\n");
  fs.rmSync(notes());
  await tid(row("greeting.txt"), "patch-compare").click();
  await expect(file("greeting.txt")).toHaveAttribute("data-state", "changed");
  await expect(file("greeting.txt")).toContainText("Changed since this turn");
  await tid(row("notes.txt"), "patch-compare").click();
  await expect(file("notes.txt")).toHaveAttribute("data-state", "deleted");
  await expect(file("notes.txt")).toContainText("Deleted since this turn");
  // Comparing wrote nothing and ran nothing again.
  expect(fs.readFileSync(greeting(), "utf8")).toBe("goodbye\n");
  expect(fs.existsSync(notes())).toBe(false);
  expect(edits()).toBe(1);
  await expect(currentRow(page)).toHaveAttribute("data-status", "idle");
});
