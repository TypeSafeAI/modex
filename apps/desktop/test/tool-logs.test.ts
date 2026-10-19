import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ToolLogStore, TOOL_LOG_MAX_BYTES, TOOL_LOG_PAGE_BYTES } from "../src/main/engine/tool-logs.js";
import { OUTPUT_PREVIEW_BYTES } from "../src/shared/evidence.js";
import { tmpdir } from "./helpers.js";

const T = "4f1c2a9e-0b7d-4c31-9a55-1d2e3f405162";

/** Every page from the start, joined: the whole kept text. */
function readAll(store: ToolLogStore, threadId: string, itemId: string): { text: string; pages: number } {
  let text = "";
  let pages = 0;
  let offset: number | null = 0;
  while (offset !== null) {
    const page = store.read(threadId, itemId, offset);
    assert.ok(page, "a page");
    assert.ok(Buffer.byteLength(page.text) <= TOOL_LOG_PAGE_BYTES, "a page is bounded");
    text += page.text;
    pages++;
    offset = page.next;
  }
  return { text, pages };
}

test("output that fits in the transcript's preview leaves nothing on disk", () => {
  const root = tmpdir("modex-tool-logs-");
  const store = new ToolLogStore(root);
  store.append(T, "A1:3", "small output\n");
  store.end(T, "A1:3");
  assert.equal(store.read(T, "A1:3", 0), null);
  assert.deepEqual(fs.readdirSync(root), []);
});

test("output past the preview is kept from its first byte, and reads back in bounded pages", () => {
  const root = tmpdir("modex-tool-logs-");
  const store = new ToolLogStore(root);
  const line = (i: number) => `line ${String(i).padStart(6, "0")} ${"x".repeat(80)}\n`;
  const lines: string[] = [];
  for (let i = 0, bytes = 0; bytes < OUTPUT_PREVIEW_BYTES * 3; i++) { const l = line(i); lines.push(l); bytes += l.length; store.append(T, "A1:7", l); }
  const all = lines.join("");
  store.end(T, "A1:7");
  const first = store.read(T, "A1:7", 0)!;
  assert.ok(first.text.startsWith(line(0)), "the kept log starts at the first line, which the preview no longer shows");
  assert.equal(first.kept, Buffer.byteLength(all));
  assert.equal(first.total, Buffer.byteLength(all));
  assert.equal(first.cut, false);
  const { text, pages } = readAll(store, T, "A1:7");
  assert.equal(text, all);
  assert.ok(pages >= 3);
});

test("a log past 10 MiB keeps its first 10 MiB and says how much there was", () => {
  const root = tmpdir("modex-tool-logs-");
  const store = new ToolLogStore(root);
  const chunk = "y".repeat(64 * 1024);
  const total = TOOL_LOG_MAX_BYTES + 1024 * 1024;
  for (let sent = 0; sent < total; sent += chunk.length) store.append(T, "A2:1", chunk);
  store.end(T, "A2:1");
  const page = store.read(T, "A2:1", 0)!;
  assert.equal(page.kept, TOOL_LOG_MAX_BYTES);
  assert.equal(page.total, total);
  assert.equal(page.cut, true);
  assert.equal(fs.statSync(path.join(root, T, fs.readdirSync(path.join(root, T)).find((n) => n.endsWith(".log"))!)).size, TOOL_LOG_MAX_BYTES);
});

test("pages end on a character boundary, so no character is split between pages", () => {
  const root = tmpdir("modex-tool-logs-");
  const store = new ToolLogStore(root);
  // Three-byte characters, so a page's byte limit falls inside one unless the reader steps back.
  const text = "€".repeat(Math.ceil((OUTPUT_PREVIEW_BYTES * 2) / 3) + 7) + "\nend 👋\n";
  for (let i = 0; i < text.length; i += 4099) store.append(T, "A3:1", text.slice(i, i + 4099));
  store.end(T, "A3:1");
  const { text: back } = readAll(store, T, "A3:1");
  assert.equal(back, text);
  assert.ok(!back.includes("�"));
});

test("a chunk that splits a character across appends is kept intact", () => {
  const root = tmpdir("modex-tool-logs-");
  const store = new ToolLogStore(root);
  const text = "a".repeat(OUTPUT_PREVIEW_BYTES) + "é😀z";
  store.append(T, "A3:2", text.slice(0, OUTPUT_PREVIEW_BYTES + 1));
  store.append(T, "A3:2", text.slice(OUTPUT_PREVIEW_BYTES + 1));
  store.end(T, "A3:2");
  assert.equal(readAll(store, T, "A3:2").text, text);
});

test("ids never become paths: unsafe thread ids are refused, item ids are encoded", () => {
  const root = tmpdir("modex-tool-logs-");
  const store = new ToolLogStore(root);
  for (const bad of ["../x", "a/b", "", ".", "..", "a\\b"]) {
    assert.throws(() => store.append(bad, "A1:1", "x"), /thread/, bad);
    assert.throws(() => store.read(bad, "A1:1", 0), /thread/, bad);
  }
  const big = "z".repeat(OUTPUT_PREVIEW_BYTES + 10);
  store.append(T, "../../escape:1/..", big);
  store.end(T, "../../escape:1/..");
  assert.equal(readAll(store, T, "../../escape:1/..").text, big);
  const files = fs.readdirSync(path.join(root, T));
  assert.ok(files.every((name) => /^[0-9a-f]+\.(log|json)$/.test(name)), files.join(","));
  assert.deepEqual(fs.readdirSync(root), [T], "nothing outside the thread's folder");
  assert.throws(() => store.read(T, "A1:1", -1), /offset/);
  assert.throws(() => store.read(T, "A1:1", 1.5), /offset/);
});

test("removing a thread removes its logs and nobody else's", () => {
  const root = tmpdir("modex-tool-logs-");
  const store = new ToolLogStore(root);
  const other = "9b2d6c1a-7e4f-4a83-b6c2-0f1e2d3c4b5a";
  const big = "q".repeat(OUTPUT_PREVIEW_BYTES + 1);
  store.append(T, "A1:1", big); store.end(T, "A1:1");
  store.append(other, "A1:1", big); store.end(other, "A1:1");
  store.removeThread(T);
  assert.equal(store.read(T, "A1:1", 0), null);
  assert.equal(readAll(store, other, "A1:1").text, big);
});

test("a log whose tool never finished is still readable, and its total is not claimed", () => {
  const root = tmpdir("modex-tool-logs-");
  const big = "r".repeat(OUTPUT_PREVIEW_BYTES + 100);
  const store = new ToolLogStore(root);
  store.append(T, "A4:1", big);
  store.endThread(T);
  // A later run of the app reads what was written.
  const again = new ToolLogStore(root);
  const page = again.read(T, "A4:1", 0)!;
  assert.equal(readAll(again, T, "A4:1").text, big);
  assert.equal(page.kept, Buffer.byteLength(big));
  assert.equal(page.total, undefined);
});
