import { test, expect, type ElectronApplication, type Page, type TestInfo } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { items, launch, seedHome, tid } from "./support";

/**
 * Long-transcript and log-heavy streaming through the real app, for the acceptance matrix of tracker #273
 * (CF-8, #281; docs/reviews/2026-10-18-conversation-fidelity-acceptance.md).
 *
 * 1. Opening a saved 200-turn, 1,400-item transcript: from the click on its row to its last answer in the
 *    window, timed in the renderer, first and repeated.
 * 2. A fixture Codex app-server streams a 3 MiB command log in 48 deltas through the real backend, runner and
 *    IPC. Counted: the bytes main sends the window, main's CPU time from the first item to idle, the renderer's
 *    long tasks, and the time from send to the answer.
 *
 * The cold-open median has Val's approved 500 ms CI budget; log bounds are size-based.
 * The times are this machine's; MODEX_MEASURE=<file>
 * writes them as JSON with the machine's description, and the numbers are written before anything is asserted.
 * The fixture is not a provider.
 */

const TURNS = 200;
const CHUNK = "x".repeat(64 * 1024 - 1) + "\n";
const CHUNKS = 48;
/** CF-5's preview: `OUTPUT_PREVIEW_BYTES` in src/shared/evidence.ts. */
const PREVIEW = 256 * 1024;

const results: Record<string, unknown> = {};
test.afterAll(() => {
  if (!process.env.MODEX_MEASURE) return;
  const cpus = os.cpus();
  let sha = "";
  try { sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(); } catch { /* Not a checkout. */ }
  fs.writeFileSync(process.env.MODEX_MEASURE, JSON.stringify({
    measuredAt: new Date().toISOString(), sha,
    machine: { cpu: cpus[0]?.model, cores: cpus.length, memoryGiB: Math.round(os.totalmem() / 2 ** 30), platform: process.platform, arch: process.arch, release: os.release(), loadAverage: os.loadavg() },
    ...results,
  }, null, 2) + "\n");
});

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

/** A Codex-shaped turn: reasoning, commentary, three commands with output, a Markdown answer. */
function longTranscript(threadId: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const at = new Date(Date.now() - TURNS * 60_000).toISOString();
  for (let turn = 0; turn < TURNS; turn++) {
    const user = `u-${turn}`;
    const origin = (item: string) => ({ thread: threadId, turn: user, attempt: `a-${turn}`, backend: "codex", native: { runtime: "R", thread: "nt", turn: `nu-${turn}`, item } });
    out.push({ id: user, kind: "user", text: `Request ${turn}: tidy the module and run its tests.`, at });
    out.push({ id: `r-${turn}`, kind: "thinking", text: `Plan for ${turn}: ${"read the module, then test it. ".repeat(10)}`, reasoning: "summary", status: "done", outcome: "succeeded", durationMs: 2000, origin: origin(`r-${turn}`), at });
    out.push({ id: `c-${turn}`, kind: "assistant", text: `Looking at module ${turn}. ${"Reading the files first. ".repeat(8)}`, phase: "commentary", nativePhase: "commentary", outcome: "succeeded", origin: origin(`c-${turn}`), at });
    for (let k = 0; k < 3; k++) {
      const id = `t-${turn}-${k}`;
      out.push({ id, kind: "tool", name: "shell", title: `$ npm test -- part ${k}`, args: { command: `npm test -- part ${k}` }, status: "done", ok: true, outcome: "succeeded",
        exec: { command: `/bin/zsh -lc 'npm test -- part ${k}'`, cwd: "/repo" }, exitCode: 0, output: `ok ${turn}.${k}\n`.repeat(400), outputBytes: 4000, durationMs: 1200, origin: origin(id), at });
    }
    out.push({ id: `f-${turn}`, kind: "assistant", text: `Answer ${turn}.\n\n- Tidied module ${turn}.\n- Tests pass.\n\n\`\`\`ts\nexport const value${turn} = ${turn};\n\`\`\`\n${"More detail on the change. ".repeat(20)}`,
      phase: "final", nativePhase: "final_answer", outcome: "succeeded", origin: origin(`f-${turn}`), at });
  }
  return out;
}

/** A codex-cli 0.163.0-shaped app-server whose one command streams 3 MiB, 64 KB at a time. */
function fakeCodex(dir: string): string {
  const cli = path.join(dir, "codex-stream.cjs");
  fs.writeFileSync(cli, `#!${process.execPath}
if (process.argv.includes('--version')) { console.log('codex-cli 0.163.0'); process.exit(0); }
if (process.argv.includes('login') || process.argv.includes('auth')) { console.log('Logged in using ChatGPT'); process.exit(0); }
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const chunk = ${JSON.stringify(CHUNK)};
let turn = 0;
const cwds = new Map();
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  const p = msg.params || {};
  if (msg.method === 'initialize') return emit({ id: msg.id, result: { userAgent: 'codex-stream/0.163.0' } });
  if (msg.method === 'initialized') return;
  if (msg.method === 'account/read') return emit({ id: msg.id, result: { account: { type: 'chatgpt' }, requiresOpenaiAuth: true } });
  if (msg.method === 'model/list') return emit({ id: msg.id, result: { data: [{ id: 'fixture', model: 'fixture', displayName: 'Fixture', isDefault: true }], nextCursor: null } });
  if (msg.method === 'thread/start' || msg.method === 'thread/resume') {
    const id = p.threadId || 'thr-' + cwds.size;
    cwds.set(id, p.cwd || '');
    return emit({ id: msg.id, result: { thread: { id } } });
  }
  if (msg.method === 'turn/start') {
    const id = 'turn-' + (++turn);
    const n = (method, params) => emit({ method, params: { threadId: p.threadId, turnId: id, ...params } });
    emit({ id: msg.id, result: { turn: { id } } });
    if (/modex-title-/.test(cwds.get(p.threadId) || '')) {
      n('item/completed', { item: { id: 'name-' + turn, type: 'agentMessage', text: 'Stream', phase: 'final_answer' } });
      return emit({ method: 'turn/completed', params: { threadId: p.threadId, turn: { id, status: 'completed', error: null } } });
    }
    emit({ method: 'turn/started', params: { threadId: p.threadId, turn: { id } } });
    const command = "/bin/zsh -lc 'yes | head -c 3145728'";
    n('item/started', { item: { type: 'commandExecution', id: 'c1', command, cwd: '/repo', status: 'inProgress' } });
    let sent = 0;
    const next = () => {
      if (sent < ${CHUNKS}) { sent++; n('item/commandExecution/outputDelta', { itemId: 'c1', delta: chunk }); return setTimeout(next, 10); }
      n('item/completed', { item: { type: 'commandExecution', id: 'c1', command, cwd: '/repo', status: 'completed', exitCode: 0, aggregatedOutput: chunk.repeat(${CHUNKS}) } });
      n('item/completed', { item: { type: 'agentMessage', id: 'm1', text: 'Streamed the log.', phase: 'final_answer' } });
      emit({ method: 'turn/completed', params: { threadId: p.threadId, turn: { id, status: 'completed', error: null } } });
    };
    return setTimeout(next, 10);
  }
  if (msg.id !== undefined && msg.method) emit({ id: msg.id, error: { code: -32601, message: 'fixture does not implement ' + msg.method } });
});
`, { mode: 0o755 });
  return cli;
}

/** Collects the renderer's long tasks (over 50 ms) until `stop`. */
async function watchLongTasks(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __longTasks: number[]; __longTaskObserver?: PerformanceObserver };
    w.__longTasks = [];
    w.__longTaskObserver?.disconnect();
    w.__longTaskObserver = new PerformanceObserver((list) => { for (const entry of list.getEntries()) w.__longTasks.push(entry.duration); });
    w.__longTaskObserver.observe({ type: "longtask" });
    if (!PerformanceObserver.supportedEntryTypes.includes("longtask")) throw new Error("this renderer reports no long tasks");
  });
}
async function longTasks(page: Page): Promise<{ count: number; totalMs: number; maxMs: number }> {
  return page.evaluate(() => {
    const w = window as unknown as { __longTasks: number[]; __longTaskObserver?: PerformanceObserver };
    w.__longTaskObserver?.disconnect();
    const list = w.__longTasks;
    return { count: list.length, totalMs: Math.round(list.reduce((a, b) => a + b, 0)), maxMs: Math.round(Math.max(0, ...list)) };
  });
}

let app: ElectronApplication | undefined;
let home = "", repo = "";
test.afterEach(async () => {
  await app?.close().catch(() => {});
  app = undefined;
  for (const dir of [home, repo]) if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

async function measureTranscript(testInfo: TestInfo, launchNumber: number): Promise<number> {
  ({ home, repo } = seedHome());
  const threadId = "long-transcript";
  const saved = longTranscript(threadId);
  fs.writeFileSync(path.join(home, "app", "threads", `${threadId}.json`), JSON.stringify(saved));
  const statePath = path.join(home, "app", "state.json");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  const now = new Date().toISOString();
  const thread = (id: string, title: string) => ({ id, projectId: "p1", title, titleSource: "manual", createdAt: now, updatedAt: now, cwd: repo, backend: "codex", mode: "chat", plan: false, model: "", status: "idle" });
  // A newer, short thread is the one the window opens at launch, so the long one's first open is cold.
  fs.writeFileSync(path.join(home, "app", "threads", "short.json"), JSON.stringify([{ id: "u-short", kind: "user", text: "hi", at: now }]));
  state.threads = [thread("short", "Short"), thread(threadId, "Long transcript")];
  fs.writeFileSync(statePath, JSON.stringify(state));
  let page: Page;
  ({ app, page } = await launch(home));
  // Whether the window loaded the long thread at launch, which would make the first open below warm.
  const selectedAtLaunch = await page.locator(`[data-testid="thread-row"][data-thread-id="${threadId}"][aria-current="true"]`).count() > 0;
  // Item events main sends while the thread opens. Nothing in it needs settling, so there should be none.
  await app.evaluate(({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0]!.webContents;
    const send = contents.send.bind(contents);
    const seen = (globalThis as unknown as { __openEvents: string[] }).__openEvents = [];
    contents.send = (channel: string, ...args: unknown[]) => {
      if (channel === "thread:event") seen.push((args[0] as { type: string }).type);
      return send(channel, ...args);
    };
  });
  const opens: number[] = [];
  const tasks: { count: number; totalMs: number; maxMs: number }[] = [];
  for (let run = 0; run < 5; run++) {
    await page.keyboard.press("Meta+n");
    await expect(tid(page, "draft-view")).toBeVisible();
    await watchLongTasks(page);
    // Timed in the renderer: the click, then every 5 ms until the last answer is in the transcript and in view.
    opens.push(await page.evaluate(async ({ id, marker }) => {
      const row = document.querySelector<HTMLElement>(`[data-testid="thread-row"][data-thread-id="${id}"] button.thread-main`)!;
      const start = performance.now();
      row.click();
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        const transcript = document.querySelector<HTMLElement>('[data-testid="transcript"]');
        // Item markup both this build and the pre-#273 baseline share, so the same probe measures either.
        const answers = transcript ? [...transcript.querySelectorAll<HTMLElement>('[data-testid="item"][data-item-kind="assistant"]')] : [];
        const last = answers.at(-1);
        if (last?.textContent?.includes(marker)) {
          const box = last.getBoundingClientRect(), view = transcript!.getBoundingClientRect();
          if (box.top < view.bottom && box.bottom > view.top) return performance.now() - start;
        }
        if (performance.now() - start > 60_000) {
          const box = last?.getBoundingClientRect(), view = transcript?.getBoundingClientRect();
          throw new Error(`the last answer never showed: ${answers.length} answers, last ${JSON.stringify(last?.textContent?.slice(0, 40))}, box ${box?.top}–${box?.bottom}, view ${view?.top}–${view?.bottom}`);
        }
      }
    }, { id: threadId, marker: `Answer ${TURNS - 1}.` }));
    tasks.push(await longTasks(page));
  }
  // The share of an open that is main reading the file and IPC: thread:items, called from the renderer.
  const loads: number[] = [];
  for (let run = 0; run < 3; run++) loads.push(await page.evaluate(async (id) => { const start = performance.now(); await window.modex!.invoke("thread:items", { threadId: id }); return performance.now() - start; }, threadId));
  const measurement = {
    turns: TURNS, items: saved.length, savedBytes: Buffer.byteLength(JSON.stringify(saved)),
    viewport: await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scale: devicePixelRatio })),
    firstOpenMs: Math.round(opens[0]!), repeatOpenMs: opens.slice(1).map(Math.round), repeatMedianMs: Math.round(median(opens.slice(1))),
    rendererLongTasks: { first: tasks[0], repeats: tasks.slice(1) },
    threadItemsIpcMs: loads.map(Math.round), selectedAtLaunch, renderedItems: await items(page).count(),
    threadEventsOnOpen: Object.fromEntries(Object.entries(Object.groupBy(await app.evaluate(() => (globalThis as unknown as { __openEvents: string[] }).__openEvents), (type) => type)).map(([type, list]) => [type, list!.length])),
  };
  if (launchNumber === 0) results.longTranscript = measurement;
  (results.coldLaunches as unknown[]).push(measurement);
  await testInfo.attach(`long-transcript-${launchNumber + 1}.json`, { body: JSON.stringify(measurement, null, 2), contentType: "application/json" });
  expect(selectedAtLaunch, "each first open must use a cold renderer cache").toBe(false);
  expect(measurement.renderedItems).toBe(TURNS * 7);
  await expect(items(page, "assistant").last()).toContainText(`Answer ${TURNS - 1}.`);
  // Opening a saved thread is a read: main resends none of its items.
  const opened = measurement.threadEventsOnOpen;
  expect([opened.item ?? 0, opened.item_update ?? 0]).toEqual([0, 0]);
  return opens[0]!;
}

test("a 200-turn transcript opens within the agreed median budget across five fresh launches", async ({}, testInfo) => {
  // Val approved 500 ms on 2026-10-22. A new Electron process per sample prevents
  // RenderCache reuse; use the median to resist isolated CI scheduling stalls.
  // Do not retry a failed budget or substitute the much faster warm reopens.
  results.coldLaunches = [];
  const firstOpens: number[] = [];
  for (let launchNumber = 0; launchNumber < 5; launchNumber++) {
    firstOpens.push(await measureTranscript(testInfo, launchNumber));
    await app!.close();
    app = undefined;
    for (const dir of [home, repo]) fs.rmSync(dir, { recursive: true, force: true });
    home = repo = "";
  }
  const medianMs = median(firstOpens);
  results.firstOpenBudget = { approvedBy: "Val", approvedOn: "2026-10-22", limitMs: 500, samplesMs: firstOpens, medianMs };
  console.log(`[transcript-budget] ${JSON.stringify({ ...results.firstOpenBudget as object, cpu: os.cpus()[0]?.model, cores: os.cpus().length, platform: process.platform, arch: process.arch, node: process.version })}`);
  await testInfo.attach("first-open-budget.json", { body: JSON.stringify(results.firstOpenBudget, null, 2), contentType: "application/json" });
  expect(medianMs, `cold first-open samples (ms): ${firstOpens.join(", ")}`).toBeLessThanOrEqual(500);
});

test("a 3 MiB command log streams to the window bounded, and the turn settles", async ({}, testInfo: TestInfo) => {
  ({ home, repo } = seedHome({ default_backend: "codex" }));
  const statePath = path.join(home, "app", "state.json");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  state.settings.codex_bin = fakeCodex(home);
  fs.writeFileSync(statePath, JSON.stringify(state));
  let page: Page;
  ({ app, page } = await launch(home));
  // Count what main sends the window, from main itself.
  await app.evaluate(({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0]!.webContents;
    const send = contents.send.bind(contents);
    const m = { bytes: 0, events: 0, largestEvent: 0, largestOutput: 0, first: 0, idle: 0, cpu: process.cpuUsage(), cpuMs: 0 };
    (globalThis as unknown as { __measure: typeof m }).__measure = m;
    contents.send = (channel: string, ...args: unknown[]) => {
      if (channel === "thread:event") {
        const event = args[0] as { type: string; status?: string; item?: { kind?: string; output?: string }; patch?: { output?: string } };
        const size = Buffer.byteLength(JSON.stringify(event));
        m.bytes += size; m.events++; m.largestEvent = Math.max(m.largestEvent, size);
        const output = event.item?.output ?? event.patch?.output;
        if (typeof output === "string") m.largestOutput = Math.max(m.largestOutput, Buffer.byteLength(output));
        if (!m.first && (event.type === "item" || event.type === "item_update")) m.first = performance.now();
        if (event.type === "status" && event.status === "idle" && m.first && !m.idle) {
          m.idle = performance.now();
          const cpu = process.cpuUsage(m.cpu);
          m.cpuMs = Math.round((cpu.user + cpu.system) / 1000);
        }
      }
      return send(channel, ...args);
    };
  });
  await page.keyboard.press("Meta+n");
  await expect(tid(page, "composer-input")).toBeFocused();
  await tid(page, "composer-input").fill("Print a long log");
  await watchLongTasks(page);
  const sentAt = Date.now();
  await page.keyboard.press("Meta+Enter");
  await expect(page.getByText("Streamed the log.")).toBeVisible({ timeout: 60_000 });
  const shownMs = Date.now() - sentAt;
  await expect.poll(() => app!.evaluate(() => (globalThis as unknown as { __measure: { idle: number } }).__measure.idle)).toBeGreaterThan(0);
  const main = await app.evaluate(() => {
    const m = (globalThis as unknown as { __measure: { bytes: number; events: number; largestEvent: number; largestOutput: number; first: number; idle: number; cpuMs: number } }).__measure;
    return { bytes: m.bytes, events: m.events, largestEvent: m.largestEvent, largestOutput: m.largestOutput, streamMs: Math.round(m.idle - m.first), cpuMs: m.cpuMs };
  });
  results.logStream = {
    loggedBytes: CHUNK.length * CHUNKS, deltas: CHUNKS, deltaSpacingMs: 10,
    sentToWindow: { bytes: main.bytes, events: main.events, largestEventBytes: main.largestEvent, largestOutputBytes: main.largestOutput },
    mainStreamMs: main.streamMs, mainCpuMs: main.cpuMs, sendToAnswerShownMs: shownMs,
    rendererLongTasks: await longTasks(page),
  };
  await testInfo.attach("log-stream.json", { body: JSON.stringify(results.logStream, null, 2), contentType: "application/json" });
  // Machine-independent bounds: no event carries more than the preview, and the window was told the whole size.
  expect(main.largestOutput).toBeLessThanOrEqual(PREVIEW);
  expect(main.bytes).toBeLessThan(CHUNKS * (PREVIEW + 4096));
  await tid(page, "turn-label").last().click();
  const tool = items(page, "tool").filter({ hasText: "yes | head" });
  await tid(tool, "item-toggle").click();
  await expect(tid(tool, "tool-truncated")).toHaveText("Showing the last 256 KB of 3.0 MB.");
});
