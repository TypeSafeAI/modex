import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { SecretStore, testCipher } from "../src/main/engine/secrets.js";
import { LocalConnectionStore } from "../src/main/engine/local-models/connections.js";
import { LocalModelDiscovery } from "../src/main/engine/local-models/discovery.js";
import type { DiscoveryResult, LocalModelDescriptor } from "../src/shared/local-connections.js";
import { tmpdir } from "./helpers.js";

/** LM-2 (#378) AC1, AC3–AC6: bounded metadata discovery against fixture runtimes on loopback. */

interface Hit { method: string; url: string; auth: string | null; body: string }
type Route = (req: http.IncomingMessage, body: string) => { status?: number; json?: unknown; raw?: string; delayMs?: number } | undefined;

async function runtime(route: Route) {
  const hits: Hit[] = [];
  const s = http.createServer((req, res) => {
    let body = "";
    req.on("data", c => { body += c; });
    req.on("end", () => {
      hits.push({ method: req.method ?? "", url: req.url ?? "", auth: req.headers.authorization ?? null, body });
      const answer = route(req, body) ?? { status: 404, json: { error: "not found" } };
      const send = () => { res.writeHead(answer.status ?? 200, { "content-type": "application/json" }); res.end(answer.raw ?? JSON.stringify(answer.json)); };
      if (answer.delayMs) setTimeout(send, answer.delayMs); else send();
    });
  });
  await new Promise<void>(resolve => s.listen(0, "127.0.0.1", resolve));
  const { port } = s.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, hits, close: () => new Promise<void>(resolve => { s.closeAllConnections(); s.close(() => resolve()); }) };
}

function setup() {
  const home = tmpdir("modex-lm-");
  const secrets = new SecretStore(home, testCipher);
  // A cloud credential that must never reach a local server.
  secrets.set("typesafe_api_key", "ts-cloud-key-NEVER");
  const store = new LocalConnectionStore(home, secrets);
  return { store, discovery: new LocalModelDiscovery(store, { timeoutMs: 1000 }) };
}

const byId = (result: DiscoveryResult) => Object.fromEntries((result.state === "stale" ? [] : result.models).map(m => [m.model.id, m]));
/** Inference, pulls, loads and unloads: none of these may ever be requested by discovery. */
const FORBIDDEN = /\/(generate|chat|completions|responses|embed|embeddings|pull|push|create|copy|delete|load|unload|blobs)\b/;

const OLLAMA: Route = (req, body) => {
  if (req.method === "GET" && req.url === "/api/tags") return { json: { models: [
    { name: "qwen3-coder:30b", model: "qwen3-coder:30b", details: { family: "qwen3moe" } },
    { name: "nomic-embed-text:latest", model: "nomic-embed-text:latest", details: { family: "nomic-bert" } },
    { name: "gpt-oss:120b-cloud", model: "gpt-oss:120b-cloud", remote_model: "gpt-oss:120b", remote_host: "https://ollama.com:443" },
    { name: "hf.co/Org/My Model:Q4_K_M", model: "hf.co/Org/My Model:Q4_K_M" },
    { name: "bad\u0000id" }, { model: 7 },
  ] } };
  if (req.method === "GET" && req.url === "/api/ps") return { json: { models: [{ name: "qwen3-coder:30b", model: "qwen3-coder:30b", context_length: 8192 }] } };
  if (req.method === "POST" && req.url === "/api/show") {
    const model = (JSON.parse(body) as { model: string }).model;
    if (model === "qwen3-coder:30b") return { json: { capabilities: ["completion", "tools"], model_info: { "qwen3moe.context_length": 262144 } } };
    if (model === "nomic-embed-text:latest") return { json: { capabilities: ["embedding"], model_info: { "nomic-bert.context_length": 2048 } } };
    if (model === "hf.co/Org/My Model:Q4_K_M") return { json: { capabilities: ["completion", "vision", "thinking"] } };
  }
  return undefined;
};

test("Ollama: installed, loaded, kind, advertised capabilities, cloud models and exact IDs", async () => {
  const rt = await runtime(OLLAMA);
  const { store, discovery } = setup();
  try {
    const c = store.create({ label: "Ollama", runtime: "ollama", url: rt.url, manualModels: ["custom:tag", "qwen3-coder:30b"] });
    const result = await discovery.discover({ id: c.id, revision: c.revision }, "r1");
    assert.equal(result.state, "ready");
    const m = byId(result);
    assert.deepEqual(Object.keys(m).sort(), ["custom:tag", "gpt-oss:120b-cloud", "hf.co/Org/My Model:Q4_K_M", "nomic-embed-text:latest", "qwen3-coder:30b"]);
    const coder = m["qwen3-coder:30b"]!;
    assert.deepEqual(coder.model, { connection: { id: c.id, revision: 1 }, id: "qwen3-coder:30b" });
    assert.deepEqual([coder.source, coder.kind, coder.installed, coder.loaded, coder.advertisedContext, coder.locality, coder.selectable], ["discovered", "generative", "yes", "yes", 262144, "unverified", true]);
    assert.deepEqual(coder.advertised, { tools: "advertised", vision: "not-advertised", reasoning: "not-advertised" });
    const embed = m["nomic-embed-text:latest"]!;
    assert.deepEqual([embed.kind, embed.loaded, embed.selectable, embed.unselectableReason], ["embedding", "no", false, "embedding"]);
    const cloud = m["gpt-oss:120b-cloud"]!;
    assert.deepEqual([cloud.locality, cloud.selectable, cloud.unselectableReason, cloud.installed], ["cloud", false, "cloud", "unknown"]);
    const spaced = m["hf.co/Org/My Model:Q4_K_M"]!;
    assert.deepEqual([spaced.kind, spaced.advertised.vision, spaced.advertised.reasoning, spaced.advertised.tools, spaced.advertisedContext], ["generative", "advertised", "advertised", "not-advertised", null]);
    const manual = m["custom:tag"]!;
    assert.deepEqual([manual.source, manual.kind, manual.installed, manual.loaded, manual.selectable], ["manual", "unknown", "unknown", "unknown", true]);

    // Only metadata reads, no cloud model shown, nothing loaded, pulled or run; no credential sent.
    assert.deepEqual(rt.hits.filter(h => FORBIDDEN.test(h.url)), []);
    assert.ok(rt.hits.every(h => (h.method === "GET" && ["/api/tags", "/api/ps"].includes(h.url)) || (h.method === "POST" && h.url === "/api/show")));
    assert.deepEqual(rt.hits.filter(h => h.url === "/api/show").map(h => JSON.parse(h.body).model).sort(), ["hf.co/Org/My Model:Q4_K_M", "nomic-embed-text:latest", "qwen3-coder:30b"], "no /api/show for cloud models or manual IDs");
    assert.ok(rt.hits.every(h => h.auth === null));
    assert.ok(rt.hits.every(h => !h.body.includes("NEVER")));
  } finally { await rt.close(); }
});

test("LM Studio: native listing states and types; authenticated with only its own token", async () => {
  const rt = await runtime((req) => {
    if (req.headers.authorization !== "Bearer lms-tok") return { status: 401, raw: "bad token lms-tok" };
    if (req.url === "/api/v0/models") return { json: { data: [
      { id: "qwen/qwen3-coder-30b", type: "llm", state: "loaded", max_context_length: 262144, capabilities: ["tool_use"] },
      { id: "google/gemma-3-12b", type: "vlm", state: "not-loaded", max_context_length: 131072 },
      { id: "text-embedding-nomic-embed-text-v1.5", type: "embeddings", state: "not-loaded" },
      { id: "some-tts", type: "tts", state: "not-loaded" },
    ] } };
    return undefined;
  });
  const { store, discovery } = setup();
  try {
    const c = store.create({ label: "LM Studio", runtime: "lmstudio", url: rt.url, token: "lms-tok" });
    const result = await discovery.discover({ id: c.id, revision: 1 }, "r1");
    assert.equal(result.state, "ready");
    const m = byId(result);
    assert.deepEqual([m["qwen/qwen3-coder-30b"]!.loaded, m["qwen/qwen3-coder-30b"]!.advertised.tools, m["qwen/qwen3-coder-30b"]!.advertisedContext], ["yes", "advertised", 262144]);
    assert.deepEqual([m["google/gemma-3-12b"]!.loaded, m["google/gemma-3-12b"]!.advertised.vision, m["google/gemma-3-12b"]!.advertised.tools], ["no", "advertised", "unknown"]);
    assert.deepEqual([m["text-embedding-nomic-embed-text-v1.5"]!.kind, m["text-embedding-nomic-embed-text-v1.5"]!.selectable], ["embedding", false]);
    assert.deepEqual([m["some-tts"]!.kind, m["some-tts"]!.selectable, m["some-tts"]!.unselectableReason], ["other", false, "other"]);
    assert.deepEqual(rt.hits.map(h => `${h.method} ${h.url} ${h.auth}`), ["GET /api/v0/models Bearer lms-tok"]);

    store.update(c.id, 1, { token: "wrong" });
    const denied = await discovery.discover({ id: c.id, revision: 2 }, "r2");
    assert.equal(denied.state, "unavailable");
    assert.equal(denied.state === "unavailable" && denied.reason, "unauthorized");
    assert.equal(JSON.stringify(denied).includes("lms-tok") || JSON.stringify(denied).includes("wrong"), false, "no token in results");
  } finally { await rt.close(); }
});

test("LM Studio without the native listing falls back to /v1/models with unknown states", async () => {
  const rt = await runtime(req => (req.url === "/v1/models" ? { json: { object: "list", data: [{ id: "qwen/qwen3-coder-30b", object: "model" }] } } : undefined));
  const { store, discovery } = setup();
  try {
    const c = store.create({ label: "LM Studio", runtime: "lmstudio", url: rt.url });
    const m = byId(await discovery.discover({ id: c.id, revision: 1 }, "r"))["qwen/qwen3-coder-30b"]!;
    assert.deepEqual([m.kind, m.installed, m.loaded, m.advertised.tools, m.selectable], ["unknown", "unknown", "unknown", "unknown", true]);
    assert.deepEqual(rt.hits.map(h => h.url), ["/api/v0/models", "/v1/models"]);
  } finally { await rt.close(); }
});

test("Responses-compatible servers: IDs only, unknown states, with or without the /v1 prefix", async () => {
  const rt = await runtime(req => (req.url === "/v1/models" ? { json: { object: "list", data: [{ id: "Qwen/Qwen3-Coder-30B-A3B-Instruct", max_model_len: 65536 }, { id: "local model.gguf" }] } } : undefined));
  const { store, discovery } = setup();
  try {
    for (const url of [rt.url, `${rt.url}/v1`]) {
      const c = store.create({ label: "vLLM", runtime: "responses", url });
      const result = await discovery.discover({ id: c.id, revision: 1 }, "r");
      const m = byId(result);
      assert.deepEqual(Object.keys(m), ["Qwen/Qwen3-Coder-30B-A3B-Instruct", "local model.gguf"]);
      const q = m["Qwen/Qwen3-Coder-30B-A3B-Instruct"]!;
      assert.deepEqual([q.kind, q.installed, q.loaded, q.advertised, q.advertisedContext, q.locality, q.selectable], ["unknown", "unknown", "unknown", { tools: "unknown", vision: "unknown", reasoning: "unknown" }, 65536, "unverified", true]);
    }
    assert.deepEqual(rt.hits.map(h => h.url), ["/v1/models", "/v1/models"]);
  } finally { await rt.close(); }
});

test("empty, malformed and unavailable runtimes are typed results; manual IDs stay available", async () => {
  const empty = await runtime(req => (req.url === "/api/tags" ? { json: { models: [] } } : req.url === "/api/ps" ? { json: { models: [] } } : undefined));
  const malformed = await runtime(() => ({ raw: "<html>" }));
  const wrongShape = await runtime(() => ({ json: { models: "nope", data: 3 } }));
  const gone = await runtime(() => undefined);
  await gone.close();
  const { store, discovery } = setup();
  try {
    const e = store.create({ label: "e", runtime: "ollama", url: empty.url });
    const er = await discovery.discover({ id: e.id, revision: 1 }, "r");
    assert.deepEqual([er.state, er.state === "ready" && er.models.length], ["ready", 0]);
    for (const [url, reason] of [[malformed.url, "malformed"], [wrongShape.url, "malformed"], [gone.url, "unavailable"]] as const) {
      const c = store.create({ label: "x", runtime: "responses", url, manualModels: ["typed/model"] });
      const r = await discovery.discover({ id: c.id, revision: 1 }, "r");
      assert.equal(r.state, "unavailable");
      if (r.state === "unavailable") {
        assert.equal(r.reason, reason, url);
        assert.deepEqual(r.models.map(m => [m.model.id, m.source, m.selectable]), [["typed/model", "manual", true]], "explicit IDs survive a failed listing");
      }
    }
    // Ollama /api/ps failing leaves loaded state unknown rather than "no".
    const noPs = await runtime(req => (req.url === "/api/tags" ? { json: { models: [{ name: "m:1" }] } } : req.url === "/api/ps" ? { status: 500, json: {} } : req.url === "/api/show" ? { status: 500, json: {} } : undefined));
    const p = store.create({ label: "p", runtime: "ollama", url: noPs.url });
    const pm = byId(await discovery.discover({ id: p.id, revision: 1 }, "r"))["m:1"]!;
    assert.deepEqual([pm.installed, pm.loaded, pm.kind, pm.advertised.tools], ["yes", "unknown", "unknown", "unknown"]);
    await noPs.close();
  } finally { await Promise.all([empty.close(), malformed.close(), wrongShape.close()]); }
});

test("listings are bounded in size, count and time", async () => {
  const many = await runtime(req => (req.url === "/v1/models" ? { json: { data: Array.from({ length: 900 }, (_, i) => ({ id: `m-${i}` })) } } : undefined));
  const huge = await runtime(req => (req.url === "/v1/models" ? { raw: JSON.stringify({ data: [{ id: "x".repeat(3_000_000) }] }) } : undefined));
  const slow = await runtime(req => (req.url === "/v1/models" ? { json: { data: [{ id: "late" }] }, delayMs: 3000 } : undefined));
  const showMany = await runtime((req) => {
    if (req.url === "/api/tags") return { json: { models: Array.from({ length: 60 }, (_, i) => ({ name: `m${i}:latest` })) } };
    if (req.url === "/api/ps") return { json: { models: [] } };
    if (req.url === "/api/show") return { json: { capabilities: ["completion"] } };
    return undefined;
  });
  const { store, discovery } = setup();
  try {
    const m = store.create({ label: "m", runtime: "responses", url: many.url });
    const mr = await discovery.discover({ id: m.id, revision: 1 }, "r");
    assert.deepEqual([mr.state, mr.state === "ready" && mr.models.length, mr.state === "ready" && mr.truncated], ["ready", 500, true]);
    const h = store.create({ label: "h", runtime: "responses", url: huge.url });
    const hr = await discovery.discover({ id: h.id, revision: 1 }, "r");
    assert.equal(hr.state === "unavailable" && hr.reason, "too-large");
    const s = store.create({ label: "s", runtime: "responses", url: slow.url });
    const started = Date.now();
    const sr = await discovery.discover({ id: s.id, revision: 1 }, "r");
    assert.equal(sr.state === "unavailable" && sr.reason, "timeout");
    assert.ok(Date.now() - started < 2500);
    const o = store.create({ label: "o", runtime: "ollama", url: showMany.url });
    const or = await discovery.discover({ id: o.id, revision: 1 }, "r");
    assert.equal(or.state === "ready" && or.models.length, 60);
    assert.equal(showMany.hits.filter(x => x.url === "/api/show").length, 32, "per-model metadata reads are capped");
    assert.equal(or.state === "ready" && or.models.filter(x => x.kind === "unknown").length, 28, "unread models stay unknown");
  } finally { await Promise.all([many.close(), huge.close(), slow.close(), showMany.close()]); }
});

test("same model ID on two connections stays two targets; late answers after edit, switch or delete are stale", async () => {
  let delay = 0;
  const rt = await runtime(req => (req.url === "/v1/models" ? { json: { data: [{ id: "same/model" }] }, delayMs: delay } : undefined));
  const { store, discovery } = setup();
  try {
    const a = store.create({ label: "a", runtime: "responses", url: rt.url });
    const b = store.create({ label: "b", runtime: "responses", url: `${rt.url}/v1` });
    const [ra, rb] = await Promise.all([discovery.discover({ id: a.id, revision: 1 }, "a1"), discovery.discover({ id: b.id, revision: 1 }, "b1")]);
    const ma = byId(ra)["same/model"] as LocalModelDescriptor, mb = byId(rb)["same/model"] as LocalModelDescriptor;
    assert.notDeepEqual(ma.model, mb.model);
    assert.equal(ma.model.id, mb.model.id);

    delay = 300;
    const edited = discovery.discover({ id: a.id, revision: 1 }, "a2");
    await new Promise(r => setTimeout(r, 50));
    store.update(a.id, 1, { url: `http://localhost:${new URL(rt.url).port}` });
    discovery.invalidate(a.id);
    assert.deepEqual(await edited, { state: "stale", connection: { id: a.id, revision: 1 }, requestId: "a2" });

    // Even without an explicit invalidate, a completed answer for an old revision is dropped.
    const raced = discovery.discover({ id: b.id, revision: 1 }, "b2");
    await new Promise(r => setTimeout(r, 50));
    store.update(b.id, 1, { token: "t" });
    assert.equal((await raced).state, "stale");

    // A newer request for the same connection supersedes the older one.
    const first = discovery.discover({ id: b.id, revision: 2 }, "b3");
    const second = discovery.discover({ id: b.id, revision: 2 }, "b4");
    assert.equal((await first).state, "stale");
    assert.equal((await second).state, "ready");

    const doomed = discovery.discover({ id: b.id, revision: 2 }, "b5");
    await new Promise(r => setTimeout(r, 50));
    store.delete(b.id, 2);
    assert.equal((await doomed).state, "stale");
    assert.equal((await discovery.discover({ id: b.id, revision: 2 }, "b6")).state, "stale", "a deleted connection is never read");
    assert.equal((await discovery.discover({ id: a.id, revision: 1 }, "a3")).state, "stale", "an old revision is never read");

    const cancelled = discovery.discover({ id: a.id, revision: 2 }, "a4");
    discovery.cancel(a.id);
    assert.equal((await cancelled).state, "stale");
  } finally { await rt.close(); }
});

test("a saved localhost profile whose name now resolves off this Mac is refused before connecting", async () => {
  const rt = await runtime(() => ({ json: { data: [{ id: "x" }] } }));
  const home = tmpdir("modex-lm-");
  const store = new LocalConnectionStore(home, new SecretStore(home, testCipher));
  const rebound = new LocalModelDiscovery(store, { timeoutMs: 1000, lookup: (_h, _o, done) => done(null, [{ address: "10.0.0.7", family: 4 }]) });
  try {
    const c = store.create({ label: "l", runtime: "responses", url: `http://localhost:${new URL(rt.url).port}`, token: "tok" });
    const r = await rebound.discover({ id: c.id, revision: 1 }, "r");
    assert.equal(r.state === "unavailable" && r.reason, "not-loopback");
    assert.equal(rt.hits.length, 0);
  } finally { await rt.close(); }
});

test("a server that repeats the saved token in its model list is ignored, never shown", async () => {
  const SECRET = "reflect-tok-31337";
  const echo = (req: http.IncomingMessage) => (req.headers.authorization ?? "").replace(/^Bearer /, "");
  const listings: [string, "responses" | "lmstudio" | "ollama", Route][] = [
    ["exact Responses ID", "responses", req => (req.url === "/v1/models" ? { json: { data: [{ id: "ok-model" }, { id: echo(req) }] } } : undefined)],
    ["embedded Responses ID", "responses", req => (req.url === "/v1/models" ? { json: { data: [{ id: `org/${echo(req)}:Q4` }] } } : undefined)],
    ["LM Studio native listing", "lmstudio", req => (req.url === "/api/v0/models" ? { json: { data: [{ id: `lms-${echo(req)}`, type: "llm", state: "loaded" }] } } : undefined)],
    ["Ollama tags", "ollama", req => (req.url === "/api/tags" ? { json: { models: [{ name: `${echo(req)}:latest` }] } } : req.url === "/api/ps" ? { json: { models: [] } } : undefined)],
  ];
  for (const [name, kind, route] of listings) {
    const rt = await runtime(route);
    const { store, discovery } = setup();
    try {
      // Saving a manual ID that holds the token is refused (see local-model-connections), so only the clean one is here.
      const c = store.create({ label: name, runtime: kind, url: rt.url, token: SECRET, manualModels: ["manual/kept"] });
      const result = await discovery.discover({ id: c.id, revision: 1 }, "r");
      assert.equal(JSON.stringify(result).includes(SECRET), false, `${name}: the token never reaches IPC`);
      assert.equal(result.state, "unavailable", name);
      if (result.state !== "unavailable") continue;
      assert.equal(result.reason, "reflected-credential", name);
      assert.deepEqual(result.models.map(m => m.model.id), ["manual/kept"], `${name}: the untouched manual ID stays available`);
    } finally { await rt.close(); }
  }
});

test("model IDs that merely resemble a token are kept exactly, not redacted into another identity", async () => {
  const rt = await runtime(req => (req.url === "/v1/models" ? { json: { data: [{ id: "reflect-tok" }, { id: "31337" }] } } : undefined));
  const { store, discovery } = setup();
  try {
    const c = store.create({ label: "r", runtime: "responses", url: rt.url, token: "reflect-tok-31337" });
    const result = await discovery.discover({ id: c.id, revision: 1 }, "r");
    assert.equal(result.state, "ready");
    assert.deepEqual(result.state === "ready" ? result.models.map(m => m.model.id) : [], ["reflect-tok", "31337"]);
  } finally { await rt.close(); }
});
test("a saved token that can't be decrypted is reported, and no request goes out without it", async () => {
  const rt = await runtime(req => (req.url === "/v1/models" ? { json: { data: [{ id: "org/model" }] } } : undefined));
  const home = tmpdir("modex-lm-");
  let keychain = true;
  const secrets = new SecretStore(home, { ...testCipher, available: () => keychain });
  const store = new LocalConnectionStore(home, secrets);
  const discovery = new LocalModelDiscovery(store, { timeoutMs: 1000 });
  try {
    const c = store.create({ label: "vLLM", runtime: "responses", url: rt.url, token: "locked-token", manualModels: ["org/manual"] });
    keychain = false;
    const result = await discovery.discover({ id: c.id, revision: 1 }, "r");
    assert.equal(result.state === "unavailable" && result.reason, "credential-unavailable");
    assert.deepEqual(result.state === "unavailable" ? result.models.map(m => m.model.id) : null, ["org/manual"], "manual IDs stay available");
    assert.equal(rt.hits.length, 0, "an unauthenticated request is never sent in its place");
    keychain = true;
    assert.equal((await discovery.discover({ id: c.id, revision: 1 }, "r2")).state, "ready");
    assert.deepEqual(rt.hits.map(h => h.auth), ["Bearer locked-token"]);
  } finally { await rt.close(); }
});

test("slow per-model reads can't hold discovery past its overall deadline; unread models stay unknown", async () => {
  const rt = await runtime((req) => {
    if (req.url === "/api/tags") return { json: { models: Array.from({ length: 32 }, (_, i) => ({ name: `m${i}:latest` })) } };
    if (req.url === "/api/ps") return { json: { models: [] } };
    if (req.url === "/api/show") return { json: { capabilities: ["completion"] }, delayMs: 900 };
    return undefined;
  });
  const { store, discovery } = setup();
  try {
    const c = store.create({ label: "o", runtime: "ollama", url: rt.url });
    const started = Date.now();
    const result = await discovery.discover({ id: c.id, revision: 1 }, "r");
    const elapsed = Date.now() - started;
    // Each read is under the 1 s per-request deadline; 32 of them, four at a time, would take ~7 s.
    assert.ok(elapsed < 4500, `discovery took ${elapsed} ms`);
    assert.equal(result.state, "ready", "running out of time for per-model detail is not a failure");
    if (result.state !== "ready") return;
    assert.equal(result.models.length, 32);
    assert.ok(result.models.some(m => m.kind === "generative"), "reads that finished in time are used");
    assert.ok(result.models.some(m => m.kind === "unknown"), "the rest stay unknown");
  } finally { await rt.close(); }
});

