import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { ZipFile } from "yazl";
import { stageUpdateArchive } from "../src/main/engine/update-archive.js";

type Item = { name: string; text?: string; mode?: number };
async function fixture(items: Item[]) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "modex-update-archive-"));
  const archive = path.join(parent, "candidate.zip");
  const zip = new ZipFile();
  for (const item of items) zip.addBuffer(Buffer.from(item.text ?? "data"), item.name, { mode: item.mode ?? 0o100644 });
  const writing = pipeline(zip.outputStream, createWriteStream(archive));
  zip.end(); await writing;
  const bytes = await fs.readFile(archive);
  return {
    parent, archive, sha512: createHash("sha512").update(bytes).digest("base64"), size: bytes.length,
    clean: () => fs.rm(parent, { recursive: true, force: true }),
  };
}
const executable = { name: "Modex.app/Contents/MacOS/Modex", text: "not executable test data", mode: 0o100755 };

test("update archive stages regular files and internal framework links in private storage", async () => {
  const f = await fixture([executable,
    { name: "Modex.app/Contents/Frameworks/Demo.framework/Versions/A/data", text: "framework" },
    { name: "Modex.app/Contents/Frameworks/Demo.framework/Versions/Current", text: "A", mode: 0o120777 },
    { name: "Modex.app/Contents/Frameworks/Demo.framework/data", text: "Versions/Current/data", mode: 0o120777 },
  ]);
  try {
    const staged = await stageUpdateArchive(f.archive, f);
    assert.equal(await fs.readFile(path.join(staged.bundle, "Contents/Frameworks/Demo.framework/data"), "utf8"), "framework");
    assert.equal((await fs.stat(path.dirname(staged.bundle))).mode & 0o777, 0o700);
    assert.equal((await fs.stat(path.join(staged.bundle, "Contents/MacOS/Modex"))).mode & 0o777, 0o755);
    assert.equal(createHash("sha512").update(await fs.readFile(staged.archive)).digest("base64"), f.sha512);
    await staged.dispose();
    await assert.rejects(fs.stat(staged.bundle), { code: "ENOENT" });
  } finally { await f.clean(); }
});

test("update archive refuses altered bytes and removes partial staging", async () => {
  const f = await fixture([executable]);
  try {
    const bytes = await fs.readFile(f.archive); bytes[0] = bytes[0]! ^ 1; await fs.writeFile(f.archive, bytes);
    await assert.rejects(stageUpdateArchive(f.archive, f), /checksum/i);
    assert.deepEqual(await fs.readdir(f.parent), ["candidate.zip"]);
    await assert.rejects(stageUpdateArchive(f.archive, { ...f, sha512: "not a hash" }), /checksum/i);
  } finally { await f.clean(); }
});

test("update archive refuses symlink escapes and entries beneath links regardless of order", async () => {
  for (const items of [
    [executable, { name: "Modex.app/link", text: "../../outside", mode: 0o120777 }],
    [executable, { name: "Modex.app/link", text: "/tmp", mode: 0o120777 }],
    [executable, { name: "Modex.app/link", text: "Contents", mode: 0o120777 }, { name: "Modex.app/link/injected" }],
    [executable, { name: "Modex.app/link/injected" }, { name: "Modex.app/link", text: "Contents", mode: 0o120777 }],
    [executable, { name: "Modex.app/link", text: "missing", mode: 0o120777 }],
  ]) {
    const f = await fixture(items);
    try {
      await assert.rejects(stageUpdateArchive(f.archive, f));
      assert.deepEqual(await fs.readdir(f.parent), ["candidate.zip"]);
    } finally { await f.clean(); }
  }
});

test("update archive rejects duplicates, filesystem aliases, special files and unexpected roots", async () => {
  for (const items of [
    [executable, executable],
    [executable, { name: "Modex.app/Contents/MacOS/modex" }],
    [executable, { name: "Modex.app/A/data" }, { name: "Modex.app/a/other" }],
    [executable, { name: "Modex.app/file" }, { name: "Modex.app/file/child" }],
    [executable, { name: "Other.app/data" }],
    [executable, { name: "Modex.app/fifo", mode: 0o010600 }],
    [executable, { name: "Modex.app/Contents/MacOS/evil", mode: 0o104755 }],
    [{ name: "Modex.app/Contents/notes" }],
  ]) {
    const f = await fixture(items);
    try { await assert.rejects(stageUpdateArchive(f.archive, f)); }
    finally { await f.clean(); }
  }
});

test("update archive enforces expanded byte, file, entry and compressed input limits", async () => {
  const f = await fixture([executable, { name: "Modex.app/large", text: "x".repeat(2048) }]);
  try {
    for (const limits of [{ expandedBytes: 1024 }, { fileBytes: 1024 }, { entries: 1 }, { archiveBytes: 10 }]) {
      await assert.rejects(stageUpdateArchive(f.archive, { ...f, limits }), /limit/i);
      assert.deepEqual(await fs.readdir(f.parent), ["candidate.zip"]);
    }
    const link = path.join(f.parent, "alias.zip"); await fs.symlink(f.archive, link);
    await assert.rejects(stageUpdateArchive(link, f));
  } finally { await f.clean(); }
});

test("update archive rejects excessive nesting before building or extracting its path tree", async () => {
  const f = await fixture([executable, { name: `Modex.app/${"a/".repeat(40)}leaf` }]);
  try { await assert.rejects(stageUpdateArchive(f.archive, f), /path limit/i); }
  finally { await f.clean(); }
});

test("update archive bounds UTF-8 path bytes even when the character count is small", async () => {
  // Each component fits a normal filesystem name; only the complete UTF-8 path
  // exceeds the archive policy. A character-count check would admit this path.
  const name = `Modex.app/${Array(5).fill("界".repeat(70)).join("/")}/payload`;
  assert.ok(name.length < 1024 && Buffer.byteLength(name) > 1024);
  const f = await fixture([executable, { name }]);
  try {
    await assert.rejects(stageUpdateArchive(f.archive, f), /path limit/i);
    assert.deepEqual(await fs.readdir(f.parent), ["candidate.zip"]);
  } finally { await f.clean(); }
});

test("update archive counts implicit directories against the topology budget", async () => {
  const f = await fixture([executable, { name: "Modex.app/a/b/c/d/e/f/g/leaf" }]);
  try {
    // Two ZIP records still require more than eight filesystem nodes.
    await assert.rejects(stageUpdateArchive(f.archive, { ...f, limits: { entries: 8 } }), /path limit/i);
    assert.deepEqual(await fs.readdir(f.parent), ["candidate.zip"]);
  } finally { await f.clean(); }
});

test("update archive bounds aggregate path metadata before extracting a wide deep tree", async () => {
  // Every path fits the individual byte/depth limits, and the whole topology
  // fits the node budget. Repeated long prefixes still exceed metadata storage.
  const items = Array.from({ length: 400 }, (_, i) => ({
    name: `Modex.app/${String(i).padStart(4, "0")}-${"a".repeat(25)}/${Array(29).fill("b".repeat(30)).join("/")}/leaf`,
  }));
  assert.ok(items.every(({ name }) => Buffer.byteLength(name) <= 1024 && name.split("/").length <= 32));
  const f = await fixture([executable, ...items]);
  try {
    await assert.rejects(stageUpdateArchive(f.archive, f), /path limit/i);
    assert.deepEqual(await fs.readdir(f.parent), ["candidate.zip"]);
  } finally { await f.clean(); }
});
