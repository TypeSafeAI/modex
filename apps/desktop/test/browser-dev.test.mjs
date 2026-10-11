import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { request } from "node:http";

const appDir = fileURLToPath(new URL("../", import.meta.url));

test("browser dev bridge opens a real project, streams an offline turn, and persists it", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "modex-browser-test-"));
  process.env.MODEX_BROWSER_HOME = home;
  process.env.MODEX_NO_LOGIN_PATH = "1";
  const server = await createServer({
    configFile: path.join(appDir, "vite.config.ts"),
    server: { host: "127.0.0.1", port: 0, open: false },
  });
  t.after(async () => { await server.close(); await fs.rm(home, { recursive: true, force: true }); });
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  const html = await (await fetch(origin)).text();
  const token = html.match(/name="modex-browser-token" content="([^"]+)"/)?.[1];
  assert.ok(token, "Vite must provide a browser bridge instead of the inert Electron-only fallback");
  const invoke = async (channel, payload) => {
    const response = await fetch(`${origin}/__modex/invoke`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-Modex-Token": token, Origin: origin },
      body: JSON.stringify({ channel, payload }),
    });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    return result.value;
  };

  for (const headers of [
    { Origin: origin },
    { "X-Modex-Token": token, Origin: "https://example.com" },
  ]) {
    const rejected = await fetch(`${origin}/__modex/invoke`, {
      method: "POST", headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ channel: "state:get" }),
    });
    assert.equal(rejected.status, 403, "reject missing credentials and foreign origins/hosts");
  }
  const foreignHost = await new Promise((resolve, reject) => {
    const req = request(`${origin}/__modex/invoke`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-Modex-Token": token, Origin: origin, Host: "example.com" },
    }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on("error", reject);
    req.end(JSON.stringify({ channel: "state:get" }));
  });
  assert.equal(foreignHost, 403);

  const script = path.join(home, "script.json");
  await fs.writeFile(script, JSON.stringify([{ content: "Browser bridge works." }]));
  await invoke("settings:update", { default_backend: "mock", mock_script: script });
  const project = await invoke("project:add", { path: home });
  assert.equal(project.path, home);
  const thread = await invoke("thread:create", { projectId: project.id });
  assert.match((await invoke("thread:retry", { threadId: thread.id })).error, /Nothing to retry/);
  assert.equal((await invoke("chatgpt:status")).available, false);

  const abort = new AbortController();
  const events = await fetch(`${origin}/__modex/events?token=${token}`, { signal: abort.signal });
  assert.equal(events.status, 200);
  const reader = events.body.getReader();
  let streamed = "";
  const reading = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        streamed += new TextDecoder().decode(value);
      }
    } catch (error) { if (error.name !== "AbortError") throw error; }
  })();
  t.after(() => abort.abort());
  assert.equal((await invoke("thread:send", { threadId: thread.id, text: "hello browser" })).ok, true);
  const deadline = Date.now() + 10_000;
  let items = [];
  while (Date.now() < deadline) {
    items = await invoke("thread:items", { threadId: thread.id });
    if (items.some((item) => item.kind === "assistant" && item.text === "Browser bridge works.")) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(items.some((item) => item.kind === "user" && item.text === "hello browser"));
  assert.ok(items.some((item) => item.kind === "assistant" && item.text === "Browser bridge works."));
  assert.match(streamed, /event: thread/);
  assert.match(streamed, /hello browser/);
  abort.abort();
  await reading;
  assert.equal((await invoke("state:get")).threads[0].id, thread.id);
  assert.equal((await invoke("changes:status", { threadId: thread.id })).isRepo, false);
  assert.equal((await invoke("models:list", { backend: "mock" })).models[0].id, "mock");
  assert.ok(JSON.parse(await fs.readFile(path.join(home, "app/state.json"), "utf8")).projects.length);
});

test("browser attachments use authenticated bounded byte-only transport and guarded thumbnails", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "modex-browser-attachments-"));
  process.env.MODEX_BROWSER_HOME = home;
  process.env.MODEX_NO_LOGIN_PATH = "1";
  const server = await createServer({ configFile: path.join(appDir, "vite.config.ts"), server: { host: "127.0.0.1", port: 0, open: false } });
  t.after(async () => { await server.close(); await fs.rm(home, { recursive: true, force: true }); });
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  const token = (await (await fetch(origin)).text()).match(/name="modex-browser-token" content="([^"]+)"/)?.[1];
  const headers = { "Content-Type": "application/json", "X-Modex-Token": token, Origin: origin };
  const post = (endpoint, body, extra = {}) => fetch(`${origin}/__modex/${endpoint}`, { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(body) });
  const invoke = async (channel, payload) => { const r = await post("invoke", { channel, payload }); assert.equal(r.status, 200); return (await r.json()).value; };
  const upload = (file, extra) => post("attachments/stage", { files: [file] }, extra);
  const bytes = Buffer.alloc(25 * 1024 * 1024, 37);
  const file = { name: "large.bin", size: bytes.length, data: bytes.toString("base64") };
  const response = await upload(file);
  assert.equal(response.status, 200);
  const large = (await response.json()).value.staged[0];
  assert.deepEqual(await fs.readFile(path.join(home, "attachments", large.rel)), bytes);

  // Keep the ordinary command envelope bounded, and never accept source paths on either route.
  assert.equal((await post("invoke", { channel: "attachments:stage", payload: { files: [file] } })).status, 413);
  const source = path.join(home, "secret.txt"); await fs.writeFile(source, "secret");
  for (const endpoint of ["invoke", "attachments/stage"]) {
    const payload = { files: [{ name: "secret.txt", path: source }] };
    const r = await post(endpoint, endpoint === "invoke" ? { channel: "attachments:stage", payload } : payload);
    const result = (await r.json()).value;
    assert.deepEqual(result.staged, []); assert.match(result.errors.join(" "), /bytes|path/i);
  }
  for (const invalid of [
    { name: "lie.txt", size: 4, data: "aGk=" }, { name: "bad.txt", size: 1, data: "!not base64!" },
    { name: "bad.txt", size: -1, data: "" }, { name: "bad.txt", size: 1.1, data: "eA==" },
    { name: "image.png", size: bytes.length, data: file.data },
  ]) {
    const r = await upload(invalid); assert.equal(r.status, 200);
    const result = (await r.json()).value; assert.deepEqual(result.staged, []); assert.ok(result.errors.length);
  }
  assert.equal((await post("attachments/stage", { files: [{ name: "one", size: 1, data: "eA==" }, { name: "two", size: 1, data: "eA==" }] })).status, 400);
  assert.equal((await upload({ ...file, data: `${file.data}AAAA` })).status, 413);

  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
  const image = (await (await upload({ name: "dot.png", mime: "image/png", size: png.length, data: png.toString("base64") })).json()).value.staged[0];
  const thumbnail = (rel, extra = {}) => fetch(`${origin}/__modex/attachments/image?rel=${encodeURIComponent(rel)}`, { headers: { ...headers, ...extra } });
  let r = await thumbnail(image.rel); assert.equal(r.status, 200); assert.deepEqual(Buffer.from(await r.arrayBuffer()), png);
  assert.equal(r.headers.get("content-type"), "image/png"); assert.equal(r.headers.get("x-content-type-options"), "nosniff"); assert.equal(r.headers.get("cache-control"), "no-store");
  for (const bad of [{ "X-Modex-Token": "" }, { "X-Modex-Token": "wrong" }, { Origin: "https://foreign.example" }, { "Sec-Fetch-Site": "cross-site" }]) {
    assert.equal((await upload({ name: "x", size: 1, data: "eA==" }, bad)).status, 403, JSON.stringify(bad));
    assert.equal((await thumbnail(image.rel, bad)).status, 403, JSON.stringify(bad));
  }
  for (const endpoint of ["attachments/stage", `attachments/image?rel=${encodeURIComponent(image.rel)}`]) {
    const status = await new Promise((resolve, reject) => {
      const req = request(`${origin}/__modex/${endpoint}`, { method: endpoint.endsWith("stage") ? "POST" : "GET", headers: { ...headers, Host: "foreign.example" } }, res => { res.resume(); resolve(res.statusCode); });
      req.on("error", reject); req.end();
    });
    assert.equal(status, 403);
  }
  for (const rel of ["../secret.txt", "%2e%2e/secret.txt", "/etc/passwd", "staging/../../secret.txt", "staging\\secret.txt", large.rel]) assert.equal((await thumbnail(rel)).status, 404);
  const html = (await (await upload({ name: "x.svg", size: 6, data: Buffer.from("<svg/>").toString("base64") })).json()).value.staged[0];
  assert.equal((await thumbnail(html.rel)).status, 404);
  await invoke("attachments:discard", { ids: [html.id] });
  assert.equal((await thumbnail(html.rel)).status, 404);

  // The real shared command must carry the attachment-only send into persistence.
  const script = path.join(home, "script.json"); await fs.writeFile(script, JSON.stringify([{ content: "transport only" }]));
  await invoke("settings:update", { default_backend: "mock", mock_script: script });
  const project = await invoke("project:add", { path: home });
  const thread = await invoke("thread:create", { projectId: project.id });
  assert.equal((await invoke("thread:send", { threadId: thread.id, text: "", attachments: [image, large] })).ok, true);
  const user = (await invoke("thread:items", { threadId: thread.id })).find(x => x.kind === "user");
  assert.equal(user.attachments.length, 2);
  for (const [i, expected] of [[0, png], [1, bytes]]) assert.deepEqual(await fs.readFile(path.join(home, "attachments", user.attachments[i].rel)), expected);
  r = await thumbnail(user.attachments[0].rel); assert.equal(r.status, 200); assert.deepEqual(Buffer.from(await r.arrayBuffer()), png);
  const dest = path.join(home, "attachments", user.attachments[0].rel);
  await fs.unlink(dest); await fs.symlink(source, dest);
  assert.equal((await thumbnail(user.attachments[0].rel)).status, 404);
});


test("attachment uploads bound concurrent and chunked bodies and leave no partial files after abort", { timeout: 15000 }, async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "modex-upload-abort-"));
  process.env.MODEX_BROWSER_HOME = home; process.env.MODEX_NO_LOGIN_PATH = "1";
  const server = await createServer({ configFile: path.join(appDir, "vite.config.ts"), server: { host: "127.0.0.1", port: 0, open: false } });
  t.after(async () => { await server.close(); await fs.rm(home, { recursive: true, force: true }); });
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  const token = (await (await fetch(origin)).text()).match(/name="modex-browser-token" content="([^"]+)"/)?.[1];
  const headers = { "Content-Type": "application/json", "X-Modex-Token": token, Origin: origin };
  const url = `${origin}/__modex/attachments/stage`;
  const payload = JSON.stringify({ files: [{ name: "after.txt", size: 1, data: "eA==" }] });
  const held = request(url, { method: "POST", headers: { ...headers, "Content-Length": 10000 } });
  held.on("error", () => {}); held.flushHeaders(); held.write('{"files":[');
  t.after(() => held.destroy());
  // A second authenticated request observes the active reservation, before any parsing.
  const deadline = Date.now() + 3000;
  let status;
  while (Date.now() < deadline) {
    const res = await fetch(url, { method: "POST", headers, body: "{}" }); status = res.status;
    if (status === 429) break;
  }
  assert.equal(status, 429);
  assert.deepEqual(await fs.readdir(path.join(home, "attachments", "staging")), []);
  held.destroy();
  while (Date.now() < deadline) {
    const res = await fetch(url, { method: "POST", headers, body: "{}" }); status = res.status;
    if (status !== 429) break;
  }
  assert.equal(status, 400, "aborted request releases the upload slot");
  assert.deepEqual(await fs.readdir(path.join(home, "attachments", "staging")), []);
  assert.equal((await fetch(url, { method: "POST", headers, body: payload })).status, 200);
  const before = await fs.readdir(path.join(home, "attachments", "staging"));
  const chunked = await new Promise((resolve, reject) => {
    const req = request(url, { method: "POST", headers }, res => { res.resume(); resolve(res.statusCode); });
    req.on("error", error => { if (["EPIPE", "ECONNRESET"].includes(error.code)) resolve(error.code); else reject(error); });
    req.write(Buffer.alloc(20 * 1024 * 1024, 32)); req.end(Buffer.alloc(20 * 1024 * 1024, 32));
  });
  // HTTP may close the rejected chunked stream while Node is still writing its final bytes.
  assert.ok([413, "EPIPE", "ECONNRESET"].includes(chunked), `oversize rejection: ${chunked}`);
  assert.deepEqual(await fs.readdir(path.join(home, "attachments", "staging")), before);
  const malformed = await fetch(url, { method: "POST", headers, body: '{"files":[' });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.text()).includes(home), false);
});

test("discard failure hides host paths over HTTP and preserves attachment ownership for retry", {
  skip: process.platform === "win32" || process.getuid?.() === 0,
}, async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "modex-discard-error-"));
  const root = path.join(home, "attachments");
  process.env.MODEX_BROWSER_HOME = home; process.env.MODEX_NO_LOGIN_PATH = "1";
  const server = await createServer({ configFile: path.join(appDir, "vite.config.ts"), server: { host: "127.0.0.1", port: 0, open: false } });
  t.after(async () => { await fs.chmod(root, 0o700); await server.close(); await fs.rm(home, { recursive: true, force: true }); });
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  const token = (await (await fetch(origin)).text()).match(/name="modex-browser-token" content="([^"]+)"/)?.[1];
  const headers = { "Content-Type": "application/json", "X-Modex-Token": token, Origin: origin };
  const uploaded = await fetch(`${origin}/__modex/attachments/stage`, {
    method: "POST", headers, body: JSON.stringify({ files: [{ name: "owned.txt", size: 1, data: "eA==" }] }),
  });
  assert.equal(uploaded.status, 200);
  const attachment = (await uploaded.json()).value.staged[0];
  const manifest = await fs.readFile(path.join(root, ".manifest.json"), "utf8");
  const discard = () => fetch(`${origin}/__modex/invoke`, {
    method: "POST", headers, body: JSON.stringify({ channel: "attachments:discard", payload: { ids: [attachment.id] } }),
  });
  // Keep traversal/read access, but prevent the store's real transactional manifest write.
  await fs.chmod(root, 0o500);
  try {
    const response = await discard();
    assert.equal(response.status, 400, "failed removal must still reject");
    const body = await response.text();
    assert.equal(body.includes(home), false, "attachment errors must not reveal the host home path");
    assert.equal(body.includes(".manifest"), false, "attachment errors must not reveal storage paths");
    assert.deepEqual(JSON.parse(body), { error: "Could not remove that attachment. Please try again." });
    assert.equal(await fs.readFile(path.join(root, attachment.rel), "utf8"), "x");
    assert.equal(await fs.readFile(path.join(root, ".manifest.json"), "utf8"), manifest);
  } finally { await fs.chmod(root, 0o700); }
  const retried = await discard(); assert.equal(retried.status, 200);
  await assert.rejects(fs.stat(path.join(root, attachment.rel)), { code: "ENOENT" });
  const after = JSON.parse(await fs.readFile(path.join(root, ".manifest.json"), "utf8"));
  assert.equal(after.files.some(file => file.attachment.id === attachment.id), false);
});
