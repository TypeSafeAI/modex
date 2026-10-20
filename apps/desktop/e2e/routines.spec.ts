import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { items, launch, seedHome, tid, waitForWindowReady } from "./support";

/**
 * Routines Phase 1 exit tests (docs/specs/2026-10-11-modex-routines-spec.md): a routine runs with the
 * window closed and shows in Activity on reopening; killing Modex mid-run leaves the run interrupted
 * with no page revision; a routine's turn is read-only and its approvals are refused.
 */

type Run = { status: string; threadId?: string; page?: { revision: number } };
const routinesFile = (home: string) => path.join(home, "app", "routines.json");
const runs = (home: string): Run[] => fs.existsSync(routinesFile(home)) ? JSON.parse(fs.readFileSync(routinesFile(home), "utf8")).runs : [];
const script = (home: string, name: string, steps: unknown[]) => { const file = path.join(home, `${name}.json`); fs.writeFileSync(file, JSON.stringify(steps)); return file; };
const routine = (projectId: string, trigger: unknown, over: Record<string, unknown> = {}) => ({ name: "Repository check", projectId, instructions: "Summarize the repository's state.", mode: "chat", enabled: true, trigger, ...over });

let app: ElectronApplication | undefined;
test.afterEach(async () => { try { await app?.close(); } catch { /* A killed app is already gone. */ } app = undefined; });

async function openRoutines(page: Page) {
  await tid(page, "rail-routines").click();
  await expect(tid(page, "routines-view")).toBeVisible();
}

test("with the window closed, a routine still runs, and reopening shows it in Activity", async () => {
  test.skip(process.platform !== "darwin", "macOS keeps Modex running after its last window closes");
  const { home } = seedHome();
  const settings = JSON.parse(fs.readFileSync(path.join(home, "app", "state.json"), "utf8"));
  settings.settings.mock_script = script(home, "quick", [{ content: "The repository is quiet: one commit, no open work." }]);
  fs.writeFileSync(path.join(home, "app", "state.json"), JSON.stringify(settings));
  let page: Page;
  ({ app, page } = await launch(home));
  const at = new Date(Date.now() + 4000).toISOString();
  await page.evaluate((draft) => window.modex!.invoke("routines:save", draft), routine("p1", { kind: "once", at }));

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
  await expect.poll(() => runs(home)[0]?.status, { timeout: 30_000, message: "the routine runs with no window" }).toBe("completed");

  const nextWindow = app.waitForEvent("window");
  await app.evaluate(({ app }) => app.emit("activate"));
  page = await nextWindow;
  await waitForWindowReady(app, page);
  await openRoutines(page);
  const row = tid(page, "activity-row");
  await expect(row).toHaveCount(1);
  await expect(row).toHaveAttribute("data-status", "completed");
  await expect(row).toContainText("Scheduled");
  await expect(tid(row, "activity-page")).toHaveText("Repository check · revision 1");
  await expect(tid(page, "routine-next")).toHaveText("Ran; no further runs");
  await tid(row, "activity-thread").click();
  await expect(items(page, "notice").first()).toContainText("Routine “Repository check” · scheduled run · read-only Chat");
  await expect(items(page, "assistant")).toHaveText("The repository is quiet: one commit, no open work.");
});

test("killing Modex mid-run leaves the run interrupted on restart, with no page revision", async () => {
  const { home } = seedHome();
  const state = JSON.parse(fs.readFileSync(path.join(home, "app", "state.json"), "utf8"));
  state.settings.mock_script = script(home, "slow", [{ content: "still working ".repeat(3000) }]);
  fs.writeFileSync(path.join(home, "app", "state.json"), JSON.stringify(state));
  let page: Page;
  ({ app, page } = await launch(home));
  const saved = await page.evaluate((draft) => window.modex!.invoke("routines:save", draft),
    routine("p1", { kind: "interval", every: 1, unit: "days", from: new Date(Date.now() + 86_400_000).toISOString() }));
  await page.evaluate((id) => window.modex!.invoke("routines:run", { id }), saved.id);
  await expect.poll(() => runs(home)[0]?.threadId, { message: "the run's turn started" }).toBeTruthy();
  await expect.poll(() => {
    const threadId = runs(home)[0]?.threadId;
    const file = threadId ? path.join(home, "app", "threads", `${threadId}.json`) : "";
    return file && fs.existsSync(file) ? fs.readFileSync(file, "utf8").includes("still working") : false;
  }, { message: "the reply is streaming" }).toBe(true);

  app.process().kill("SIGKILL");
  await new Promise((resolve) => app!.process().once("exit", resolve));
  app = undefined;
  expect(runs(home)[0]?.status, "the file still says running: nothing finished it").toBe("running");

  const restarted = JSON.parse(fs.readFileSync(path.join(home, "app", "state.json"), "utf8"));
  restarted.settings.mock_script = script(home, "quick", [{ content: "Checked again: all quiet." }]);
  fs.writeFileSync(path.join(home, "app", "state.json"), JSON.stringify(restarted));
  ({ app, page } = await launch(home));
  await openRoutines(page);
  const interrupted = tid(page, "activity-row");
  await expect(interrupted).toHaveCount(1, { timeout: 10_000 });
  await expect(interrupted).toHaveAttribute("data-status", "interrupted");
  await expect(interrupted).toContainText("Modex quit while this run was working.");
  await expect(tid(interrupted, "activity-page")).toHaveCount(0);

  // The next run writes the page's first revision: the interrupted run wrote none.
  await tid(page, "routine-run-now").click();
  await expect(tid(page, "activity-row").first()).toHaveAttribute("data-status", "completed", { timeout: 30_000 });
  await expect(tid(tid(page, "activity-row").first(), "activity-page")).toHaveText("Repository check · revision 1");
  await expect(tid(page, "activity-row")).toHaveCount(2);
});

test("a routine made in the editor runs read-only: its edit is refused with a receipt and the checkout is untouched", async () => {
  const { home, repo } = seedHome();
  const state = JSON.parse(fs.readFileSync(path.join(home, "app", "state.json"), "utf8"));
  state.settings.mock_script = script(home, "edit", [
    { content: "Let me write a note.", tool_calls: [{ name: "apply_patch", arguments: { patch: "*** Begin Patch\n*** Add File: ROUTINE.md\n+written by a routine\n*** End Patch" } }] },
    { content: "I could not edit files, so here is the summary instead." },
  ]);
  fs.writeFileSync(path.join(home, "app", "state.json"), JSON.stringify(state));
  let page: Page;
  ({ app, page } = await launch(home));
  await openRoutines(page);
  await tid(page, "routine-new").click();
  await tid(page, "routine-name").fill("Weekly summary");
  await tid(page, "routine-instructions").fill("Write a short summary of the week.");
  await tid(page, "routine-mode-plan").check();
  await tid(page, "routine-save").click();
  const row = tid(page, "routine-row");
  await expect(row).toContainText("Weekly summary");
  await expect(row).toContainText("Plan (read-only)");
  await expect(tid(row, "routine-next")).toContainText("Next run");

  await tid(row, "routine-run-now").click();
  const activity = tid(page, "activity-row").first();
  await expect(activity).toHaveAttribute("data-status", "completed", { timeout: 30_000 });
  await expect(activity).toContainText("Run now");
  await expect(tid(activity, "activity-page")).toHaveText("Weekly summary · revision 1");
  await tid(activity, "activity-thread").click();
  // A finished turn folds its work; the refused approval is part of it.
  await tid(page, "turn-label").last().click();
  const refusal = items(page, "approval");
  await expect(refusal).toHaveAttribute("data-decided-by", "never");
  await expect(tid(refusal, "approval-receipt")).toContainText("Refused: add ROUTINE.md");
  await expect(tid(refusal, "receipt-meta")).toHaveText("Routine run: approvals are refused while it runs unattended");
  await expect(items(page, "assistant").last()).toHaveText("I could not edit files, so here is the summary instead.");
  expect(fs.existsSync(path.join(repo, "ROUTINE.md")), "the checkout is untouched").toBe(false);
});
