import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { codexMemoriesDir, readMemoryCitation, MEMORY_EXCERPT_BYTES, MEMORY_FILE_MAX_BYTES } from "../src/main/engine/memory-citations.js";
import { tmpdir } from "./helpers.js";

/** A Codex home with a memories folder, and a file outside it that a citation must never reach. */
function codexHome() {
  const home = tmpdir("modex-codex-home-");
  const memories = path.join(home, "memories");
  fs.mkdirSync(path.join(memories, "notes"), { recursive: true });
  fs.writeFileSync(path.join(memories, "MEMORY.md"), Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
  fs.writeFileSync(path.join(memories, "notes", "build.md"), "a\nb\nUse --frozen-lockfile ✓\nand pnpm 10\nthen build\nf\n");
  const outside = path.join(home, "secret.txt");
  fs.writeFileSync(outside, "outside the memories folder\n");
  return { home, memories, outside };
}

test("the memories folder is $CODEX_HOME/memories, else ~/.codex/memories", () => {
  assert.equal(codexMemoriesDir({ CODEX_HOME: "/tmp/codex-x" }, "/Users/u"), path.join("/tmp/codex-x", "memories"));
  assert.equal(codexMemoriesDir({}, "/Users/u"), path.join("/Users/u", ".codex", "memories"));
});

test("a citation reads its 1-based, inclusive line range from a file inside the memories folder", async () => {
  const { memories } = codexHome();
  assert.deepEqual(await readMemoryCitation(memories, { path: "notes/build.md", lineStart: 3, lineEnd: 4 }),
    { path: "notes/build.md", lineStart: 3, lineEnd: 4, text: "Use --frozen-lockfile ✓\nand pnpm 10", totalLines: 6 });
  assert.deepEqual(await readMemoryCitation(memories, { path: "MEMORY.md", lineStart: 10, lineEnd: 10 }),
    { path: "MEMORY.md", lineStart: 10, lineEnd: 10, text: "line 10", totalLines: 10 });
});

test("a range past the end of the file is cut to what exists and says so", async () => {
  const { memories } = codexHome();
  assert.deepEqual(await readMemoryCitation(memories, { path: "MEMORY.md", lineStart: 9, lineEnd: 40 }),
    { path: "MEMORY.md", lineStart: 9, lineEnd: 10, text: "line 9\nline 10", totalLines: 10, beyondEnd: true });
  await assert.rejects(readMemoryCitation(memories, { path: "MEMORY.md", lineStart: 11, lineEnd: 12 }), /past the end/);
});

test("a citation cannot leave the memories folder: absolute paths, .., and symlinks out are refused", async () => {
  const { memories, outside } = codexHome();
  fs.symlinkSync(outside, path.join(memories, "escape.md"));
  fs.symlinkSync(path.dirname(outside), path.join(memories, "up"));
  for (const bad of [outside, "../secret.txt", "notes/../../secret.txt", "escape.md", "up/secret.txt", "", "notes", "a\0b"]) {
    await assert.rejects(readMemoryCitation(memories, { path: bad, lineStart: 1, lineEnd: 1 }), /memory/i, JSON.stringify(bad));
  }
});

test("a symlink that stays inside the memories folder is followed", async () => {
  const { memories } = codexHome();
  fs.symlinkSync(path.join(memories, "notes", "build.md"), path.join(memories, "alias.md"));
  assert.equal((await readMemoryCitation(memories, { path: "alias.md", lineStart: 5, lineEnd: 5 })).text, "then build");
});

test("bad ranges, missing files, oversized files and a missing folder are refused without reading", async () => {
  const { memories } = codexHome();
  for (const [lineStart, lineEnd] of [[0, 1], [2, 1], [1.5, 2], [-1, 3]] as const) {
    await assert.rejects(readMemoryCitation(memories, { path: "MEMORY.md", lineStart, lineEnd }), /line range/);
  }
  await assert.rejects(readMemoryCitation(memories, { path: "missing.md", lineStart: 1, lineEnd: 1 }), /not found/);
  fs.writeFileSync(path.join(memories, "huge.md"), Buffer.alloc(MEMORY_FILE_MAX_BYTES + 1, 0x61));
  await assert.rejects(readMemoryCitation(memories, { path: "huge.md", lineStart: 1, lineEnd: 1 }), /too large/);
  await assert.rejects(readMemoryCitation(path.join(memories, "nope"), { path: "MEMORY.md", lineStart: 1, lineEnd: 1 }), /memories folder/);
});

test("a long excerpt is bounded and says it was cut", async () => {
  const { memories } = codexHome();
  const line = "x".repeat(1000);
  fs.writeFileSync(path.join(memories, "long.md"), Array.from({ length: 200 }, () => line).join("\n"));
  const excerpt = await readMemoryCitation(memories, { path: "long.md", lineStart: 1, lineEnd: 200 });
  assert.ok(Buffer.byteLength(excerpt.text) <= MEMORY_EXCERPT_BYTES);
  assert.equal(excerpt.cut, true);
});
