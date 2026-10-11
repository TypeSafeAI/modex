import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { appDir, launch, seedHome } from "./support";

let app: ElectronApplication, page: Page, home: string, repo: string;
const fixtureValues = { username: "document-fixture-user", password: "document-fixture-secret" };

test.beforeEach(async () => {
  ({ home, repo } = seedHome());
  const bin = path.join(home, "bin"); fs.mkdirSync(bin);
  const login = { id: "a".repeat(26), title: "Fixture login", category: "LOGIN", vault: { id: "b".repeat(26) }, urls: [{ href: "https://example.test" }], fields: [{ purpose: "USERNAME", value: fixtureValues.username }, { purpose: "PASSWORD", value: fixtureValues.password }] };
  fs.writeFileSync(path.join(bin, "op"), `#!/bin/sh\nprintf 'read\\n' >> '${home}/op-reads'\ncase "$2" in\nlist) cat <<'JSON'\n${JSON.stringify([login])}\nJSON\n;;\nget) cat <<'JSON'\n${JSON.stringify(login)}\nJSON\n;;\nesac\n`, { mode: 0o700 });
  ({ app, page } = await launch(home));
  await app.evaluate(async ({ BrowserWindow, session, dialog }, { browserModule, bin, home }) => {
    const require = process.getBuiltinModule("node:module").createRequire(browserModule);
    const { WorkspaceBrowser } = require("./workspace-browser.js");
    const { BrowserTools } = require("./browser-tools.js");
    const window = BrowserWindow.getAllWindows()[0]!;
    const profile = session.fromPartition("persist:modex-workspace-browser");
    profile.removeAllListeners("select-webauthn-account");
    const fixture: any = { profile, window, held: false };
    (globalThis as any).__browserDocument = fixture;
    profile.protocol.handle("https", request => {
      const url = new URL(request.url);
      if (url.pathname === "/resource") return new Promise<Response>(resolve => { fixture.releaseResource = () => resolve(new Response("", { headers: { "content-type": "image/png" } })); });
      const frames = url.pathname === "/frames" ? '<iframe name="parent" src="/parent"></iframe><iframe name="sibling" src="/sibling"></iframe>' : url.pathname === "/parent" ? '<iframe name="child" src="/child"></iframe>' : "";
      const held = fixture.held && url.pathname === "/first" ? '<img src="/resource">' : "";
      return new Response(`<title>Credential document fixture</title><form><input autocomplete="username"><input type="password" autocomplete="current-password"><button>Sign in</button></form>${frames}${held}<script>window.writes=0;window.events=0;window.submitted=false;const original=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value');Object.defineProperty(HTMLInputElement.prototype,'value',{...original,set(value){window.writes++;original.set.call(this,value)}});document.addEventListener('input',()=>window.events++);document.addEventListener('change',()=>window.events++);document.querySelector('form').onsubmit=e=>{e.preventDefault();window.submitted=true};</script>`, { headers: { "content-type": "text/html" } });
    });
    fixture.browser = new WorkspaceBrowser(window);
    fixture.tools = new BrowserTools(home, () => ({ window, browser: fixture.browser }));
    process.env.PATH = `${bin}:/usr/bin:/bin`;
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    await fixture.browser.command("document", "navigate", "https://example.test/first");
    fixture.contents = [...fixture.browser.views.values()][0].view.webContents;
  }, { browserModule: pathToFileURL(path.join(appDir, "dist/src/main/workspace-browser.js")).href, bin, home });
  await loaded();
});
test.afterEach(async () => {
  await app?.evaluate(() => { const f = (globalThis as any).__browserDocument; f?.releaseResource?.(); f?.browser.dispose(); }).catch(() => {});
  await app?.close();
  fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(repo, { recursive: true, force: true });
});
async function loaded(url = "https://example.test/first") {
  await expect.poll(() => app.evaluate(() => { const c = (globalThis as any).__browserDocument.contents; return { url: c.getURL(), loading: c.isLoadingMainFrame() }; })).toEqual({ url, loading: false });
}
async function untouched() {
  expect(await app.evaluate(() => (globalThis as any).__browserDocument.contents.executeJavaScript('[document.querySelector("input").value,document.querySelector("input[type=password]").value,window.events,window.submitted]'))).toEqual(["", "", 0, false]);
}

test("loading /first refuses preparation before fake op reads; /second receives no credentials", async () => {
  await app.evaluate(async () => { const f = (globalThis as any).__browserDocument; f.held = true; f.contents.reload(); });
  await expect.poll(() => app.evaluate(() => Boolean((globalThis as any).__browserDocument.releaseResource))).toBe(true);
  expect(await app.evaluate(async () => { const f = (globalThis as any).__browserDocument; try { await f.tools.fill("document"); return "filled"; } catch { return "cancelled"; } })).toBe("cancelled");
  expect(fs.existsSync(path.join(home, "op-reads"))).toBe(false);
  await app.evaluate(async () => { const f = (globalThis as any).__browserDocument; void f.contents.loadURL("https://example.test/second").catch(() => {}); });
  await loaded("https://example.test/second");
  await app.evaluate(() => (globalThis as any).__browserDocument.releaseResource());
  await untouched();
});

test("a fill queued behind a held /first resource cannot write into same-origin /second", async () => {
  await app.evaluate(async (_, fields) => {
    const f = (globalThis as any).__browserDocument;
    f.target = await f.browser.credentialTarget("document");
    const execute = f.contents.executeJavaScriptInIsolatedWorld.bind(f.contents);
    f.contents.executeJavaScriptInIsolatedWorld = async (world: number, scripts: any[]) => {
      f.contents.executeJavaScriptInIsolatedWorld = execute;
      f.held = true;
      const ready = new Promise<void>(resolve => f.contents.once("dom-ready", () => resolve()));
      void f.contents.loadURL("https://example.test/first").catch(() => {});
      await ready;
      return execute(world, scripts);
    };
    f.pending = f.target.fill(fields);
  }, fixtureValues);
  await expect.poll(() => app.evaluate(() => Boolean((globalThis as any).__browserDocument.releaseResource))).toBe(true);
  await app.evaluate(() => { const f = (globalThis as any).__browserDocument; void f.contents.loadURL("https://example.test/second").catch(() => {}); });
  await loaded("https://example.test/second");
  const filled = await app.evaluate(async () => { const f = (globalThis as any).__browserDocument; f.releaseResource(); const result = await f.pending; await f.target.dispose(); return result; });
  expect(filled).toBe(false); await untouched();
});

for (const navigation of ["reload", "cross-origin", "same-document", "close", "renderer-loss"]) test(`prepared credential request cancels on ${navigation}`, async () => {
  const result = await app.evaluate(async (_, { navigation, fields }) => {
    const f = (globalThis as any).__browserDocument, target = await f.browser.credentialTarget("document");
    if (navigation === "reload") await f.contents.loadURL("https://example.test/first");
    if (navigation === "cross-origin") await f.contents.loadURL("https://other.test/second");
    if (navigation === "same-document") await f.contents.executeJavaScript('history.pushState({},"","/away");history.replaceState({},"","/first")');
    if (navigation === "close") f.browser.close("document");
    if (navigation === "renderer-loss") { const gone = new Promise<void>(resolve => f.contents.once("render-process-gone", () => resolve())); f.contents.forcefullyCrashRenderer(); await gone; }
    const result = await target.fill(fields); await target.dispose(); return result;
  }, { navigation, fields: fixtureValues });
  expect(result).toBe(false);
  if (navigation !== "close" && navigation !== "renderer-loss") await untouched();
});

test("navigation during nonce initialization cancels before fake op reads", async () => {
  expect(await app.evaluate(async () => {
    const f = (globalThis as any).__browserDocument, execute = f.contents.executeJavaScriptInIsolatedWorld.bind(f.contents);
    f.contents.executeJavaScriptInIsolatedWorld = async (world: number, scripts: any[]) => {
      f.contents.executeJavaScriptInIsolatedWorld = execute;
      await f.contents.loadURL("https://example.test/first");
      return execute(world, scripts);
    };
    try { await f.tools.fill("document"); return "filled"; } catch { return "cancelled"; }
  })).toBe("cancelled");
  expect(fs.existsSync(path.join(home, "op-reads"))).toBe(false); await untouched();
});

test("matching document nonce succeeds once; wrong, missing, revoked and old cleanup never write", async () => {
  expect(await app.evaluate(async (_, fields) => {
    const f = (globalThis as any).__browserDocument;
    const results: boolean[] = [];
    for (const code of ['globalThis.modexCredentialRequest.token="wrong"', 'delete globalThis.modexCredentialRequest', 'globalThis.modexCredentialRequest.revoke()']) {
      const target = await f.browser.credentialTarget("document");
      await f.contents.executeJavaScriptInIsolatedWorld(1001, [{ code }]);
      results.push(await target.fill(fields)); await target.dispose();
    }
    const old = await f.browser.credentialTarget("document"), current = await f.browser.credentialTarget("document");
    results.push(await old.fill(fields)); await old.dispose();
    results.push(await current.fill(fields), await current.fill(fields)); await current.dispose();
    return results;
  }, fixtureValues)).toEqual([false, false, false, false, true, false]);
  expect(await app.evaluate(() => (globalThis as any).__browserDocument.contents.executeJavaScript('[document.querySelector("input").value,document.querySelector("input[type=password]").value,window.events,window.submitted,typeof window.modexCredentialRequest]'))).toEqual([fixtureValues.username, fixtureValues.password, 4, false, "undefined"]);
  await expect(page.locator("body")).not.toContainText(fixtureValues.password);
  expect(fs.readFileSync(path.join(home, "app/state.json"), "utf8")).not.toContain(fixtureValues.password);
});

test("deferred native chooser cancels initiating and ancestor navigation, close and destruction exactly once; siblings stay valid", async () => {
  for (const change of ["success", "cancel", "error", "self", "ancestor", "sibling", "destroy", "close"]) {
    const results = await app.evaluate(async ({ dialog }, change) => {
      const f = (globalThis as any).__browserDocument;
      await f.contents.loadURL("https://example.test/frames");
      const child = f.contents.mainFrame.framesInSubtree.find((frame: any) => frame.name === "child");
      const sibling = f.contents.mainFrame.framesInSubtree.find((frame: any) => frame.name === "sibling");
      if (!child || !sibling) throw new Error("Frame fixture not ready");
      let resolve!: (value: any) => void, reject!: (reason: Error) => void;
      dialog.showMessageBox = (() => new Promise((yes, no) => { resolve = yes; reject = no; })) as any;
      const results: (string | null)[] = [];
      f.profile.emit("select-webauthn-account", {}, { frame: child, relyingPartyId: "example.test", accounts: [{ credentialId: "fixture-account", name: "Fixture" }] }, (selected?: string) => results.push(selected ?? null));
      if (change === "self" || change === "ancestor" || change === "sibling") {
        const frame = change === "self" ? child : change === "ancestor" ? child.parent : sibling;
        await frame.executeJavaScript('(()=>{const original=location.href;history.pushState({},"","/away");history.replaceState({},"",original)})()');
      }
      if (change === "destroy") await child.parent.executeJavaScript('document.querySelector("iframe").remove()');
      if (change === "close") f.browser.close("document");
      if (change === "error") reject(new Error("Synthetic chooser exception")); else resolve({ response: change === "cancel" ? 0 : 1, checkboxChecked: false });
      await new Promise(done => setImmediate(done));
      return results;
    }, change);
    expect(results, change).toEqual([change === "success" || change === "sibling" ? "fixture-account" : null]);
  }
});

test("navigation to a held page cancels the chooser and releases the 1Password busy gate", async () => {
  await app.evaluate(({ dialog }) => {
    const f = (globalThis as any).__browserDocument;
    dialog.showMessageBox = (() => new Promise(resolve => { f.answer = () => resolve({ response: 0, checkboxChecked: false }); })) as any;
    f.pending = f.tools.fill("document").then(() => { f.settled = "filled"; }, () => { f.settled = "cancelled"; });
  });
  await expect.poll(() => app.evaluate(() => Boolean((globalThis as any).__browserDocument.answer))).toBe(true);
  await app.evaluate(() => { const f = (globalThis as any).__browserDocument; f.held = true; void f.contents.loadURL("https://example.test/first").catch(() => {}); });
  await expect.poll(() => app.evaluate(() => Boolean((globalThis as any).__browserDocument.releaseResource))).toBe(true);
  await app.evaluate(() => (globalThis as any).__browserDocument.answer());
  await expect.poll(() => app.evaluate(() => (globalThis as any).__browserDocument.settled), { timeout: 5_000 }).toBe("cancelled");
  expect(await app.evaluate(async () => { try { await (globalThis as any).__browserDocument.tools.fill("document"); return "filled"; } catch (error) { return (error as Error).message; } })).toMatch(/loading|page changed/i);
  expect(fs.readFileSync(path.join(home, "op-reads"), "utf8").trim().split("\n")).toEqual(["read"]);
});
