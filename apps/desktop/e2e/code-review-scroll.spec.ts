import { test, expect, type Locator, type Page } from "@playwright/test";
import { tid } from "./support.js";
import { baseWorld, fitWindow, launchWithGh, LENDING, LENDING_73, prRow, type Harness } from "./code-review-support.js";
import { ghFile, ghPull, ghRow } from "../test/fixtures/code-review-gh-world.js";

/**
 * CR-3 (#322) AC3 and AC4 with populated content: now that the overview (#323) and the remote diff (#324) fill the
 * panes, the inbox list, the overview, the diff and the file tree each scroll on their own, by wheel and by
 * keyboard, and scrolling one neither moves another nor takes the focus from it. Through the production read
 * service with a synthetic gh (e2e/code-review-support.ts), at 1440×900 and at 900×600, where the split folds to
 * one pane and the tree may sit behind the Files toggle.
 */
let h: Harness;
test.afterEach(async () => { await h?.close(); });

const ROWS = 40, FILES = 60;
function populated() {
  const world = baseWorld();
  world.search.authored = [world.search.authored[0]!, ...Array.from({ length: ROWS }, (_, i) =>
    ghRow(LENDING, 1000 + i, `Synthetic change ${String(i + 1).padStart(2, "0")} to the lending queue, long enough to wrap onto a second line`, [1001, "ada-fixture"], new Date(Date.parse("2026-10-18T20:00:00Z") - i * 60_000).toISOString()))];
  const body = Array.from({ length: 40 }, (_, i) => `Paragraph ${i + 1}. The desk, the member app and the nightly batch all read the policy, so every change to a term or a fine has to be visible before it is saved.`).join("\n\n");
  world.routes["repos/example-org/lending/pulls/73"] = ghPull(LENDING, 73, LENDING_73, { body, files: FILES, additions: FILES * 20, deletions: FILES * 3 });
  world.routes["repos/example-org/lending/pulls/73/files"] = Array.from({ length: FILES }, (_, i) =>
    ghFile(`src/queue/module-${String(i).padStart(2, "0")}.ts`, `@@ -1,3 +1,20 @@\n-old line\n-old line\n-old line\n${Array.from({ length: 20 }, (_, n) => `+export const line${n} = ${i};`).join("\n")}`, 20, 3));
  return world;
}

const top = (l: Locator) => l.evaluate((el) => el.scrollTop);
/** Chromium animates keyboard scrolls: the position once it has stopped moving. */
async function settled(l: Locator): Promise<number> {
  let last = await top(l);
  for (;;) { await l.page().waitForTimeout(120); const now = await top(l); if (now === last) return now; last = now; }
}
/** The overview's own scroller: its main column, or the whole body where the pane is narrow and stacks them. */
async function overviewScroller(page: Page): Promise<Locator> {
  const main = page.locator(".cr-overview-main");
  if (!(await main.count())) return tid(page, "code-review-overview-body");
  const stacked = await main.evaluate((el) => getComputedStyle(el).overflowY === "visible");
  return stacked ? tid(page, "code-review-overview-body") : main;
}
/** Every scroll container that is on screen: wheel one, and the rest must not move. */
async function regions(page: Page): Promise<Record<string, Locator>> {
  const all: Record<string, Locator> = { inbox: tid(page, "code-review-inbox-list"), overview: await overviewScroller(page), sidebar: page.locator(".cr-overview-sidebar"), diff: tid(page, "code-review-diff"), tree: tid(page, "code-review-tree") };
  const shown: Record<string, Locator> = {};
  for (const [name, l] of Object.entries(all)) {
    if (!(await l.count()) || !(await l.first().isVisible())) continue;
    // A column that stacks under the narrow overview has no scroller of its own: its body scrolls.
    if (await l.first().evaluate((el) => !["auto", "scroll"].includes(getComputedStyle(el).overflowY))) continue;
    shown[name] = l.first();
  }
  return shown;
}
async function tops(r: Record<string, Locator>): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const [name, l] of Object.entries(r)) out[name] = await top(l);
  return out;
}
const pageTop = (page: Page) => page.evaluate(() => [document.scrollingElement!.scrollTop, document.querySelector('[data-testid="sheet"]')?.scrollTop ?? 0]);

/** Wheels over `name`: it moves, nothing else does, and the focused element stays focused. */
async function wheelOnly(page: Page, r: Record<string, Locator>, name: string, focused: Locator) {
  const before = await tops(r);
  await r[name]!.hover();
  await page.mouse.wheel(0, 400);
  await expect.poll(() => top(r[name]!), `${name} scrolls`).toBeGreaterThan(before[name]!);
  await settled(r[name]!);
  for (const [other, l] of Object.entries(r)) if (other !== name) expect(await top(l), `${other} unmoved by ${name}`).toBe(before[other]);
  expect(await pageTop(page), `the window and sheet unmoved by ${name}`).toEqual([0, 0]);
  await expect(focused).toBeFocused();
}
/** The keyboard scrolls what has focus: PageDown moves `name` only. */
async function keyOnly(page: Page, r: Record<string, Locator>, name: string) {
  await r[name]!.evaluate((el) => { el.scrollTop = 0; });
  await r[name]!.evaluate((el) => (el as HTMLElement).focus());
  const before = await tops(r);
  await page.keyboard.press("PageDown");
  await expect.poll(() => top(r[name]!), `${name} scrolls by key`).toBeGreaterThan(0);
  await settled(r[name]!);
  for (const [other, l] of Object.entries(r)) if (other !== name) expect(await top(l), `${other} unmoved by keys in ${name}`).toBe(before[other]);
  expect(await pageTop(page)).toEqual([0, 0]);
}

for (const size of [{ width: 1440, height: 900 }, { width: 900, height: 600 }]) {
  test(`list, overview, diff and file tree scroll independently and keep focus at ${size.width}×${size.height}`, async () => {
    h = await launchWithGh(populated());
    const { page } = h;
    const used = await fitWindow(h, size.width, size.height);
    test.info().annotations.push({ type: "viewport", description: `${used.width}×${used.height}` });
    await tid(page, "rail-code-review").click();
    await expect(prRow(page, "example-org/lending#1028")).toBeVisible();
    await prRow(page, "example-org/lending#73").click();
    await expect(tid(page, "code-review-tab-changes")).toContainText(`+${(FILES * 20).toLocaleString("en-US")}`);
    await expect(tid(page, "cr-description")).toContainText("Paragraph 40");

    // One pane, the overview: the list and the overview scroll apart, with focus held in the list.
    const row = prRow(page, "example-org/lending#73");
    await row.focus();
    let r = await regions(page);
    expect(Object.keys(r).sort()).toEqual(expect.arrayContaining(["inbox", "overview"]));
    await wheelOnly(page, r, "overview", row);
    await wheelOnly(page, r, "inbox", row);
    if (r.sidebar) await wheelOnly(page, r, "sidebar", row);
    await keyOnly(page, r, "overview");
    await expect(row).not.toBeFocused();

    // Changes, beside the overview where there is room, alone where there is not.
    await tid(page, "code-review-split-toggle").click();
    const split = (await tid(page, "code-review-workspace").getAttribute("data-panes")) === "overview changes";
    expect(split, "the split is kept at 1440×900 and folded at 900×600").toBe(size.width >= 1440);
    if (!split) await tid(page, "code-review-tab-changes").click();
    await expect(tid(page, "cr-file-section")).toHaveCount(FILES);
    const toggle = tid(page, "code-review-files-toggle");
    const treeHidden = (await toggle.count()) > 0;
    r = await regions(page);
    expect(r.diff, "the diff is on screen").toBeTruthy();
    if (treeHidden) expect(r.tree, "the tree waits behind the Files toggle").toBeUndefined();
    else expect(r.tree, "the tree sits beside the diff").toBeTruthy();

    // The diff, with focus on a file heading inside it; then the list again with focus still in the diff.
    const heading = tid(page, "cr-file-section").first().getByRole("button", { name: /^(Expand|Collapse) src\// });
    await heading.focus();
    await wheelOnly(page, r, "diff", heading);
    await wheelOnly(page, r, "inbox", heading);
    if (r.overview) await wheelOnly(page, r, "overview", heading);
    await keyOnly(page, r, "diff");
    await expect(heading).not.toBeFocused();

    // The tree: beside the diff, or on its own behind the toggle. Focus stays in its filter while anything else scrolls.
    if (treeHidden) {
      await toggle.click();
      await expect(tid(page, "code-review-tree")).toBeVisible();
      await expect(tid(page, "code-review-diff")).toBeHidden();
      r = await regions(page);
    }
    const filter = page.getByRole("textbox", { name: "Filter remote files" });
    await filter.focus();
    await wheelOnly(page, r, "tree", filter);
    await wheelOnly(page, r, "inbox", filter);
    if (r.diff) await wheelOnly(page, r, "diff", filter);
    await keyOnly(page, r, "tree");
    await expect(filter).not.toBeFocused();

    // Where the tree and diff share the pane, choosing a file moves the diff to it and focuses the file there,
    // and the tree keeps its own position.
    if (!treeHidden) {
      const treeBefore = await top(r.tree!);
      const last = tid(page, "cr-tree-file").last();
      await last.scrollIntoViewIfNeeded();
      await last.click();
      const section = tid(page, "cr-file-section").last();
      await expect(section).toBeFocused();
      await expect(section).toBeInViewport();
      expect(await top(r.tree!)).toBeGreaterThanOrEqual(treeBefore);
      expect(await top(r.inbox!)).toBeGreaterThan(0);
    }

    // Positions survive leaving and returning: each region is where it was, and the list is untouched.
    const kept = await tops(r);
    await tid(page, "code-review-tab-overview").click();
    await expect(tid(page, "code-review-pane-overview")).toBeVisible();
    if (!split) await tid(page, "code-review-tab-changes").click();
    if (treeHidden && !(await tid(page, "code-review-tree").isVisible())) await toggle.click();
    await expect(tid(page, "code-review-tree")).toBeVisible();
    const back = await regions(page);
    for (const [name, l] of Object.entries(back)) if (kept[name] !== undefined) await expect.poll(() => top(l), `${name} restored`).toBe(kept[name]);
    expect(await pageTop(page)).toEqual([0, 0]);
  });
}
