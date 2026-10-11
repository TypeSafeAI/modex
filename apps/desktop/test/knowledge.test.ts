import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { KnowledgeService } from "../src/main/engine/knowledge.js";

async function existingServer(options: { exitCode?: number; ready?: boolean; ui?: boolean; matchingPid?: boolean; banner?: boolean } = {}) {
  const fixture = setup();
  const server = http.createServer((_req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ready: options.ready ?? true }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as import("node:net").AddressInfo).port;
  const url = `http://127.0.0.1:${port}`;
  const runtime = path.join(fixture.home, "runtime");
  const packageDir = path.join(runtime, "node_modules", "@inkeep", "open-knowledge");
  fs.mkdirSync(path.join(packageDir, "dist"), { recursive: true });
  fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ version: "0.83.2" }));
  const status = {
    server: { state: "alive", alive: true, pid: options.matchingPid === false ? process.pid + 1 : process.pid, port },
    ui: { state: "alive", alive: options.ui ?? true, pid: process.pid, port, servedByServer: true },
  };
  fs.writeFileSync(path.join(packageDir, "dist", "cli.mjs"), `
    if (process.env.FORCE_COLOR) throw new Error('FORCE_COLOR must not reach the companion');
    if (process.argv.includes('status')) console.log(${JSON.stringify(JSON.stringify(status))});
    else {
      console.log(${JSON.stringify(options.banner === false ? url : `OpenKnowledge is already running on this project (pid ${process.pid}).\n  ${url}\nLeaving it running — run \`ok stop\` first if you want a fresh server.`)});
      process.exit(${options.exitCode ?? 0});
    }
  `);
  const service = new KnowledgeService(fixture.home, { runtimeDir: runtime, startupTimeoutMs: 1000, env: { ...process.env, FORCE_COLOR: "1" } });
  await service.selectFolder(fixture.folder);
  return { ...fixture, service, url, async dispose() {
    try { await service.dispose(); }
    finally {
      // Report a failed process cleanup without leaving this fixture's listener alive forever.
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      fixture.clean();
    }
  } };
}

test("knowledge reuses a verified existing server and disconnects without stopping it", async () => {
  const fixture = await existingServer();
  try {
    const state = await fixture.service.start();
    assert.equal(state.status, "ready");
    assert.equal(state.url, fixture.url);
    assert.equal(state.external, true);
    await fixture.service.stop();
    assert.equal((await fetch(`${fixture.url}/readyz`)).ok, true);
    assert.equal((await fixture.service.start()).status, "ready");
    await fixture.service.dispose();
    assert.equal((await fetch(`${fixture.url}/readyz`)).ok, true);
  } finally { await fixture.dispose(); }
});

test("knowledge does not adopt failed, unready, unidentified, or UI-less servers", async () => {
  for (const options of [{ exitCode: 1 }, { ready: false }, { ui: false }, { matchingPid: false }, { banner: false }]) {
    const fixture = await existingServer(options);
    try {
      await assert.rejects(fixture.service.start());
      assert.equal(fixture.service.snapshot().status, "error");
      assert.equal(fixture.service.snapshot().url, null);
      assert.equal((await fetch(`${fixture.url}/readyz`)).ok, true);
    } finally { await fixture.dispose(); }
  }
});

function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "modex-knowledge-"));
  const folder = path.join(home, "Knowledge & notes");
  fs.mkdirSync(folder);
  return { home, folder, clean: () => fs.rmSync(home, { recursive: true, force: true }) };
}

test("knowledge remembers a canonical folder without starting or installing anything", async () => {
  const { home, folder, clean } = setup();
  const service = new KnowledgeService(home);
  try {
    assert.equal(service.snapshot().installed, false);
    await service.selectFolder(folder);
    assert.equal(service.snapshot().status, "idle");
    assert.equal(new KnowledgeService(home).snapshot().folder, fs.realpathSync(folder));
    assert.equal(fs.existsSync(path.join(folder, ".ok")), false);
    await assert.rejects(service.start(), /Install Open Knowledge/);
    assert.equal(service.snapshot().url, null);
    await assert.rejects(service.selectFolder(path.join(home, "missing")), /folder/i);
    assert.equal(service.snapshot().folder, fs.realpathSync(folder));
  } finally { await service.dispose(); clean(); }
});

test("knowledge copies portable Markdown without overwriting files or following destination symlinks", async () => {
  const { home, folder, clean } = setup();
  const service = new KnowledgeService(home);
  try {
    await service.selectFolder(folder);
    const document = { id: "abc-123", title: "Design notes", markdown: "## Decision\n\nKeep [[links]]." };
    const file = service.copyPage(document);
    assert.equal(path.dirname(file), fs.realpathSync(folder));
    assert.equal(fs.readFileSync(file, "utf8"), "# Design notes\n\n## Decision\n\nKeep [[links]].\n");
    assert.throws(() => service.copyPage(document), /already exists/);
    assert.throws(() => service.copyPage({ ...document, id: "../../escape" }), /Invalid/);
    const target = path.join(home, "protected.md");
    fs.writeFileSync(target, "preserve");
    fs.symlinkSync(target, path.join(folder, "space-def-456.md"));
    assert.throws(() => service.copyPage({ ...document, id: "def-456" }), /already exists/);
    assert.equal(fs.readFileSync(target, "utf8"), "preserve");
  } finally { await service.dispose(); clean(); }
});

test("knowledge preserves malformed configuration and reports it", () => {
  const { home, clean } = setup();
  fs.mkdirSync(path.join(home, "app"));
  const file = path.join(home, "app", "knowledge.json");
  fs.writeFileSync(file, "broken");
  try {
    const state = new KnowledgeService(home).snapshot();
    assert.equal(state.status, "error");
    assert.match(state.error ?? "", /saved knowledge folder/i);
    assert.equal(fs.readFileSync(file, "utf8"), "broken");
  } finally { clean(); }
});

test("knowledge owns its server lifecycle, rejects concurrent starts, and reports crashes", async () => {
  const { home, folder, clean } = setup();
  const runtime = path.join(home, "runtime");
  const packageDir = path.join(runtime, "node_modules", "@inkeep", "open-knowledge");
  fs.mkdirSync(path.join(packageDir, "dist"), { recursive: true });
  fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ version: "0.83.2" }));
  fs.mkdirSync(path.join(folder, ".ok"));
  fs.writeFileSync(path.join(folder, ".ok", "config.yml"), "test fixture");
  fs.writeFileSync(path.join(packageDir, "dist", "cli.mjs"), `
    import http from 'node:http';
    const server = http.createServer((req, res) => {
      if (req.url === '/crash') { res.end(); setTimeout(() => process.exit(1), 10); return; }
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ready: true }));
    });
    server.listen(0, '127.0.0.1', () => console.log('http://127.0.0.1:' + server.address().port));
  `);
  const service = new KnowledgeService(home, { runtimeDir: runtime, startupTimeoutMs: 3000 });
  try {
    await service.selectFolder(folder);
    const starting = service.start();
    await assert.rejects(service.start(), /current knowledge operation/);
    const state = await starting;
    assert.equal(state.status, "ready");
    assert.equal(state.external, false);
    assert.equal((await fetch(`${state.url}/readyz`)).ok, true);
    await assert.rejects(service.selectFolder(home), /Stop/);
    await service.stop();
    assert.equal(service.snapshot().status, "idle");
    await assert.rejects(fetch(`${state.url}/readyz`));
    const restarted = await service.start();
    await fetch(`${restarted.url}/crash`);
    for (let i = 0; i < 100 && service.snapshot().status !== "error"; i++) await new Promise(r => setTimeout(r, 10));
    assert.equal(service.snapshot().status, "error");
    assert.equal(service.snapshot().url, null);
    const recovered = await service.start();
    assert.equal(recovered.status, "ready");
    await service.dispose();
    await assert.rejects(fetch(`${recovered.url}/readyz`));
    await assert.rejects(service.start(), /shutting down/);
  } finally { await service.dispose(); clean(); }
});

test("knowledge refuses a selected folder replaced by a symlink", async () => {
  const { home, folder, clean } = setup();
  const service = new KnowledgeService(home);
  try {
    await service.selectFolder(folder);
    fs.rmdirSync(folder);
    fs.symlinkSync(home, folder);
    assert.throws(() => service.copyPage({ id: "escaped", title: "No", markdown: "Outside" }), /changed|choose/i);
    assert.equal(fs.existsSync(path.join(home, "space-escaped.md")), false);
  } finally { await service.dispose(); clean(); }
});

test("knowledge copies into an existing content directory and rejects roots outside the chosen folder", async () => {
  const { home, folder, clean } = setup();
  const service = new KnowledgeService(home);
  try {
    await service.selectFolder(folder);
    fs.mkdirSync(path.join(folder, ".ok"));
    fs.mkdirSync(path.join(folder, "docs"));
    const config = path.join(folder, ".ok", "config.yml");
    fs.writeFileSync(config, "content:\n  dir: docs\n");
    const file = service.copyPage({ id: "inside", title: "Inside", markdown: "Knowledge" });
    assert.equal(path.dirname(file), path.join(fs.realpathSync(folder), "docs"));
    fs.writeFileSync(config, "content:\n  dir: ..\n");
    assert.throws(() => service.copyPage({ id: "outside", title: "No", markdown: "Outside" }), /outside/i);
    assert.equal(fs.existsSync(path.join(home, "space-outside.md")), false);
  } finally { await service.dispose(); clean(); }
});
