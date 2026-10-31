import { test, expect, type Locator, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { appDir, tid } from "./support.js";
import { baseWorld, fitWindow, launchWithGh, prRow, READ_ENDPOINT, type Harness } from "./code-review-support.js";
import { ghFile } from "../test/fixtures/code-review-gh-world.js";

/**
 * CR-8 (#327): the integrated Code Review journey in real Electron, through main's production read service
 * with a synthetic gh (e2e/code-review-support.ts). Inbox → R1 → R2 activity → R3 instructions → R4.
 * Captures document the current fixture journey; missing originals keep visual fidelity acceptance open.
 *
 * The window is fitted to the display (fitWindow): a CI display shorter than a reference gives a shorter capture,
 * and the manifest records the viewport actually used. Pane geometry is checked on the x axis only.
 *
 * Captures go to test-results/ui-code-review/<state>.png with a manifest.json, so
 * `pnpm run ui:compare -- --captures test-results/ui-code-review <dir of R1.png, R4.png>` lays them beside
 * Val's references. The references stay off the repository (docs/design/code-review.md); so do these
 * captures, which Playwright wipes on its next run.
 */
const outDir = path.join(appDir, "test-results", "ui-code-review");
/** The references' CSS sizes (docs/design/code-review.md, References and calibration). */
const R1 = { width: 1766, height: 1057 }, R2 = { width: 1768, height: 1051 },
  R3 = { width: 1769, height: 1049 }, R4 = { width: 1764, height: 1047 };

let h: Harness;
test.afterEach(async () => { await h?.close(); });

const box = async (l: Locator) => { const b = (await l.boundingBox())!; return { x: Math.round(b.x), y: Math.round(b.y), right: Math.round(b.x + b.width), bottom: Math.round(b.y + b.height) }; };

async function capture(page: Page, manifest: object[], state: string, geometry: Record<string, unknown> = {}): Promise<void> {
  await page.waitForTimeout(250);
  const file = `${state}.png`;
  await page.screenshot({ path: path.join(outDir, file), animations: "disabled", caret: "hide" });
  const env = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio, locale: navigator.language,
    theme: document.documentElement.dataset.theme ?? null, dark: matchMedia("(prefers-color-scheme: dark)").matches, font: getComputedStyle(document.body).fontFamily }));
  manifest.push({ state, file, viewport: { width: env.width, height: env.height }, dpr: env.dpr, locale: env.locale, theme: env.theme, dark: env.dark, font: env.font, geometry });
}

test("inbox → R1 → R2 → R3 → R4 through the production read service, with captures for ui:compare and nothing written", async () => {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const manifest: object[] = [];
  const world = baseWorld();
  world.routes["repos/example-org/lending/issues/73/timeline"] = Array.from({ length: 12 }, (_, i) => ({
    id: 9100 + i, event: "commented", user: { id: 1002, login: "grace-fixture", type: "User" },
    created_at: `2026-10-18T20:${String(10 + i).padStart(2, "0")}:00Z`,
    body: `Journey activity ${i + 1}: keep the hold's place when moving between branches.`,
  }));
  world.routes["repos/example-org/lending/deployments"] = [];
  // R1's sidebar shows checks for the head, and R4's Changes pane shows grouped diffs and a file tree: give the
  // world lending #73's check runs and a commit status, and field-guide #91's four files (+11 −4, as its PR says),
  // so the captures hold populated content for the reference comparison (#322 Step 3). All made up.
  const head = `repos/example-org/lending/commits/${"c".repeat(40)}`;
  const checkRun = (id: number, name: string, conclusion: string | null, minutes: number) => ({
    id, name, head_sha: "c".repeat(40), status: conclusion ? "completed" : "in_progress", conclusion, app: { slug: "github-actions" },
    started_at: "2026-10-18T20:31:00Z", completed_at: conclusion ? `2026-10-18T20:${31 + minutes}:00Z` : null, html_url: `https://github.com/example-org/lending/runs/${id}`,
  });
  world.routes[`${head}/check-runs`] = { total_count: 4, check_runs: [checkRun(8101, "unit + e2e (macOS)", "success", 6), checkRun(8102, "typecheck", "success", 2), checkRun(8103, "lint", "failure", 1), checkRun(8104, "package", null, 0)] };
  world.routes[`${head}/status`] = { total_count: 1, statuses: [{ id: 8201, context: "preview/deploy", state: "pending", creator: { id: 1003, login: "deploy-bot", type: "User" }, created_at: "2026-10-18T20:32:00Z", updated_at: "2026-10-18T20:32:00Z", target_url: "https://example.test/preview/73" }] };
  world.routes["repos/example-org/field-guide/pulls/91/files"] = [
    ghFile("src/branches/regions.ts", "@@ -1,4 +1,7 @@\n import { Branch } from \"./branch\";\n-export const regions = [\"north\", \"south\"];\n-export function groupByRegion(branches: Branch[]) { return branches; }\n+export const regions = [\"north\", \"south\", \"east\", \"west\"] as const;\n+export type Region = (typeof regions)[number];\n+export function groupByRegion(branches: Branch[]): Map<Region, Branch[]> {\n+  return new Map(regions.map((region) => [region, branches.filter((b) => b.region === region)]));\n+}\n export const DEFAULT_REGION = \"north\";", 5, 2),
    ghFile("src/branches/index.ts", "@@ -2,3 +2,5 @@\n export { Branch } from \"./branch\";\n-export { regions } from \"./regions\";\n+export { regions, groupByRegion } from \"./regions\";\n+export type { Region } from \"./regions\";\n+export { BranchList } from \"../pages/branch-list\";\n export { openingHours } from \"./hours\";", 3, 1),
    ghFile("src/pages/branch-list.tsx", "@@ -8,4 +8,5 @@ export function BranchList({ branches }: Props) {\n   return (\n-    <ul>{branches.map((b) => <li key={b.id}>{b.name}</li>)}</ul>\n+    <>{[...groupByRegion(branches)].map(([region, list]) => <section key={region}><h2>{region}</h2>\n+      <ul>{list.map((b) => <li key={b.id}>{b.name}</li>)}</ul></section>)}</>\n   );\n }", 2, 1),
    ghFile("docs/branches.md", "@@ -1,2 +1,3 @@\n # Branches\n+Branch pages are grouped by region: north, south, east and west.\n Each branch page lists its opening hours.", 1, 0),
  ];
  const deploymentRead = `repos/example-org/lending/deployments?sha=${"c".repeat(40)}&per_page=20&page=1`;
  h = await launchWithGh(world);
  const { page, repo } = h;
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  const before = { head: git("rev-parse", "HEAD"), status: git("status", "--porcelain=v1", "--untracked-files=all") };
  const starts = h.providerStarts().length;

  // Inbox: the rail opens it, and both groups arrive through main's service.
  await fitWindow(h, R1.width, R1.height);
  await tid(page, "rail-code-review").click();
  await expect(tid(page, "rail-code-review")).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("group", { name: "Authored by me" })).toContainText("Move holds between branches");
  await expect(page.getByRole("group", { name: "Needs my review" })).toContainText("Fix the broken anchors");

  // R1: a row opens its PR with the PR and Changes tabs; the totals come from main's overview read.
  await prRow(page, "example-org/lending#73").click();
  await expect(tid(page, "code-review-tab-overview")).toHaveAttribute("aria-selected", "true");
  await expect(tid(page, "code-review-tab-changes")).toContainText("+8,912");
  await expect(tid(page, "code-review-tab-changes")).toContainText("−47");
  await expect(tid(page, "code-review-pr-id").first()).toHaveText("lending #73");
  await expect(tid(page, "code-review-loading")).toHaveCount(0);
  await capture(page, manifest, "R1", { inbox: await box(tid(page, "code-review-inbox")), prTab: await box(tid(page, "code-review-tab-overview")), header: await box(tid(page, "code-review-pr-header").first()) });
  // R2: scroll the actual overview to loaded activity, without scrolling the inbox.
  await fitWindow(h, R2.width, R2.height);
  const overview = page.getByRole("main", { name: "Description and activity" });
  const activity = tid(page, "cr-activity");
  await expect(activity).toContainText("All activity loaded");
  const lastComment = activity.getByText("Journey activity 12: keep the hold's place when moving between branches.", { exact: true });
  const inboxScroll = await tid(page, "code-review-inbox").evaluate(el => el.scrollTop);
  await lastComment.scrollIntoViewIfNeeded();
  await expect(lastComment).toBeVisible();
  await expect.poll(() => overview.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
  expect(await tid(page, "code-review-inbox").evaluate(el => el.scrollTop)).toBe(inboxScroll);
  await capture(page, manifest, "R2", { overview: await box(overview), activity: await box(activity) });

  // R3: opening instructions preserves the scrolled PR and returns keyboard focus on Escape.
  await fitWindow(h, R3.width, R3.height);
  const scrollBeforeInstructions = await overview.evaluate(el => el.scrollTop);
  const gear = tid(page, "code-review-instructions").first();
  await gear.click();
  const instructions = page.getByRole("dialog", { name: "Review instructions" });
  await expect(instructions).toBeVisible();
  await expect(instructions.getByRole("textbox", { name: "Review instructions" })).toBeFocused();
  await expect(tid(page, "cr-instructions-scope")).toContainText("Saved on this Mac only, as version 0");
  await capture(page, manifest, "R3", { instructions: await box(instructions) });
  await page.keyboard.press("Escape");
  await expect(instructions).toHaveCount(0);
  await expect(gear).toBeFocused();
  expect(await overview.evaluate(el => el.scrollTop)).toBe(scrollBeforeInstructions);
  expect(h.providerStarts().length).toBe(starts);
  expect(h.posts()).toEqual([]);

  // R4: another PR, split beside its Changes through the right-panel button.
  await fitWindow(h, R4.width, R4.height);
  await prRow(page, "example-org/field-guide#91").click();
  await expect(tid(page, "code-review-tab-changes")).toContainText("+11");
  await tid(page, "code-review-split-toggle").click();
  await expect(tid(page, "code-review-workspace")).toHaveAttribute("data-panes", "overview changes");
  const split = { inbox: await box(tid(page, "code-review-inbox")), pr: await box(tid(page, "code-review-pane-overview")), diff: await box(tid(page, "code-review-diff")), tree: await box(tid(page, "code-review-tree")) };
  await capture(page, manifest, "R4", split);
  // CR-3's built geometry (docs/design/code-review.md, Workspace), within 2 px.
  for (const [name, got, want] of [["inbox", split.inbox, [53, 333]], ["pr pane", split.pr, [333, 996]], ["tree", split.tree, [1470, 1760]]] as const) {
    expect(Math.abs(got.x - want[0]), `${name} left`).toBeLessThanOrEqual(2);
    expect(Math.abs(got.right - want[1]), `${name} right`).toBeLessThanOrEqual(2);
  }

  // Back and forward return to each PR as it was left, without reading it again.
  const reads = h.calls().filter((c) => /pulls\/(73|91)$/.test(c)).length;
  await tid(page, "nav-back").click();
  await expect(tid(page, "code-review-pr-id").first()).toHaveText("lending #73");
  await expect(tid(page, "code-review-workspace")).toHaveAttribute("data-panes", "overview");
  await tid(page, "nav-forward").click();
  await expect(tid(page, "code-review-pr-id").first()).toHaveText("field-guide #91");
  await expect(tid(page, "code-review-workspace")).toHaveAttribute("data-panes", "overview changes");
  expect(h.calls().filter((c) => /pulls\/(73|91)$/.test(c)).length).toBe(reads);

  // The two other sizes #327 names.
  await fitWindow(h, 1440, 900);
  await capture(page, manifest, "split-1440");
  await fitWindow(h, 900, 600);
  await expect(tid(page, "code-review-workspace")).toHaveAttribute("data-panes", /^(overview|changes)$/);
  await capture(page, manifest, "narrow-900");
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify({ reference: { R1, R2, R3, R4 }, states: manifest }, null, 2) + "\n");

  // Read-only end to end: only read endpoints, no provider started, the local checkout untouched.
  expect(h.calls().filter((c) => !READ_ENDPOINT.test(c) && c !== deploymentRead)).toEqual([]);
  expect(h.providerStarts().length).toBe(starts);
  expect({ head: git("rev-parse", "HEAD"), status: git("status", "--porcelain=v1", "--untracked-files=all") }).toEqual(before);
});
