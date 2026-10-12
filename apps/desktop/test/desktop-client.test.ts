import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import https from "node:https";
import type { ServerResponse } from "node:http";
import { execFileSync } from "node:child_process";
import { DesktopClient, pinnedDesktopCertificate, type DesktopCredentials } from "../src/main/engine/desktop-client.js";
import { DESKTOP_PROTOCOL } from "../src/shared/desktop-protocol.js";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check: () => boolean) {
  for (let attempt = 0; attempt < 250 && !check(); attempt++) await sleep(20);
  assert.equal(check(), true);
}
async function fixture(san = "IP:127.0.0.1") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "modex-client-recovery-"));
  const key = path.join(dir, "key.pem"), cert = path.join(dir, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-days", "2", "-subj", "/CN=Modex test", "-addext", `subjectAltName=${san}`, "-keyout", key, "-out", cert], { stdio: "ignore" });
  const certificate = new crypto.X509Certificate(fs.readFileSync(cert));
  let mode: "ok" | "events409" | "protocol" | "protocolNull" | "invoke409" | "invoke401" = "ok";
  const requests: string[] = [], streams = new Set<ServerResponse>();
  const connections = { tls: 0 };
  let hold = false;
  let response: unknown = { value: "ok", error: "Host protocol mismatch" };
  const pending: ServerResponse[] = [];
  const server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (req, res) => {
    requests.push(req.url!);
    if (req.url === "/events") {
      if (mode === "events409") { res.writeHead(409); res.end(); return; }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      streams.add(res); res.once("close", () => streams.delete(res));
      res.write(`event: connected\ndata: ${JSON.stringify(mode === "protocolNull" ? null : { protocol: mode === "protocol" ? DESKTOP_PROTOCOL + 1 : DESKTOP_PROTOCOL })}\n\n`);
    } else if (hold) pending.push(res);
    else { res.writeHead(mode === "invoke409" ? 409 : mode === "invoke401" ? 401 : 200); res.end(JSON.stringify(response)); }
  });
  server.on("secureConnection", () => { connections.tls++; });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const credentials: DesktopCredentials = { port: (server.address() as { port: number }).port, fingerprint: crypto.createHash("sha256").update(certificate.raw).digest("hex"), clientId: "a".repeat(64), token: "b".repeat(64) };
  return { credentials, certificate, requests, streams, pending, connections,
    mode(value: typeof mode) { mode = value; }, response(value: unknown) { response = value; }, hold() { hold = true; },
    async close() { for (const stream of streams) stream.destroy(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

for (const failure of ["pin", "expired", "future", "hostname"] as const) test(`${failure} identity failure stops retries and sends no authenticated HTTP`, async t => {
  const host = await fixture(failure === "hostname" ? "DNS:other.invalid" : undefined);
  const credentials = { ...host.credentials, ...(failure === "pin" ? { fingerprint: "0".repeat(64) } : {}) };
  const saves: (DesktopCredentials | undefined)[] = [];
  const client = new DesktopClient(value => saves.push(value));
  try {
    if (failure === "expired") t.mock.method(Date, "now", () => Date.parse(host.certificate.validTo) + 1000);
    if (failure === "future") t.mock.method(Date, "now", () => Date.parse(host.certificate.validFrom) - 1000);
    await assert.rejects(pinnedDesktopCertificate(credentials.port, credentials.fingerprint), error => (error as Error).name === "DesktopIdentityError");
    client.start(credentials);
    await waitFor(() => client.status().state !== "connecting");
    assert.partialDeepStrictEqual(client.status(), { state: "recovery", reason: "identity" });
    await assert.rejects(client.invoke("thread:send", {}), /disconnected/);
    const probes = host.connections.tls;
    await sleep(700);
    assert.equal(host.connections.tls, probes);
    assert.partialDeepStrictEqual(client.status(), { state: "recovery", reason: "identity" });
    assert.deepEqual(host.requests, []);
    assert.deepEqual(saves, []);
    client.retry();
    await waitFor(() => client.status().state !== "connecting");
    assert.partialDeepStrictEqual(client.status(), { state: "recovery", reason: "identity" });
    assert.deepEqual(host.requests, []);
    client.disconnect();
    assert.deepEqual(saves, [undefined]);
  } finally { client.dispose(); await host.close(); }
});

for (const failure of ["events409", "protocol", "protocolNull", "invoke409"] as const) test(`${failure} requires explicit retry, keeps access and never replays commands`, async () => {
  const host = await fixture();
  const saves: (DesktopCredentials | undefined)[] = [];
  const client = new DesktopClient(value => saves.push(value));
  try {
    if (failure !== "invoke409") host.mode(failure);
    client.start(host.credentials);
    await waitFor(() => client.status().state !== "connecting");
    if (failure === "invoke409") {
      assert.equal(client.status().state, "connected");
      host.mode(failure);
      await assert.rejects(client.invoke("thread:send", { text: "send once" }), /protocol/);
    }
    assert.partialDeepStrictEqual(client.status(), { state: "recovery", reason: "protocol" });
    await waitFor(() => host.streams.size === 0);
    await assert.rejects(client.invoke("thread:send", {}), /disconnected/);
    const count = host.requests.length;
    host.mode("ok");
    await sleep(700);
    assert.equal(host.requests.length, count);
    assert.deepEqual(saves, []);
    client.retry();
    await waitFor(() => client.status().state === "connected");
    assert.equal(host.requests.filter(endpoint => endpoint === "/invoke").length, failure === "invoke409" ? 1 : 0);
    assert.equal(await client.invoke("state:get", undefined), "ok");
  } finally { client.dispose(); await host.close(); }
});

test("stale command failures cannot revoke or stop a newer saved connection", async () => {
  const host = await fixture();
  const saves: (DesktopCredentials | undefined)[] = [];
  const client = new DesktopClient(value => saves.push(value));
  try {
    client.start(host.credentials); await waitFor(() => client.status().state === "connected");
    host.hold();
    const first = assert.rejects(client.invoke("thread:send", {}));
    const second = assert.rejects(client.invoke("thread:send", {}));
    await waitFor(() => host.pending.length === 2);
    client.start(host.credentials); await waitFor(() => client.status().state === "connected");
    host.pending[0]!.writeHead(401); host.pending[0]!.end(JSON.stringify({ error: "revoked" }));
    host.pending[1]!.writeHead(409); host.pending[1]!.end(JSON.stringify({ error: "protocol" }));
    await Promise.all([first, second]);
    assert.equal(client.status().state, "connected");
    assert.deepEqual(saves, []);
  } finally { client.dispose(); await host.close(); }
});


for (const status of [401, 409]) test(`HTTP ${status} with a null error body still changes access state`, async () => {
  const host = await fixture();
  const saves: (DesktopCredentials | undefined)[] = [];
  const client = new DesktopClient(value => saves.push(value));
  try {
    client.start(host.credentials); await waitFor(() => client.status().state === "connected");
    host.mode(status === 401 ? "invoke401" : "invoke409"); host.response(null);
    await assert.rejects(client.invoke("thread:send", {}));
    assert.equal(client.status().state, status === 401 ? "unpaired" : "recovery");
    assert.deepEqual(saves, status === 401 ? [undefined] : []);
  } finally { client.dispose(); await host.close(); }
});
