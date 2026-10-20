import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch, seedHome, tid, items } from "./support";

// Live smoke acceptance for #281 (CF-8): the real `claude -p` and `codex app-server`, driven through the app on the
// signed-in accounts. Each run spends real usage, so it runs only with MODEX_LIVE_SMOKE=1. MODEX_LIVE_BACKENDS picks
// the CLIs (default "claude,codex"); MODEX_CLAUDE_BIN / MODEX_CODEX_BIN the executables (default ~/.local/bin/…);
// MODEX_CLAUDE_MODEL (default haiku) and MODEX_CODEX_MODEL (default: the CLI's own) the models. Start it from a shell
// without CLAUDE*/ANTHROPIC* variables, so Claude does not run as a nested session. MODEX_LIVE_REPORT names a file
// for what it observed. The tasks are benign and stay inside a disposable repository.
test.skip(process.env.MODEX_LIVE_SMOKE !== "1", "live smoke acceptance is opt-in (MODEX_LIVE_SMOKE=1)");

type Backend = "claude" | "codex";
type Item = { id: string; kind: string; name?: string; title?: string; text?: string; phase?: string; status?: string; outcome?: string; exitCode?: number | null; exec?: { command: string }; failure?: unknown; level?: string; answer?: string; args?: Record<string, unknown> };

const backends = (process.env.MODEX_LIVE_BACKENDS ?? "claude,codex").split(",").map((b) => b.trim()).filter(Boolean) as Backend[];
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
/** Approves each card the CLI asks for until the turn settles (idle, or error when the CLI refused it); returns how many there were. */
async function approveUntilIdle(page: Page, timeout: number): Promise<number> {
  const until = Date.now() + timeout;
  let approved = 0;
  while (Date.now() < until) {
    const status = await currentRow(page).getAttribute("data-status");
    const open = items(page, "approval").getByRole("button", { name: "Approve" });
    if (await open.count()) { await open.first().click(); approved++; continue; }
    if (status === "idle" || status === "error") return approved;
    await page.waitForTimeout(1000);
  }
  throw new Error("the turn did not settle in time");
}
/** A turn the CLI refused: the failure card's code and Modex's summary, kept in the report, then a clear failure. */
function refused(list: Item[], report: Record<string, unknown>): void {
  const failure = list.filter((i) => i.kind === "notice" && i.failure).at(-1) as (Item & { failure?: { code?: string; summary?: string; message?: string } }) | undefined;
  if (!failure) return;
  report.refused = { code: failure.failure?.code, summary: failure.failure?.summary ?? failure.text, cliMessage: failure.failure?.message?.slice(0, 200) };
  throw new Error(`the CLI refused the turn (${failure.failure?.code}): ${failure.failure?.summary ?? failure.text}`);
}
const summary = (list: Item[]) => list.filter((i) => i.kind !== "user").map((i) => ({
  kind: i.kind, ...(i.name ? { name: i.name } : {}), ...(i.title ? { title: i.title.slice(0, 80) } : {}), ...(i.phase ? { phase: i.phase } : {}),
  ...(i.outcome ? { outcome: i.outcome } : {}), ...(i.exitCode !== undefined ? { exitCode: i.exitCode } : {}), ...(i.failure ? { failure: true } : {}),
}));

/** The keys, and the keys of the first element, of each field of the latest Codex web-search item in a rollout: shape only, no content. */
function webSearchShape(since: number): unknown {
  const root = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "sessions");
  const files: string[] = [];
  const walk = (dir: string) => { for (const e of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith(".jsonl") && fs.statSync(p).mtimeMs >= since) files.push(p); } };
  walk(root);
  const shape = (v: unknown, depth = 0): unknown => depth > 3 ? typeof v
    : Array.isArray(v) ? (v.length ? [shape(v[0], depth + 1)] : [])
    : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).slice(0, 20).map(([k, x]) => [k, shape(x, depth + 1)])) : typeof v;
  for (const file of files) {
    for (const line of fs.readFileSync(file, "utf8").split("\n").reverse()) {
      if (!/web_?search/i.test(line)) continue;
      try {
        const payload = (JSON.parse(line) as { payload?: Record<string, unknown> }).payload;
        const item = (payload?.item ?? payload) as Record<string, unknown> | undefined;
        if (item && /web_?search/i.test(String(item.type ?? ""))) return shape(item);
      } catch { /* not a JSON line */ }
    }
  }
  return null;
}

for (const backend of backends) {
  test(`live ${backend}: a real edit and check, the final answer, and Stop mid-command`, async () => {
    test.setTimeout(600_000);
    const bin = backend === "claude" ? process.env.MODEX_CLAUDE_BIN ?? path.join(os.homedir(), ".local/bin/claude") : process.env.MODEX_CODEX_BIN ?? path.join(os.homedir(), ".local/bin/codex");
    const model = backend === "claude" ? process.env.MODEX_CLAUDE_MODEL ?? "haiku" : process.env.MODEX_CODEX_MODEL ?? "";
    const { home, repo } = seedHome({ default_backend: backend, default_mode: "agent", default_model: { codex: backend === "codex" ? model : "", claude: backend === "claude" ? model : "", mock: "mock" } });
    fs.writeFileSync(path.join(repo, "greeting.txt"), "hello\n");
    const statePath = path.join(home, "app/state.json");
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    state.settings[`${backend}_bin`] = bin;
    fs.writeFileSync(statePath, JSON.stringify(state));
    const started = Date.now();
    const report: Record<string, unknown> = { backend, bin, version: execFileSync(bin, ["--version"]).toString().trim(), model: model || "(CLI default)", at: new Date().toISOString() };
    // `codex login status` writes to stderr.
    if (backend === "codex") { const status = spawnSync(bin, ["login", "status"], { encoding: "utf8" }); report.account = `${status.stdout}${status.stderr}`.trim() || "unknown"; }
    let app: ElectronApplication | undefined;
    try {
      const opened = await launch(home); app = opened.app;
      const page = opened.page;

      // 1. A real edit and check: the file's bytes change, the command's outcome is recorded, and the answer is final.
      await newChat(page, "In greeting.txt, replace the word hello with: hello, live. Then run exactly this shell command and nothing else, and tell me its exit code: grep -q 'hello, live' greeting.txt");
      report.editApprovals = await approveUntilIdle(page, 300_000);
      const edited = await threadItems(page);
      report.edit = summary(edited);
      refused(edited, report);
      expect(fs.readFileSync(path.join(repo, "greeting.txt"), "utf8")).toContain("hello, live");
      const check = edited.filter((i) => i.kind === "tool" && /grep -q/.test(i.exec?.command ?? i.title ?? ""));
      expect(check.length, "the check command ran as a tool item").toBeGreaterThan(0);
      expect(check.at(-1)!.outcome).toBe("succeeded");
      if (backend === "codex") expect(check.at(-1)!.exitCode, "Codex reports the exit code").toBe(0);
      const answers = edited.filter((i) => i.kind === "assistant");
      expect(answers.length).toBeGreaterThan(0);
      report.finalPhase = answers.at(-1)!.phase;
      expect(edited.filter((i) => i.kind === "notice" && i.failure)).toEqual([]);

      // 2. Stop while an approved command runs: the call ends interrupted, and its file is never written.
      await newChat(page, `Run exactly this shell command and nothing else: python3 -c "import time; time.sleep(30); open('live-stop.txt', 'w')"`);
      const runUntil = Date.now() + 120_000;
      while (Date.now() < runUntil) {
        const open = items(page, "approval").getByRole("button", { name: "Approve" });
        if (await open.count()) { await open.first().click(); continue; }
        if ((await threadItems(page)).some((i) => i.kind === "tool" && i.status === "running" && /sleep\(30\)/.test(i.exec?.command ?? i.title ?? JSON.stringify(i.args ?? {})))) break;
        await page.waitForTimeout(1000);
      }
      await page.waitForTimeout(2000);
      const stopAt = Date.now();
      await tid(page, "stop").click();
      await expect(currentRow(page)).toHaveAttribute("data-status", "idle", { timeout: 30_000 });
      const stopped = await threadItems(page);
      const call = stopped.filter((i) => i.kind === "tool" && /sleep\(30\)/.test(i.exec?.command ?? i.title ?? JSON.stringify(i.args ?? {}))).at(-1);
      report.stop = { ms: Date.now() - stopAt, tool: call ? { status: call.status, outcome: call.outcome } : null, notice: stopped.filter((i) => i.kind === "notice").at(-1)?.text, failures: stopped.filter((i) => i.kind === "notice" && i.failure).length };
      expect(call, "the long command started").toBeTruthy();
      expect(call!.status).toBe("done");
      expect(["interrupted", "failed", "unknown"]).toContain(call!.outcome);
      await page.waitForTimeout(31_000);
      expect(fs.existsSync(path.join(repo, "live-stop.txt")), "the stopped command never finished").toBe(false);

      // 3. Codex only: one web search, to record the native result's shape for CF-5 (keys only, from Codex's own rollout).
      if (backend === "codex") {
        await newChat(page, "Search the web for the codex-cli changelog on GitHub and reply with one link. Do not run any commands.");
        await approveUntilIdle(page, 300_000);
        const searched = await threadItems(page);
        report.webSearch = { items: summary(searched).filter((i) => i.kind === "tool"), rolloutShape: webSearchShape(started) };
      }
      await page.screenshot({ path: test.info().outputPath(`live-${backend}.png`) });
    } finally {
      const out = JSON.stringify(report, null, 2);
      fs.writeFileSync(test.info().outputPath(`live-${backend}.json`), out);
      if (process.env.MODEX_LIVE_REPORT) fs.writeFileSync(`${process.env.MODEX_LIVE_REPORT}.${backend}.json`, out);
      if (app) await app.close();
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
}
