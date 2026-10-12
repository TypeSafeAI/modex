import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { downloadReleaseArchive } from "../src/main/engine/update-download.js";
import { tmpdir } from "./helpers.js";

const bytes = Buffer.from("a release ZIP fixture");
const candidate = { version: "0.0.11", arch: "arm64" as const, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
const redirect = (url: string) => new Response(null, { status: 302, headers: { Location: url } });

test("first download creates a private cache in a fresh home", async () => {
  const home = tmpdir("update-fresh-home-");
  const parent = path.join(home, "app", "updates");
  try {
    const downloaded = await downloadReleaseArchive(candidate, { parent, signal: new AbortController().signal, progress: () => {}, fetcher: async () => new Response(bytes) });
    assert.equal((await fs.stat(parent)).mode & 0o777, 0o700);
    assert.deepEqual(await fs.readFile(downloaded.file), bytes);
    await downloaded.dispose();
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});

test("download refuses a redirected cache directory before making a network request", async () => {
  const home = tmpdir("update-cache-symlink-");
  try {
    const target = path.join(home, "elsewhere");
    await fs.mkdir(target);
    const parent = path.join(home, "updates");
    await fs.symlink(target, parent);
    await assert.rejects(downloadReleaseArchive(candidate, { parent, signal: new AbortController().signal, progress: () => {}, fetcher: async () => assert.fail("network must not start") }), /cache/i);
    assert.deepEqual(await fs.readdir(target), []);
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});

test("update download constructs its URL, follows only public GitHub delivery and verifies bounded bytes", async () => {
  const parent = tmpdir("update-download-");
  const calls: string[] = [];
  const progress: number[] = [];
  try {
    const downloaded = await downloadReleaseArchive(candidate, { parent, signal: new AbortController().signal, progress: n => progress.push(n), fetcher: async (url, options) => {
      calls.push(String(url));
      assert.equal(options?.redirect, "manual");
      assert.equal(new Headers(options?.headers).has("Authorization"), false);
      return calls.length === 1 ? redirect("https://release-assets.githubusercontent.com/release.zip?ticket=public") : new Response(bytes);
    } });
    assert.equal(calls[0], "https://github.com/TypeSafeAI/modex/releases/download/v0.0.11/Modex-0.0.11-arm64.zip");
    assert.deepEqual(await fs.readFile(downloaded.file), bytes);
    assert.equal(downloaded.sha512, createHash("sha512").update(bytes).digest("base64"));
    assert.equal((await fs.stat(downloaded.file)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(downloaded.directory)).mode & 0o777, 0o700);
    assert.equal(progress.at(-1), bytes.length);
    await downloaded.dispose();
    assert.deepEqual(await fs.readdir(parent), []);
  } finally { await fs.rm(parent, { recursive: true, force: true }); }
});

test("update download refuses external redirects, redirect loops and bad archive integrity without retaining partial files", async () => {
  const parent = tmpdir("update-download-");
  try {
    for (const response of [
      () => redirect("http://127.0.0.1/private"), () => redirect("https://untrusted.example/archive.zip"),
      () => redirect("https://github.com/another/repo/releases/download/v0.0.11/app.zip"),
      () => redirect("https://release-assets.githubusercontent.com/again"),
      () => new Response(bytes.subarray(1)), () => new Response(Buffer.concat([bytes, bytes])),
      () => new Response(Buffer.alloc(bytes.length)), () => new Response("offline", { status: 503 }),
    ]) {
      let requests = 0;
      await assert.rejects(downloadReleaseArchive(candidate, { parent, signal: new AbortController().signal, progress: () => {}, fetcher: async () => { requests++; return response(); } }));
      assert.ok(requests <= 5);
      assert.deepEqual(await fs.readdir(parent), []);
    }
  } finally { await fs.rm(parent, { recursive: true, force: true }); }
});

test("cancellation interrupts a pending body read, removes partial bytes and permits a clean retry", async () => {
  const parent = tmpdir("update-download-");
  const abort = new AbortController();
  let cancelled = false;
  let started!: () => void;
  const reading = new Promise<void>(resolve => { started = resolve; });
  try {
    const downloading = downloadReleaseArchive(candidate, { parent, signal: abort.signal, progress: () => started(), fetcher: async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(bytes.subarray(0, 2)); },
      cancel() { cancelled = true; },
    })) });
    await reading;
    abort.abort();
    await assert.rejects(downloading, { name: "AbortError" });
    assert.equal(cancelled, true);
    assert.deepEqual(await fs.readdir(parent), []);
    const retry = await downloadReleaseArchive(candidate, { parent, signal: new AbortController().signal, progress: () => {}, fetcher: async () => new Response(bytes) });
    await retry.dispose();
  } finally { await fs.rm(parent, { recursive: true, force: true }); }
});

test("destination creation failure cancels the response before returning the filesystem error", async () => {
  const parent = tmpdir("update-download-");
  let cancelled = false;
  try {
    await assert.rejects(downloadReleaseArchive(candidate, { parent, signal: new AbortController().signal, progress: () => {}, fetcher: async () => {
      const [directory] = await fs.readdir(parent);
      await fs.writeFile(path.join(parent, directory!, "update.zip"), "occupied");
      return new Response(new ReadableStream({ cancel() { cancelled = true; } }));
    } }), { code: "EEXIST" });
    assert.equal(cancelled, true);
    assert.deepEqual(await fs.readdir(parent), []);
  } finally { await fs.rm(parent, { recursive: true, force: true }); }
});
