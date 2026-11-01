import { test, expect, type ElectronApplication } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { launch, seedHome, tid, items } from "./support";

// Modex's Claude account pool end to end: Settings → IPC → main's ClaudeAccounts → AccountClaudeBackend →
// the runner's usage-limit rotation, against a local executable that stands in for Claude Code 2.1.316. It
// keeps a separate login per CLAUDE_CONFIG_DIR (as the real CLI does), reports a usage limit when its profile
// holds a `limited` marker, and records each turn's account environment. It is a scripted fixture, not
// live-model or OrcaRouter evidence: no request leaves the machine.

const KEY = "sk-orca-e2eSyntheticKey0123456789";

function fixture(home: string): string {
  const cli = path.join(home, "claude-accounts.cjs");
  fs.writeFileSync(cli, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const dir = process.env.CLAUDE_CONFIG_DIR || '';
const who = process.env.ANTHROPIC_BASE_URL ? 'gateway' : dir ? path.basename(dir) : 'cli';
if (process.argv.includes('--version')) { console.log('2.1.316 (Claude Code)'); process.exit(0); }
if (process.argv[2] === 'auth' && process.argv[3] === 'status') {
  const loggedIn = !dir || fs.existsSync(path.join(dir, 'signed-in'));
  console.log(JSON.stringify({ loggedIn, authMethod: 'claude.ai' })); process.exit(loggedIn ? 0 : 1);
}
if (process.argv[2] === 'auth' && process.argv[3] === 'login') { fs.writeFileSync(path.join(dir, 'signed-in'), 'yes'); process.exit(0); }
if (path.basename(process.cwd()).startsWith('modex-title-')) process.exit(1);
fs.appendFileSync(${JSON.stringify(path.join(home, "claude-turns.jsonl"))}, JSON.stringify({ who, token: process.env.ANTHROPIC_AUTH_TOKEN === ${JSON.stringify(KEY)}, scrub: process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB || null }) + '\\n');
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'user') return;
  emit({ type: 'system', subtype: 'init', session_id: 'session-' + who, claude_code_version: '2.1.316' });
  if (dir && fs.existsSync(path.join(dir, 'limited'))) {
    emit({ type: 'result', subtype: 'success', is_error: true, result: 'Claude AI usage limit reached|resets at 11pm', session_id: 'session-' + who });
  } else {
    emit({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'Ran on ' + who }] } });
    emit({ type: 'result', subtype: 'success', is_error: false, result: 'Ran on ' + who, session_id: 'session-' + who });
  }
  process.stdin.destroy(); setTimeout(() => process.exit(0), 20);
});
`, { mode: 0o755 });
  return cli;
}

test("Claude account pool: profiles sign in separately, an OrcaRouter key stays in main, and a usage limit rotates the turn", async () => {
  const { home, repo } = seedHome({ default_backend: "claude", default_mode: "agent" });
  const statePath = path.join(home, "app/state.json");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  state.settings.claude_bin = fixture(home);
  fs.writeFileSync(statePath, JSON.stringify(state));
  let app: ElectronApplication | undefined;
  try {
    const opened = await launch(home); app = opened.app;
    const page = opened.page;
    await tid(page, "open-settings").click();
    await tid(page, "settings-nav").getByRole("button", { name: "Coding CLIs", exact: true }).click();
    const pool = tid(page, "claude-accounts");
    const status = tid(pool, "claude-accounts-status");
    await expect(status).toContainText("Add a Claude account");

    // Two profiles, each signed in through the CLI's own login in its own directory.
    for (const name of ["Work", "Personal"]) {
      await tid(pool, "claude-account-add-profile").click();
      await tid(pool, "claude-account-label").fill(name);
      await pool.getByRole("button", { name: "Save account" }).click();
      await expect(status).toContainText(`Added ${name}. Sign in to it next.`);
      const row = tid(pool, "claude-account-row").filter({ hasText: name });
      await expect(row).toContainText(`Signed out · sign in to ${name}`);
      await row.getByRole("button", { name: "Sign in", exact: true }).click();
      await expect(status).toContainText("Claude sign-in confirmed");
      await expect(row).toContainText(`Signed in · ${name}`);
    }

    // A gateway key: refused unless it is an OrcaRouter key, then stored in main and never returned.
    await tid(pool, "claude-account-add-gateway").click();
    await tid(pool, "claude-account-label").fill("Orca");
    await tid(pool, "claude-account-key").fill("sk-ant-not-a-gateway-key");
    await pool.getByRole("button", { name: "Save account" }).click();
    await expect(status).toContainText("Keys start with sk-orca-");
    await tid(pool, "claude-account-key").fill(KEY);
    await tid(pool, "claude-account-model").fill("orcarouter/auto");
    await pool.getByRole("button", { name: "Save account" }).click();
    await expect(status).toContainText("Saved Orca.");
    await expect(tid(pool, "claude-account-row").filter({ hasText: "Orca" })).toContainText("OrcaRouter gateway key saved · orcarouter/auto");
    const ipcStatus = await page.evaluate(() => window.modex!.invoke("claudeAccounts:status", undefined));
    expect(JSON.stringify(ipcStatus)).not.toContain("e2eSyntheticKey");
    expect(fs.readFileSync(path.join(home, "app/claude-accounts.json"), "utf8")).not.toContain("e2eSyntheticKey");
    const ids = Object.fromEntries(ipcStatus.accounts.map((account) => [account.label, account.id]));

    // Work is active with rotation on; Work is usage-limited.
    await tid(pool, "claude-account-select").selectOption(ids.Work!);
    await expect(status).toContainText("Account selected for new conversations.");
    // The box follows main's confirmed state, so it changes after the reply rather than on the click itself.
    await tid(pool, "claude-account-rotate").click();
    await expect(status).toContainText("Rotation on.");
    await expect(tid(pool, "claude-account-rotate")).toBeChecked();
    fs.writeFileSync(path.join(home, "app/claude-profiles", ids.Work!, "limited"), "yes");
    await page.keyboard.press("Escape");
    await expect(tid(page, "settings")).toHaveCount(0);

    // A new conversation starts on Work, hits the limit, and retries on Personal before doing any work.
    await tid(page, "new-chat").click();
    await tid(page, "composer-input").fill("hello");
    await tid(page, "send").click();
    await expect(items(page, "assistant").last()).toHaveText(`Ran on ${ids.Personal}`);
    await expect(items(page, "notice").filter({ hasText: "usage limit" })).toContainText(`Claude account "Work" hit its usage limit; Modex holds it out of rotation until 11:00 PM. Retrying on "Personal".`);
    await expect(page.locator('[data-item-kind="notice"][data-level="error"]')).toHaveCount(0);
    const turns = fs.readFileSync(path.join(home, "claude-turns.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(turns.map((turn) => turn.who)).toEqual([ids.Work, ids.Personal]);
    const threadId = (await page.locator('[data-testid="thread-row"][aria-current="true"]').getAttribute("data-thread-id"))!;
    const thread = await page.evaluate((id) => window.modex!.invoke("state:get", undefined).then((s: any) => s.threads.find((t: any) => t.id === id)), threadId);
    expect(thread.claudeAccount).toBe(ids.Personal);

    // The pool shows Work cooling down; new conversations now start on Personal.
    await tid(page, "open-settings").click();
    await tid(page, "settings-nav").getByRole("button", { name: "Coding CLIs", exact: true }).click();
    await expect(tid(pool, "claude-account-row").filter({ hasText: "Work" })).toContainText("Usage limit until 11:00 PM");

    // The gateway runs with its key in the child's environment only, scrubbed from the model's tools.
    await tid(pool, "claude-account-select").selectOption(ids.Orca!);
    await expect(status).toContainText("Account selected for new conversations.");
    await page.keyboard.press("Escape");
    await tid(page, "new-chat").click();
    await tid(page, "composer-input").fill("through the gateway");
    await tid(page, "send").click();
    await expect(items(page, "assistant").last()).toHaveText("Ran on gateway");
    const last = JSON.parse(fs.readFileSync(path.join(home, "claude-turns.jsonl"), "utf8").trim().split("\n").at(-1)!);
    expect(last).toEqual({ who: "gateway", token: true, scrub: "1" });

    // Removing the gateway clears its encrypted key.
    await tid(page, "open-settings").click();
    await tid(page, "settings-nav").getByRole("button", { name: "Coding CLIs", exact: true }).click();
    await tid(pool, "claude-account-row").filter({ hasText: "Orca" }).getByRole("button", { name: "Remove" }).click();
    await expect(status).toContainText("Removed Orca.");
    await expect(tid(pool, "claude-account-row")).toHaveCount(2);
    const secrets = JSON.parse(fs.readFileSync(path.join(home, "app/secrets.json"), "utf8"));
    expect(Object.keys(secrets.entries).filter((name) => name.startsWith("claude_account:"))).toEqual([]);
    await page.screenshot({ path: test.info().outputPath("claude-accounts.png") });
  } finally {
    await app?.close();
    fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(repo, { recursive: true, force: true });
  }
});
