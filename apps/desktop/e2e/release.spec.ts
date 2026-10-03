import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { launch, seedHome, tid } from "./support";

let app: ElectronApplication;
let page: Page;
let home: string;
let repo: string;

test.beforeEach(async () => {
  ({ home, repo } = seedHome());
  ({ app, page } = await launch(home));
});

test.afterEach(async () => {
  await app?.close();
  const pidFile = path.join(home, "fixture.pid");
  if (fs.existsSync(pidFile)) {
    try { process.kill(Number(fs.readFileSync(pidFile, "utf8")), "SIGKILL"); } catch { /* fixture already exited */ }
  }
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

test("reasoning effort can be selected with the keyboard and returns focus to the picker", async () => {
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler("models:list");
    ipcMain.handle("models:list", () => ({ models: [
      { id: "mock", label: "Reasoning model", isDefault: true, efforts: ["low", "high"], defaultEffort: "low" },
      { id: "other", label: "Other model" },
    ] }));
  });
  await page.reload();
  const picker = tid(page, "model-picker");
  await expect(picker).toContainText("Reasoning model");
  await picker.focus();
  await page.keyboard.press("Enter");
  await expect(tid(page, "model-option").first()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  const high = page.getByRole("menuitemradio", { name: "Reasoning effort: high", exact: true });
  await expect(high).toBeFocused({ timeout: 1500 });
  await page.screenshot({ path: test.info().outputPath("reasoning-menu.png") });
  await page.keyboard.press("Enter");
  await expect(tid(page, "model-menu")).toHaveCount(0);
  await expect(picker).toContainText("high");
  await expect(picker).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(high).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await expect(picker).toContainText("Other model", { timeout: 1500 });
});

test("minimum window keeps composer controls inside the main pane with Changes open", async () => {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(900, 600));
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(900);
  await tid(page, "composer-input").fill("Review the project");
  await page.keyboard.press("Meta+Enter");
  await expect(tid(page, "changes-panel")).toBeVisible();
  const main = (await tid(page, "main").boundingBox())!;
  for (const id of ["composer-input", "model-picker", "stop"]) {
    const control = tid(page, id);
    await expect(control).toBeVisible();
    const box = (await control.boundingBox())!;
    expect(box.x, id).toBeGreaterThanOrEqual(main.x);
    expect(box.x + box.width, id).toBeLessThanOrEqual(main.x + main.width + 1);
  }
  for (const id of ["context-project", "context-kind", "context-branch"]) {
    expect(await tid(page, id).evaluate((el) => el.scrollWidth <= el.clientWidth + 1), `${id} text overflows its label`).toBe(true);
  }
  await page.screenshot({ path: test.info().outputPath("minimum-window.png") });
});

test("switching projects does not carry another thread's unsent instructions", async () => {
  await app.close();
  const file = path.join(home, "app/state.json");
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  state.projects.push({ ...state.projects[0], id: "p2", name: "Second project" });
  state.threads = ["one", "two"].map((id, i) => ({ id, projectId: i ? "p2" : "p1", title: id, cwd: repo, backend: "mock", model: "mock", mode: "chat", plan: false, status: "idle", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
  fs.writeFileSync(file, JSON.stringify(state));
  ({ app, page } = await launch(home));
  await expect(tid(page, "thread-view")).toHaveAttribute("data-thread-id", "one");
  await tid(page, "composer-input").fill("Only change files in the first project");
  await tid(page, "thread-row").filter({ hasText: "two" }).getByRole("button", { name: "two", exact: true }).click();
  await expect(tid(page, "thread-view")).toHaveAttribute("data-thread-id", "two");
  await expect(tid(page, "composer-input")).toHaveValue("", { timeout: 1500 });
});

test("New chat resets an existing draft while settings changes preserve its text", async () => {
  await tid(page, "composer-input").fill("Old unsent draft");
  await page.keyboard.press("Meta+Shift+p");
  await expect(tid(page, "composer-input")).toHaveValue("Old unsent draft");
  await page.keyboard.press("Meta+n");
  await expect(tid(page, "composer-input")).toHaveValue("", { timeout: 1500 });
});

test("unsent text waits on its own thread: switching threads keeps it, the sidebar marks it, sending clears it", async () => {
  await app.close();
  const file = path.join(home, "app/state.json");
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  state.threads = ["one", "two"].map((id) => ({ id, projectId: "p1", title: id, cwd: repo, backend: "mock", model: "mock", mode: "chat", plan: false, status: "idle", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
  fs.writeFileSync(file, JSON.stringify(state));
  ({ app, page } = await launch(home));
  const row = (title: string) => tid(page, "thread-row").filter({ hasText: title });
  const open = (title: string) => row(title).getByRole("button", { name: title, exact: true }).click();
  const input = tid(page, "composer-input");
  await expect(tid(page, "thread-view")).toHaveAttribute("data-thread-id", "one");
  await input.fill("Keep this for one");
  await expect(tid(row("one"), "thread-row-unsent")).toHaveCount(0); // the selected thread needs no reminder

  // Another thread starts empty and the first thread's row shows a pen.
  await open("two");
  await expect(tid(page, "thread-view")).toHaveAttribute("data-thread-id", "two");
  await expect(input).toHaveValue("");
  await expect(tid(row("one"), "thread-row-unsent")).toBeVisible();
  await input.fill("Second thread text");

  // Coming back restores the text exactly; a new chat is still empty; the draft's text stays with the draft.
  await open("one");
  await expect(input).toHaveValue("Keep this for one");
  await expect(tid(row("one"), "thread-row-unsent")).toHaveCount(0);
  await expect(tid(row("two"), "thread-row-unsent")).toBeVisible();
  await page.keyboard.press("Meta+n");
  await expect(tid(page, "draft-view")).toBeVisible();
  await expect(input).toHaveValue("");
  await input.fill("Draft text");
  await open("two");
  await expect(input).toHaveValue("Second thread text");
  await page.keyboard.press("Meta+n");
  await expect(input).toHaveValue(""); // ⌘N is always a fresh draft
  await open("one");

  // Sending clears the thread's text and its marker.
  await expect(input).toHaveValue("Keep this for one");
  await page.keyboard.press("Meta+Enter");
  await expect(input).toHaveValue("");
  await expect(tid(page, "thread-row").filter({ hasText: "one" }).locator('[data-testid="thread-row-unsent"]')).toHaveCount(0);
  await open("two");
  await expect(input).toHaveValue("Second thread text");
  await expect(tid(row("one"), "thread-row-unsent")).toHaveCount(0);
});

test("quitting waits for the CLI to stop and flushes the final transcript", async () => {
  await app.close();
  const stopped = path.join(home, "fixture-stopped");
  const pidFile = path.join(home, "fixture.pid");
  const cli = path.join(home, "claude-fixture.cjs");
  fs.writeFileSync(cli, `#!${process.execPath}\nconst fs = require('node:fs');\nfs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nprocess.on('SIGTERM', () => setTimeout(() => { fs.writeFileSync(${JSON.stringify(stopped)}, 'stopped'); process.exit(0); }, 300));\nrequire('node:readline').createInterface({input:process.stdin}).on('line', () => process.stdout.write(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'final shutdown text'}]}})+'\\n'));\nsetInterval(() => {}, 1000);\n`, { mode: 0o755 });
  const file = path.join(home, "app/state.json");
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  state.settings.default_backend = "claude";
  state.settings.claude_bin = cli;
  fs.writeFileSync(file, JSON.stringify(state));
  ({ app, page } = await launch(home));
  await tid(page, "composer-input").fill("Test shutdown");
  await page.keyboard.press("Meta+Enter");
  await expect(page.getByText("final shutdown text", { exact: true })).toBeVisible();
  await app.close();
  expect(fs.existsSync(stopped), "the app exited before its CLI acknowledged termination").toBe(true);
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  const transcript = fs.readFileSync(path.join(home, "app/threads", `${saved.threads[0].id}.json`), "utf8");
  expect(transcript).toContain("final shutdown text");
});

test("the bundled terminal engine starts a real PTY in the thread directory", async () => {
  const result = await page.evaluate(async () => {
    const bridge = window.modex!;
    const thread = await bridge.invoke("thread:create", { projectId: "p1", backend: "mock", mode: "chat" });
    const chunks: string[] = [];
    let sessionId: string | undefined;
    let finish!: (code: number) => void;
    const exited = new Promise<number>((resolve) => { finish = resolve; });
    const unsubscribe = bridge.onTerminalEvent((event) => {
      if (event.threadId !== thread.id) return;
      if (event.type === "data") chunks.push(event.data);
      else finish(event.exitCode);
    });
    try {
      const session = await bridge.invoke("terminal:open", { threadId: thread.id, cols: 80, rows: 24 });
      sessionId = session.sessionId;
      await bridge.invoke("terminal:write", { threadId: thread.id, sessionId: session.sessionId, data: "printf '__MODEX_CWD__%s\\n' \"$PWD\"; test -t 0 && printf '__MODEX_TTY__yes\\n'; exit 0\r" });
      return { code: await exited, output: chunks.join(""), cwd: thread.cwd };
    } finally {
      unsubscribe();
      if (sessionId) await bridge.invoke("terminal:close", { threadId: thread.id, sessionId });
    }
  });
  expect(result.code).toBe(0);
  expect(result.output).toContain(`__MODEX_CWD__${result.cwd}`);
  expect(result.output).toContain("__MODEX_TTY__yes");
});

test("closing terminals releases every PTY the app opened", async () => {
  // node-pty 1.1.0 left one unused /dev/ptmx open per spawn, and macOS allows 511 machine-wide.
  // The unit suite proves the fix in Node; this proves it in the bundle that ships (MODEX_PACKAGED_APP).
  test.skip(process.platform !== "darwin", "counts /dev/ptmx handles with macOS lsof");
  const pid = String(app.process().pid);
  const masters = () => execFileSync("/usr/sbin/lsof", ["-p", pid], { encoding: "utf8" }).split("\n").filter((line) => line.includes("/dev/ptmx")).length;
  const before = masters();
  const threadId = await page.evaluate(async () => (await window.modex!.invoke("thread:create", { projectId: "p1", backend: "mock", mode: "chat" })).id);
  for (let i = 0; i < 5; i++) {
    const sessionId = await page.evaluate(async (threadId) => (await window.modex!.invoke("terminal:open", { threadId, cols: 80, rows: 24 })).sessionId, threadId);
    if (i === 0) expect(masters(), "an open terminal holds a PTY master the count can see").toBeGreaterThan(before);
    await page.evaluate(async ({ threadId, sessionId }) => { await window.modex!.invoke("terminal:close", { threadId, sessionId }); }, { threadId, sessionId });
  }
  await expect.poll(masters, { message: "closed terminals still hold PTY masters" }).toBe(before);
});
