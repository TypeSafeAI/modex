import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { isLoopbackAddress, loopbackLookup, parseLocalEndpoint, localGet, type LocalGetFailure } from "../src/main/engine/local-models/endpoint-policy.js";

/** LM-2 (#378) AC2: only explicitly configured same-machine HTTP(S) origins are reachable. */

test("accepts loopback HTTP(S) origins and normalizes IPv4 and IPv6 spellings", () => {
  const cases: [string, string][] = [
    ["http://127.0.0.1:11434", "http://127.0.0.1:11434"],
    ["http://localhost:1234/", "http://localhost:1234"],
    ["HTTP://LOCALHOST:1234", "http://localhost:1234"],
    ["http://127.1:8080", "http://127.0.0.1:8080"],
    ["http://0x7f.0.0.1:8080", "http://127.0.0.1:8080"],
    ["http://2130706433:8080", "http://127.0.0.1:8080"],
    ["http://127.255.0.9:8080", "http://127.255.0.9:8080"],
    ["http://[::1]:8000", "http://[::1]:8000"],
    ["http://[0:0:0:0:0:0:0:1]:8000", "http://[::1]:8000"],
    ["http://[::ffff:127.0.0.1]:8000", "http://[::ffff:7f00:1]:8000"],
    ["https://localhost:8443", "https://localhost:8443"],
    ["http://localhost", "http://localhost"],
    ["http://0177.0.0.1:8080", "http://127.0.0.1:8080"],
    ["http://127.0.0.1.:8080", "http://127.0.0.1:8080"],
    ["http://ｌｏｃａｌｈｏｓｔ:11434", "http://localhost:11434"],
  ];
  for (const [input, origin] of cases) {
    const parsed = parseLocalEndpoint(input);
    assert.ok(parsed.ok, `${input} is accepted`);
    if (parsed.ok) assert.equal(parsed.endpoint.origin, origin, input);
  }
  const v1 = parseLocalEndpoint("http://127.0.0.1:8080/v1", { allowV1: true });
  assert.ok(v1.ok && v1.endpoint.basePath === "/v1");
});

test("refuses non-loopback hosts, schemes, credentials, queries, fragments and unexpected paths", () => {
  const refused = [
    "", "   ", "not a url", "127.0.0.1:11434", "//127.0.0.1:1",
    "ftp://127.0.0.1/", "file:///etc/passwd", "ws://127.0.0.1:1", "javascript:alert(1)", "data:text/plain,x",
    "http://0.0.0.0:11434", "http://[::]:1", "http://10.0.0.5:11434", "http://192.168.1.4:1234", "http://169.254.169.254/",
    "http://example.com", "http://localhost.example.com", "http://127.0.0.1.nip.io", "http://localtest.me",
    "http://[::ffff:10.0.0.1]:1", "http://[fe80::1]:1", "http://[2001:db8::1]:1",
    "http://user:pass@127.0.0.1:1", "http://token@localhost:1", "http://127.0.0.1:1?x=1", "http://127.0.0.1:1/#a",
    "http://127.0.0.1:1/api/tags", "http://127.0.0.1:1/v1", "http://127.0.0.1:1/v1/../admin", "http://127.0.0.1:1/%2e%2e/",
    "http://127.0.0.1@evil.example:80", "http://evil.example\\@127.0.0.1", "http://127.0.0.1\n.evil", "http://127.0.0.1:0",
    // IPv4-compatible, NAT64 and other embeddings of 127.0.0.1 are not loopback; neither is a dotted localhost.
    "http://[::127.0.0.1]:1", "http://[64:ff9b::7f00:1]:1", "http://[::ffff:0:127.0.0.1]:1", "http://localhost.:1", "http://127.0.0.1:65536",
  ];
  for (const input of refused) assert.equal(parseLocalEndpoint(input).ok, false, `${JSON.stringify(input)} is refused`);
  assert.equal(parseLocalEndpoint("http://127.0.0.1:1/v2", { allowV1: true }).ok, false);
  assert.equal(parseLocalEndpoint(42 as unknown as string).ok, false);
  assert.equal(parseLocalEndpoint("http://127.0.0.1:1/" + "a".repeat(3000)).ok, false);
  // Refusals never echo the input back: it could carry a password.
  const refusal = parseLocalEndpoint("http://user:hunter2@127.0.0.1:1");
  assert.ok(!refusal.ok && !refusal.reason.includes("hunter2"));
});

test("only loopback addresses count as loopback", () => {
  for (const a of ["127.0.0.1", "127.9.8.7", "::1", "::ffff:127.0.0.1", "::ffff:7f00:1"]) assert.equal(isLoopbackAddress(a), true, a);
  for (const a of ["0.0.0.0", "::", "10.0.0.1", "::ffff:10.0.0.1", "fe80::1", "128.0.0.1", "", "localhost"]) assert.equal(isLoopbackAddress(a), false, a);
});

test("a hostname that resolves anywhere but loopback is refused at connect time", async () => {
  const lookup = loopbackLookup((_host, _options, done) => done(null, [{ address: "127.0.0.1", family: 4 }, { address: "10.0.0.7", family: 4 }]));
  const err = await new Promise<NodeJS.ErrnoException | null>(resolve => lookup("localhost", { all: true }, (e) => resolve(e)));
  assert.ok(err, "a mixed answer is refused, not filtered");
  const ok = loopbackLookup((_host, _options, done) => done(null, [{ address: "::1", family: 6 }]));
  const answer = await new Promise<unknown>(resolve => ok("localhost", { all: true }, (e, a) => resolve(e ?? a)));
  assert.deepEqual(answer, [{ address: "::1", family: 6 }]);
  const single = await new Promise<unknown>(resolve => ok("localhost", {}, (e, a, f) => resolve(e ?? [a, f])));
  assert.deepEqual(single, ["::1", 6]);
});

async function server(handler: http.RequestListener): Promise<{ origin: string; close: () => Promise<void>; hits: string[] }> {
  const hits: string[] = [];
  const s = http.createServer((req, res) => { hits.push(`${req.method} ${req.url}`); handler(req, res); });
  await new Promise<void>(resolve => s.listen(0, "127.0.0.1", resolve));
  const { port } = s.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${port}`, hits, close: () => new Promise(resolve => { s.closeAllConnections(); s.close(() => resolve()); }) };
}

const endpoint = (origin: string) => { const p = parseLocalEndpoint(origin); assert.ok(p.ok); return p.endpoint; };
const reason = async (p: Promise<unknown>) => { try { await p; return "ok"; } catch (e) { return (e as LocalGetFailure).reason; } };

test("bounded GETs: redirects, oversize bodies, slow answers and cancellation fail closed", async () => {
  const s = await server((req, res) => {
    if (req.url === "/redirect") { res.writeHead(302, { location: "http://10.0.0.7/" }); res.end(); return; }
    if (req.url === "/big") { res.writeHead(200, { "content-type": "application/json" }); res.end("x".repeat(70_000)); return; }
    if (req.url === "/slow") { setTimeout(() => res.end("{}"), 2_000); return; }
    if (req.url === "/auth") { res.end(JSON.stringify({ auth: req.headers.authorization ?? null, cookie: req.headers.cookie ?? null })); return; }
    if (req.url === "/denied") { res.writeHead(401); res.end("Bearer token-secret-xyz is wrong"); return; }
    if (req.url === "/ok") { res.end('{"path":"/ok"}'); return; }
    res.writeHead(404); res.end();
  });
  try {
    const e = endpoint(s.origin);
    assert.deepEqual(await localGet(e, "/ok", { maxBytes: 1024, timeoutMs: 1000 }), { path: "/ok" });
    assert.equal(await reason(localGet(e, "/redirect", { maxBytes: 1024, timeoutMs: 1000 })), "redirect");
    assert.equal(await reason(localGet(e, "/big", { maxBytes: 64_000, timeoutMs: 1000 })), "too-large");
    assert.equal(await reason(localGet(e, "/slow", { maxBytes: 1024, timeoutMs: 100 })), "timeout");
    const abort = new AbortController();
    const pending = localGet(e, "/slow", { maxBytes: 1024, timeoutMs: 5000, signal: abort.signal });
    abort.abort();
    assert.equal(await reason(pending), "cancelled");
    assert.deepEqual(await localGet(e, "/auth", { maxBytes: 1024, timeoutMs: 1000, token: "tok-1" }), { auth: "Bearer tok-1", cookie: null });
    assert.deepEqual(await localGet(e, "/auth", { maxBytes: 1024, timeoutMs: 1000 }), { auth: null, cookie: null });
    const denied = await localGet(e, "/denied", { maxBytes: 1024, timeoutMs: 1000, token: "token-secret-xyz" }).catch(err => err as LocalGetFailure);
    assert.equal((denied as LocalGetFailure).reason, "unauthorized");
    assert.equal(String((denied as Error).message).includes("token-secret-xyz"), false, "server text is never quoted");
    // Paths are fixed by the adapter; anything that could leave the base path is refused before a request.
    for (const bad of ["api/tags", "//evil/x", "/../x", "/a?b", "/a#b", "http://10.0.0.1/"]) assert.equal(await reason(localGet(e, bad, { maxBytes: 1024, timeoutMs: 1000 })), "invalid", bad);
    assert.equal(s.hits.filter(h => h.includes("evil") || h.includes("..")).length, 0);
  } finally { await s.close(); }
});

test("an unreachable or non-JSON server is a typed failure, not a crash", async () => {
  const s = await server((_req, res) => res.end("<html>nope</html>"));
  const e = endpoint(s.origin);
  assert.equal(await reason(localGet(e, "/x", { maxBytes: 1024, timeoutMs: 1000 })), "malformed");
  await s.close();
  assert.equal(await reason(localGet(e, "/x", { maxBytes: 1024, timeoutMs: 1000 })), "unavailable");
});
