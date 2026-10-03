import { test, expect, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { appDir, items, launch, seedHome, tid, currentRow } from "./support";

/**
 * Visual harness for the Modex desktop shell.
 *
 * 1. Captures every named UI state at 1786×1049, the original measured window size, into
 *    `test-results/ui/<state>.png` with a `manifest.json` for visual review.
 * 2. Checks the current palette, type, and shell geometry. The geometry began with the
 *    original 1× reference screenshots (macOS traffic lights measure their native 12 px).
 */
const REFERENCE = { width: 1786, height: 1049 };
const outDir = path.join(appDir, "test-results", "ui");

let app: ElectronApplication;
let page: Page;
const manifest: { state: string; file: string; viewport: { width: number; height: number } }[] = [];

async function capture(state: string): Promise<void> {
  // Let transitions (shimmer, spinners, focus rings) settle into a stable frame.
  await page.waitForTimeout(250);
  const file = path.join(outDir, `${state}.png`);
  await page.screenshot({ path: file, animations: "disabled", caret: "hide" });
  manifest.push({ state, file: path.relative(outDir, file), viewport: await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })) });
}

const box = async (l: Locator) => (await l.boundingBox())!;
/** Geometry checks set the pane layout they measure instead of inheriting it from the capture sequence. */
async function changesHidden(): Promise<void> {
  // The window itself is a precondition too: re-assert the reference size before measuring.
  if ((await page.evaluate(() => window.innerWidth)) !== REFERENCE.width) {
    await app.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0]!.setContentSize(s.width, s.height), REFERENCE);
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(REFERENCE.width);
  }
  if (await tid(page, "changes-panel").count()) await page.keyboard.press("Meta+j");
  await expect(tid(page, "changes-panel")).toHaveCount(0);
  // Let the grid settle: the composer is centred in the full-width main pane.
  await expect.poll(async () => { const m = (await box(tid(page, "main"))); const c = (await box(tid(page, "composer-box"))); return Math.round(Math.abs(c.x + c.width / 2 - (m.x + 1 + (m.width - 1) / 2))); }).toBeLessThanOrEqual(1);
}
const css = (l: Locator, prop: string) => l.evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), prop);

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const { home } = seedHome();
  ({ app, page } = await launch(home));
  // Content size, not window size: the capture must match the reference pixel for pixel.
  await app.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0]!.setContentSize(s.width, s.height), REFERENCE);
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(REFERENCE.width);
});

test.afterAll(async () => {
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify({ reference: REFERENCE, states: manifest }, null, 2) + "\n");
  await app?.close();
});

test("captures every named chat state at the reference size", async () => {
  // MODEX_E2E opens the window with enableLargerThanScreen, so even a small CI display must give the full
  // reference size. Printed as well as asserted: the list reporter drops annotations.
  const vp = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  console.log(`[ui:capture] viewport ${vp.width}×${vp.height} (reference ${REFERENCE.width}×${REFERENCE.height})`);
  expect(vp, "capture viewport must match the reference; the window was clamped to the display").toEqual(REFERENCE);

  await expect(tid(page, "draft-view")).toBeVisible();
  await capture("01-draft");

  await page.keyboard.press("Meta+n");
  await expect(tid(page, "composer-input")).toBeFocused();
  await capture("02-draft-focused");

  await page.keyboard.type("Add a CONTRIBUTING.md with the three-step workflow");
  await capture("03-composer-typed");

  await page.keyboard.press("Meta+Enter");
  await expect(items(page, "approval").first()).toBeVisible();
  await capture("04-approval");

  await items(page, "approval").first().getByRole("button", { name: "Approve" }).click();
  await expect(currentRow(page)).toHaveAttribute("data-status", "idle");
  await expect(tid(page, "changes-file")).toHaveCount(1);
  await expect(tid(page, "followup")).toBeVisible();
  expect(await tid(page, "composer-input").evaluate((el) => getComputedStyle(el, "::placeholder").color)).toBe("rgba(0, 0, 0, 0)");
  await capture("05-turn-complete");

  await items(page, "thinking").first().locator('[data-testid="item-toggle"]').click();
  await items(page, "tool").filter({ hasText: "edit CONTRIBUTING.md" }).locator('[data-testid="item-toggle"]').click();
  await capture("06-items-expanded");

  await tid(page, "model-picker").click();
  await expect(tid(page, "model-menu")).toBeVisible();
  await capture("07-model-menu");
  await page.keyboard.press("Escape");

  await page.keyboard.press("Meta+j");
  await expect(tid(page, "changes-panel")).toHaveCount(0);
  await capture("08-changes-hidden");

  expect(manifest.map((m) => m.state)).toEqual(["01-draft", "02-draft-focused", "03-composer-typed", "04-approval", "05-turn-complete", "06-items-expanded", "07-model-menu", "08-changes-hidden"]);
});

// ── Shell geometry follows the measured reference; the palette is Modex's own. ──────────────

test.describe("Design tokens", () => {
  // Geometry and type began with the 1× reference; cool graphite colors are the Modex palette.
  const MEASURED: Record<string, string> = {
    "--bg-window": "#181c23", "--bg-sidebar": "#141920", "--bg-main": "#0e1218", "--bg-row-selected": "#262e3a",
    "--bg-composer": "#252d38", "--bg-composer-context": "#171e28", "--bg-user-bubble": "#1c2531",
    "--border-pane": "#2c3542", "--border-rail": "#303b4a", "--border-composer": "#3a4657", "--rule": "#293442",
    "--text-1": "#eef2f7", "--text-2": "#c6d0dc", "--text-3": "#929eae", "--text-4": "#7f8b9b", "--text-placeholder": "#8996a6",
    "--accent-warn": "#dc9258", "--text-sm": "13px", "--text-md": "14px", "--text-lg": "18px", "--text-xl": "28px",
    "--radius-row": "10px", "--radius-composer": "20px",
  };

  test("tokens resolve to the chosen values", async () => {
    const got = await page.evaluate((names) => {
      const cs = getComputedStyle(document.documentElement);
      return Object.fromEntries(names.map((n) => [n, cs.getPropertyValue(n).trim()]));
    }, Object.keys(MEASURED));
    expect(got).toEqual(MEASURED);
  });

  test("surface and text colors use the Modex palette", async () => {
    expect(await css(page.locator("body"), "background-color")).toBe("rgb(14, 18, 24)");
    expect(await css(page.locator("body"), "color")).toBe("rgb(238, 242, 247)");
    expect(await css(tid(page, "sidebar"), "background-color")).toBe("rgb(20, 25, 32)");
  });
});

test.describe("Phase 3 · shell", () => {
  // Reference screenshot #1 (1×). ±1 px where anti-aliasing blurs an edge.
  const near = (got: number, want: number, tol = 1) => expect(Math.abs(got - want), `${got} vs ${want}`).toBeLessThanOrEqual(tol);

  test("titlebar 42px, rail 48px, sheet with a 1px edge and 12px corners", async () => {
    const bar = await box(tid(page, "titlebar"));
    expect([bar.x, bar.y, bar.height]).toEqual([0, 0, 42]);
    expect(await css(tid(page, "titlebar"), "background-color")).toBe("rgb(24, 28, 35)");
    const rail = await box(tid(page, "rail"));
    expect([rail.x, rail.y, rail.width]).toEqual([0, 42, 48]);
    const sheet = await box(tid(page, "sheet"));
    expect([sheet.x, sheet.y]).toEqual([48, 42]);
    expect(await css(tid(page, "sheet"), "border-top-left-radius")).toBe("12px");
    expect(await css(tid(page, "sheet"), "border-left-color")).toBe("rgb(48, 59, 74)");
  });

  test("sidebar x 49–288, divider at 289, main from 290", async () => {
    const side = await box(tid(page, "sidebar"));
    expect([side.x, side.y, side.width]).toEqual([49, 43, 240]);
    expect(await css(tid(page, "main"), "border-left-color")).toBe("rgb(44, 53, 66)");
    expect((await box(tid(page, "main"))).x).toBe(289);
  });

  test("titlebar nav buttons centred at x 99 / 133 / 167, y 20", async () => {
    for (const [id, cx] of [["nav-back", 99], ["nav-forward", 133], ["sidebar-toggle", 167]] as const) {
      const b = await box(tid(page, id));
      near(b.x + b.width / 2, cx);
      near(b.y + b.height / 2, 20);
    }
    const rail = await box(tid(page, "rail-chat"));
    expect([rail.x, rail.y, rail.width, rail.height]).toEqual([5, 51, 36, 36]);
    expect(await css(tid(page, "rail-chat"), "background-color")).toBe("rgb(39, 51, 69)");
  });

  test("sidebar header, New chat, Projects label and rows sit on the reference rhythm", async () => {
    const title = tid(page, "sidebar-title");
    expect(await css(title, "font-size")).toBe("18px");
    expect(await css(title, "font-weight")).toBe("600");
    const t = await box(title);
    near(t.x, 65);
    near(t.y + t.height / 2, 69);
    const chat = await box(tid(page, "new-chat"));
    expect([chat.x, chat.y, chat.height]).toEqual([57, 95, 30]);
    const project = await box(tid(page, "project-toggle").first());
    expect(project.y).toBe(166);
    const row = await box(tid(page, "thread-row").first());
    expect([row.x, row.y, row.width, row.height]).toEqual([57, 197, 213, 30]); // x 57–269, 31 px pitch from the project row
    expect(await css(tid(page, "thread-row").first(), "border-top-left-radius")).toBe("10px");
    const label = await box(tid(page, "thread-row-title").first());
    near(label.x, 89);
    expect(await css(tid(page, "thread-row-title").first(), "font-size")).toBe("14px");
  });
});

test.describe("Phase 4 · composer", () => {
  // Reference #1: box 736×98 at x 668–1403, y 931–1028; strip 38 px, inset 13 px; send a 34 px circle in the corner.
  const near = (got: number, want: number, tol = 1) => expect(Math.abs(got - want), `${got} vs ${want}`).toBeLessThanOrEqual(tol);

  test("box is 736×98, centred in the main pane, 16 px off the bottom", async () => {
    await changesHidden();
    const c = await box(tid(page, "composer-box"));
    near(c.x, 668); near(c.y, 931); near(c.width, 736); near(c.height, 98);
    const m = await box(tid(page, "main"));
    near(c.x + c.width / 2, m.x + 1 + (m.width - 1) / 2);
    expect(await css(tid(page, "composer-box"), "background-color")).toBe("rgb(37, 45, 56)");
    expect(await css(tid(page, "composer-box"), "border-top-color")).toBe("rgb(58, 70, 87)");
    expect(await css(tid(page, "composer-box"), "border-top-left-radius")).toBe("20px");
  });

  test("context strip sits on the box: 38 px, inset 13 px, 13 px text", async () => {
    const c = await box(tid(page, "composer-box"));
    const s = await box(tid(page, "composer-context"));
    near(s.x, c.x + 13); near(s.width, c.width - 26); expect(s.height).toBe(38); near(s.y + s.height, c.y);
    expect(await css(tid(page, "composer-context"), "background-color")).toBe("rgb(23, 30, 40)");
    expect(await css(tid(page, "composer-context"), "font-size")).toBe("13px");
  });

  test("control row: + at x 690, access pill after it, round send in the corner", async () => {
    const c = await box(tid(page, "composer-box"));
    const plus = await box(tid(page, "composer-plus"));
    near(plus.x + plus.width / 2, 690); near(plus.y + plus.height / 2, 1007);
    const access = await box(tid(page, "access-picker"));
    near(access.x, 708);
    expect(await css(tid(page, "access-picker"), "font-size")).toBe("13px");
    const send = await box(tid(page, "send"));
    expect([send.width, send.height]).toEqual([34, 34]);
    near(send.x + send.width, c.x + c.width - 2);
    near(send.y + send.height, c.y + c.height - 2);
    expect(await css(tid(page, "send"), "border-top-left-radius")).toBe("50%");
    expect(await css(tid(page, "composer-input"), "font-size")).toBe("14px");
    await expect(tid(page, "composer-input")).toHaveAttribute("placeholder", "Do anything");
  });
});

test.describe("Phase 6 · transcript", () => {
  // Reference #8 geometry: column = composer box − 22 px; 14 px / 1.6 prose and a right-aligned bubble.
  test("column, bubble, turn header and prose match the reference", async () => {
    await changesHidden();
    const c = await box(tid(page, "composer-box"));
    const header = await box(tid(page, "turn-label").first());
    expect(Math.abs(header.x - (c.x + 11))).toBeLessThanOrEqual(1);
    expect(Math.abs(header.width - (c.width - 22))).toBeLessThanOrEqual(1);
    const label = tid(page, "turn-label").first();
    expect(await css(label, "font-size")).toBe("14px");
    expect(await css(label, "font-weight")).toBe("500");
    expect(await css(label, "color")).toBe("rgb(146, 158, 174)");
    expect(await css(label, "border-bottom-color")).toBe("rgb(41, 52, 66)");
    const bubble = items(page, "user").first().locator('[data-testid="item-text"]');
    expect(await css(bubble, "background-color")).toBe("rgb(28, 37, 49)");
    expect(await css(bubble, "border-top-left-radius")).toBe("12px");
    const b = await box(bubble);
    expect(Math.abs(b.x + b.width - (header.x + header.width))).toBeLessThanOrEqual(1);
    const prose = items(page, "assistant").first();
    expect(await css(prose, "font-size")).toBe("14px");
    expect(await css(prose, "line-height")).toBe("22.4px");
    expect(await css(prose, "color")).toBe("rgb(238, 242, 247)");
    // Resting state: an expanded or hovered line is brighter (--text-2) on purpose.
    const thinking = items(page, "thinking").first().locator('[data-testid="item-toggle"]');
    if ((await thinking.getAttribute("aria-expanded")) === "true") await thinking.click();
    await page.mouse.move(5, 600);
    await expect(thinking).toHaveAttribute("aria-expanded", "false");
    await expect(thinking).toHaveCSS("color", "rgb(139, 151, 167)");
  });
});

test.describe("Phase 7 · title bar actions", () => {
  // Reference #8/#9: ⋯ and the panel toggle on a 34 px pitch, ending 6 px inside the main pane's right edge.
  test("⋯ and the Changes icon sit at the main pane's right edge, with or without the panel", async () => {
    await changesHidden();
    const check = async (edge: number) => {
      const more = await box(tid(page, "thread-menu-toggle"));
      const toggle = await box(tid(page, "changes-toggle"));
      expect(Math.abs(toggle.x + toggle.width - (edge - 6))).toBeLessThanOrEqual(1);
      expect(Math.abs(toggle.x + toggle.width / 2 - (more.x + more.width / 2) - 34)).toBeLessThanOrEqual(1);
      expect(Math.abs(toggle.y + toggle.height / 2 - 20)).toBeLessThanOrEqual(1);
    };
    const main = await box(tid(page, "main"));
    await check(main.x + main.width);
    await page.keyboard.press("Meta+j");
    await expect(tid(page, "changes-panel")).toHaveCount(1);
    const panel = await box(tid(page, "changes-panel"));
    await check(panel.x);
    expect((await box(page.locator('[data-testid="changes-panel"] > header'))).height).toBe(42);
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe("dark");
    await changesHidden();
  });
});

test.describe("Terminal · title bar and panel", () => {
  // No reference shows a terminal; the gate keeps it from disturbing what the references do fix.
  test("the toggle sits one 34 px step left of ⋯; the open panel spans the main pane under the composer", async () => {
    await changesHidden();
    const more0 = await box(tid(page, "thread-menu-toggle"));
    const changes0 = await box(tid(page, "changes-toggle"));
    const toggle = tid(page, "terminal-toggle");
    const t = await box(toggle);
    expect(Math.abs(more0.x + more0.width / 2 - (t.x + t.width / 2) - 34)).toBeLessThanOrEqual(1);
    expect(Math.abs(t.y + t.height / 2 - 20)).toBeLessThanOrEqual(1);

    await page.keyboard.press("Control+Backquote");
    const panel = tid(page, "terminal-panel");
    await expect(panel).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    const main = await box(tid(page, "main"));
    // The panel enters with a 180 ms rise (v0.0.3), so its bottom edge sits a few px low until the
    // animation ends; CI measured 2–3 px on a slow runner. Wait for it to settle against the pane.
    await expect.poll(async () => { const p = await box(panel); return Math.abs(p.y + p.height - (main.y + main.height)); }).toBeLessThanOrEqual(1);
    const p = await box(panel);
    expect(Math.abs(p.x - main.x) + Math.abs(p.x + p.width - (main.x + main.width))).toBeLessThanOrEqual(2);
    const c = await box(tid(page, "composer-box"));
    expect(Math.round(c.width)).toBe(736);
    expect(c.y + c.height).toBeLessThanOrEqual(p.y);
    // The title bar's right-hand controls do not move.
    for (const [id, before] of [["thread-menu-toggle", more0], ["changes-toggle", changes0]] as const) {
      const after = await box(tid(page, id));
      expect(Math.abs(after.x - before.x) + Math.abs(after.y - before.y)).toBeLessThanOrEqual(1);
    }
    await capture("terminal-open");

    // With Changes open too, the panel stays in the main pane, left of the Changes panel.
    await page.keyboard.press("Meta+j");
    await expect(tid(page, "changes-panel")).toHaveCount(1);
    const changesPanel = await box(tid(page, "changes-panel"));
    const p2 = await box(panel);
    expect(p2.x + p2.width).toBeLessThanOrEqual(changesPanel.x + 1);
    await capture("terminal-open-changes");

    await page.keyboard.press("Control+Backquote");
    await expect(panel).toHaveCount(0);
    await changesHidden();
  });
});

test.describe("Phase 5 · draft", () => {
  // Reference #1: "What should we build in coven-threads?" at 28/400, ink y 481–505, centred in the main pane.
  test("draft heading is 28 px regular text-1, centred in the main pane at the reference height", async () => {
    await page.keyboard.press("Meta+n");
    await expect(tid(page, "draft-view")).toBeVisible();
    const h = tid(page, "draft-title");
    expect(await css(h, "font-size")).toBe("28px");
    expect(await css(h, "font-weight")).toBe("400");
    expect(await css(h, "color")).toBe("rgb(238, 242, 247)");
    expect(await css(tid(page, "draft-project"), "text-decoration-style")).toBe("dotted");
    const b = await box(h);
    const m = await box(tid(page, "main"));
    expect(Math.abs(b.x + b.width / 2 - (m.x + 1 + (m.width - 1) / 2))).toBeLessThanOrEqual(2);
    // Reference ink centre y 493; with a 34 px line box the box centre sits 4 px above the ink centre.
    expect(Math.abs(b.y + b.height / 2 - 489)).toBeLessThanOrEqual(2);
  });
});
