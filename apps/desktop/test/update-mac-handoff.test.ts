import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { MacUpdateHandoff } from "../src/main/engine/update-mac-handoff.js";
import { tmpdir } from "./helpers.js";

class NativeUpdater extends EventEmitter {
  feed = "";
  checks = 0;
  started!: () => void;
  readonly checked = new Promise<void>(resolve => { this.started = resolve; });
  setFeedURL(input: { url: string }): void { this.feed = input.url; }
  checkForUpdates(): void { this.checks++; this.started(); }
}
async function fixture() {
  const dir = tmpdir("mac-handoff-");
  const archive = path.join(dir, "verified.zip");
  const bytes = Buffer.from("already verified private ZIP snapshot");
  await fs.writeFile(archive, bytes, { mode: 0o600 });
  return { dir, bytes, candidate: { archive, version: "0.0.11", size: bytes.length, sha512: createHash("sha512").update(bytes).digest("base64") } };
}

test("native handoff serves only exact capability routes from its verified open snapshot", async () => {
  const f = await fixture();
  const native = new NativeUpdater();
  let receipted = false;
  const handoff = new MacUpdateHandoff(native, () => {}, 2_000);
  const result = handoff.stage(f.candidate, async receipt => {
    assert.equal(native.checks, 0);
    assert.equal(receipt.version, "0.0.11");
    receipted = true;
  });
  try {
    await native.checked;
    assert.equal(receipted, true);
    assert.equal(new URL(native.feed).hostname, "127.0.0.1");
    assert.equal((await fetch(new URL("/", native.feed))).status, 404);
    assert.equal((await fetch(native.feed, { method: "POST" })).status, 405);
    const feed = await (await fetch(native.feed)).json() as { url: string; name: string };
    assert.equal(feed.name, f.candidate.version);
    assert.equal((await fetch(feed.url + "/extra")).status, 404);
    await fs.rename(f.candidate.archive, f.candidate.archive + ".old");
    await fs.writeFile(f.candidate.archive, "replaced cache pathname");
    assert.deepEqual(Buffer.from(await (await fetch(feed.url)).arrayBuffer()), f.bytes);
    native.emit("update-downloaded", {}, "", feed.name, new Date(), feed.url);
    assert.equal(await result, "staged");
    assert.equal(handoff.state, "staged");
    await assert.rejects(handoff.stage(f.candidate, async () => {}), /already/i);
    assert.equal(native.checks, 1);
  } finally {
    native.emit("error", new Error("test cleanup"));
    await result;
    await fs.rm(f.dir, { recursive: true, force: true });
  }
});

test("native timeout remains uncertain and a late matching event never starts another attempt", async () => {
  const f = await fixture();
  const native = new NativeUpdater();
  const states: string[] = [];
  const handoff = new MacUpdateHandoff(native, state => states.push(state), 100);
  try {
    const result = handoff.stage(f.candidate, async () => {});
    await native.checked;
    const feed = await (await fetch(native.feed)).json() as { url: string };
    native.emit("update-downloaded", {}, "", "0.0.11", new Date(), "https://unrelated.example/update.zip");
    assert.equal(await result, "uncertain");
    assert.equal(handoff.state, "uncertain");
    native.emit("update-downloaded", {}, "", "0.0.11", new Date(), feed.url);
    assert.equal(handoff.state, "staged");
    native.emit("error", new Error("late unrelated error"));
    assert.equal(handoff.state, "staged");
    await assert.rejects(handoff.stage(f.candidate, async () => {}), /already/i);
    assert.equal(native.checks, 1);
    assert.deepEqual(states, ["preparing", "staging", "uncertain", "staged"]);
  } finally { await fs.rm(f.dir, { recursive: true, force: true }); }
});

test("native errors cannot claim cancellation after checkForUpdates", async () => {
  const f = await fixture();
  const native = new NativeUpdater();
  const handoff = new MacUpdateHandoff(native, () => {});
  try {
    const result = handoff.stage(f.candidate, async () => {});
    await native.checked;
    native.emit("error", new Error("may have written ShipIt receipt already"));
    assert.equal(await result, "uncertain");
    assert.equal(handoff.state, "uncertain");
    await assert.rejects(handoff.stage(f.candidate, async () => {}), /already/i);
  } finally { await fs.rm(f.dir, { recursive: true, force: true }); }
});

test("snapshot integrity and durable receipt failures abort before native admission and allow retry", async () => {
  const f = await fixture();
  const native = new NativeUpdater();
  const handoff = new MacUpdateHandoff(native, () => {});
  try {
    await assert.rejects(handoff.stage({ ...f.candidate, sha512: Buffer.alloc(64).toString("base64") }, async () => {}), /integrity/i);
    assert.equal(native.checks, 0);
    assert.equal(handoff.state, "idle");
    await assert.rejects(handoff.stage(f.candidate, async () => { throw new Error("receipt not saved"); }), /receipt not saved/);
    assert.equal(native.checks, 0);
    const result = handoff.stage(f.candidate, async () => {});
    await native.checked;
    native.emit("error", new Error("test cleanup"));
    assert.equal(await result, "uncertain");
  } finally { await fs.rm(f.dir, { recursive: true, force: true }); }
});

test("reentrant preparation shares one attempt and synchronous native failure remains uncertain", async () => {
  const f = await fixture();
  const native = new NativeUpdater();
  native.checkForUpdates = () => { native.checks++; throw new Error("native call failed after admission"); };
  let nested: Promise<string> | undefined;
  const handoff = new MacUpdateHandoff(native, state => {
    if (state === "preparing") nested = handoff.stage(f.candidate, async () => assert.fail("duplicate receipt"));
  });
  try {
    const result = handoff.stage(f.candidate, async () => {});
    assert.equal(await result, "uncertain");
    assert.equal(nested, result);
    assert.equal(native.checks, 1);
  } finally { await fs.rm(f.dir, { recursive: true, force: true }); }
});

test("native no-update cannot reset the committed attempt to cancelable idle", async () => {
  const f = await fixture();
  const native = new NativeUpdater();
  const handoff = new MacUpdateHandoff(native, () => {});
  try {
    const result = handoff.stage(f.candidate, async () => {});
    await native.checked;
    native.emit("update-not-available");
    assert.equal(await result, "uncertain");
    await assert.rejects(handoff.stage(f.candidate, async () => {}), /already/i);
  } finally { await fs.rm(f.dir, { recursive: true, force: true }); }
});

test("synchronous feed initialization errors stay reversible and never invoke native checking", async () => {
  const f = await fixture();
  const native = new NativeUpdater();
  native.setFeedURL = () => { native.emit("error", new Error("SQRLUpdater initialization failed")); };
  native.checkForUpdates = () => { native.checks++; throw new Error("must not call check"); };
  const handoff = new MacUpdateHandoff(native, () => {});
  try {
    await assert.rejects(handoff.stage(f.candidate, async () => {}), /feed.*initial/i);
    assert.equal(handoff.state, "idle");
    assert.equal(native.checks, 0);
    native.setFeedURL = input => { native.feed = input.url; };
    native.checkForUpdates = () => { native.checks++; native.started(); };
    const result = handoff.stage(f.candidate, async () => {});
    await native.checked;
    native.emit("error", new Error("test cleanup"));
    assert.equal(await result, "uncertain");
  } finally { await fs.rm(f.dir, { recursive: true, force: true }); }
});
