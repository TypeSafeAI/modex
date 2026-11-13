import { test, expect, type Locator } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { appDir, currentRow, items, launch, resizeWindow, seedHome, setTheme, tid } from "./support";

const fixture = JSON.parse(fs.readFileSync(path.join(appDir, "../../docs/reviews/2026-10-20-keyboard-voiceover/markdown-fixture.json"), "utf8"));

for (const theme of ["graphite", "jev", "coven"] as const) {
  test(`Markdown keyboard traversal and reduced motion in ${theme}`, async () => {
    const { home } = seedHome();
    const { app, page } = await launch(home);
    try {
      // Observe renderer delivery/cancellation; snapshot native focus on failure.
      // DOM focus alone does not explain a missing native scroll action.
      await page.evaluate(() => {
        const state = window as typeof window & { __markdownKeys?: unknown[] };
        const records: unknown[] = state.__markdownKeys = [];
        const record = (value: unknown) => { records.push(value); if (records.length > 200) records.shift(); };
        const scroll = (el: Element) => ({ tag: el.tagName, className: el.className, left: el.scrollLeft, width: el.clientWidth, scrollWidth: el.scrollWidth });
        for (const type of ["keydown", "keyup"] as const) document.addEventListener(type, event => {
          if (!["ArrowRight", "ArrowLeft", "Tab"].includes(event.key)) return;
          const target = event.target instanceof Element ? scroll(event.target) : null;
          // A later task observes cancellation after all capture/bubble listeners.
          setTimeout(() => record({ type, key: event.key, at: performance.now(), trusted: event.isTrusted, defaultPrevented: event.defaultPrevented,
            documentFocused: document.hasFocus(), visibility: document.visibilityState, target, active: document.activeElement && scroll(document.activeElement) }), 0);
        }, true);
        document.addEventListener("scroll", event => {
          if (event.target instanceof Element && event.target.matches(".md-table, pre.code")) record({ type: "scroll", at: performance.now(), target: scroll(event.target) });
        }, true);
      });
      await resizeWindow(app, page, 900, 600);
      await setTheme(page, theme);
      await page.emulateMedia({ reducedMotion: "reduce" });
      const script = path.join(home, "markdown.json");
      fs.writeFileSync(script, JSON.stringify([fixture]));
      await page.evaluate(mock_script => window.modex!.invoke("settings:update", { mock_script }), script);
      await page.keyboard.press("Meta+n");
      await tid(page, "composer-input").fill("Review Markdown");
      await page.keyboard.press("Meta+Enter");
      await expect(currentRow(page)).toHaveAttribute("data-status", "idle");
      const answer = items(page, "assistant");
      const link = answer.getByRole("link", { name: "Review link", exact: true });
      const table = answer.locator(".md-table");
      const evidence = answer.getByRole("link", { name: "Evidence link", exact: true });
      const copy = tid(answer, "code-copy");
      const code = answer.locator("pre.code");
      const end = answer.getByRole("link", { name: "End link", exact: true });
      // The scripted reply streams. Wait for its final element before testing the settled
      // tab order; an initially idle row can be observed before the turn starts.
      await expect(end).toBeVisible();
      await expect(currentRow(page)).toHaveAttribute("data-status", "idle");
      const stops = [link, table, evidence, copy, code, end];
      const focused = async (stop: Locator) => {
        await expect(stop, `active element: ${await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 400))}`).toBeFocused();
        expect(await stop.evaluate(el => {
          const s = getComputedStyle(el);
          return el.matches(":focus-visible") && s.outlineStyle !== "none" && parseFloat(s.outlineWidth) >= 2 && s.outlineColor !== "rgba(0, 0, 0, 0)";
        }), "keyboard focus has a visible ring").toBe(true);
      };
      // Establish the start, then use real Tab/Shift-Tab for every transition (including the
      // table containing a link: Chromium does not automatically tab to that scroll container).
      await link.focus();
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Tab");
      await focused(link);
      for (const stop of stops.slice(1)) {
        await page.keyboard.press("Tab");
        await focused(stop);
        if (stop === table || stop === code) {
          expect(await stop.evaluate(el => el.scrollWidth - el.clientWidth)).toBeGreaterThan(100);
          const before = await stop.evaluate(el => el.scrollLeft);
          // Native keyboard scrolling can still be animating when scrollLeft first changes.
          // Complete that action before reversing; an opposite key at its completion boundary
          // can be lost even in a blank Electron window with no application handlers.
          const rightScroll = await stop.evaluateHandle(el => ({
            done: new Promise<void>(resolve => el.addEventListener("scrollend", () => {
              requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
            }, { once: true })),
          }));
          try {
            await page.keyboard.press("ArrowRight");
            await expect.poll(() => stop.evaluate(el => el.scrollLeft)).toBeGreaterThan(before);
            await rightScroll.evaluate(state => state.done);
          } finally { await rightScroll.dispose(); }
          await page.keyboard.press("ArrowLeft");
          await expect.poll(() => stop.evaluate(el => el.scrollLeft)).toBeLessThanOrEqual(before);
        }
        if (stop === copy) {
          await page.keyboard.press("Enter");
          await expect(copy).toHaveText("Copied");
          expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(fixture.content.split("```ts\n")[1].split("\n```")[0]);
          await focused(copy);
        }
      }
      for (const stop of stops.slice(0, -1).reverse()) {
        await page.keyboard.press("Shift+Tab");
        await focused(stop);
      }
      await expect(table).toHaveAccessibleName("Markdown table");
      await expect(code).toHaveAccessibleName("ts code");
      expect(await answer.evaluate(el => [el, ...el.querySelectorAll("*")].flatMap(node => {
        const s = getComputedStyle(node);
        return s.animationName !== "none" || s.transitionDuration.split(",").some(v => parseFloat(v) > 0) || s.scrollBehavior === "smooth" ? [node.tagName] : [];
      }))).toEqual([]);
      await expect(items(page, "tool")).toHaveCount(0);
      await expect(items(page, "approval")).toHaveCount(0);
    } catch (error) {
      // A stalled renderer must not prevent collecting native state or rethrowing
      // the original assertion. Keep both observations inside their own budget.
      const observe = async <T>(read: () => Promise<T>) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([Promise.resolve().then(read).catch(readError => ({ error: String(readError) })),
            new Promise<{ error: string }>(resolve => { timer = setTimeout(() => resolve({ error: "Diagnostic read exceeded 2000ms" }), 2000); })]);
        } finally { clearTimeout(timer); }
      };
      const [renderer, native] = await Promise.all([
        observe(() => page.evaluate(() => ({ records: (window as typeof window & { __markdownKeys?: unknown[] }).__markdownKeys,
          documentFocused: document.hasFocus(), visibility: document.visibilityState, active: document.activeElement?.outerHTML.slice(0, 800),
          scroll: [...document.querySelectorAll(".md-table, pre.code")].map(el => ({ tag: el.tagName, className: el.className, left: el.scrollLeft, width: el.clientWidth, scrollWidth: el.scrollWidth })) }))),
        observe(() => app.evaluate(({ BrowserWindow }) => ({ windows: BrowserWindow.getAllWindows().map(w => ({ id: w.id, focused: w.isFocused(), contentsFocused: w.webContents.isFocused(), visible: w.isVisible(), minimized: w.isMinimized(), bounds: w.getBounds() })) }))),
      ]);
      await observe(() => test.info().attach("markdown-keyboard-diagnostics", { body: JSON.stringify({ renderer, native }, null, 2), contentType: "application/json" }));
      throw error;
    } finally {
      await app.close();
    }
  });
}
