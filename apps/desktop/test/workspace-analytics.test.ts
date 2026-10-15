import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { EventEmitter } from "node:events";
import ts from "typescript";
import type { BrowserBounds } from "../src/shared/browser.js";

function fixture(theme?: () => string) {
  const navigations: (() => void)[] = [];
  const shown: (BrowserBounds | null)[] = [];
  let disposed = false;
  class Browser {
    async command(_id: string, action: string) {
      if (action === "navigate") await new Promise<void>(resolve => navigations.push(resolve));
      return {};
    }
    show(id: string | null, bounds?: BrowserBounds) { shown.push(id ? bounds! : null); }
    dispose() { disposed = true; }
  }
  const profile = Object.assign(new EventEmitter(), { protocol: { handle() {}, unhandle() {} }, webRequest: { onBeforeRequest() {} } });
  const source = readFileSync(new URL("../src/main/workspace-analytics.js", import.meta.url), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: Record<string, any> = {};
  const dependencies: Record<string, unknown> = {
    electron: { session: { fromPartition: () => profile } },
    "./workspace-browser.js": { WorkspaceBrowser: Browser },
    "./engine/analytics-assets.js": { ANALYTICS_ORIGIN: "modex-analytics://app", ANALYTICS_SCHEME: "modex-analytics", respondAnalytics() {} },
    "../shared/theme.js": { THEMES: { graphite: { background: "#0f0f11" }, jev: { background: "#0b0f1b" }, coven: { background: "#1c1b1d" } }, normalizeTheme: (value: unknown) => (value === "jev" || value === "coven" ? value : "graphite") },
  };
  vm.runInNewContext(`(function(require,exports){${code}\n})`)((id: string) => {
    assert.ok(id in dependencies, `Unexpected dependency: ${id}`);
    return dependencies[id];
  }, exports);
  const analytics = new exports.WorkspaceAnalytics({}, "/unused", {}, theme);
  return { analytics, navigations, shown, profile, isDisposed: () => disposed };
}
const bounds = { x: 0, y: 0, width: 640, height: 480 };

test("Analytics stays hidden when hide arrives during navigation", async () => {
  const f = fixture();
  const opening = f.analytics.show(bounds);
  await f.analytics.show();
  f.navigations[0]!();
  await opening;
  assert.deepEqual(f.shown, [null]);
});

test("Analytics never shows a disposed browser after navigation", async () => {
  const f = fixture();
  const opening = f.analytics.show(bounds);
  f.analytics.dispose();
  f.navigations[0]!();
  await opening;
  assert.equal(f.isDisposed(), true);
  assert.deepEqual(f.shown, []);
});

test("Analytics keeps the latest bounds when navigation finishes out of order", async () => {
  const f = fixture();
  const first = f.analytics.show(bounds);
  const latest = { ...bounds, width: 800 };
  const second = f.analytics.show(latest);
  f.navigations[1]!();
  await second;
  f.navigations[0]!();
  await first;
  assert.deepEqual(f.shown, [latest]);
});

test("Analytics can reopen after a hidden navigation completes", async () => {
  const f = fixture();
  const opening = f.analytics.show(bounds);
  await f.analytics.show();
  f.navigations[0]!();
  await opening;
  await f.analytics.show(bounds);
  assert.deepEqual(f.shown, [null, bounds]);
});

test("Analytics permits only its own CSV blob and removes its download policy on disposal", async () => {
  const f = fixture();
  const opening = f.analytics.show(bounds);
  f.navigations[0]!();
  await opening;
  const source = "modex-analytics://app/index.html";
  for (const [url, mime, filename, page, permitted] of [
    ["blob:modex-analytics://app/id", "text/csv", "modex-usage.csv", source, true],
    ["https://example.com/export.csv", "text/csv", "modex-usage.csv", source, false],
    ["blob:modex-analytics://other/id", "text/csv", "modex-usage.csv", source, false],
    ["blob:modex-analytics://app/id", "text/html", "modex-usage.csv", source, false],
    ["blob:modex-analytics://app/id", "text/csv", "other.csv", source, false],
    ["blob:modex-analytics://app/id", "text/csv", "modex-usage.csv", "https://example.com", false],
  ] as const) {
    let cancelled = false, configured = false;
    f.profile.emit("will-download", { preventDefault() { cancelled = true; } }, {
      getURL: () => url, getMimeType: () => mime, getFilename: () => filename,
      setSaveDialogOptions() { configured = true; },
    }, { isDestroyed: () => false, getURL: () => page });
    assert.equal(cancelled, !permitted, url);
    assert.equal(configured, permitted);
  }
  f.analytics.dispose();
  assert.equal(f.profile.listenerCount("will-download"), 0);
});

test("Analytics wears the app's theme, and falls back to Graphite", () => {
  let theme = "jev";
  const { analytics } = fixture(() => theme);
  assert.equal(analytics.appearance().background, "#0b0f1b");
  assert.match(analytics.appearance().script, /dataset\.theme = "jev"/);
  theme = "coven";
  assert.match(analytics.appearance().script, /"coven"/, "a theme change is read when the view next styles");
  theme = "</script><script>alert(1)";
  assert.match(analytics.appearance().script, /"graphite"/, "an unknown theme never reaches the page");
  assert.equal(fixture().analytics.appearance().background, "#0f0f11");
});
