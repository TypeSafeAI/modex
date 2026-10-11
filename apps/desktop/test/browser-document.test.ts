import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import ts from "typescript";

// Run the production main-process classes without launching Electron. The guest executes
// the exact serialized scripts in a separate world; real Chromium races live in e2e.
function load(name: string, electron: object, dependencies: Record<string, unknown> = {}) {
  const filename = new URL(`../src/main/${name}.js`, import.meta.url);
  const source = readFileSync(filename, "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: Record<string, any> = {};
  vm.runInNewContext(`(function(require,exports){${code}\n})`, { process, URL, AbortController })(
    (id: string) => id === "electron" ? electron : dependencies[id] ?? createRequire(filename)(id), exports);
  return exports;
}
function world() {
  const navigation = new EventTarget(), window = new EventTarget() as any;
  window.top = window; window.navigation = navigation;
  const location = { href: "https://example.test/first", origin: "https://example.test", protocol: "https:" };
  let writes = 0, events = 0;
  class Input {
    disabled = false; readOnly = false; form = null; stored = "";
    constructor(public type: string, public autocomplete: string) {}
    getClientRects() { return [{}]; }
    get value() { return this.stored; }
    set value(value: string) { writes++; this.stored = value; }
    dispatchEvent() { events++; return true; }
  }
  const inputs = [new Input("text", "username"), new Input("password", "current-password")];
  const document = { querySelectorAll: () => inputs, activeElement: null };
  const context = vm.createContext({ window, navigation, location, document, HTMLInputElement: Input, getComputedStyle: () => ({ visibility: "visible" }), Event, URL });
  return { context, navigation, window, location, counts: () => ({ writes, events }), values: () => inputs.map(i => i.value) };
}
function fixture() {
  const guest = world();
  const frame = (id: number, parent: any = null): any => ({ frameTreeNodeId: id, url: "https://example.test/first", parent, top: parent?.top, isDestroyed: () => false });
  const main = frame(1); main.top = main;
  const contents = new EventEmitter() as any;
  let dead = false, loading = false;
  Object.assign(contents, { mainFrame: main, getURL: () => guest.location.href, isDestroyed: () => dead, isLoadingMainFrame: () => loading, isLoading: () => loading,
    executeJavaScriptInIsolatedWorld: async (_world: number, scripts: { code: string }[]) => vm.runInContext(scripts[0]!.code, guest.context),
    session: Object.assign(new EventEmitter(), { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} }),
    setWindowOpenHandler() {}, loadURL: async () => {}, getTitle: () => "fixture", navigationHistory: { canGoBack: () => false, canGoForward: () => false }, close: () => { dead = true; contents.emit("destroyed"); },
  });
  const window = Object.assign(new EventEmitter(), { isDestroyed: (): boolean => false, contentView: { addChildView() {}, removeChildView() {} } });
  const electron = { WebContentsView: class { webContents = contents; setBackgroundColor() {} setVisible() {} } };
  const browser = new (load("workspace-browser", electron).WorkspaceBrowser)(window);
  const start = async () => { await browser.command("fixture", "navigate", guest.location.href); };
  const navigate = (target = main, url = "https://example.test/second") => { contents.emit("did-start-navigation", { frame: target, isMainFrame: target === main, isSameDocument: true }, url, true, target === main); target.url = url; if (target === main) guest.location.href = url; };
  return { browser, guest, contents, main, frame, window, start, navigate, setLoading: (value: boolean) => { loading = value; }, destroy: () => { dead = true; contents.emit("destroyed"); } };
}
const fields = { username: "synthetic-user", password: "synthetic-secret" };

test("loading main documents are refused before any isolated script or vault read", async () => {
  const f = fixture(); await f.start(); f.setLoading(true);
  let scripts = 0; f.contents.executeJavaScriptInIsolatedWorld = async () => { scripts++; return true; };
  await assert.rejects(async () => f.browser.credentialTarget("fixture"), /loading|page changed/i);
  assert.equal(scripts, 0);
});

test("document preparation queued into a replacement document fails before vault access", async () => {
  const f = fixture(); await f.start();
  const run = f.contents.executeJavaScriptInIsolatedWorld;
  let first = true;
  f.contents.executeJavaScriptInIsolatedWorld = async (...args: any[]) => { if (first) { first = false; f.navigate(); } return run(...args); };
  await assert.rejects(async () => f.browser.credentialTarget("fixture"), /page changed/i);
  assert.deepEqual(f.guest.counts(), { writes: 0, events: 0 });
});

test("a prepared request is consumed once and old cleanup cannot cancel a newer request", async () => {
  const f = fixture(); await f.start();
  const old = await f.browser.credentialTarget("fixture");
  const target = await f.browser.credentialTarget("fixture");
  assert.equal(await old.fill(fields), false);
  await old.dispose();
  assert.equal(await target.fill(fields), true);
  assert.equal(await target.fill(fields), false);
  assert.deepEqual(f.guest.counts(), { writes: 2, events: 4 });
  await target.dispose();
});

for (const change of ["replacement", "navigate-back", "pagehide", "missing", "disposed"]) test(`isolated request fails closed after ${change}`, async () => {
  const f = fixture(); await f.start();
  const target = await f.browser.credentialTarget("fixture");
  if (change === "replacement") vm.runInContext("document = { querySelectorAll: document.querySelectorAll }", f.guest.context);
  if (change === "navigate-back") { f.guest.navigation.dispatchEvent(new Event("navigate")); f.guest.location.href = "https://example.test/away"; f.guest.location.href = target.url; }
  if (change === "pagehide") f.guest.window.dispatchEvent(new Event("pagehide"));
  if (change === "missing") vm.runInContext("delete globalThis.modexCredentialRequest", f.guest.context);
  if (change === "disposed") await target.dispose();
  assert.equal(await target.fill(fields), false);
  assert.deepEqual(f.guest.counts(), { writes: 0, events: 0 });
});

test("preparation fails closed without the Navigation API", async () => {
  const f = fixture(); await f.start(); delete f.guest.window.navigation;
  await assert.rejects(async () => f.browser.credentialTarget("fixture"), /page changed/i);
});

for (const who of ["self", "ancestor", "sibling", "unknown", "destroy", "close"]) test(`frame guard handles ${who} navigation monotonically and releases tracking`, async () => {
  const f = fixture(); await f.start();
  const parent = f.frame(2, f.main), child = f.frame(3, parent), sibling = f.frame(4, f.main);
  const guard = f.browser.frameGuard(child);
  assert.equal(guard(), true);
  if (who === "destroy") child.isDestroyed = () => true;
  else if (who === "close") f.browser.close("fixture");
  else if (who === "unknown") f.contents.emit("did-start-navigation", { frame: null, isMainFrame: false }, "https://example.test/away", true, false);
  else {
    const changed = who === "self" ? child : who === "ancestor" ? parent : sibling;
    f.navigate(changed); f.navigate(changed, "https://example.test/first");
  }
  assert.equal(guard(), who === "sibling");
  guard.dispose();
  assert.equal(guard(), false);
  assert.equal(f.browser.views.get("fixture")?.frameNavigations.size ?? 0, 0);
});

test("Touch ID stays disabled without inspecting codesign or activating the authenticator", () => {
  let configured = 0;
  const profile = Object.assign(new EventEmitter(), { extensions: {} });
  const electron = { app: { isPackaged: true, configureWebAuthn: () => { configured++; }, getPath: () => "/not/a/signed/app" }, systemPreferences: { canPromptTouchID: () => true }, session: { fromPartition: () => profile } };
  const tools = new (load("browser-tools", electron, { "node:child_process": { spawnSync: () => ({ status: 0, stderr: "TeamIdentifier=9LR8Z8UQ9X", stdout: "<string>9LR8Z8UQ9X.ai.typesafe.modex.webauthn</string>" }) } }).BrowserTools)("/tmp/modex-browser-document-unused", () => null);
  assert.equal(tools.snapshot().touchID, false);
  assert.equal(configured, 0);
});

test("default entitlement contains no deferred WebAuthn keychain group", () => {
  const plist = readFileSync(new URL("../../build/entitlements.mac.plist", import.meta.url), "utf8");
  assert.equal(plist.includes("keychain-access-groups"), false);
});

for (const outcome of ["success", "cancel", "error", "self", "ancestor", "sibling", "close", "destroy", "window"]) test(`deferred passkey chooser ${outcome} invokes its callback exactly once`, async () => {
  const f = fixture(); await f.start();
  const parent = f.frame(2, f.main), child = f.frame(3, parent), sibling = f.frame(4, f.main);
  let resolve!: (value: { response: number }) => void, reject!: (error: Error) => void;
  const answer = new Promise<{ response: number }>((yes, no) => { resolve = yes; reject = no; });
  const profile = Object.assign(new EventEmitter(), { extensions: {} });
  const electron = { app: { isPackaged: false }, session: { fromPartition: () => profile }, dialog: { showMessageBox: () => answer } };
  new (load("browser-tools", electron).BrowserTools)("/tmp/modex-browser-document-unused", () => ({ window: f.window, browser: f.browser }));
  const results: (string | undefined)[] = [];
  profile.emit("select-webauthn-account", {}, { frame: child, relyingPartyId: "example.test", accounts: [{ credentialId: "credential", name: "Fixture" }] }, (selected?: string) => results.push(selected));
  if (outcome === "self" || outcome === "ancestor" || outcome === "sibling") {
    const changed = outcome === "self" ? child : outcome === "ancestor" ? parent : sibling;
    f.navigate(changed); f.navigate(changed, "https://example.test/first");
  }
  if (outcome === "close") f.browser.close("fixture");
  if (outcome === "destroy") child.isDestroyed = () => true;
  if (outcome === "window") f.window.isDestroyed = () => true;
  if (outcome === "error") reject(new Error("synthetic native error")); else resolve({ response: outcome === "cancel" ? 0 : 1 });
  await new Promise(done => setImmediate(done));
  assert.deepEqual(results, [outcome === "success" || outcome === "sibling" ? "credential" : undefined]);
  assert.equal(f.browser.views.get("fixture")?.frameNavigations.size ?? 0, 0);
});

test("credential preparation holds the busy gate before awaiting and releases it on failure", async () => {
  let reject!: (error: Error) => void;
  const pending = new Promise((_yes, no) => { reject = no; });
  const profile = Object.assign(new EventEmitter(), { extensions: {} });
  const electron = { app: { isPackaged: false }, session: { fromPartition: () => profile } };
  const tools = new (load("browser-tools", electron).BrowserTools)("/tmp/modex-browser-document-unused", () => ({ window: {}, browser: { credentialTarget: () => pending } }));
  const first = tools.fill("fixture");
  const firstResult = assert.rejects(first, /page changed/);
  await assert.rejects(tools.fill("fixture"), /already in progress/);
  reject(new Error("The page changed."));
  await firstResult;
  await assert.rejects(tools.fill("fixture"), /page changed/);
});

test("opening the system browser uses the tab URL without preparing a credential request", async () => {
  const opened: string[] = [];
  const profile = Object.assign(new EventEmitter(), { extensions: {} });
  const electron = { session: { fromPartition: () => profile }, shell: { openExternal: async (url: string) => { opened.push(url); } } };
  const tools = new (load("browser-tools", electron).BrowserTools)("/tmp/modex-browser-document-unused", () => ({ browser: {
    tabURL: () => "https://example.test/loading", credentialTarget: () => { throw new Error("must not prepare"); },
  } }));
  await tools.external("fixture");
  assert.deepEqual(opened, ["https://example.test/loading"]);
});

test("credential cleanup does not wait for a native script that cannot complete", async () => {
  const f = fixture(); await f.start();
  const target = await f.browser.credentialTarget("fixture");
  f.contents.executeJavaScriptInIsolatedWorld = () => new Promise(() => {});
  let settled = false;
  void Promise.resolve(target.dispose()).then(() => { settled = true; });
  await new Promise(done => setImmediate(done));
  assert.equal(settled, true);
  assert.equal(target.isCurrent(), false);
});

test("stale credential cleanup never dispatches into a loading or lost document", async () => {
  const f = fixture(); await f.start();
  const target = await f.browser.credentialTarget("fixture");
  f.navigate(); f.setLoading(true);
  let scripts = 0;
  f.contents.executeJavaScriptInIsolatedWorld = async () => { scripts++; return true; };
  await target.dispose();
  assert.equal(scripts, 0);
});

for (const phase of ["owner", "frame", "url", "guard", "accounts", "cleanup", "callback"]) test(`passkey chooser ${phase} exception completes its callback exactly once`, async () => {
  const f = fixture(); await f.start();
  const child = f.frame(2, f.main);
  const fail = () => { throw new Error("Synthetic disposed-frame error"); };
  const details: any = { frame: child, relyingPartyId: "example.test", accounts: [{ credentialId: "credential", name: "Fixture" }] };
  if (phase === "frame") Object.defineProperty(details, "frame", { get: fail });
  if (phase === "url") Object.defineProperty(child, "url", { get: fail });
  if (phase === "guard") f.browser.frameGuard = fail;
  if (phase === "accounts") Object.defineProperty(details, "accounts", { get: fail });
  if (phase === "cleanup") f.browser.frameGuard = () => Object.assign(() => true, { dispose: fail });
  const profile = Object.assign(new EventEmitter(), { extensions: {} });
  const electron = { session: { fromPartition: () => profile }, dialog: { showMessageBox: async () => ({ response: 1 }) } };
  new (load("browser-tools", electron).BrowserTools)("/tmp/modex-browser-document-unused", () => phase === "owner" ? fail() : { window: f.window, browser: f.browser });
  const results: (string | undefined)[] = [];
  assert.doesNotThrow(() => profile.emit("select-webauthn-account", {}, details, (selected?: string) => { results.push(selected); if (phase === "callback") fail(); }));
  await new Promise(done => setImmediate(done));
  assert.deepEqual(results, [phase === "callback" ? "credential" : undefined]);
  assert.equal(f.browser.views.get("fixture")?.frameNavigations.size ?? 0, 0);
});

for (const phase of ["child-url", "child-parent", "ancestor-url", "ancestor-parent"]) test(`frame guard releases partial registration after ${phase} getter throws`, async () => {
  const f = fixture(); await f.start();
  const parent = f.frame(2, f.main), child = f.frame(3, parent);
  const target = phase.startsWith("child") ? child : parent;
  Object.defineProperty(target, phase.endsWith("url") ? "url" : "parent", { get: () => { throw new Error("Synthetic disposed-frame error"); } });
  const guard = f.browser.frameGuard(child);
  assert.equal(guard(), false);
  guard.dispose();
  assert.equal(f.browser.views.get("fixture").frameNavigations.size, 0);
});
