import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { DesktopHost } from "../src/main/engine/desktop-host.js";
import { DesktopClient, parseDesktopInvitation, type DesktopCredentials } from "../src/main/engine/desktop-client.js";

async function connected(client: DesktopClient): Promise<void> {
  if (client.status().state === "connected") return;
  await once(client, "connected", { signal: AbortSignal.timeout(5000) });
}

test("desktop authority pairs once, persists over host restart, streams and is revoked", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "modex-desktop-host-test-"));
  let credentials: DesktopCredentials | undefined;
  const client = new DesktopClient((value) => { credentials = value; });
  let host = new DesktopHost(home, { version: "0.0.7", channels: () => ["echo"], async invoke(_channel, payload, authorized) { assert.ok(authorized()); return payload; } });
  try {
    await host.start(); const uri = host.invite();
    const invite = parseDesktopInvitation(uri); assert.ok(invite.port > 0);
    await client.pair(uri, "a".repeat(64)); await connected(client);
    assert.deepEqual(await client.invoke("echo", { text: "hello" }), { text: "hello" });
    await assert.rejects(client.invoke("unknown", {}), /Unknown desktop command/);
    const second = new DesktopClient(() => {});
    await assert.rejects(second.pair(uri, "b".repeat(64)), /new connection link/);
    second.dispose();
    assert.ok(credentials?.token);
    assert.ok(!fs.readFileSync(path.join(home, "desktop-host", "clients.json"), "utf8").includes(credentials.token));
    const event = once(client, "thread", { signal: AbortSignal.timeout(2000) });
    host.broadcast("thread", { threadId: "t1", type: "status", status: "idle" });
    assert.deepEqual((await event)[0], { threadId: "t1", type: "status", status: "idle" });
    await host.dispose();
    host = new DesktopHost(home, { version: "0.0.7", channels: () => ["echo"], async invoke(_channel, payload) { return payload; } });
    await host.start();
    await new Promise((resolve) => setTimeout(resolve, 600)); await connected(client);
    assert.equal(await client.invoke("echo", "after restart"), "after restart");
    const removed = new Promise<void>((resolve) => client.on("status", (status) => { if (status.state === "unpaired") resolve(); }));
    host.revoke("a".repeat(64)); await removed;
    assert.equal(credentials, undefined);
    await assert.rejects(client.invoke("echo", "forbidden"), /disconnected/);
  } finally { client.dispose(); await host.dispose(); fs.rmSync(home, { recursive: true, force: true }); }
});

test("wrong certificate pin cannot consume a pairing invitation", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "modex-desktop-pin-test-"));
  const host = new DesktopHost(home, { version: "0.0.7", channels: () => [], async invoke() {} });
  const client = new DesktopClient(() => {});
  try {
    await host.start(); const uri = host.invite();
    const wrong = new URL(uri); wrong.searchParams.set("fingerprint", "0".repeat(64));
    await assert.rejects(client.pair(wrong.href, "a".repeat(64)), /identity changed/);
    assert.equal(host.clients().length, 0);
    await client.pair(uri, "a".repeat(64)); await connected(client);
    assert.equal(host.clients().length, 1);
  } finally { client.dispose(); await host.dispose(); fs.rmSync(home, { recursive: true, force: true }); }
});

test("connection links cannot send credentials to a remote host or accept duplicate fields", () => {
  const query = `port=12345&fingerprint=${"a".repeat(64)}&code=${"b".repeat(64)}`;
  for (const uri of [`https://example.com?${query}`, `modex-desktop://example.com?${query}`, `modex-desktop://pair/path?${query}`, `modex-desktop://pair?${query}&code=${"c".repeat(64)}`, `modex-desktop://pair?${query}#extra`]) assert.throws(() => parseDesktopInvitation(uri));
});
