import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { test } from "node:test";
import { RestartAdmission } from "../src/main/engine/restart-admission.js";

/** Execute the actual native host startup/menu implementation with inert host,
 * discovery and dialog boundaries. No listeners, credentials or windows open. */
function harness(discover: Promise<string>) {
  const source = fs.readFileSync(path.resolve(import.meta.dirname, "../src/main/index.js"), "utf8");
  const begin = source.indexOf("let startingDesktopHost"), end = source.indexOf('app.on("second-instance"', begin);
  assert.ok(begin >= 0 && end > begin);
  const observed = { constructed: 0, started: 0, disposed: 0, invited: 0, menu: [] as any[], options: null as any };
  let resolveDialog!: (value: { response: number }) => void;
  const context: any = { demo: false, desktopHost: undefined, home: "/fixture", app: { isPackaged: true, getVersion: () => "0.0.10" },
    process: { platform: "darwin", env: {} }, path, desktopSystem: () => discover, desktopCommands: new Map(),
    restartAdmission: new RestartAdmission(), shuttingDown: false, checkingWindowClose: false, nativeDraftFailure: undefined, nativeStartup: undefined, servicesTouched: false,
    win: { isDestroyed: () => false, show() {}, focus() {} },
    DesktopHost: class { constructor(_home: string, options: any) { observed.constructed++; observed.options = options; } async start() { observed.started++; } async dispose() { observed.disposed++; } invite() { observed.invited++; return "fixture-invite"; } clients() { return []; } },
    Menu: { getApplicationMenu: () => ({ append: (menu: any) => observed.menu.push(menu) }), setApplicationMenu() {} }, MenuItem: class { constructor(options: any) { return options; } },
    dialog: { showMessageBox: () => new Promise(resolve => { resolveDialog = resolve; }), showErrorBox() {} }, clipboard: { writeText() {} }, console: { warn() {}, error() {} },
  };
  vm.createContext(context); vm.runInContext(source.slice(begin, end) + "\nglobalThis.start = startDesktopHost;", context);
  return { context, observed, finishDialog: () => resolveDialog({ response: 1 }) };
}
test("direct desktop host startup owns admission before its discovery await", async () => {
  let finish!: (value: string) => void;
  const h = harness(new Promise(resolve => { finish = resolve; }));
  const starting = h.context.start(); void starting.catch(() => {});
  try { assert.throws(() => h.context.restartAdmission.holdForRestart(), /finish/i); }
  finally { finish("/fixture"); await starting; }
  assert.equal(h.observed.started, 1);
});
test("a recovery transition during discovery cannot publish a desktop host", async () => {
  let finish!: (value: string) => void;
  const h = harness(new Promise(resolve => { finish = resolve; }));
  const starting = h.context.start(); void starting.catch(() => {});
  h.context.nativeStartup = { recovery: { message: "recover" } }; finish("/fixture");
  await assert.rejects(starting, /recovery|unavailable/i);
  assert.equal(h.observed.constructed, 0); assert.equal(h.observed.menu.length, 0);
});
test("ordinary Quit disposal during host discovery prevents a new host", async () => {
  let finish!: (value: string) => void;
  const h = harness(new Promise(resolve => { finish = resolve; }));
  const starting = h.context.start(); void starting.catch(() => {});
  h.context.servicesTouched = true; finish("/fixture");
  await assert.rejects(starting, /recovery|unavailable/i);
  assert.equal(h.observed.constructed, 0); assert.equal(h.observed.menu.length, 0);
});
test("native pairing dialogs own admission and recheck recovery before accepting", async () => {
  const h = harness(Promise.resolve("/fixture")); await h.context.start();
  const pending = h.observed.options.authorize("123456", new AbortController().signal); void pending.catch(() => {});
  try { assert.throws(() => h.context.restartAdmission.holdForRestart(), /finish/i); }
  finally { h.context.nativeStartup = { recovery: {} }; h.finishDialog(); }
  await assert.rejects(pending, /recovery|unavailable/i);
});
test("native pairing menu work is fenced during its dialog", async () => {
  const h = harness(Promise.resolve("/fixture")); await h.context.start();
  h.observed.menu[0].submenu[0].click();
  try { assert.throws(() => h.context.restartAdmission.holdForRestart(), /finish/i); }
  finally { h.context.nativeStartup = { recovery: {} }; h.finishDialog(); }
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(h.observed.invited, 0);
});
