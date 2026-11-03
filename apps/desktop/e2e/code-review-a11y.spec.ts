import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import { setTheme, tid } from "./support.js";
import { baseWorld, fitWindow, launchWithGh, prRow, type Harness } from "./code-review-support.js";
import { THEMES, type Theme } from "../src/shared/theme.js";

/**
 * CR-8 (#327): keyboard path, visible focus and text contrast across the Code Review surface, through the
 * production read service (e2e/code-review-support.ts). It complements code-review-navigation.spec.ts's
 * keyboard test and e2e/app.spec.ts's shell accessibility check. It does not stand in for the human
 * VoiceOver pass (docs/reviews/2026-10-22-cr8-voiceover/checklist.md).
 *
 * MODEX_A11Y=<file> writes the measured contrast ratios and Tab orders as JSON.
 */
let h: Harness;
test.afterEach(async () => { await h?.close(); });
/** Each test merges its measurements into the file, so a worker restarted after a failure keeps the rest. */
function record(name: string, value: unknown): void {
  const file = process.env.MODEX_A11Y;
  if (!file) return;
  const all = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown> : {};
  fs.writeFileSync(file, JSON.stringify({ ...all, [name]: value }, null, 2) + "\n");
}

/** WCAG 2 contrast of an element's text against the first opaque background behind it (as e2e/app.spec.ts). */
const contrast = (page: Page, selector: string) => page.locator(selector).first().evaluate((el) => {
  const rgb = (s: string) => (s.match(/[\d.]+/g) ?? []).map(Number);
  const lum = ([r, g, b]: number[]) => [r!, g!, b!].map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }).reduce((a, c, i) => a + c * [0.2126, 0.7152, 0.0722][i]!, 0);
  let bg: number[] = [0, 0, 0];
  for (let n: Element | null = el; n; n = n.parentElement) { const c = rgb(getComputedStyle(n).backgroundColor); if (c.length === 3 || (c.length === 4 && c[3]! > 0.9)) { bg = c; break; } }
  const [a, b] = [lum(rgb(getComputedStyle(el).color)), lum(bg)].sort((x, y) => y - x);
  return Math.round(((a! + 0.05) / (b! + 0.05)) * 100) / 100;
});

/** Text that carries information on this surface. Unavailable actions are measured too, but WCAG 1.4.3 exempts inactive controls. */
const TEXT: [string, string][] = [
  ["inbox title", ".cr-inbox-title"], ["group label", ".cr-group-label"], ["row title", ".cr-row-title"], ["row meta (login · age)", ".cr-row-meta"],
  ["PR id in header", '[data-testid="code-review-pr-id"]'], ["state pill", '[data-testid="code-review-state"]'], ["PR tab title", '[data-testid="code-review-tab-overview"]'],
  ["PR description", '[data-testid="cr-description"]'], ["search field text", '[data-testid="code-review-search"]'],
];

for (const theme of Object.keys(THEMES) as Theme[]) {
  test(`information text meets AA contrast in the ${THEMES[theme].name} theme`, async () => {
    h = await launchWithGh(baseWorld());
    const { page } = h;
    await setTheme(page, theme);
    await tid(page, "rail-code-review").click();
    await prRow(page, "example-org/lending#73").click();
    await expect(tid(page, "code-review-tab-changes")).toContainText("+8,912");
    const measured: Record<string, number> = {};
    for (const [name, selector] of TEXT) measured[name] = await contrast(page, selector);
    measured["unavailable action (exempt)"] = await contrast(page, '[data-testid="code-review-review"]');
    record(`contrast:${theme}`, measured);
    for (const [name] of TEXT) expect(measured[name], `${name} in ${theme}`).toBeGreaterThanOrEqual(4.5);
  });
}

/**
 * C76: every control CR-3 to CR-7 put on the surface, identified as a person meets it. A test id where the slice
 * gave one, otherwise the accessible name; the numbers name the matrix rows (docs/reviews/2026-11-01-cr8-acceptance-matrix.md).
 */
const REQUIRED_IDS = [
  // CR-3: inbox, tabs and header.
  "code-review-inbox-menu", "code-review-search", "code-review-row", "code-review-tab-overview", "code-review-close-overview",
  "code-review-split-toggle", "code-review-pin", "code-review-copy-link", "code-review-open-github",
  // CR-3 Changes tab; CR-5 tree (C73); CR-6 review and instructions (C27, C28); CR-7 state and merge (C21, C29).
  "code-review-tab-changes", "code-review-close-changes", "cr-tree-file", "code-review-review", "code-review-instructions", "code-review-state", "code-review-merge",
];
const REQUIRED_NAMES: [string, RegExp][] = [
  // CR-4 overview: the scrollable regions, Open Changes and the activity filter (C36, C47, C48).
  ["overview column", /^Description and activity$/], ["details column", /^Pull request details$/], ["open Changes", /^Open Changes$/], ["activity filter", /^Activity filter$/],
  // CR-5 diff: dividers, filter, file sections, menus, line anchors and folded context (C64, C66, C67, C68, C70, C72, C74, C75).
  ["pane divider", /^Resize the pull request pane$/], ["tree divider", /^Resize the file tree$/], ["file filter", /^Filter remote files$/],
  ["file collapse", /^Collapse src\/holds\/move\.ts$/], ["file menu", /^File options for src\/holds\/move\.ts$/], ["line anchor", /^(Old|New) line \d+/], ["folded context", /^Expand \d+ unchanged lines/],
  // CR-7 writes: comment, review, edit and reviewer requests (C31, C35, C38, C43, C55).
  ["comment", /^Comment$/], ["review", /^Review$/], ["edit", /^Edit pull request$/], ["reviewers", /^Request reviewers$/],
];

/** One pane has no divider beside it to move. */
const WIDE_ONLY = new Set(["pane divider"]);

for (const size of [{ width: 1440, height: 900 }, { width: 900, height: 600 }]) {
  test(`Tab reaches every Code Review control with a visible focus ring at ${size.width}×${size.height}`, async () => {
    h = await launchWithGh(baseWorld());
    const { page } = h;
    const used = await fitWindow(h, size.width, size.height);
    await tid(page, "rail-code-review").click();
    await prRow(page, "example-org/lending#73").click();
    await tid(page, "code-review-split-toggle").click();
    await expect(tid(page, "code-review-tab-changes")).toContainText("+8,912");
    await expect(page.getByRole("button", { name: "Request reviewers" })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Activity filter" })).toBeVisible();
    const expand = page.getByRole("button", { name: /^Expand \d+ unchanged lines/ }).first();
    // A narrow window keeps one pane of the split (navigation.ts), so the keyboard path visits each view in turn.
    const onePane = size.width < 1000;
    if (!onePane) await expect(expand).toBeVisible();
    const order: { id: string; name: string; ring: boolean }[] = [];
    const walk = async () => {
      await tid(page, "rail-code-review").focus();
      // The PR and Changes tabs sit in the title bar's strip, outside the surface's region; both count.
      for (let i = 0; i < 240; i++) {
        await page.keyboard.press("Tab");
        const stop = await page.evaluate(() => {
          const el = document.activeElement as HTMLElement | null;
          if (!el || !el.closest('[data-testid="code-review"], [data-testid="code-review-tabbar"]')) return null;
          const style = getComputedStyle(el);
          let ring = (style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0) || style.boxShadow !== "none";
          // A search field shows focus on its box: the border turns the accent colour (styles.css .sidebar-search).
          const field = el.closest(".sidebar-search");
          if (!ring && field) {
            const probe = document.createElement("span");
            probe.style.color = "var(--accent)";
            document.body.append(probe);
            ring = getComputedStyle(field).borderTopColor === getComputedStyle(probe).color;
            probe.remove();
          }
          return { id: el.dataset.testid ?? el.getAttribute("role") ?? el.tagName.toLowerCase(), name: el.getAttribute("aria-label") ?? el.textContent?.trim().slice(0, 60) ?? "", ring };
        });
        if (stop) order.push(stop);
      }
    };
    await walk();
    if (onePane) {
      await tid(page, "code-review-tab-changes").click();
      await expect(expand).toBeVisible();
      await walk();
    }
    record(`tab:${used.width}x${used.height}`, order);
    const reached = new Set(order.map((s) => s.id));
    const path = () => order.map((s) => `${s.id}:${s.name}`).join(" → ");
    for (const id of REQUIRED_IDS) expect(reached.has(id), `${id} reachable by Tab at ${size.width}×${size.height}; order: ${path()}`).toBe(true);
    for (const [label, name] of REQUIRED_NAMES.filter(([label]) => !onePane || !WIDE_ONLY.has(label))) expect(order.some((s) => name.test(s.name)), `${label} reachable by Tab at ${size.width}×${size.height}; order: ${path()}`).toBe(true);
    expect(order.filter((s) => !s.ring).map((s) => s.id), "stops without a visible focus indicator").toEqual([]);
  });
}

/** The lowest WCAG contrast of any text inside an element, skipping inactive controls (WCAG 1.4.3 exempts them), with the text that scored it. */
const lowest = (page: Page, selector: string) => page.locator(selector).first().evaluate((root) => {
  const rgba = (s: string) => (s.match(/[\d.]+/g) ?? []).map(Number);
  const lum = ([r, g, b]: number[]) => [r!, g!, b!].map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }).reduce((a, c, i) => a + c * [0.2126, 0.7152, 0.0722][i]!, 0);
  let worst = { ratio: 21, text: "" };
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const el = node.parentElement!;
    const text = node.textContent?.trim() ?? "";
    if (!text || el.closest('[disabled], [aria-disabled="true"]') || !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
    let bg: number[] = [0, 0, 0];
    for (let n: Element | null = el; n; n = n.parentElement) { const c = rgba(getComputedStyle(n).backgroundColor); if (c.length === 3 || (c.length === 4 && c[3]! > 0.9)) { bg = c; break; } }
    const fg = rgba(getComputedStyle(el).color);
    const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
    const ratio = Math.round(((a! + 0.05) / (b! + 0.05)) * 100) / 100;
    if (ratio < worst.ratio) worst = { ratio, text: `${text.slice(0, 40)} <${el.tagName.toLowerCase()}.${el.className}>` };
  }
  return worst;
});

/** The CR-4 to CR-7 text a reviewer reads, in every theme: details, activity, tree and diff, the review panel, the composers and the merge panel. */
const SLICE_TEXT: [string, string][] = [
  ["activity", '[data-testid="cr-activity"]'], ["checks", '[data-testid="cr-checks"]'], ["details", 'aside[aria-label="Pull request details"]'], ["details", 'aside[aria-label="Pull request details"]'],
  ["tree file", '[data-testid="cr-tree-file"]'], ["file section", '[data-testid="cr-file-section"]'],
  ["review section", '[data-testid="cr-agent"]'], ["composer", '[data-testid="cr-compose"]'],
];
for (const theme of Object.keys(THEMES) as Theme[]) {
  test(`CR-4 to CR-7 text meets AA contrast in the ${THEMES[theme].name} theme`, async () => {
    h = await launchWithGh(baseWorld());
    const { page } = h;
    await fitWindow(h, 1440, 900);
    await setTheme(page, theme);
    await tid(page, "rail-code-review").click();
    await prRow(page, "example-org/lending#73").click();
    await tid(page, "code-review-split-toggle").click();
    await expect(tid(page, "cr-tree-file").first()).toBeVisible();
    const measured: Record<string, { ratio: number; text: string }> = {};
    for (const [name, selector] of SLICE_TEXT) {
      await expect(page.locator(selector).first(), name).toBeAttached();
      measured[name] = await lowest(page, selector);
    }
    // Panels open on a click: the review panel and the merge panel.
    await tid(page, "code-review-review").first().click();
    await expect(tid(page, "cr-agent-panel").first()).toBeVisible();
    measured["review panel"] = await lowest(page, '[data-testid="cr-agent-panel"]');
    await tid(page, "code-review-merge").first().click();
    await expect(tid(page, "cr-merge").first()).toBeVisible();
    measured["merge panel"] = await lowest(page, '[data-testid="cr-merge"]');
    record(`contrast-slices:${theme}`, measured);
    for (const [name, worst] of Object.entries(measured)) expect(worst.ratio, `${name} in ${theme}: "${worst.text}"`).toBeGreaterThanOrEqual(4.5);
  });
}
