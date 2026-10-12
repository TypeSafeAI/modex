import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { appDir, seedHome, tid } from "./support";

let app: ElectronApplication, page: Page, home: string, repo: string;
async function launchOwned() {
  const env = { ...process.env, MODEX_HOME: home, MODEX_E2E: "1", MODEX_NO_LOGIN_PATH: "1", TYPESAFE_API_KEY: "", JEV_API_KEY: "", JEV_CONFIG: path.join(home, "no-jev.json"), MODEX_OWNER_RETIRE_TEST: test.info().title.startsWith("automatic owner retirement") ? "1" : "0" };
  delete env.MODEX_PACKAGED_APP; delete env.MODEX_DEV_URL;
  app = await electron.launch({ args: [path.join(appDir, "e2e/fixtures/owner-removal.mjs")], cwd: appDir, env });
  page = await app.firstWindow(); await page.waitForLoadState("domcontentloaded");
  page.on("dialog", dialog => { if (dialog.type() !== "beforeunload") void dialog.dismiss(); });
  console.log(JSON.stringify({ fixtureHome: home, fixtureRepo: repo, electronPid: app.process().pid }));
}
test.beforeEach(async () => {
  ({ home, repo } = seedHome()); home = fs.realpathSync(home);
  const file = path.join(home, "app", "state.json"), state = JSON.parse(fs.readFileSync(file, "utf8"));
  const other = path.join(repo, "other"); fs.mkdirSync(other);
  state.projects.push({ id: "p2", name: "Other project", path: other, addedAt: new Date().toISOString() });
  fs.writeFileSync(file, JSON.stringify(state));
  await launchOwned();
  await expect(tid(page, "draft-view")).toBeVisible();
});
test.afterEach(async () => {
  await app?.close(); fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(repo, { recursive: true, force: true });
});
const recovery = () => JSON.parse(fs.readFileSync(path.join(home, "app", "update-recovery.json"), "utf8"));
const selectProject = async (id: string) => {
  await tid(page, "draft-project").click(); await page.locator(`[data-testid="draft-project-option"][data-project-id="${id}"]`).click();
  await expect(tid(page, "draft-view")).toHaveAttribute("data-project-id", id);
};

test("owner removal refuses raw whitespace typed before the debounce reaches disk", async () => {
  await expect.poll(() => { try { return recovery().revision; } catch { return 0; } }).toBeGreaterThan(0);
  const raw = " \n  ";
  const error = await page.evaluate(async raw => {
    const input = document.querySelector<HTMLTextAreaElement>('[data-testid="composer-input"]')!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, raw);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    try { await window.modex!.invoke("project:remove", { projectId: "p1" }); return "unexpected deletion"; }
    catch (error) { return (error as Error).message; }
  }, raw);
  expect(error).toMatch(/unsent draft/i);
  expect(recovery().drafts.projects.find((row: any) => row.projectId === "p1").text).toBe(raw);
  expect((await page.evaluate(() => window.modex!.invoke("state:get", undefined))).projects.some(project => project.id === "p1")).toBe(true);
  await expect(tid(page, "composer-input")).toBeEditable(); await expect(tid(page, "composer-input")).toHaveValue(raw);
});

test("owner removal retains another project's raw draft, attachments and configuration through a full relaunch", async () => {
  await selectProject("p2"); const raw = "  keep this project's raw draft 😀  ";
  await tid(page, "composer-input").fill(raw);
  await page.evaluate(() => {
    const data = new DataTransfer(); data.items.add(new File(["preserved attachment bytes"], "keep.txt", { type: "text/plain" }));
    document.querySelector('[data-testid="composer-input"]')!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expect(tid(page, "composer-attachments")).toContainText("keep.txt");
  await selectProject("p1");
  await expect.poll(() => { try { return recovery().drafts.draft.projectId; } catch { return null; } }).toBe("p1");
  const before = recovery().drafts, other = before.projects.find((row: any) => row.projectId === "p2"), settings = before.draft;
  await page.evaluate(() => window.modex!.invoke("project:remove", { projectId: "p1" }));
  await expect(tid(page, "draft-view")).toHaveAttribute("data-project-id", "p2");
  await expect(tid(page, "composer-input")).toBeEditable(); await expect(tid(page, "composer-input")).toHaveValue(raw);
  expect(recovery().drafts.projects).toEqual([other]); expect(recovery().drafts.draft).toEqual({ ...settings, projectId: "p2" });
  expect(fs.readFileSync(path.join(home, "attachments", other.attachments[0].rel), "utf8")).toBe("preserved attachment bytes");
  await app.close(); await launchOwned();
  await expect(tid(page, "composer-input")).toHaveValue(raw); await expect(tid(page, "composer-attachments")).toContainText("keep.txt");
  expect(recovery().drafts.projects).toEqual([other]); expect(recovery().drafts.draft).toEqual({ ...settings, projectId: "p2" });
});

test("automatic owner retirement adopts the actual retired-thread event without false draft drift", async () => {
  await page.evaluate(() => window.modex!.invoke("settings:update", { auto_retire: true }));
  const thread = await page.evaluate(() => window.modex!.invoke("thread:create", { projectId: "p1", worktree: true, backend: "mock" }));
  await page.reload();
  await page.locator(`[data-testid="thread-row"][data-thread-id="${thread.id}"] .thread-main`).click();
  await expect(tid(page, "thread-view")).toHaveAttribute("data-thread-id", thread.id);
  await expect.poll(() => { try { return recovery().drafts.selectedThreadId; } catch { return null; } }).toBe(thread.id);
  const retired = await app.evaluate(async (_electron, cwd) => {
    const cp = process.getBuiltinModule("node:child_process"), fixture = (globalThis as any).__ownerRemovalFixture;
    const headSha = cp.execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
    fixture.pullRequest = { state: "merged", number: 7, url: "https://example.test/pr/7", headSha };
    return fixture.retirer.sweep();
  }, thread.cwd);
  expect(retired).toEqual([thread.id]); expect(fs.existsSync(thread.cwd)).toBe(false);
  await expect(tid(page, "update-recovery")).toHaveCount(0);
  await expect(tid(page, "composer-input")).toBeEditable();
  expect(recovery().drafts.threads.some((row: any) => row.threadId === thread.id)).toBe(false);
  expect((await page.evaluate(() => window.modex!.invoke("state:get", undefined))).threads.find(row => row.id === thread.id)?.retired?.pr).toBe(7);
});

test("uncertain owner pruning shows fresh read-only recovery and exits through ordinary Quit", async () => {
  await selectProject("p2"); const raw = "  recovery preserves the other project 😀  ";
  await tid(page, "composer-input").fill(raw); await selectProject("p1");
  await expect.poll(() => { try { return recovery().drafts.draft.projectId; } catch { return null; } }).toBe("p1");
  await app.evaluate(() => { (globalThis as any).__ownerRemovalFixture.failAfterCommit = true; });
  const error = await page.evaluate(async () => {
    try { await window.modex!.invoke("project:remove", { projectId: "p1" }); return "unexpected deletion"; }
    catch (error) { return String(error); }
  });
  expect(error).toMatch(/lost owner-removal acknowledgment/);
  await expect(tid(page, "update-recovery")).toBeVisible();
  expect(await page.locator("textarea").evaluateAll(elements => elements.map(element => element.value))).toContain(raw);
  const bytes = fs.readFileSync(path.join(home, "app/update-recovery.json"));
  expect((await page.evaluate(() => window.modex!.invoke("state:get", undefined))).projects.some(project => project.id === "p1")).toBe(true);
  const evidence = await app.evaluate(() => {
    const { failedCommits, nativeCalls } = (globalThis as any).__ownerRemovalFixture; return { failedCommits, nativeCalls };
  });
  expect(evidence).toEqual({ failedCommits: 1, nativeCalls: 0 });
  const exited = app.waitForEvent("close"); await page.getByRole("button", { name: "Quit Modex", exact: true }).click(); await exited;
  expect(fs.readFileSync(path.join(home, "app/update-recovery.json"))).toEqual(bytes);
  const receipt = test.info().outputPath("owner-removal-recovery.json"); fs.writeFileSync(receipt, JSON.stringify({ ...evidence, ordinaryQuit: true, recoveryUnchanged: true }));
  await test.info().attach("owner-removal-recovery", { path: receipt, contentType: "application/json" });
});
