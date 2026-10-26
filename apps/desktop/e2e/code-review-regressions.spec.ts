import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { tid } from "./support.js";
import { baseWorld, FIELD_GUIDE, fitWindow, launchWithGh, LENDING, prRow, READ_ENDPOINT, settle, type Harness } from "./code-review-support.js";
import { ghFile, ghPull, ghRepo, ghRow, sha } from "../test/fixtures/code-review-gh-world.js";
import type { CodeReviewReply, CodeReviewRequest, Inbox, PrKey, PrOverview } from "../src/shared/code-review.js";

/**
 * CR-8 (#327) cross-slice regressions: the CR-3 renderer over CR-2's production read service, in real Electron,
 * with only gh synthetic (e2e/code-review-support.ts). Each case is one #327 adversarial item; the slices' own
 * suites (code-review-navigation, code-review-ipc, test/code-review-*.test.ts) keep their narrower versions.
 * Later slices add theirs here: #324 remote diff anchors, #325 provider stop/unknown completion, #326 lost writes.
 */
let h: Harness;
test.afterEach(async () => { await h?.close(); });

const invoke = (request: CodeReviewRequest) => h.page.evaluate((r) => window.modex!.invoke("code-review:read", r), request) as Promise<CodeReviewReply>;
async function keyOf(slug: string): Promise<PrKey> {
  const reply = await invoke({ op: "inbox", requestId: `inbox-${slug.replace(/[^A-Za-z0-9]/g, "-")}`, query: "" });
  if (reply.result.state !== "ready") throw new Error("inbox not ready");
  const groups = (reply.result.value as Inbox).groups;
  const rows = Object.values(groups).flatMap((g) => g.state === "unavailable" ? [] : g.value);
  const row = rows.find((r) => `${r.locator.owner}/${r.locator.repo}#${r.locator.number}` === slug);
  if (!row) throw new Error(`no row ${slug}`);
  return row.key;
}

test("identity: a held answer for #73 in one repository never shows under #73 in the other", async () => {
  const world = baseWorld();
  world.holds = { "repos/example-org/lending/pulls/73": "lending-73" };
  h = await launchWithGh(world);
  const { page } = h;
  await tid(page, "rail-code-review").click();
  await prRow(page, "example-org/lending#73").click();
  await expect(tid(page, "code-review-loading").first()).toBeVisible();
  await prRow(page, "example-org/field-guide#73").click();
  await expect(tid(page, "code-review-pr-id").first()).toHaveText("field-guide #73");
  await expect(tid(page, "code-review-tab-changes")).toContainText("+5");
  h.release("lending-73");
  await expect.poll(() => h.calls().filter((c) => c === "repos/example-org/lending/pulls/73").length).toBeGreaterThan(0);
  await settle(page);
  await expect(tid(page, "code-review-pr-id").first()).toHaveText("field-guide #73");
  await expect(tid(page, "code-review-tab-changes")).not.toContainText("8,912");
  await expect(prRow(page, "example-org/lending#73")).not.toHaveAttribute("aria-current", "true");
});

test("identity: switching the gh account during a held read refuses its answer and closes every PR of the old account", async () => {
  const world = baseWorld();
  world.holds = { "repos/example-org/lending/pulls/73": "lending-73" };
  h = await launchWithGh(world);
  const { page } = h;
  await tid(page, "rail-code-review").click();
  await prRow(page, "example-org/lending#73").click();
  await expect(tid(page, "code-review-loading").first()).toBeVisible();
  // `gh auth switch`: hosts.yml is rewritten and gh now answers as another account.
  h.world((w) => {
    w.user = { id: 2002, login: "grace-fixture" };
    w.search = { authored: [ghRow(FIELD_GUIDE, 91, "Group the branch pages by region", [2002, "grace-fixture"])], "review-requested": [] };
  });
  h.switchHosts("grace-fixture");
  h.release("lending-73");
  // The refused read tells the renderer the account changed: it reconnects, reads the new account's inbox
  // and closes the old account's PR, without showing the held answer.
  await expect(prRow(page, "example-org/field-guide#91")).toBeVisible();
  await expect(tid(page, "code-review-pr-id")).toHaveCount(0);
  await expect(tid(page, "code-review")).not.toContainText("8,912");
  await expect(prRow(page, "example-org/lending#73")).toHaveCount(0);
  await expect(prRow(page, "example-org/field-guide#73")).toHaveCount(0);
});

test("revision: a head that moves before or during a files page is never served as the current diff", async () => {
  const world = baseWorld();
  h = await launchWithGh(world);
  const key = await keyOf("example-org/lending#73");
  const first = await invoke({ op: "overview", requestId: "o1", key });
  if (first.result.state !== "ready") throw new Error("overview not ready");
  const old = (first.result.value as PrOverview).revision;
  expect(old.headSha).toBe(sha("c"));
  // Moved before the page: the old revision's files are not read as current.
  h.world((w) => { w.routes["repos/example-org/lending/pulls/73"] = ghPull(LENDING, 73, "Moved", { head: sha("d"), files: 2, additions: 3, deletions: 1 }); });
  const before = await invoke({ op: "files", requestId: "f1", key, revision: old, cursor: null });
  expect(before.scope.revision).toEqual(old);
  expect(before.result).toMatchObject({ state: "unavailable", reason: "head-changed" });
  // Moved while the page was read: the page comes back stale, labelled head-changed.
  const second = await invoke({ op: "overview", requestId: "o2", key });
  const current = (second.result as { value: PrOverview }).value.revision;
  expect(current.headSha).toBe(sha("d"));
  const listed = () => h.calls().filter((c) => c.startsWith("repos/example-org/lending/pulls/73/files")).length;
  // The moved head was caught by the read before the page: the files list itself was never asked for.
  expect(listed()).toBe(0);
  h.world((w) => { w.holds = { "repos/example-org/lending/pulls/73/files": "files" }; });
  const during = invoke({ op: "files", requestId: "f2", key, revision: current, cursor: null });
  await expect.poll(listed).toBe(1);
  h.world((w) => { w.routes["repos/example-org/lending/pulls/73"] = ghPull(LENDING, 73, "Moved again", { head: sha("e"), files: 2, additions: 3, deletions: 1 }); });
  h.release("files");
  const moved = await during;
  expect(moved.scope.revision).toEqual(current);
  expect(moved.result).toMatchObject({ state: "stale", reason: "head-changed" });
});

test("incomplete data: a timed-out search, a hidden repository, a short files list and missing patches are never shown as whole", async () => {
  const world = baseWorld();
  const secret = ghRepo(7399, "example-org", "secret");
  world.incomplete = { authored: true };
  world.search["review-requested"] = [ghRow(secret, 5, "A pull request this account can't see")];
  world.routes["repos/example-org/secret"] = { status: 403, body: { message: "Must have admin rights to Repository." }, stderr: "gh: token ghp_SENTINEL0000000000000000000000000000 denied\n" };
  // The PR says 5 files; GitHub lists 3, one binary and one whose patch was too large.
  world.routes["repos/example-org/lending/pulls/73"] = ghPull(LENDING, 73, "Short files", { files: 5, additions: 9, deletions: 1 });
  world.routes["repos/example-org/lending/pulls/73/files"] = [ghFile("src/a.ts", "@@ -1 +1 @@\n-a\n+b", 1, 1), ghFile("img/b.png", null, 0, 0, "added"), ghFile("data/c.json", null, 8, 0, "added")];
  h = await launchWithGh(world);
  const { page } = h;
  await tid(page, "rail-code-review").click();
  const authored = tid(page, "code-review-group-authored"), requested = tid(page, "code-review-group-review-requested");
  await expect(authored).toContainText("Some pull requests are missing. GitHub took too long to answer.");
  await expect(requested).toContainText("Some pull requests are missing. This account can't see it.");
  await expect(requested.getByTestId("code-review-group-empty")).toHaveCount(0);
  await expect(requested).not.toContainText("A pull request this account can't see");
  const key = await keyOf("example-org/lending#73");
  const overview = await invoke({ op: "overview", requestId: "o", key });
  const files = await invoke({ op: "files", requestId: "f", key, revision: (overview.result as { value: PrOverview }).value.revision, cursor: null });
  expect(files.result).toMatchObject({ state: "partial", coverage: { loaded: 3, total: 5, complete: false },
    value: { files: [{ patch: { kind: "text" } }, { patch: { kind: "omitted", reason: "binary" } }, { patch: { kind: "omitted", reason: "too-large" } }] } });
  // gh's diagnostics never cross into the renderer.
  expect(await page.content()).not.toContain("SENTINEL");
  expect(JSON.stringify(files)).not.toContain("SENTINEL");
});

test("hostile content: PR text renders inert, and unsafe or look-alike links never resolve, open or navigate", async () => {
  const world = baseWorld();
  const hostile = `<img src=x onerror="document.title='pwned'"> Fix ‮gnp.exe‬ <script>document.title='pwned'</script> [x](javascript:alert(1))`;
  world.search.authored.unshift(ghRow(LENDING, 74, hostile));
  world.routes["repos/example-org/lending/pulls/74"] = ghPull(LENDING, 74, hostile, { body: `<iframe src="https://evil.example"></iframe>\n[click](javascript:alert(1)) ![x](https://evil.example/t.png)` });
  h = await launchWithGh(world);
  const { page, app } = h;
  await app.evaluate(({ shell }) => {
    const g = globalThis as unknown as { __opened: string[] };
    g.__opened = [];
    shell.openExternal = async (url: string) => { g.__opened.push(url); };
  });
  const title = await page.title(), url = page.url();
  await tid(page, "rail-code-review").click();
  const row = prRow(page, "example-org/lending#74");
  await expect(row).toContainText("<img src=x");
  await expect(row).toContainText("<script>");
  await row.click();
  await expect(tid(page, "code-review-pr-id").first()).toHaveText("lending #74");
  await expect(tid(page, "code-review-tab-overview")).toContainText("<img src=x");
  expect(await tid(page, "code-review").locator("img, script, iframe").count()).toBe(0);
  for (const input of ["javascript:alert(1)//github.com/example-org/lending/pull/73", "https://github.com.evil.example/example-org/lending/pull/73",
    "https://user:secret@github.com/example-org/lending/pull/73", "https://github.com/example-org/../lending/pull/73", "file:///etc/passwd", "https://github.com/example-org/lending/pull/0073"]) {
    await tid(page, "code-review-search").fill(input);
    await expect(tid(page, "code-review-link-hint"), input).toHaveCount(0);
    await tid(page, "code-review-search").press("Enter");
    await expect(tid(page, "code-review-pr-id").first()).toHaveText("lending #74");
  }
  await tid(page, "code-review-search").fill("");
  await settle(page);
  expect(await page.title()).toBe(title);
  expect(page.url()).toBe(url);
  expect(await app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened)).toEqual([]);
  // Hostile links only ever reached gh as search text; nothing else was asked for.
  expect(h.calls().filter((c) => !READ_ENDPOINT.test(c))).toEqual([]);
  expect(h.calls().filter((c) => c.startsWith("repos/") && /evil|\.\.|etc/.test(c))).toEqual([]);
});

for (const delayed of [false, true]) test(`dispatch: unavailable actions start nothing after ${delayed ? "held" : "ordinary"} overview reads`, async () => {
  const world = baseWorld();
  if (delayed) world.holds = {
    [`repos/example-org/lending/commits/${"c".repeat(40)}/check-runs`]: "initial-context",
    "repos/example-org/lending/issues/73/timeline": "initial-context",
    "repos/example-org/lending/pulls": "initial-context",
  };
  h = await launchWithGh(world);
  const { page } = h;
  await tid(page, "rail-code-review").click();
  await prRow(page, "example-org/lending#73").click();
  await expect(tid(page, "code-review-tab-changes")).toContainText("+8,912");
  // Overview totals arrive before the independent context reads. A connection IPC
  // reply cannot drain those reads; require each mounted section to finish first.
  const sections = ["cr-activity", "cr-stack", "cr-checks"].map(id => tid(page, id));
  for (const section of sections) {
    await expect(section).toBeVisible();
    if (delayed) await expect(section.getByRole("status").filter({ hasText: /Loading/ })).toHaveCount(1);
  }
  if (delayed) h.release("initial-context");
  for (const section of sections) {
    await expect(section.getByRole("status").filter({ hasText: /Loading|Refreshing/ })).toHaveCount(0);
  }
  await settle(page);
  const calls = h.calls().length, starts = h.providerStarts().length;
  // Merge is CR-7's now (e2e/code-review-actions.spec.ts): opening it reads, and only an explicit preview and confirm writes.
  for (const id of ["code-review-review", "code-review-instructions", "code-review-new-tab"]) {
    const control = tid(page, id).first();
    await expect(control, id).toHaveAttribute("aria-disabled", "true");
    // aria-disabled, not disabled: it stays focusable, so force the pointer through to prove it does nothing.
    await control.dblclick({ force: true });
    await control.focus();
    await page.keyboard.press("Enter");
    await page.keyboard.press("Space");
  }
  await expect(tid(page, "code-review-pr-id").first()).toHaveText("lending #73");
  await settle(page);
  // The settle reads are connection checks; nothing else reached gh, and no provider CLI started.
  expect(h.calls().slice(calls).filter((c) => c !== "user")).toEqual([]);
  expect(h.providerStarts().length).toBe(starts);
  const state = JSON.parse(fs.readFileSync(path.join(h.home, "app", "state.json"), "utf8")) as { threads: unknown[] };
  expect(state.threads).toEqual([]);
});

test("local Changes stay local: a remote PR touching the same path never reaches Discard or the checkout", async () => {
  h = await launchWithGh(baseWorld());
  const { page, app, repo } = h;
  // A local edit at the very path the remote PR changes, plus an untracked file.
  fs.mkdirSync(path.join(repo, "src", "holds"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src", "holds", "move.ts"), "local work\n");
  fs.writeFileSync(path.join(repo, "README.md"), "# e2e\nlocal edit\n");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  const before = { head: git("rev-parse", "HEAD"), status: git("status", "--porcelain=v1", "--untracked-files=all"), diff: git("diff"),
    file: fs.readFileSync(path.join(repo, "src", "holds", "move.ts"), "utf8") };
  await app.evaluate(({ ipcMain }) => {
    const g = globalThis as unknown as { __reverts: number };
    g.__reverts = 0;
    ipcMain.removeHandler("changes:revert");
    ipcMain.handle("changes:revert", () => { g.__reverts += 1; });
  });
  // Wide enough for the split (the default window may fold it to one pane).
  await fitWindow(h, 1440, 900);
  await tid(page, "rail-code-review").click();
  await prRow(page, "example-org/lending#73").click();
  await tid(page, "code-review-split-toggle").click();
  await expect(tid(page, "code-review-workspace")).toHaveAttribute("data-panes", "overview changes");
  const key = await keyOf("example-org/lending#73");
  const overview = await invoke({ op: "overview", requestId: "o", key });
  await invoke({ op: "files", requestId: "f", key, revision: (overview.result as { value: PrOverview }).value.revision, cursor: null });
  await tid(page, "code-review-tab-changes").click();
  await expect(tid(page, "code-review").locator('[data-testid="changes-revert"], [data-testid="changes-panel"]')).toHaveCount(0);
  expect(await app.evaluate(() => (globalThis as unknown as { __reverts: number }).__reverts)).toBe(0);
  expect({ head: git("rev-parse", "HEAD"), status: git("status", "--porcelain=v1", "--untracked-files=all"), diff: git("diff"),
    file: fs.readFileSync(path.join(repo, "src", "holds", "move.ts"), "utf8") }).toEqual(before);
  expect(h.calls().filter((c) => !READ_ENDPOINT.test(c))).toEqual([]);
});
