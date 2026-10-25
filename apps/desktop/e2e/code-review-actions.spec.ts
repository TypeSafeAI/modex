import { test, expect, type Page } from "@playwright/test";
import { tid } from "./support.js";
import { baseWorld, fitWindow, launchWithGh, prRow, type Harness } from "./code-review-support.js";

/**
 * CR-7 (#326): comments and reviews in real Electron, through main's production `code-review:write` service and
 * gh write transport, with the synthetic gh (e2e/code-review-support.ts) standing in for GitHub. Each POST it
 * receives is recorded (Harness.posts), so a test counts exactly what reached "GitHub". Nothing here touches a
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

test("a review with a line comment from Changes pins the head; self-approval is offered nowhere", async () => {
  h = await launchWithGh(baseWorld());
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
