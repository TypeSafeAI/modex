import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Store } from "../src/main/engine/store.js";
import { ThreadRunner } from "../src/main/engine/runner.js";
import { UsageLedger } from "../src/main/engine/usage-ledger.js";
import { ANALYTICS_CSP, respondAnalytics } from "../src/main/engine/analytics-assets.js";
import type { Backend, TurnResult, TurnUsage } from "../src/main/engine/backends/types.js";
import { gitRepo, tmpdir } from "./helpers.js";

const usage: TurnUsage = { first: { cacheRead: 0, cacheWrite: 30_000, uncached: 5 }, contextTokens: 31_000, outputTokens: 420, calls: 2, totals: { input: 9, cached: 30_500, cacheWrite: 30_100 } };
const turn = (over: Partial<Parameters<UsageLedger["record"]>[0]> = {}) => ({ at: "2026-10-15T08:00:00.000Z", backend: "claude", model: "opus", threadId: "t1", project: "modex", account: "", usage, ...over });

test("the ledger appends one row per turn, mapped to the dashboard's tool ids, with the turn's summed input", () => {
  const dir = tmpdir("modex-usage-");
  try {
    const ledger = new UsageLedger(dir);
    assert.deepEqual(ledger.list(), [], "no file yet, no rows");
    const row = ledger.record(turn());
    assert.deepEqual({ ...row, id: typeof row.id }, {
      id: "string", at: "2026-10-15T08:00:00.000Z", tool: "claude-code", model: "opus", session: "t1", project: "modex", account: "", kind: "main",
      input: 9, cached: 30_500, cacheWrite: 30_100, output: 420, reasoning: 0, cost: null, uncachedCost: null,
    });
    ledger.record(turn({ backend: "codex", model: "", at: "2026-10-15T09:00:00.000Z", usage: { first: { cacheRead: 7, cacheWrite: 1, uncached: 2 }, contextTokens: 10, calls: 1 } }));
    const [, codex] = ledger.list();
    assert.deepEqual([codex!.tool, codex!.model, codex!.input, codex!.cached, codex!.cacheWrite, codex!.output], ["codex", "default", 2, 7, 1, 0],
      "an unnamed model is the CLI default; a usage without totals falls back to its one call");
    assert.equal(fs.statSync(ledger.file).mode & 0o777, 0o600);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("reading skips torn or foreign lines and filters by inclusive dates", () => {
  const dir = tmpdir("modex-usage-");
  try {
    const ledger = new UsageLedger(dir);
    ledger.record(turn({ at: "2026-10-01T00:00:00.000Z" }));
    fs.appendFileSync(ledger.file, "not json\n{\"id\":1}\n");
    ledger.record(turn({ at: "2026-10-10T00:00:00.000Z" }));
    fs.appendFileSync(ledger.file, "{\"id\":\"torn\",\"at\":");
    assert.equal(ledger.list().length, 2);
    assert.deepEqual(ledger.list({ since: "2026-10-05T00:00:00.000Z" }).map(r => r.at), ["2026-10-10T00:00:00.000Z"]);
    assert.deepEqual(ledger.list({ until: "2026-10-01T00:00:00.000Z" }).map(r => r.at), ["2026-10-01T00:00:00.000Z"]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

const backendReturning = (results: TurnResult[]): Backend => ({
  id: "codex",
  listModels: async () => [{ id: "gpt-6-luna", label: "Luna", efforts: ["low", "high"], isDefault: true }],
  dispose: async () => {},
  async runTurn(_text, _opts, sink) { sink.assistant("done"); return results.shift() ?? { status: "completed" }; },
});

test("every turn that called a model is recorded, Auto or not, and a ledger failure never fails the turn", async () => {
  const home = tmpdir("modex-usage-runner-");
  const repo = gitRepo();
  const store = new Store(home);
  const project = store.addProject(repo);
  const rows: unknown[] = [];
  let broken = false;
  const ledger = { record: (r: Parameters<UsageLedger["record"]>[0]) => { if (broken) throw new Error("disk full"); rows.push(r); return undefined as never; } };
  const runner = new ThreadRunner({ home, store, emit: () => {}, usage: ledger, backends: { codex: backendReturning([
    { status: "completed", usage },
    { status: "completed" },
    { status: "interrupted", usage },
    { status: "completed", usage },
  ]) } });
  try {
    const thread = await runner.createThread(project.id, { backend: "codex", model: "gpt-6-luna" });
    await runner.send(thread.id, "first");
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0], { at: (rows[0] as { at: string }).at, backend: "codex", model: "gpt-6-luna", threadId: thread.id, project: project.name, account: "", usage });
    await runner.send(thread.id, "no model call, no row");
    assert.equal(rows.length, 1);
    await runner.send(thread.id, "stopped after a call still used tokens");
    assert.equal(rows.length, 2);
    broken = true;
    await runner.send(thread.id, "ledger down");
    assert.equal(store.thread(thread.id)!.status, "idle", "the turn still ends normally");
  } finally {
    await runner.dispose();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("the analytics origin serves only the built dashboard and the recorded usage", async () => {
  const root = tmpdir("modex-analytics-root-");
  const outside = tmpdir("modex-analytics-outside-");
  try {
    fs.writeFileSync(path.join(root, "index.html"), "<!doctype html><div id=root></div>");
    fs.mkdirSync(path.join(root, "assets"));
    fs.writeFileSync(path.join(root, "assets", "app.js"), "console.log(1)");
    fs.writeFileSync(path.join(root, "notes.md"), "not a served type");
    fs.writeFileSync(path.join(outside, "secret.js"), "nope");
    fs.symlinkSync(path.join(outside, "secret.js"), path.join(root, "assets", "link.js"));
    fs.symlinkSync(outside, path.join(root, "assets", "linked"), "junction");
    const rows = [{ id: "r1" }];
    const ledger = { list: () => rows as never };
    const get = (url: string, method = "GET") => respondAnalytics(root, ledger, new Request(url, { method }));

    const index = await get("modex-analytics://app/");
    assert.equal(index.status, 200);
    assert.equal(index.headers.get("content-security-policy"), ANALYTICS_CSP);
    assert.match(await index.text(), /id=root/);
    assert.equal((await get("modex-analytics://app/assets/app.js")).headers.get("content-type"), "text/javascript; charset=utf-8");
    const data = await get("modex-analytics://app/usage.json");
    assert.deepEqual(await data.json(), rows);
    assert.equal(data.headers.get("cache-control"), "no-store");
    for (const refused of [
      "modex-analytics://app/../" + path.basename(outside) + "/secret.js",
      "modex-analytics://app/%2e%2e/%2e%2e/etc/passwd",
      "modex-analytics://app/assets/link.js",
      "modex-analytics://app/assets/linked/secret.js",
      "modex-analytics://app/notes.md",
      "modex-analytics://app/missing.js",
      "modex-analytics://other/index.html",
    ]) assert.equal((await get(refused)).status, 404, refused);
    assert.equal((await get("modex-analytics://app/index.html", "POST")).status, 404);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("a torn ledger tail does not swallow the next recorded turn", () => {
  const dir = tmpdir("modex-usage-tail-");
  try {
    const ledger = new UsageLedger(dir);
    const first = ledger.record(turn());
    fs.appendFileSync(ledger.file, '{"id":"torn","at":');
    const next = new UsageLedger(dir).record(turn({ threadId: "after-crash" }));
    assert.deepEqual(new UsageLedger(dir).list().map(row => row.id), [first.id, next.id]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
