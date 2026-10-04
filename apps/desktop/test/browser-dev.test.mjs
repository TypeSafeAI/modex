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
