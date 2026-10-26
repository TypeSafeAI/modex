import { test, expect, type Page } from "@playwright/test";
import { tid } from "./support.js";
import { baseWorld, fitWindow, launchWithGh, prRow, type Harness } from "./code-review-support.js";

/**
 * CR-7 (#326): comments, reviews, Merge, the state menu, edits and reviewer requests in real Electron, through main's production `code-review:write` service and
 * gh write transport, with the synthetic gh (e2e/code-review-support.ts) standing in for GitHub. Each POST it
 * receives, and each merge, is recorded (Harness.posts), so a test counts exactly what reached "GitHub". Nothing here touches a
 * real repository: the world, its accounts and its PRs are made up.
 */
let h: Harness;
test.afterEach(async () => { await h?.close(); });

const COMMENTS = "repos/example-org/lending/issues/73/comments";
const comment = (p: Page) => p.getByRole("region", { name: "Comment on this pull request" });
const review = (p: Page) => p.getByRole("region", { name: "Review this pull request" });

async function openLending(): Promise<Page> {
  const page = h.page;
  await fitWindow(h, 1440, 900);
  await tid(page, "rail-code-review").click();
  await prRow(page, "example-org/lending#73").click();
  await expect(tid(page, "code-review-pr-id").first()).toHaveText("lending #73");
  return page;
}

async function writeComment(page: Page, text: string): Promise<void> {
  const region = comment(page);
  if (await region.getByRole("textbox", { name: "Comment text" }).count() === 0) await region.getByRole("button", { name: "Comment", exact: true }).click();
  await region.getByRole("textbox", { name: "Comment text" }).fill(text);
}

test("a comment stays a local draft across a reload, previews its exact destination and posts once despite a double click", async () => {
  h = await launchWithGh(baseWorld());
  let page = await openLending();
  await writeComment(page, "Checked the queue position by hand.");
  await expect(comment(page)).toContainText("Saved on this Mac only");
  // Let the debounced save land, then reload: the draft is main's, not the renderer's.
  await expect.poll(() => page.evaluate(async () => {
    const reply = await window.modex!.invoke("code-review:write", { op: "status", requestId: `probe-${Date.now()}`,
      key: { account: "1001", host: "github.com", repoId: "7301", number: 73 }, revision: { baseRef: "main", baseSha: "b".repeat(40), headSha: "c".repeat(40) } });
    return reply.result.state === "ok" ? reply.result.value.drafts.comment?.body ?? null : null;
  })).toBe("Checked the queue position by hand.");
  await page.reload();
  page = h.page;
  await tid(page, "rail-code-review").click();
  await prRow(page, "example-org/lending#73").click();
  await expect(comment(page).getByRole("textbox", { name: "Comment text" })).toHaveValue("Checked the queue position by hand.");
  expect(h.posts()).toEqual([]);

  await comment(page).getByRole("button", { name: "Preview comment" }).click();
  const preview = page.getByRole("region", { name: "Preview comment" });
  await expect(preview.getByTestId("cr-preview-destination")).toHaveText("As ada-fixture on example-org/lending #73");
  await expect(preview.getByTestId("cr-preview-revision")).toContainText("Head cccccccc into main");
  expect(h.posts()).toEqual([]);
  await preview.getByRole("button", { name: "Post comment" }).dblclick();
  await expect(comment(page).getByRole("status")).toContainText("Comment posted.");
  await expect(comment(page).getByRole("link", { name: "View on GitHub" })).toHaveAttribute("href", /^https:\/\/github\.com\/example-org\/lending\/pull\/73#issuecomment-900001$/);
  const posts = h.posts();
  expect(posts.map((p) => p.endpoint)).toEqual([COMMENTS]);
  expect(String(posts[0]!.body.body)).toMatch(/^Checked the queue position by hand\.\n\n<!-- modex-intent: [0-9a-f-]{36} -->$/);
  await expect(comment(page).getByRole("textbox", { name: "Comment text" })).toHaveValue("");
  expect(h.calls().filter((c) => c.startsWith("POST "))).toEqual([`POST ${COMMENTS}`]);
  expect(h.providerStarts()).toEqual([]);
});

test("navigating before the draft debounce preserves the latest text", async () => {
  h = await launchWithGh(baseWorld());
  const page = await openLending();
  await page.clock.pauseAt(new Date("2026-10-18T20:42:00Z"));
  await writeComment(page, "Keep the last edit across navigation.");
  await tid(page, "code-review-tab-changes").click();
  await expect(comment(page)).toHaveCount(0);
  await tid(page, "code-review-tab-overview").click();
  await expect(comment(page).getByRole("textbox", { name: "Comment text" })).toHaveValue("Keep the last edit across navigation.");
  await page.clock.runFor(450);
  await expect.poll(() => page.evaluate(async () => {
    const reply = await window.modex!.invoke("code-review:write", { op: "status", requestId: `navigation-${Date.now()}`, key: { account: "1001", host: "github.com", repoId: "7301", number: 73 }, revision: { baseRef: "main", baseSha: "b".repeat(40), headSha: "c".repeat(40) } });
    return reply.result.state === "ok" ? reply.result.value.drafts.comment?.body : null;
  })).toBe("Keep the last edit across navigation.");
  expect(h.posts()).toEqual([]);
});

test("a review with a line comment from Changes pins the head; self-approval is offered nowhere", async () => {
  const world = baseWorld();
  // The display-density fixture advertises 11 files but supplies two; a writable review needs complete evidence.
  Object.assign(world.routes["repos/example-org/lending/pulls/73"] as object, { changed_files: 2, additions: 3, deletions: 1 });
  h = await launchWithGh(world);
  const page = await openLending();
  await fitWindow(h, 1766, 1057);
  await tid(page, "code-review-split-toggle").click();
  await expect(tid(page, "code-review-workspace")).toHaveAttribute("data-panes", "overview changes");
  await page.getByRole("button", { name: "View remote diff for src/holds/move.ts" }).click();
  await page.getByRole("button", { name: "New line 2", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Line anchor" })).toContainText("head 2");
  await page.getByRole("button", { name: "Comment on this line" }).click();
  await page.getByRole("textbox", { name: "Line comment" }).fill("Does this keep the hold's place?");
  await page.getByRole("button", { name: "Add to review" }).click();

  const region = review(page);
  await expect(region.getByRole("list", { name: "Line comments" })).toContainText("src/holds/move.ts · head 2");
  // ada-fixture wrote lending#73: approving or requesting changes is refused before anything is sent.
  await expect(region.getByRole("radio", { name: "Approve" })).toBeDisabled();
  await expect(region.getByRole("radio", { name: "Request changes" })).toBeDisabled();
  await region.getByRole("textbox", { name: "Review summary" }).fill("One question inline.");
  await region.getByRole("button", { name: "Preview review" }).click();
  const preview = page.getByRole("region", { name: "Preview review" });
  await expect(preview).toContainText("Submit a review · Comment");
  await expect(preview.getByTestId("cr-preview-revision")).toContainText("1 line comment");
  await expect(preview.getByRole("list", { name: "Line comments to submit" })).toContainText("src/holds/move.ts · head 2");
  await expect(preview).toContainText("Does this keep the hold's place?");
  await preview.getByRole("button", { name: "Submit review" }).click();
  await expect(region.getByRole("status")).toContainText("Review submitted.");
  const [posted] = h.posts();
  expect(posted!.endpoint).toBe("repos/example-org/lending/pulls/73/reviews");
  expect(posted!.body).toMatchObject({ commit_id: "c".repeat(40), event: "COMMENT", comments: [{ path: "src/holds/move.ts", side: "RIGHT", line: 2, body: "Does this keep the hold's place?" }] });
});

test("a denial and a moved head are shown as such, send nothing extra and keep the draft", async () => {
  h = await launchWithGh(baseWorld());
  const page = await openLending();
  h.world((w) => { w.postAnswers = { [COMMENTS]: { status: 403, body: { message: "Must have push access" } } }; });
  await writeComment(page, "Denied, kept.");
  await comment(page).getByRole("button", { name: "Preview comment" }).click();
  await page.getByRole("region", { name: "Preview comment" }).getByRole("button", { name: "Post comment" }).click();
  await expect(comment(page).getByRole("alert")).toHaveText("GitHub refused this. The draft is kept.");
  await expect(comment(page)).not.toContainText("Must have push access");
  await expect(comment(page).getByRole("textbox", { name: "Comment text" })).toHaveValue("Denied, kept.");

  // The PR moves between preview and submit: main refuses, and the preview can't be reused.
  h.world((w) => { delete w.postAnswers; });
  await comment(page).getByRole("button", { name: "Preview comment" }).click();
  await expect(page.getByRole("region", { name: "Preview comment" })).toBeVisible();
  h.world((w) => { (w.routes["repos/example-org/lending/pulls/73"] as { head: { sha: string } }).head.sha = "d".repeat(40); });
  await page.getByRole("region", { name: "Preview comment" }).getByRole("button", { name: "Post comment" }).click();
  await expect(comment(page).getByRole("alert")).toContainText("newer head");
  expect(h.posts()).toEqual([]);
  expect(h.calls().filter((c) => c.startsWith("POST "))).toEqual([`POST ${COMMENTS}`]);
});

test("a crash mid-send restarts in doubt, sends nothing, and Check GitHub confirms it from a read-back", async () => {
  h = await launchWithGh(baseWorld());
  let page = await openLending();
  // GitHub records the comment, then its answer never arrives before Modex is killed.
  h.world((w) => { w.postHolds = { [COMMENTS]: "lost-answer" }; });
  await writeComment(page, "Sent just before the crash.");
  await comment(page).getByRole("button", { name: "Preview comment" }).click();
  await page.getByRole("region", { name: "Preview comment" }).getByRole("button", { name: "Post comment" }).click();
  await expect.poll(() => h.posts().length).toBe(1);
  await h.relaunch();
  h.release("lost-answer");
  page = await openLending();
  const doubt = page.getByTestId("cr-doubt");
  await expect(doubt).toContainText("Modex can't tell whether GitHub received a comment");
  await expect(comment(page).getByRole("button", { name: "Preview comment" })).toHaveAttribute("title", "Resolve the send above first.");
  expect(h.posts()).toHaveLength(1);
  await doubt.getByRole("button", { name: "Check GitHub" }).click();
  await expect(doubt).toHaveCount(0);
  expect(h.posts()).toHaveLength(1);
  expect(h.calls().filter((c) => c.startsWith("POST "))).toEqual([`POST ${COMMENTS}`]);
});

test("a send GitHub may or may not have received is never resent; stopping tracking is the person's decision", async () => {
  h = await launchWithGh(baseWorld());
  const page = await openLending();
  // A gateway error: GitHub didn't say whether it made the comment (here it didn't).
  h.world((w) => { w.postAnswers = { [COMMENTS]: { status: 502, body: { message: "Bad gateway" } } }; });
  await writeComment(page, "Unclear outcome.");
  await comment(page).getByRole("button", { name: "Preview comment" }).click();
  await page.getByRole("region", { name: "Preview comment" }).getByRole("button", { name: "Post comment" }).click();
  const doubt = page.getByTestId("cr-doubt");
  await expect(doubt).toBeVisible();
  await doubt.getByRole("button", { name: "Check GitHub" }).click();
  await expect(doubt.getByRole("status")).toHaveText("Modex didn't find it on GitHub. That doesn't prove it wasn't sent.");
  expect(h.calls().filter((c) => c.startsWith("POST "))).toHaveLength(1);
  await doubt.getByRole("button", { name: "Stop tracking" }).click();
  await expect(doubt).toHaveCount(0);
  await expect(comment(page).getByRole("textbox", { name: "Comment text" })).toHaveValue("Unclear outcome.");
  await expect(comment(page).getByRole("button", { name: "Preview comment" })).toBeEnabled();
  expect(h.calls().filter((c) => c.startsWith("POST "))).toHaveLength(1);
});

// --- Merge ------------------------------------------------------------------------------------------

const MERGE = "repos/example-org/lending/pulls/73/merge";
const panel = (p: Page) => p.getByRole("region", { name: "Merge this pull request" });
const pushable = () => { const w = baseWorld(); w.permissions!["7301"] = { admin: false, maintain: false, push: true, triage: true, pull: true }; return w; };
const mutations = () => h.calls().filter((c) => /^(POST|PUT|PATCH|DELETE) /.test(c));
/** Opens the Merge panel once the PR has loaded and main has answered for this account. */
async function openMerge(page: Page): Promise<void> {
  const button = tid(page, "code-review-merge").first();
  await expect(button).toHaveAttribute("aria-expanded", "false");
  await button.click();
  await expect(panel(page)).toBeVisible();
}

test("Merge offers only the repository's methods, previews the reviewed head and merges once despite a double click", async () => {
  h = await launchWithGh(pushable());
  const page = await openLending();
  await openMerge(page);
  const methods = panel(page).getByRole("group", { name: "Merge method" });
  await expect(methods.getByRole("radio")).toHaveCount(2);
  await expect(methods.getByRole("radio", { name: "Squash and merge" })).toBeChecked();
  await expect(methods).not.toContainText("Create a merge commit");
  await methods.getByRole("radio", { name: "Rebase and merge" }).check();
  await panel(page).getByRole("button", { name: "Preview merge" }).click();
  const preview = page.getByRole("region", { name: "Preview merge" });
  await expect(preview).toContainText("Merge pull request · Rebase and merge");
  await expect(preview.getByTestId("cr-preview-destination")).toHaveText("As ada-fixture on example-org/lending #73");
  await expect(preview.getByTestId("cr-preview-revision")).toContainText("Head cccccccc into main");
  expect(mutations()).toEqual([]);
  await preview.getByRole("button", { name: "Merge pull request" }).dblclick();
  await expect(panel(page).getByRole("status")).toContainText("Pull request merged.");
  expect(h.posts().map((p) => [p.endpoint, p.body])).toEqual([[MERGE, { sha: "c".repeat(40), merge_method: "rebase" }]]);
  expect(mutations()).toEqual([`PUT ${MERGE}`]);
  // The PR is read again, and GitHub now says it merged.
  await expect(tid(page, "code-review-state").first()).toHaveText("Merged");
  expect(h.providerStarts()).toEqual([]);
});

test("Merge stays with GitHub when the rules block it, and needs push permission, read by main", async () => {
  h = await launchWithGh(pushable());
  const page = await openLending();
  h.world((w) => { (w.routes["repos/example-org/lending/pulls/73"] as { mergeable_state: string }).mergeable_state = "blocked"; });
  await openMerge(page);
  const blocked = panel(page).getByTestId("cr-merge-unavailable");
  await expect(blocked).toContainText("The target branch's rules block merging: required reviews or checks aren't satisfied.");
  await expect(blocked.getByRole("link", { name: "Open on GitHub" })).toHaveAttribute("href", "https://github.com/example-org/lending/pull/73");
  await expect(panel(page).getByRole("button", { name: "Preview merge" })).toHaveCount(0);
  // Without push, main refuses before offering anything.
  h.world((w) => { w.permissions!["7301"] = { ...w.permissions!["7301"]!, push: false }; });
  await blocked.getByRole("button", { name: "Check again" }).click();
  await expect(panel(page).getByRole("alert")).toHaveText("GitHub refused this. The account may lack permission, or the pull request doesn't allow it.");
  expect(mutations()).toEqual([]);
});

test("a head that moves between preview and merge is refused before anything is sent", async () => {
  h = await launchWithGh(pushable());
  const page = await openLending();
  await openMerge(page);
  await panel(page).getByRole("button", { name: "Preview merge" }).click();
  const preview = page.getByRole("region", { name: "Preview merge" });
  await expect(preview).toBeVisible();
  h.world((w) => { (w.routes["repos/example-org/lending/pulls/73"] as { head: { sha: string } }).head.sha = "d".repeat(40); });
  await preview.getByRole("button", { name: "Merge pull request" }).click();
  await expect(panel(page).getByRole("alert")).toContainText("newer head");
  expect(mutations()).toEqual([]);
  expect(h.posts()).toEqual([]);
});

test("a crash during a merge restarts in doubt, merges nothing again, and Check GitHub confirms it from the PR", async () => {
  h = await launchWithGh(pushable());
  let page = await openLending();
  h.world((w) => { w.postHolds = { [MERGE]: "lost-merge" }; });
  await openMerge(page);
  await panel(page).getByRole("button", { name: "Preview merge" }).click();
  await page.getByRole("region", { name: "Preview merge" }).getByRole("button", { name: "Merge pull request" }).click();
  await expect.poll(() => h.posts().length).toBe(1);
  await h.relaunch();
  h.release("lost-merge");
  page = await openLending();
  const doubt = page.getByTestId("cr-doubt");
  await expect(doubt).toContainText("Modex can't tell whether GitHub merged this pull request");
  await doubt.getByRole("button", { name: "Check GitHub" }).click();
  await expect(doubt).toHaveCount(0);
  expect(mutations()).toEqual([`PUT ${MERGE}`]);
  expect(h.posts()).toHaveLength(1);
});

// --- Decisions 2–4: the state menu, edits and reviewer requests ---------------------------------------

const PULL = "repos/example-org/lending/pulls/73";
const statePill = (p: Page) => tid(p, "code-review-state").first();
async function pickState(page: Page, item: string): Promise<void> {
  await expect(statePill(page)).toHaveAttribute("aria-haspopup", "menu");
  await statePill(page).click();
  await page.getByRole("menu", { name: "Change state" }).getByRole("menuitem", { name: item }).click();
}

test("the state menu closes and reopens a PR, and converts it to draft, each previewed and sent once", async () => {
  h = await launchWithGh(baseWorld());
  const page = await openLending();
  await expect(statePill(page)).toHaveAttribute("aria-haspopup", "menu");
  await statePill(page).click();
  const menu = page.getByRole("menu", { name: "Change state" });
  await expect(menu.getByRole("menuitem")).toHaveText(["Convert to draft", "Close pull request"]);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await pickState(page, "Close pull request");
  const change = page.getByRole("region", { name: "Change pull request state" });
  const preview = change.getByRole("region", { name: "Preview: Close pull request" });
  await expect(preview.getByTestId("cr-preview-destination")).toHaveText("As ada-fixture on example-org/lending #73");
  expect(mutations()).toEqual([]);
  await preview.getByRole("button", { name: "Close pull request" }).dblclick();
  await expect(change.getByRole("status")).toHaveText("Close pull request: done.");
  await expect(statePill(page)).toHaveText("Closed");
  await pickState(page, "Reopen pull request");
  await page.getByRole("region", { name: "Preview: Reopen pull request" }).getByRole("button", { name: "Reopen pull request" }).click();
  await expect(statePill(page)).toHaveText("Open");
  await pickState(page, "Convert to draft");
  await page.getByRole("region", { name: "Preview: Convert to draft" }).getByRole("button", { name: "Convert to draft" }).click();
  await expect(statePill(page)).toHaveText("Draft");
  expect(mutations()).toEqual([`PATCH ${PULL}`, `PATCH ${PULL}`, "POST graphql"]);
  expect(h.posts().map((p) => p.endpoint === "graphql" ? ["graphql", (p.body as { variables: unknown }).variables] : [p.endpoint, p.body])).toEqual([
    [PULL, { state: "closed" }], [PULL, { state: "open" }], ["graphql", { id: "PR_fixture_7301_73" }]]);
});

test("an edit saves only the changed field, and never overwrites a change made on GitHub meanwhile", async () => {
  h = await launchWithGh(baseWorld());
  const page = await openLending();
  await page.getByRole("button", { name: "Edit pull request" }).click();
  const form = page.getByRole("region", { name: "Edit pull request" });
  await form.getByRole("textbox", { name: "Title" }).fill("Move holds between branches, keeping their place");
  // Someone edits the description on GitHub before the preview: main refuses rather than overwrite it.
  h.world((w) => { (w.routes[PULL] as { body: string }).body = "Written on GitHub."; });
  await form.getByRole("button", { name: "Preview changes" }).click();
  await expect(form.getByRole("alert")).toHaveText("The title or description changed on GitHub since you started editing. Nothing was saved: review the new text and edit again.");
  expect(mutations()).toEqual([]);
  // The PR is read again: starting over begins from what GitHub has now.
  await expect(page.getByTestId("cr-description")).toContainText("Written on GitHub.");
  await form.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("button", { name: "Edit pull request" }).click();
  await expect(form.getByRole("textbox", { name: "Description" })).toHaveValue("Written on GitHub.");
  await form.getByRole("textbox", { name: "Title" }).fill("Move holds between branches, keeping their place");
  await form.getByRole("button", { name: "Preview changes" }).click();
  const preview = page.getByRole("region", { name: "Preview: Edit the title" });
  await expect(preview).toContainText("Title: Move holds between branches, keeping their place");
  await preview.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Pull request updated." })).toBeVisible();
  await expect(page.getByRole("main", { name: "Description and activity" }).getByRole("heading", { level: 1 })).toHaveText("Move holds between branches, keeping their place");
  // Only the title is sent: the description someone else wrote stays theirs.
  expect(h.posts().map((p) => [p.endpoint, p.body])).toEqual([[PULL, { title: "Move holds between branches, keeping their place" }]]);
  await expect(page.getByTestId("cr-description")).toContainText("Written on GitHub.");
});

test("reviewer requests go to others, need triage, and show on the PR once GitHub has them", async () => {
  h = await launchWithGh(baseWorld());
  const page = await openLending();
  const ask = async (logins: string) => {
    await page.getByRole("button", { name: "Request reviewers" }).click();
    await page.getByRole("textbox", { name: "Reviewer logins" }).fill(logins);
    await page.getByRole("button", { name: "Preview request" }).click();
  };
  await ask("grace-fixture");
  await expect(page.getByTestId("cr-reviewers").getByRole("alert")).toHaveText("GitHub refused this. The account may lack permission, or the pull request doesn't allow it.");
  h.world((w) => { w.permissions!["7301"] = { ...w.permissions!["7301"]!, triage: true }; });
  await page.getByRole("textbox", { name: "Reviewer logins" }).fill("ada-fixture");
  await page.getByRole("button", { name: "Preview request" }).click();
  await expect(page.getByTestId("cr-reviewers").getByRole("alert")).toHaveText("A pull request's author, and you, can't be requested as reviewers. Nothing was sent.");
  await page.getByRole("textbox", { name: "Reviewer logins" }).fill("grace-fixture, @lin-fixture");
  await page.getByRole("button", { name: "Preview request" }).click();
  const preview = page.getByRole("region", { name: "Preview: Request review from grace-fixture, lin-fixture" });
  await preview.getByRole("button", { name: "Request review" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Review requested." })).toBeVisible();
  await expect(page.getByRole("complementary").or(page.locator(".cr-overview-layout")).getByText("lin-fixture", { exact: true })).toBeVisible();
  expect(h.posts().map((p) => [p.endpoint, p.body])).toEqual([[`${PULL}/requested_reviewers`, { reviewers: ["grace-fixture", "lin-fixture"] }]]);
});

test("a state change GitHub may have made stays in doubt, blocks the PR and is confirmed from the PR itself", async () => {
  h = await launchWithGh(baseWorld());
  const page = await openLending();
  h.world((w) => { w.postAnswers = { [PULL]: { status: 502, body: { message: "Bad gateway" }, recorded: true } }; });
  await pickState(page, "Close pull request");
  await page.getByRole("region", { name: "Preview: Close pull request" }).getByRole("button", { name: "Close pull request" }).click();
  const doubt = page.getByTestId("cr-doubt");
  await expect(doubt).toContainText("Modex can't tell whether GitHub changed this pull request's state");
  await expect(comment(page).getByRole("button", { name: "Comment", exact: true })).toHaveAttribute("aria-disabled", "true");
  await doubt.getByRole("button", { name: "Check GitHub" }).click();
  await expect(doubt).toHaveCount(0);
  expect(mutations()).toEqual([`PATCH ${PULL}`]);
});

