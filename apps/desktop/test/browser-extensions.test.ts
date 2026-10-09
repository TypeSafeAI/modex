import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BrowserExtensions, inspectExtension } from "../src/main/engine/browser-extensions.js";

const manifest = { manifest_version: 3, name: "Page helper", version: "1.0", permissions: ["storage"], content_scripts: [{ matches: ["https://example.com/*"], js: ["page.js"] }] };
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "modex-extensions-"));
  const source = path.join(root, "source");
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, "manifest.json"), JSON.stringify(manifest));
  await fs.writeFile(path.join(source, "page.js"), "document.documentElement.dataset.helper = 'enabled';");
  return { root, source };
}

test("only selected page extension capabilities and safe site patterns are accepted", async () => {
  const { root, source } = await fixture();
  try {
    const candidate = await inspectExtension(source);
    assert.equal(candidate.name, "Page helper");
    assert.deepEqual(candidate.sites, ["https://example.com/*"]);
    for (const patch of [
      { permissions: ["nativeMessaging"] }, { permissions: ["cookies"] }, { host_permissions: ["<all_urls>"] },
      { background: { service_worker: "page.js" } }, { action: {} }, { optional_permissions: ["tabs"] },
      { content_scripts: [{ matches: ["file:///*"], js: ["page.js"] }] },
      { content_scripts: [{ matches: ["http://*.example.com/*"], js: ["page.js"] }] },
      { content_scripts: [{ matches: ["https://example.com/*"], js: ["../page.js"] }] },
      { content_scripts: [{ matches: ["https://example.com/*"], js: ["missing.js"] }] },
    ]) {
      await fs.writeFile(path.join(source, "manifest.json"), JSON.stringify({ ...manifest, ...patch }));
      await assert.rejects(inspectExtension(source));
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("extension packages reject symlinks and oversized files", async () => {
  const { root, source } = await fixture();
  try {
    await fs.symlink(path.join(root, "private"), path.join(source, "link"));
    await assert.rejects(inspectExtension(source), /symbolic|symlink/i);
    await fs.unlink(path.join(source, "link"));
    await fs.writeFile(path.join(source, "huge"), Buffer.alloc(21 * 1024 * 1024));
    await assert.rejects(inspectExtension(source), /large|limit/i);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("only approved copies load, survive restart and fail closed when changed", async () => {
  const { root, source } = await fixture();
  const loaded: string[] = [], removed: string[] = [];
  const loader = { loadExtension: async (dir: string, options: { allowFileAccess: boolean }) => { assert.equal(options.allowFileAccess, false); loaded.push(dir); return { id: path.basename(dir) }; }, removeExtension: (id: string) => { removed.push(id); } };
  try {
    const manager = new BrowserExtensions(path.join(root, "profile"), loader);
    await manager.restore();
    const candidate = await inspectExtension(source);
    const entry = await manager.install(candidate);
    assert.notEqual(loaded[0], source);
    await fs.writeFile(path.join(source, "page.js"), "changed after approval");
    assert.match(await fs.readFile(path.join(loaded[0]!, "page.js"), "utf8"), /dataset.helper/);
    await manager.update(entry.id, "disable");
    assert.equal(manager.snapshot()[0]!.enabled, false);
    assert.equal(removed.length, 1);
    await manager.update(entry.id, "enable");
    const restarted = new BrowserExtensions(path.join(root, "profile"), loader);
    await restarted.restore();
    assert.equal(restarted.snapshot()[0]!.enabled, true);
    await fs.writeFile(path.join(loaded[0]!, "page.js"), "tampered");
    const tampered = new BrowserExtensions(path.join(root, "profile"), loader);
    const before = loaded.length;
    await tampered.restore();
    assert.equal(loaded.length, before);
    assert.match(tampered.snapshot()[0]!.error!, /changed/);
    await assert.rejects(tampered.update(entry.id, "enable"), /changed/);
    await tampered.update(entry.id, "remove");
    assert.deepEqual(tampered.snapshot(), []);
    await assert.rejects(tampered.update("../escape", "remove"));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("a loader failure never records an extension as enabled", async () => {
  const { root, source } = await fixture();
  const manager = new BrowserExtensions(path.join(root, "profile"), { loadExtension: async () => { throw new Error("load failed"); }, removeExtension: () => {} });
  try {
    await manager.restore();
    await assert.rejects(manager.install(await inspectExtension(source)), /load/);
    assert.deepEqual(manager.snapshot(), []);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
