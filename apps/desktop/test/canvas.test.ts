import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CanvasResources } from "../src/main/engine/canvas.js";

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "modex-canvas-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "index.html"), '<h1>Canvas</h1>');
  return root;
}

test("Canvas only serves bounded supported files inside its authorized root", async t => {
  const root = await fixture(t);
  const resources = new CanvasResources(root, "index.html");
  const response = await resources.respond(new Request(resources.url));
  assert.equal(response.status, 200);
  assert.match(await response.text(), /<h1>Canvas/);
  assert.match(response.headers.get("Content-Security-Policy")!, /connect-src 'none'/);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  await fs.writeFile(path.join(root, ".env"), "SECRET=hidden");
  await fs.symlink(path.join(root, ".env"), path.join(root, "public.html"));
  await fs.mkdir(path.join(root, ".private"));
  await fs.writeFile(path.join(root, ".private", "hidden.html"), "PRIVATE");
  await fs.symlink(path.join(root, ".private"), path.join(root, "public"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "modex-canvas-outside-"));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.writeFile(path.join(outside, "outside.html"), "sensitive content");
  await fs.symlink(outside, path.join(root, "escape"));
  for (const relative of [".env", "public.html", "public/hidden.html", "../outside.html", "escape/outside.html", "index.html%00", "%2e%2e%2foutside.html"]) {
    assert.notEqual((await resources.respond(new Request(`${resources.origin}/${relative}`))).status, 200, relative);
  }
  assert.equal((await resources.respond(new Request('modex-canvas://untrusted/index.html'))).status, 403);
  assert.equal((await resources.respond(new Request(resources.url, { method: "POST" }))).status, 405);
  await fs.writeFile(path.join(root, "large.html"), "x".repeat(1024 * 1024 + 1));
  assert.notEqual((await resources.respond(new Request(`${resources.origin}/large.html`))).status, 200);
  await fs.mkdir(path.join(root, "folder.html"));
  assert.notEqual((await resources.respond(new Request(`${resources.origin}/folder.html`))).status, 200);
});

test("Canvas detects changes in loaded assets, deletion and restoration", async t => {
  const root = await fixture(t);
  const resources = new CanvasResources(root, "index.html");
  await fs.writeFile(path.join(root, "style.css"), "body {color:red}");
  await resources.respond(new Request(resources.url));
  await resources.respond(new Request(`${resources.origin}/style.css`));
  assert.equal(await resources.changed(), false);
  await fs.writeFile(path.join(root, "style.css"), "body {color:tan}");
  assert.equal(await resources.changed(), true);
  assert.equal(await resources.changed(), false);
  await fs.unlink(path.join(root, "index.html"));
  assert.equal(await resources.changed(), true);
  assert.equal(await resources.changed(), false);
  await fs.writeFile(path.join(root, "index.html"), "<h1>Restored</h1>");
  assert.equal(await resources.changed(), true);
});

test("Markdown renders formatting but never executes raw HTML", async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, "note.md"), '# Title\n\n**Strong** and `code`\n\n- first\n- second\n\n```html\n<script>bad()</script>\n```\n\n<script>bad()</script>');
  const resources = new CanvasResources(root, "note.md");
  const response = await resources.respond(new Request(resources.url));
  const text = await response.text();
  assert.match(text, /<h1>Title<\/h1>/);
  assert.match(text, /<strong>Strong<\/strong>/);
  assert.match(text, /<code>code<\/code>/);
  assert.match(text, /<ul><li>first<\/li><li>second<\/li><\/ul>/);
  assert.doesNotMatch(text, /<script>/);
  assert.match(text, /&lt;script&gt;/);
});
