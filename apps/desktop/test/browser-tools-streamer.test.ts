import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import ts from "typescript";
import { fillFrom1Password } from "../src/main/engine/browser-credentials.js";

type Kind = "login" | "passkey" | "extension";
function fixture(initial: unknown = "true") {
  const origin = "https://sk-originSynthetic.test";
  const logins = ["a", "b"].map((id, index) => ({ id: id.repeat(26), title: `TOKEN=loginSynthetic${index}`, category: "LOGIN", vault: { id: "v".repeat(26) }, urls: [{ href: origin }], fields: [{ purpose: "USERNAME", value: `TOKEN=user${index}` }, { purpose: "PASSWORD", value: `sk-password${index}` }] }));
  const accounts = [{ name: "TOKEN=accountSynthetic0", credentialId: "raw-account-zero" }, { displayName: "TOKEN=accountSynthetic1", name: "Raw fallback", credentialId: "raw-account-one" }];
  const candidate = Object.freeze({ name: "TOKEN=extensionSynthetic", version: "1.0", sites: Object.freeze(["https://sk-siteSynthetic.test/*"]), path: "/synthetic/package", digest: "raw-digest", files: Object.freeze(["raw-file.js"]) });
  let mode = initial, loading = false, dead = false, current = true, read: (() => Promise<unknown>) | undefined;
  let listGate: Promise<void> | undefined, releaseList!: () => void, disposed = 0;
  const scripts: string[] = [], dialogs: any[] = [], opReads: string[][] = [], fields: unknown[] = [], installed: unknown[] = [], selections: unknown[] = [];
  const frame = { isDestroyed: () => false, executeJavaScript: async (code: string) => {
    scripts.push(code);
    if (read) return read();
    return vm.runInNewContext(code, { document: { querySelector: () => mode === undefined ? null : { getAttribute: () => mode } } });
  } };
  const contents = { mainFrame: frame, isDestroyed: () => dead, isLoadingMainFrame: () => loading };
  const window = { webContents: contents, isDestroyed: () => dead };
  const guest = { url: origin + "/login" };
  const browser = {
    ownsFrame: (value: unknown) => value === guest,
    frameGuard: () => Object.assign(() => current, { dispose: () => { disposed++; } }),
    credentialTarget: async () => ({ url: guest.url, isCurrent: () => current, fill: async (value: unknown) => { fields.push(value); return true; }, dispose: () => { disposed++; } }),
  };
  const profile = Object.assign(new EventEmitter(), { extensions: {} });
  const electron = { session: { fromPartition: () => profile }, dialog: {
    showOpenDialog: async () => ({ canceled: false, filePaths: [candidate.path] }),
    showMessageBox: async (_owner: unknown, options: any) => { dialogs.push(options); return { response: options.title === "Add browser extension" ? 1 : 2 }; },
  } };
  const dependencies: Record<string, unknown> = {
    "./engine/browser-extensions.js": { inspectExtension: async () => candidate, BrowserExtensions: class {
      async install(value: unknown) { installed.push(value); }
      snapshot() { return installed; }
    } },
    "./engine/browser-credentials.js": { fillFrom1Password, read1Password: async (args: string[]) => {
      opReads.push(args);
      if (args[1] === "list") { await listGate; return logins; }
      return logins.find(login => login.id === args[2]);
    } },
  };
  const filename = new URL("../src/main/browser-tools.js", import.meta.url);
  const code = ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: Record<string, any> = {};
  vm.runInNewContext(`(function(require,exports){${code}\n})`, { process, URL, setTimeout, clearTimeout })(
    (id: string) => id === "electron" ? electron : dependencies[id] ?? createRequire(filename)(id), exports);
  const tools = new exports.BrowserTools("/synthetic/home", () => ({ window, browser }));
  const run = async (kind: Kind, cancelled = false) => {
    if (kind === "login") { assert.equal(await tools.fill("guest"), true); return; }
    if (kind === "extension") { await tools.install(); return; }
    const selected = await new Promise(resolve => profile.emit("select-webauthn-account", {}, { frame: guest, relyingPartyId: "sk-relyingSynthetic.test", accounts }, (value: unknown) => { selections.push(value); resolve(value); }));
    assert.equal(selected, cancelled ? undefined : accounts[1]!.credentialId);
  };
  const assertRaw = (kind: Kind) => {
    if (kind === "extension") { assert.equal(installed.length, 1); assert.equal(installed[0], candidate); }
    if (kind === "login") {
      assert.deepEqual(opReads[1], ["item", "get", logins[1]!.id, "--vault", logins[1]!.vault.id, "--format=json"]);
      assert.deepEqual(fields, [{ username: "TOKEN=user1", password: "sk-password1" }]);
      assert.equal(disposed, 1);
    }
    if (kind === "passkey") { assert.equal(disposed, 1); assert.deepEqual(selections, [accounts[1]!.credentialId]); }
    assert.equal(accounts[1]!.displayName, "TOKEN=accountSynthetic1");
    assert.equal(logins[1]!.title, "TOKEN=loginSynthetic1");
    assert.equal(candidate.name, "TOKEN=extensionSynthetic");
    assert.equal(candidate.sites[0], "https://sk-siteSynthetic.test/*");
  };
  return { run, assertRaw, dialogs, scripts, opReads, contents, frame, fields, selections, disposed: () => disposed, cancelGuest: () => { current = false; }, setMode: (value: unknown) => { mode = value; }, setLoading: () => { loading = true; }, setDead: () => { dead = true; }, setRead: (value: () => Promise<unknown>) => { read = value; },
    holdList: () => { listGate = new Promise(resolve => { releaseList = resolve; }); }, releaseList: () => releaseList() };
}

function assertDisplay(kind: Kind, dialog: any, masked: boolean) {
  const message = kind === "login" ? "Choose a login for https://sk-originsynthetic.test" : kind === "passkey" ? "Choose an account for sk-relyingSynthetic.test" : "Add TOKEN=extensionSynthetic 1.0?";
  assert.equal(dialog.message, masked ? kind === "login" ? "Choose a login for https://[redacted].test" : kind === "passkey" ? "Choose an account for [redacted].test" : "Add TOKEN=[redacted] 1.0?" : message);
  if (kind === "extension") {
    assert.ok(dialog.detail.includes(masked ? "https://[redacted].test/*" : "https://sk-siteSynthetic.test/*"));
    assert.deepEqual(Array.from(dialog.buttons), ["Cancel", "Add extension"]);
  } else {
    assert.deepEqual(Array.from(dialog.buttons), ["Cancel", ...[0, 1].map(index => masked ? "TOKEN=[redacted]" : `TOKEN=${kind === "login" ? "login" : "account"}Synthetic${index}`)]);
    if (kind === "passkey") assert.equal(dialog.detail, masked ? "Requested by https://[redacted].test" : "Requested by https://sk-originsynthetic.test");
  }
  assert.equal(dialog.defaultId, 0); assert.equal(dialog.cancelId, 0);
}

for (const kind of ["login", "passkey", "extension"] as const) {
  for (const mode of ["true", "false", undefined]) test(`${kind} native labels honor current Streamer state ${String(mode)} without changing operations`, async () => {
    const f = fixture(); f.setMode(mode);
    await f.run(kind);
    assertDisplay(kind, f.dialogs[0], mode !== "false");
    f.assertRaw(kind);
    assert.equal(f.scripts.length, 1);
    assert.ok(!f.scripts[0]!.includes("Synthetic"));
  });
  for (const state of ["loading", "rejected", "replaced", "non-string"]) test(`${kind} native labels mask when app state is ${state}`, async () => {
    const f = fixture("false");
    if (state === "loading") f.setLoading();
    if (state === "rejected") f.setRead(async () => { throw new Error("Synthetic app read rejection"); });
    if (state === "replaced") f.setRead(async () => { f.contents.mainFrame = { ...f.frame }; return "false"; });
    if (state === "non-string") f.setMode(false);
    await f.run(kind);
    assertDisplay(kind, f.dialogs[0], true); f.assertRaw(kind);
    if (state === "loading") assert.equal(f.scripts.length, 0);
  });
  test(`${kind} hung app read masks once and ignores a late response`, async () => {
    const f = fixture("false"); let resolve!: (value: string) => void;
    f.setRead(() => new Promise(yes => { resolve = yes; }));
    await f.run(kind);
    assertDisplay(kind, f.dialogs[0], true); f.assertRaw(kind);
    assert.equal(f.dialogs.length, 1);
    resolve("false"); await new Promise(done => setImmediate(done));
    assert.equal(f.dialogs.length, 1); f.assertRaw(kind);
    f.setRead(async () => "false"); await f.run(kind);
    assert.equal(f.dialogs.length, 2); assertDisplay(kind, f.dialogs[1], false);
  });
}

for (const [before, after] of [["false", "true"], ["true", "false"]]) test(`login presentation sees a late Streamer toggle ${before} → ${after}`, async () => {
  const f = fixture(before); f.holdList();
  const result = f.run("login");
  await new Promise(done => setImmediate(done));
  assert.equal(f.opReads.length, 1); assert.equal(f.dialogs.length, 0);
  f.setMode(after); f.releaseList(); await result;
  assertDisplay("login", f.dialogs[0], after === "true"); f.assertRaw("login");
});

for (const kind of ["login", "passkey"] as const) test(`${kind} navigation during the app-state read cancels before any chooser`, async () => {
  const f = fixture("false"); let resolve!: (value: string) => void;
  f.setRead(() => new Promise(yes => { resolve = yes; }));
  const request = kind === "login" ? assert.rejects(f.run(kind), /page changed/i) : f.run(kind, true);
  await new Promise(done => setImmediate(done));
  assert.equal(f.scripts.length, 1); assert.equal(f.dialogs.length, 0);
  f.cancelGuest(); resolve("false"); await request;
  assert.equal(f.dialogs.length, 0); assert.equal(f.fields.length, 0); assert.equal(f.disposed(), 1);
  assert.equal(f.opReads.length, kind === "login" ? 1 : 0);
  assert.deepEqual(f.selections, kind === "passkey" ? [undefined] : []);
});

test("extension owner closing during the app-state read prevents its confirmation", async () => {
  const f = fixture("false"); let resolve!: (value: string) => void;
  f.setRead(() => new Promise(yes => { resolve = yes; }));
  const request = assert.rejects(f.run("extension"), /unavailable|page changed/i);
  await new Promise(done => setImmediate(done));
  assert.equal(f.scripts.length, 1); f.setDead(); resolve("false"); await request;
  assert.equal(f.dialogs.length, 0);
});
