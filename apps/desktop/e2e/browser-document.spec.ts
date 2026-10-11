import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { appDir, launch, seedHome, tid } from "./support";

let app: ElectronApplication, page: Page, home: string, repo: string;
let heldMetadataCLI = false;
const fixtureValues = { username: "document-fixture-user", password: "document-fixture-secret" };

test.beforeEach(async () => {
  heldMetadataCLI = false;
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
async function prepareToClose() {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      app?.evaluate(async (_, { home, held }) => {
        const f = (globalThis as any).__browserDocument;
        const settled = Promise.resolve(f?.pending).catch(() => {});
        f?.releaseResource?.(); f?.browser.dispose();
        if (held) {
          process.getBuiltinModule("node:fs").writeFileSync(home + "/op-release", "release");
          await settled;
        }
        return "settled";
      }, { home, held: heldMetadataCLI }),
      new Promise<string>(resolve => { timer = setTimeout(() => resolve("timed-out"), 6_000); }),
    ]).catch(() => "app-closed");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    // Also release the child if Electron vanished before its cleanup evaluation ran.
    if (heldMetadataCLI && fs.existsSync(home)) fs.writeFileSync(path.join(home, "op-release"), "release");
  }
}
test.afterEach(async () => {
  try { await prepareToClose(); }
  finally {
    await app?.close();
    fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(repo, { recursive: true, force: true });
  }
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
      let opened!: () => void;
      const ready = new Promise<void>(yes => { opened = yes; });
      dialog.showMessageBox = (() => new Promise((yes, no) => { resolve = yes; reject = no; opened(); })) as any;
      const results: (string | null)[] = [];
      f.profile.emit("select-webauthn-account", {}, { frame: child, relyingPartyId: "example.test", accounts: [{ credentialId: "fixture-account", name: "Fixture" }] }, (selected?: string) => results.push(selected ?? null));
      await ready;
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

function metadataCLI(held = false) {
  heldMetadataCLI = held;
  const entry = { id: "a".repeat(26), title: "TOKEN=loginSynthetic", category: "LOGIN", vault: { id: "b".repeat(26) }, urls: [{ href: "https://example.test" }], fields: [{ purpose: "USERNAME", value: fixtureValues.username }, { purpose: "PASSWORD", value: fixtureValues.password }] };
  fs.writeFileSync(path.join(home, "bin", "op"), `#!${process.execPath}\nconst fs = require('node:fs'); const home = ${JSON.stringify(home)}, entry = ${JSON.stringify(entry)};
const answer = () => process.stdout.write(JSON.stringify(process.argv[3] === 'list' ? [entry] : entry));
fs.appendFileSync(home + '/op-arguments', JSON.stringify(process.argv.slice(2)) + '\\n');
if (${held} && process.argv[3] === 'list') {
  process.on('exit', () => { try { fs.writeFileSync(home + '/op-exited', String(process.pid)); } catch {} });
  let released = false;
  const fallback = setTimeout(() => { watcher.close(); process.exit(1); }, 5_000);
  const release = () => { if (!released && fs.existsSync(home + '/op-release')) { released = true; clearTimeout(fallback); watcher.close(); answer(); } };
  const watcher = fs.watch(home, release);
  fs.writeFileSync(home + '/op-started', String(process.pid));
  release(); // Teardown can release before this child finishes starting.
} else answer();\n`, { mode: 0o700 });
}
async function beginMetadataFill() {
  await app.evaluate(() => {
    const f = (globalThis as any).__browserDocument;
    f.pending = f.tools.fill("document");
    void f.pending.then(() => { f.pendingSettled = true; }, () => { f.pendingSettled = true; });
  });
}
async function captureLabels() {
  await app.evaluate(({ dialog }) => {
    const f = (globalThis as any).__browserDocument; f.labels = [];
    dialog.showMessageBox = (async (_window: unknown, options: any) => { f.labels.push(options); return { response: 1, checkboxChecked: false }; }) as any;
  });
}
async function passkeyMetadata() {
  return app.evaluate(async () => {
    const f = (globalThis as any).__browserDocument, results: (string | null)[] = [];
    await new Promise<void>(resolve => f.profile.emit("select-webauthn-account", {}, {
      frame: f.contents.mainFrame, relyingPartyId: "sk-relyingSynthetic.test",
      accounts: [{ credentialId: "raw-credential-id", displayName: "TOKEN=accountSynthetic" }],
    }, (selected?: string) => { results.push(selected ?? null); resolve(); }));
    return results;
  });
}

for (const enabled of [false, true]) test(`native browser metadata is ${enabled ? "masked" : "unchanged"} while operational values stay raw`, async () => {
  metadataCLI(); await captureLabels();
  if (enabled) await tid(page, "streamer-mode-toggle").click();
  await expect(page.locator(".app")).toHaveAttribute("data-streamer-mode", String(enabled));
  expect(await app.evaluate(async () => (globalThis as any).__browserDocument.tools.fill("document"))).toBe(true);
  expect(await passkeyMetadata()).toEqual(["raw-credential-id"]);
  const directory = path.join(home, "metadata-extension"); fs.mkdirSync(directory);
  const manifest = JSON.stringify({ manifest_version: 3, name: "TOKEN=extensionSynthetic", version: "1.0", content_scripts: [{ matches: ["https://sk-sitesynthetic.test/*"], js: ["page.js"] }] });
  fs.writeFileSync(path.join(directory, "manifest.json"), manifest); fs.writeFileSync(path.join(directory, "page.js"), "// original package bytes\n");
  const installed = await app.evaluate(async ({ dialog }, { directory, module }) => {
    const f = (globalThis as any).__browserDocument;
    const require = process.getBuiltinModule("node:module").createRequire(module);
    const inspect = require("./engine/browser-extensions.js").inspectExtension;
    const candidate = await inspect(directory);
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [directory] })) as any;
    const snapshot = await f.tools.install();
    return { entry: snapshot.extensions[0], digest: candidate.digest, labels: f.labels };
  }, { directory, module: pathToFileURL(path.join(appDir, "dist/src/main/browser-tools.js")).href });
  expect(installed.labels).toHaveLength(3);
  expect(installed.labels[0].buttons).toEqual(["Cancel", enabled ? "TOKEN=[redacted]" : "TOKEN=loginSynthetic"]);
  expect(installed.labels[1].buttons).toEqual(["Cancel", enabled ? "TOKEN=[redacted]" : "TOKEN=accountSynthetic"]);
  expect(installed.labels[1].message).toBe(enabled ? "Choose an account for [redacted].test" : "Choose an account for sk-relyingSynthetic.test");
  expect(installed.labels[2].message).toBe(enabled ? "Add TOKEN=[redacted] 1.0?" : "Add TOKEN=extensionSynthetic 1.0?");
  expect(installed.labels[2].detail).toContain(enabled ? "https://[redacted].test/*" : "https://sk-sitesynthetic.test/*");
  expect(installed.entry).toMatchObject({ name: "TOKEN=extensionSynthetic", sites: ["https://sk-sitesynthetic.test/*"], enabled: true });
  expect(JSON.parse(fs.readFileSync(path.join(home, "browser", "extensions.json"), "utf8"))[0].digest).toBe(installed.digest);
  expect(fs.readFileSync(path.join(home, "browser", "extensions", installed.entry.id, "manifest.json"), "utf8")).toBe(manifest);
  expect(fs.readFileSync(path.join(home, "browser", "extensions", installed.entry.id, "page.js"), "utf8")).toBe("// original package bytes\n");
  expect(JSON.parse(fs.readFileSync(path.join(home, "op-arguments"), "utf8").trim().split("\n")[1]!)).toEqual(["item", "get", "a".repeat(26), "--vault", "b".repeat(26), "--format=json"]);
  expect(await app.evaluate(() => (globalThis as any).__browserDocument.contents.executeJavaScript('[document.querySelector("input").value, document.querySelector("input[type=password]").value, window.submitted]'))).toEqual([fixtureValues.username, fixtureValues.password, false]);
});

for (const initiallyEnabled of [false, true]) test(`native login labels use Streamer toggle during pending CLI listing from ${initiallyEnabled}`, async () => {
  metadataCLI(true); await captureLabels();
  if (initiallyEnabled) await tid(page, "streamer-mode-toggle").click();
  await beginMetadataFill();
  await expect.poll(() => fs.existsSync(path.join(home, "op-started"))).toBe(true);
  await tid(page, "streamer-mode-toggle").click();
  await expect(page.locator(".app")).toHaveAttribute("data-streamer-mode", String(!initiallyEnabled));
  fs.writeFileSync(path.join(home, "op-release"), "release");
  expect(await app.evaluate(async () => await (globalThis as any).__browserDocument.pending)).toBe(true);
  expect(await app.evaluate(() => (globalThis as any).__browserDocument.labels[0].buttons)).toEqual(["Cancel", initiallyEnabled ? "TOKEN=loginSynthetic" : "TOKEN=[redacted]"]);
});

test("early failure releases and settles the held CLI before Electron closes", async ({}, testInfo) => {
  metadataCLI(true); await captureLabels(); await beginMetadataFill();
  await expect.poll(() => fs.existsSync(path.join(home, "op-started"))).toBe(true);
  const pid = Number(fs.readFileSync(path.join(home, "op-started"), "utf8"));
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  expect(alive()).toBe(true);
  try {
    await expect((async () => {
      try { throw new Error("Synthetic failure before releasing the CLI"); }
      finally { await prepareToClose(); }
    })()).rejects.toThrow("Synthetic failure before releasing the CLI");
    const settled = await app.evaluate(() => Boolean((globalThis as any).__browserDocument.pendingSettled));
    const receipt = { pid, settled, alive: alive(), released: fs.existsSync(path.join(home, "op-release")) };
    fs.writeFileSync(testInfo.outputPath("held-cli-teardown.json"), JSON.stringify(receipt));
    expect(settled).toBe(true);
    expect(fs.existsSync(path.join(home, "op-release"))).toBe(true);
    expect(fs.readFileSync(path.join(home, "op-exited"), "utf8")).toBe(String(pid));
    expect(alive()).toBe(false);
    expect(await app.evaluate(() => (globalThis as any).__browserDocument.labels)).toEqual([]);
    expect(fs.readFileSync(path.join(home, "op-arguments"), "utf8").trim().split("\n")).toHaveLength(1);
  } finally {
    // Even the RED teardown regression releases its own child before the app is closed.
    fs.writeFileSync(path.join(home, "op-release"), "release");
    await app.evaluate(async () => { await (globalThis as any).__browserDocument.pending.catch(() => {}); });
    await expect.poll(alive).toBe(false);
  }
});

test("held CLI cleanup stays bounded when its pending operation cannot settle", async ({}, testInfo) => {
  metadataCLI(true); await captureLabels(); await beginMetadataFill();
  await expect.poll(() => fs.existsSync(path.join(home, "op-started"))).toBe(true);
  await app.evaluate(() => { (globalThis as any).__browserDocument.pending = new Promise(() => {}); });
  try {
    const outcome = await prepareToClose();
    expect(outcome).toBe("timed-out");
    const pid = Number(fs.readFileSync(path.join(home, "op-exited"), "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
    fs.writeFileSync(testInfo.outputPath("bounded-cleanup.json"), JSON.stringify({ outcome, pid, childExited: true }));
  } finally {
    // Leave the ordinary afterEach free to reach app.close after this forced timeout.
    await app.evaluate(() => { (globalThis as any).__browserDocument.pending = Promise.resolve(); });
  }
});

test("persisted Streamer startup masks unsolicited passkeys before app state arrives", async () => {
  await tid(page, "streamer-mode-toggle").click(); await captureLabels();
  await app.evaluate(({ ipcMain }) => {
    const f = (globalThis as any).__browserDocument;
    const original = (ipcMain as any)._invokeHandlers.get("state:get");
    ipcMain.removeHandler("state:get");
    ipcMain.handle("state:get", (...args) => new Promise(resolve => { f.releaseStartup = () => resolve(original(...args)); }));
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator(".app.loading")).toHaveAttribute("data-streamer-mode", "true");
  await expect.poll(() => app.evaluate(() => Boolean((globalThis as any).__browserDocument.releaseStartup))).toBe(true);
  expect(await passkeyMetadata()).toEqual(["raw-credential-id"]);
  expect(await app.evaluate(() => (globalThis as any).__browserDocument.labels[0].buttons)).toEqual(["Cancel", "TOKEN=[redacted]"]);
  await app.evaluate(() => (globalThis as any).__browserDocument.releaseStartup());
});
