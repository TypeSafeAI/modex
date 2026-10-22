import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import { resizeWindow, setTheme, tid } from "./support.js";
import { baseWorld, launchWithGh, prRow, type Harness } from "./code-review-support.js";
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
  ["pane placeholder", ".cr-placeholder"], ["search field text", '[data-testid="code-review-search"]'],
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

for (const size of [{ width: 1440, height: 900 }, { width: 900, height: 600 }]) {
  test(`Tab reaches every Code Review control with a visible focus ring at ${size.width}×${size.height}`, async () => {
    h = await launchWithGh(baseWorld());
    const { page, app } = h;
    await resizeWindow(app, page, size.width, size.height);
    await tid(page, "rail-code-review").click();
    await prRow(page, "example-org/field-guide#91").click();
    await tid(page, "code-review-split-toggle").click();
    await expect(tid(page, "code-review-tab-changes")).toContainText("+11");
    await tid(page, "rail-code-review").focus();
    const order: { id: string; name: string; ring: boolean }[] = [];
    // The PR and Changes tabs sit in the title bar's strip, outside the surface's region; both count.
    for (let i = 0; i < 80; i++) {
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
    record(`tab:${size.width}x${size.height}`, order);
    const reached = new Set(order.map((s) => s.id));
    for (const id of ["code-review-inbox-menu", "code-review-search", "code-review-row", "code-review-tab-overview", "code-review-close-overview",
      "code-review-split-toggle", "code-review-pin", "code-review-copy-link", "code-review-open-github", "code-review-review", "code-review-instructions", "code-review-merge"]) {
      expect(reached.has(id), `${id} reachable by Tab at ${size.width}×${size.height}; order: ${order.map((s) => s.id).join(" → ")}`).toBe(true);
    }
    expect(order.filter((s) => !s.ring).map((s) => s.id), "stops without a visible focus indicator").toEqual([]);
  });
}
