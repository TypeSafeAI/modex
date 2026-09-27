import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_LAYOUT, LAYOUT_KEY, LEGACY_SIDEBAR_KEY, loadLayout, saveLayout } from "../src/shared/layout.js";
import { DEFAULT_SIZE, initialBounds, readWindowState, WINDOW_STATE_FILE, writeWindowState } from "../src/main/engine/window-state.js";

const memory = (init: Record<string, string> = {}) => {
  const m = new Map(Object.entries(init));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
};

test("layout: defaults, round trip, and bad data falls back per field", () => {
  const s = memory();
  assert.deepEqual(loadLayout(s), DEFAULT_LAYOUT);
  saveLayout(s, { sidebar: false, changes: false });
  assert.deepEqual(loadLayout(s), { sidebar: false, changes: false });
  assert.deepEqual(loadLayout(memory({ [LAYOUT_KEY]: "{not json" })), DEFAULT_LAYOUT);
  assert.deepEqual(loadLayout(memory({ [LAYOUT_KEY]: JSON.stringify({ changes: "no", sidebar: false }) })), { sidebar: false, changes: true });
});

test("layout: migrates the old sidebar key, and the new key wins once written", () => {
  assert.deepEqual(loadLayout(memory({ [LEGACY_SIDEBAR_KEY]: "closed" })), { sidebar: false, changes: true });
  assert.deepEqual(loadLayout(memory({ [LEGACY_SIDEBAR_KEY]: "open" })), DEFAULT_LAYOUT);
  const s = memory({ [LEGACY_SIDEBAR_KEY]: "closed" });
  saveLayout(s, { ...loadLayout(s), sidebar: true });
  assert.equal(loadLayout(s).sidebar, true);
});

const display = { x: 0, y: 0, width: 1728, height: 1079 };
const min = { width: 900, height: 600 };

test("window state: saved bounds are restored on a display that still shows them", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "modex-ws-"));
  assert.equal(readWindowState(home), null);
  writeWindowState(home, { x: 100, y: 60, width: 1200, height: 800, maximized: true, fullscreen: false });
  const saved = readWindowState(home);
  assert.deepEqual(saved, { x: 100, y: 60, width: 1200, height: 800, maximized: true, fullscreen: false });
  assert.deepEqual(initialBounds(saved, [display], min), { x: 100, y: 60, width: 1200, height: 800 });
  // A window on a second display to the right.
  assert.deepEqual(initialBounds({ ...saved!, x: 2000 }, [display, { x: 1728, y: 0, width: 2560, height: 1415 }], min), { x: 2000, y: 60, width: 1200, height: 800 });
});

test("window state: no file, corrupt file, or an unplugged display falls back to the default size, unpositioned", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "modex-ws-"));
  fs.writeFileSync(path.join(home, WINDOW_STATE_FILE), "{");
  assert.equal(readWindowState(home), null);
  fs.writeFileSync(path.join(home, WINDOW_STATE_FILE), JSON.stringify({ x: "1", y: 0, width: 10, height: 10 }));
  assert.equal(readWindowState(home), null);
  assert.deepEqual(initialBounds(null, [display], min), DEFAULT_SIZE);
  const offscreen = { x: 3000, y: 200, width: 1000, height: 700, maximized: false, fullscreen: false };
  const b = initialBounds(offscreen, [display], min);
  assert.equal(b.x, undefined);
  assert.deepEqual(b, { width: 1000, height: 700 });
  // Title bar above the top of the screen is also stranded.
  assert.equal(initialBounds({ ...offscreen, x: 100, y: -500 }, [display], min).x, undefined);
});

test("window state: size is clamped to the display and to the minimum", () => {
  const huge = { x: 0, y: 0, width: 4000, height: 3000, maximized: false, fullscreen: false };
  assert.deepEqual(initialBounds(huge, [display], min), { x: 0, y: 0, width: 1728, height: 1079 });
  assert.deepEqual(initialBounds({ ...huge, width: 300, height: 200 }, [display], min), { x: 0, y: 0, width: 900, height: 600 });
});
