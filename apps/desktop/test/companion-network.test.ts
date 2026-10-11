import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import type { TLSSocket } from "node:tls";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { CompanionServer } from "../src/main/engine/companion.js";
import type { CompanionAdvertisement } from "../src/main/engine/companion-discovery.js";
import { DEFAULT_SETTINGS } from "../src/main/engine/store.js";

// Loopback + an actual LAN socket test listener isolation on macOS, where 127.0.0.2 is
// not implicitly bound. This is NOT physical secondary-network acceptance.
const lan = Object.values(os.networkInterfaces()).flat().find((entry) => entry?.family === "IPv4" && !entry.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(entry.address))?.address;
const source = { state: () => ({ version: 1 as const, projects: [], threads: [], settings: DEFAULT_SETTINGS }),
  items: () => [], status: () => "idle", send: async () => ({ ok: true }), answer: () => {} };
const decode = (uri: string) => JSON.parse(Buffer.from(new URL(uri).searchParams.get("data")!, "base64url").toString()) as { url: string; token: string; fingerprint: string };
const request = (url: string, token: string, agent?: https.Agent) => new Promise<{ code: number; socket: unknown; fingerprint: string }>((resolve, reject) => {
  const req = https.get(`${url}/v1/snapshot`, { rejectUnauthorized: false, agent, headers: { authorization: `Bearer ${token}` } }, (res) => {
    const socket = res.socket as TLSSocket;
    const fingerprint = crypto.createHash("sha256").update(socket.getPeerCertificate(true).raw).digest("hex");
    res.resume();
    res.on("end", () => resolve({ code: res.statusCode!, socket, fingerprint }));
  });
  req.on("error", reject);
  req.setTimeout(2000, () => req.destroy(new Error("request timed out")));
});

test("each supported address has a reachable advertised listener; removing one preserves the other connection", { skip: !lan }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "modex-net-"));
  let addresses = ["127.0.0.1", lan!];
  const advertisements = new Map<string, CompanionAdvertisement>();
  const server = new CompanionServer(home, source, () => addresses, (ad) => {
    advertisements.set(ad.host, ad);
    return () => { advertisements.delete(ad.host); };
  });
  const agent = new https.Agent({ keepAlive: true, maxSockets: 1 });
  try {
    const initial = decode((await server.start()).pairingUri!);
    assert.equal(advertisements.size, 2, "secondary LAN must be advertised and listening");
    const secondary = advertisements.get(lan!)!;
    const secondaryUrl = `https://${secondary.host}:${secondary.port}`;
    const first = await request(secondaryUrl, initial.token, agent);
    assert.equal(first.code, 200);
    assert.equal(first.fingerprint, initial.fingerprint);
    assert.equal(secondary.fingerprint, initial.fingerprint);
    assert.ok(!JSON.stringify([...advertisements.values()]).includes(initial.token));
    // Losing the preferred interface must not reset an established secondary connection.
    addresses = [lan!];
    await server.refreshNetwork();
    const second = await request(secondaryUrl, initial.token, agent);
    assert.equal(second.socket, first.socket);
    assert.equal(advertisements.size, 1);
    await assert.rejects(request(initial.url, initial.token));
    const moved = decode(server.status().pairingUri!);
    assert.equal(moved.url, secondaryUrl);
    assert.equal(moved.token, initial.token);
    assert.equal(moved.fingerprint, initial.fingerprint);
    // DHCP/interface return: add only the missing listener, preserving the active socket.
    addresses = ["127.0.0.1", lan!, lan!];
    await server.refreshNetwork();
    assert.equal(advertisements.size, 2);
    assert.equal((await request(secondaryUrl, initial.token, agent)).socket, first.socket);
    server.resetAccess();
    for (const ad of advertisements.values()) assert.equal((await request(`https://${ad.host}:${ad.port}`, initial.token)).code, 401);
  } finally {
    agent.destroy();
    await server.stop();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a failed address does not prevent a healthy address from starting or recovering", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "modex-net-failure-"));
  const server = new CompanionServer(home, source, () => ["192.0.2.1", "127.0.0.1"], () => () => {});
  try {
    const pairing = decode((await server.start()).pairingUri!);
    assert.match(pairing.url, /^https:\/\/127\.0\.0\.1:/);
    assert.equal((await request(pairing.url, pairing.token)).code, 200);
    await server.refreshNetwork();
    assert.equal((await request(pairing.url, pairing.token)).code, 200);
  } finally { await server.stop(); fs.rmSync(home, { recursive: true, force: true }); }
});

test("shutdown closes a TCP socket that has not completed TLS", { timeout: 5000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "modex-net-close-"));
  const server = new CompanionServer(home, source, () => ["127.0.0.1"], () => () => {});
  let socket: net.Socket | undefined;
  try {
    const status = await server.start();
    socket = net.connect(status.port!, "127.0.0.1");
    await new Promise<void>((resolve, reject) => { socket!.once("connect", resolve); socket!.once("error", reject); });
    // The successful connect puts the accepted connection ahead of dispose in the I/O queue.
    await new Promise<void>((resolve) => setImmediate(resolve));
    const deadline = setTimeout(() => socket?.destroy(), 2500);
    const start = Date.now();
    await server.dispose();
    clearTimeout(deadline);
    assert.ok(Date.now() - start < 2000, "dispose waited for an unfinished TLS handshake");
  } finally { socket?.destroy(); await server.stop(); fs.rmSync(home, { recursive: true, force: true }); }
});

test("supported address selection excludes public, CGNAT, link-local, internal and IPv6 addresses", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "modex-net-select-"));
  const ipv4 = (address: string, internal = false): os.NetworkInterfaceInfoIPv4 => ({ address, internal, family: "IPv4", cidr: null, netmask: "255.255.255.0", mac: "00:00:00:00:00:00" });
  t.mock.method(os, "networkInterfaces", () => ({
    en0: [ipv4("10.1.2.3"), ipv4("8.8.8.8")], en1: [ipv4("192.168.2.3")],
    other: [ipv4("172.16.0.2"), ipv4("172.31.0.2"), ipv4("172.32.0.2"), ipv4("100.64.0.2"), ipv4("169.254.1.2"), ipv4("127.0.0.1", true),
      { ...ipv4("fd00::1"), family: "IPv6", scopeid: 1 }],
  }));
  try {
    const server = new CompanionServer(home, source);
    assert.deepEqual(server.status().addresses, ["10.1.2.3", "192.168.2.3", "172.16.0.2", "172.31.0.2"]);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("the production listener never accepts the excluded loopback endpoint", { skip: !lan }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "modex-net-excluded-"));
  const server = new CompanionServer(home, source, undefined, () => () => {});
  try {
    const pairing = decode((await server.start()).pairingUri!);
    assert.equal((await request(pairing.url, pairing.token)).code, 200);
    await assert.rejects(request(`https://127.0.0.1:${new URL(pairing.url).port}`, pairing.token));
  } finally { await server.stop(); fs.rmSync(home, { recursive: true, force: true }); }
});

test("an occupied port on a new interface does not move or disconnect the existing interface", { skip: !lan }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "modex-net-port-"));
  let addresses = ["127.0.0.1"];
  const server = new CompanionServer(home, source, () => addresses, () => () => {});
  const blocker = net.createServer();
  const agent = new https.Agent({ keepAlive: true, maxSockets: 1 });
  try {
    const first = await server.start();
    const pairing = decode(first.pairingUri!);
    const connected = await request(pairing.url, pairing.token, agent);
    await new Promise<void>((resolve, reject) => { blocker.once("error", reject); blocker.listen(first.port, lan!, resolve); });
    addresses = ["127.0.0.1", lan!];
    await server.refreshNetwork();
    const endpoints = server.status().endpoints!;
    assert.equal(endpoints.length, 2);
    assert.notEqual(endpoints[1]!.port, first.port);
    assert.equal(decode(endpoints[0]!.pairingUri).url, pairing.url);
    assert.equal((await request(pairing.url, pairing.token, agent)).socket, connected.socket);
    const secondary = decode(endpoints[1]!.pairingUri);
    assert.equal((await request(secondary.url, secondary.token)).code, 200);
  } finally {
    agent.destroy(); await server.stop();
    if (blocker.listening) await new Promise<void>((resolve) => blocker.close(() => resolve()));
    fs.rmSync(home, { recursive: true, force: true });
  }
});

for (const shutdown of ["stop", "dispose"] as const) {
  test(`${shutdown} wins while adding another listener`, { skip: !lan }, async (t) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "modex-net-race-"));
    let addresses = ["127.0.0.1"];
    const published = new Set<string>();
    const server = new CompanionServer(home, source, () => addresses, (ad) => {
      published.add(ad.host); return () => { published.delete(ad.host); };
    });
    try {
      await server.start();
      let entered!: () => void;
      let release!: () => void;
      let pendingPort = 0;
      const bound = new Promise<void>((resolve) => { entered = resolve; });
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const listen = https.Server.prototype.listen;
      t.mock.method(https.Server.prototype, "listen", function (this: https.Server, port: number, host: string, ready: () => void) {
        return Reflect.apply(listen, this, [port, host, () => {
          pendingPort = (this.address() as net.AddressInfo).port;
          entered();
          void gate.then(ready);
        }]);
      });
      addresses.push(lan!);
      const refreshing = server.refreshNetwork();
      await bound; // The new socket really is bound, but cannot yet join the active listeners.
      const stopping = server[shutdown]();
      release();
      await Promise.all([refreshing, stopping]);
      await assert.rejects(request(`https://${lan!}:${pendingPort}`, "0".repeat(64)));
      assert.equal(published.size, 0);
      assert.equal(server.status().pairingUri, undefined);
      await server.refreshNetwork();
      assert.equal(published.size, 0);
    } finally { await server.stop(); fs.rmSync(home, { recursive: true, force: true }); }
  });
}
