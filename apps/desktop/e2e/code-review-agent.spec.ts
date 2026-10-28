import fs from "node:fs";
import path from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { tid } from "./support.js";
import { baseWorld, fitWindow, launchWithGh, prRow, type Harness } from "./code-review-support.js";

/**
 * CR-6 (#325): agent review, questions and instructions in real Electron, through main's production
 * `code-review:agent` service, with the synthetic gh standing in for GitHub and a synthetic `claude` on PATH
 * standing in for Claude Code. The synthetic CLI answers the two probes Modex makes (`--version`, `auth status`),
 * records the argv of every run it is started with, and plays whatever its mode file says: fail, hang, or a
 * scripted stream-json reply. No model, no network, no real repository: every account, PR and finding is made up.
 */
let h: Harness;
let crashedChildPid: number | null = null;
let forceFixtureClose = false;
test.afterEach(async () => {
  // The crash test deliberately leaves unproven ownership, so production Quit must refuse.
  // End only the synthetic child captured for that test and its fixture Electron process.
  if (crashedChildPid) { try { process.kill(crashedChildPid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } }
  if (forceFixtureClose && h?.app.process().pid) { try { process.kill(h.app.process().pid!, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } }
  crashedChildPid = null;
  forceFixtureClose = false;
  await h?.close();
});

const HEAD = "c".repeat(40);
const REPLY = "The new branch `c` is never covered.\n\n```json\n{\"findings\":[{\"title\":\"Untested branch\",\"detail\":\"Line 2 adds a path with no test.\",\"severity\":\"minor\",\"path\":\"src/holds/move.ts\",\"line\":2},{\"title\":\"Elsewhere\",\"detail\":\"Not in this diff.\",\"severity\":\"note\",\"path\":\"src/missing.ts\",\"line\":9}]}\n```";

/** Replaces the harness's recorder with a synthetic Claude Code. Mode: "fail" | "hang" | "reply". */
function installClaude(mode: "fail" | "hang" | "reply"): void {
  const bin = path.join(h.home, "bin"), starts = path.join(h.home, "provider-starts.log");
  fs.writeFileSync(path.join(bin, "claude-mode"), mode);
  fs.writeFileSync(path.join(bin, "claude-reply.json"), JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: REPLY }] } }));
  fs.writeFileSync(path.join(bin, "claude"), `#!/bin/sh
dir="$(cd "$(dirname "$0")" && pwd)"
case "$1" in
  --version) printf '2.1.312 (Claude Code)\\n'; exit 0 ;;
  auth) printf '{"loggedIn":true,"authMethod":"claude.ai"}\\n'; exit 0 ;;
esac
# One line per run: the argv (newlines folded) and whether the credentials Modex strips reached this process.
{ printf '%s %s' "$(basename "$0")" "$*" | tr '\\n' ' '; printf ' env:MODEX_HOME=%s,GH_CONFIG_DIR=%s,GH_TOKEN=%s cwd=%s\\n' "\${MODEX_HOME-unset}" "\${GH_CONFIG_DIR-unset}" "\${GH_TOKEN-unset}" "$PWD"; } >> '${starts}'
printf '%s\\n' "$$" >> "$dir/claude-pids"
mode="$(cat "$dir/claude-mode" 2>/dev/null || printf fail)"
case "$mode" in
  hang) read -r line; exec sleep 120 ;;
  reply)
    read -r line
    printf '%s\\n' '{"type":"system","subtype":"init","session_id":"s-e2e","claude_code_version":"2.1.312","model":"claude-fable-5-1"}'
    printf '%s\\n' '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu1","name":"Read","input":{"file_path":"INDEX.md"}}]}}'
    printf '%s\\n' '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu1","content":"index","is_error":false}]}}'
    cat "$dir/claude-reply.json"; printf '\\n'
    printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"session_id":"s-e2e","result":"done"}'
    exit 0 ;;
esac
exit 1
`, { mode: 0o755 });
}

async function openLending(): Promise<Page> {
  const page = h.page;
  await fitWindow(h, 1440, 900);
  await tid(page, "rail-code-review").click();
  await prRow(page, "example-org/lending#73").click();
  await expect(tid(page, "code-review-pr-id").first()).toHaveText("lending #73");
  return page;
}

async function reopen(): Promise<Page> {
  await h.page.reload();
  const page = h.page;
  await tid(page, "rail-code-review").click();
  await prRow(page, "example-org/lending#73").click();
  await expect(tid(page, "code-review-pr-id").first()).toHaveText("lending #73");
  return page;
}

const runs = () => h.providerStarts().filter((line) => line.startsWith("claude -p"));
const panel = (p: Page) => tid(p, "cr-agent-panel");
const section = (p: Page) => tid(p, "cr-agent");

test("the instructions popover states its scope, saves a version on this Mac only, survives a reload, and starts nothing", async () => {
  h = await launchWithGh(baseWorld());
  installClaude("reply");
  let page = await openLending();
  const gear = tid(page, "code-review-instructions").first();
  await expect(gear).not.toHaveAttribute("aria-disabled", "true");
  await gear.click();
  const dialog = page.getByRole("dialog", { name: "Review instructions" });
  await expect(dialog).toBeVisible();
  await expect(tid(page, "cr-instructions-scope")).toHaveText("Apply to every pull request you review in Modex, on any repository. Saved on this Mac only, as version 0; each run records the version it used.");
  await expect(dialog.getByRole("textbox", { name: "Review instructions" })).toBeFocused();
  // Escape closes and returns focus to the gear; nothing was saved.
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(gear).toBeFocused();
  await gear.click();
  await dialog.getByRole("textbox", { name: "Review instructions" }).fill("Flag any new dependency.");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toHaveCount(0);
  await gear.click();
  await expect(dialog.getByRole("textbox", { name: "Review instructions" })).toHaveValue("Flag any new dependency.");
  await expect(tid(page, "cr-instructions-scope")).toContainText("as version 1");
  await page.keyboard.press("Escape");
  // Main's file, not the renderer's memory: a reload reads it back.
  page = await reopen();
  await tid(page, "code-review-instructions").first().click();
  await expect(page.getByRole("dialog", { name: "Review instructions" }).getByRole("textbox", { name: "Review instructions" })).toHaveValue("Flag any new dependency.");
  const stored = JSON.parse(fs.readFileSync(path.join(h.home, "review-agent", "state.json"), "utf8")) as { instructions: { version: number; text: string } };
  expect(stored.instructions).toMatchObject({ version: 1, text: "Flag any new dependency." });
  expect(runs()).toEqual([]);
  expect(h.calls().filter((c) => c.startsWith("POST ") || c.startsWith("PUT ") || c.startsWith("PATCH "))).toEqual([]);
});

test("a review starts only on Start, runs the confined argv once without Modex's or gh's environment, fails visibly, and a reload shows the record without a second start", async () => {
  h = await launchWithGh(baseWorld());
  installClaude("fail");
  let page = await openLending();
  await expect(section(page)).toContainText("No runs yet");
  const review = tid(page, "code-review-review").first();
  await expect(review).not.toHaveAttribute("aria-disabled", "true");
  await review.click();
  await expect(panel(page)).toBeVisible();
  await expect(tid(page, "cr-agent-scope")).toContainText("on a snapshot of this pull request's diff at head cccccccc");
  await expect(panel(page)).toContainText("Nothing it says is posted to GitHub");
  await expect(panel(page).getByRole("combobox", { name: "Model" })).toHaveValue("fable");
  expect(runs()).toEqual([]);
  await panel(page).getByRole("button", { name: "Start review" }).click();
  const run = tid(page, "cr-agent-run").first();
  await expect(run).toHaveAttribute("data-run-state", "failed", { timeout: 20_000 });
  await expect(tid(run, "cr-agent-run-reason")).toContainText(/Claude Code (ended with an error|couldn't be started)/);
  // The fixture's PR declares 11 changed files and lists two: the gap is reported, never papered over.
  await expect(tid(run, "cr-agent-coverage")).toHaveText("1 of 11 changed files in the snapshot · 1 not included · file list cut short");
  const started = runs();
  expect(started).toHaveLength(1);
  const argv = started[0]!;
  for (const flag of ["--safe-mode", "--restricted", "--tools Read", "--strict-mcp-config", "--mcp-config {\"mcpServers\":{}}", "--disable-slash-commands", "--setting-sources ", "--permission-mode dontAsk", "--permission-prompts none", "--no-session-persistence", "--max-turns", "--append-system-prompt", "--model fable"]) expect(argv, flag).toContain(flag);
  for (const flag of ["--permission-prompt-tool", "--bare", "--resume", "--add-dir", "--dangerously-skip-permissions"]) expect(argv, flag).not.toContain(flag);
  expect(argv).toContain("env:MODEX_HOME=unset,GH_CONFIG_DIR=unset,GH_TOKEN=unset");
  expect(argv).toContain(`cwd=${fs.realpathSync(h.home)}/review-agent/runs/`);
  // The snapshot is gone with the run; nothing of the PR stays on disk but the record.
  expect(fs.existsSync(path.join(h.home, "review-agent", "runs")) ? fs.readdirSync(path.join(h.home, "review-agent", "runs")) : []).toEqual([]);
  // The reads main made: identity, the repository by id, the pull, its files, then the pull again. No write.
  expect(h.calls().filter((c) => c.startsWith("POST ") || c.startsWith("PUT ") || c.startsWith("PATCH "))).toEqual([]);
  page = await reopen();
  await expect(tid(page, "cr-agent-run").first()).toHaveAttribute("data-run-state", "failed");
  expect(runs()).toHaveLength(1);
});

test("a scripted reply shows its findings bound to the head, an anchored finding joins the review draft, and a moved head refuses a start and marks the run outdated", async () => {
  h = await launchWithGh(baseWorld());
  installClaude("reply");
  let page = await openLending();
  await tid(page, "code-review-review").first().click();
  await panel(page).getByRole("button", { name: "Start review" }).click();
  const run = tid(page, "cr-agent-run").first();
  await expect(run).toHaveAttribute("data-run-state", "completed", { timeout: 20_000 });
  await expect(tid(run, "cr-agent-reply")).toContainText("is never covered.");
  await expect(tid(run, "cr-agent-reply")).not.toContainText("findings");
  const findings = tid(run, "cr-agent-finding");
  await expect(findings).toHaveCount(2);
  await expect(findings.nth(0)).toHaveAttribute("data-reference", "anchored");
  await expect(findings.nth(0)).toContainText("src/holds/move.ts:2 · In the diff");
  await expect(findings.nth(1)).toHaveAttribute("data-reference", "unverified");
  await expect(findings.nth(1)).toContainText("src/missing.ts:9 · Not found in the diff");
  await expect(findings.nth(1).getByRole("button", { name: "Add to review draft" })).toHaveCount(0);
  await expect(run.getByText("1 tool call", { exact: false }).first()).toBeVisible();
  // Into the review draft: CR-7's draft, previewed and submitted separately. Nothing reaches GitHub here.
  await findings.nth(0).getByRole("button", { name: "Add to review draft" }).click();
  await expect(findings.nth(0).getByRole("status")).toContainText("Added to the review draft");
  const composer = page.getByRole("region", { name: "Review this pull request" });
  if (await composer.getByRole("textbox", { name: "Review summary" }).count() === 0) await composer.getByRole("button", { name: "Review", exact: true }).click();
  await expect(composer.getByRole("list", { name: "Line comments" })).toContainText("src/holds/move.ts · head 2");
  expect(h.posts()).toEqual([]);
  expect(runs()).toHaveLength(1);
  // The head moves on GitHub. A start from the stale page is refused; after a reload the run is outdated, and not re-run.
  h.world((w) => { (w.routes["repos/example-org/lending/pulls/73"] as { head: { sha: string } }).head.sha = "d".repeat(40); });
  await panel(page).getByRole("button", { name: "Start review" }).click();
  await expect(panel(page).getByRole("alert")).toContainText("The pull request's head moved. Reload it, then start again.");
  expect(runs()).toHaveLength(1);
  page = await reopen();
  await expect(tid(page, "cr-agent-outdated").first()).toHaveText(`Outdated · made for head ${HEAD.slice(0, 8)}`);
  await expect(tid(page, "cr-agent-finding").first().getByRole("button", { name: "Add to review draft" })).toBeDisabled();
  expect(runs()).toHaveLength(1);
});

test("a question is answered by a run of its own, with 'Add to chat' quoting a comment into it", async () => {
  h = await launchWithGh({ ...baseWorld(), routes: { ...baseWorld().routes, "repos/example-org/lending/issues/73/timeline": [{ event: "commented", id: 900, user: { id: 1002, login: "grace-fixture", type: "User" }, body: "Does this change the retry path?", created_at: "2026-10-18T21:00:00Z" }] } });
  installClaude("reply");
  const page = await openLending();
  const ask = tid(page, "cr-agent-ask");
  await page.getByRole("button", { name: "Comment actions" }).first().click();
  await page.getByRole("menuitem", { name: "Add to chat" }).click();
  await expect(ask.getByRole("textbox")).toHaveValue("> Does this change the retry path?\n\n");
  await ask.getByRole("textbox").fill("> Does this change the retry path?\n\nWhat would you answer?");
  await ask.getByRole("button", { name: "Ask" }).click();
  const run = tid(page, "cr-agent-run").first();
  await expect(run).toContainText("Question");
  await expect(run).toHaveAttribute("data-run-state", "completed", { timeout: 20_000 });
  await expect(run.locator(".cr-agent-question")).toHaveText("> Does this change the retry path?\n\nWhat would you answer?");
  await expect(ask.getByRole("textbox")).toHaveValue("");
  expect(runs()).toHaveLength(1);
  expect(h.posts()).toEqual([]);
});

test("Stop ends a running review, and a crash mid-run reads as unknown after a relaunch with nothing replayed", async () => {
  h = await launchWithGh(baseWorld());
  installClaude("hang");
  let page = await openLending();
  await tid(page, "code-review-review").first().click();
  await panel(page).getByRole("button", { name: "Start review" }).click();
  await expect(tid(page, "cr-agent-run").first()).toHaveAttribute("data-run-state", "running");
  await expect(tid(page, "code-review-review").first()).toHaveAttribute("aria-label", "Review running");
  // A second start while one is going is refused by main, not just hidden by the view.
  const refused = await page.evaluate(async () => {
    const reply = await window.modex!.invoke("code-review:agent", { op: "start", requestId: "probe-busy", key: { account: "1001", host: "github.com", repoId: "7301", number: 73 },
      revision: { baseRef: "main", baseSha: "b".repeat(40), headSha: "c".repeat(40) }, kind: "review", question: null, model: "fable" });
    return reply.result.state === "refused" ? reply.result.reason : "started";
  });
  expect(refused).toBe("busy");
  await tid(page, "cr-agent-stop").click();
  await expect(tid(page, "cr-agent-run").first()).toHaveAttribute("data-run-state", "stopped", { timeout: 30_000 });
  await expect(tid(tid(page, "cr-agent-run").first(), "cr-agent-run-reason")).toHaveText("Stopped before it finished.");
  expect(runs()).toHaveLength(1);
  // Start again, then lose the process mid-run: the record says unknown, and the next start re-runs nothing.
  await panel(page).getByRole("button", { name: "Start review" }).click();
  await expect(tid(page, "cr-agent-run").first()).toHaveAttribute("data-run-state", "running");
  await expect.poll(runs).toHaveLength(2);
  const childPids = () => {
    const file = path.join(h.home, "bin", "claude-pids");
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").map(Number).filter(pid => Number.isSafeInteger(pid) && pid > 1) : [];
  };
  await expect.poll(childPids).toHaveLength(2);
  crashedChildPid = childPids().at(-1)!;
  expect(Number.isSafeInteger(crashedChildPid) && crashedChildPid > 1).toBe(true);
  forceFixtureClose = true;
  await h.relaunch();
  page = await openLending();
  const latest = tid(page, "cr-agent-run").first();
  await expect(latest).toHaveAttribute("data-run-state", "unknown");
  await expect(tid(latest, "cr-agent-run-reason")).toContainText("before confirming the process exit");
  await expect(tid(page, "code-review-review").first()).toHaveAttribute("aria-label", "Review exit unconfirmed");
  await tid(page, "code-review-review").first().click();
  await expect(panel(page).getByRole("button", { name: "Start review" })).toHaveCount(0);
  await expect(tid(page, "cr-agent-stop")).toHaveCount(0);
  await expect(tid(page, "cr-agent-ask").getByRole("button", { name: "Ask", exact: true })).toBeDisabled();
  const blocked = await page.evaluate(async () => {
    const reply = await window.modex!.invoke("code-review:agent", { op: "start", requestId: "probe-after-crash", key: { account: "1001", host: "github.com", repoId: "7301", number: 73 },
      revision: { baseRef: "main", baseSha: "b".repeat(40), headSha: "c".repeat(40) }, kind: "review", question: null, model: "fable" });
    return reply.result.state === "refused" ? reply.result.reason : "started";
  });
  expect(blocked).toBe("busy");
  await expect(tid(page, "cr-agent-run")).toHaveCount(2);
  expect(runs()).toHaveLength(2);
});
