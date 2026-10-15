import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import type { BrowserBounds } from "../src/shared/browser.js";

function fixture() {
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
  const profile = { protocol: { handle() {}, unhandle() {} }, webRequest: { onBeforeRequest() {} } };
  const source = readFileSync(new URL("../src/main/workspace-analytics.js", import.meta.url), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: Record<string, any> = {};
  const dependencies: Record<string, unknown> = {
    electron: { session: { fromPartition: () => profile } },
    "./workspace-browser.js": { WorkspaceBrowser: Browser },
    "./engine/analytics-assets.js": { ANALYTICS_ORIGIN: "modex-analytics://app", ANALYTICS_SCHEME: "modex-analytics", respondAnalytics() {} },
  };
  vm.runInNewContext(`(function(require,exports){${code}\n})`)((id: string) => {
    assert.ok(id in dependencies, `Unexpected dependency: ${id}`);
    return dependencies[id];
  }, exports);
  const analytics = new exports.WorkspaceAnalytics({}, "/unused", {});
  return { analytics, navigations, shown, isDisposed: () => disposed };
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
