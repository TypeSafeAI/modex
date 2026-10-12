import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { test } from "node:test";

function harness() {
  const code = fs.readFileSync(path.resolve(import.meta.dirname, "../src/main/index.js"), "utf8");
  const start = code.indexOf("let servicesDrained"), end = code.indexOf("// Main-owned update lifecycle.", start);
  assert.ok(start >= 0 && end > start, "normal Quit and update restart must share service disposal");
  const calls: string[] = [];
  const service = (name: string) => ({ dispose: async () => { calls.push(name); } });
  const context: any = { servicesTouched: false, pagesAgents: service("pages"), knowledgeAgents: service("knowledge-agents"), knowledge: service("knowledge"),
    desktopHost: service("desktop-host"), companion: service("companion"), terminals: service("terminals"), runner: service("runner"),
    modexAccount: { cancel: () => calls.push("cancel-modex"), dispose: () => calls.push("dispose-modex") },
    chatgpt: { cancel: () => calls.push("cancel-chatgpt"), dispose: () => calls.push("dispose-chatgpt") },
    claudeLogin: { cancel: () => calls.push("cancel-claude") }, retirer: { stop: () => calls.push("stop-retirer") } };
  vm.runInNewContext(code.slice(start, end) + "\nglobalThis.drain = drainServices; globalThis.drained = () => servicesDrained;", context);
  return { context, calls };
}

test("main service drain coalesces update and Quit callers and does not repeat completed shutdown", async () => {
  const h = harness(); let finish!: () => void;
  h.context.runner.dispose = () => { h.calls.push("runner"); return new Promise<void>(resolve => { finish = resolve; }); };
  const first = h.context.drain(), second = h.context.drain();
  assert.equal(first, second); assert.equal(h.context.drained(), false); assert.equal(h.context.servicesTouched, true);
  await Promise.resolve(); finish(); await first;
  assert.equal(h.context.drained(), true);
  const before = [...h.calls]; await h.context.drain(); assert.deepEqual(h.calls, before);
  for (const name of ["pages", "knowledge-agents", "knowledge", "desktop-host", "companion", "terminals", "runner"]) assert.equal(h.calls.filter(x => x === name).length, 1);
});

for (const synchronous of [false, true]) test(`main service drain preserves ${synchronous ? "synchronous" : "asynchronous"} failure and permits a shutdown retry`, async () => {
  const h = harness(); let fail = true;
  h.context.pagesAgents.dispose = () => {
    h.calls.push("pages");
    if (fail) { if (synchronous) throw new Error("pages failed"); return Promise.reject(new Error("pages failed")); }
    return Promise.resolve();
  };
  await assert.rejects(h.context.drain(), /pages failed/);
  assert.equal(h.context.servicesTouched, true, "partial disposal cannot resume ordinary services");
  assert.equal(h.context.drained(), false);
  for (const name of ["knowledge", "desktop-host", "companion", "terminals", "runner"]) assert.ok(h.calls.includes(name), `${name} still drains`);
  fail = false; await h.context.drain(); assert.equal(h.context.drained(), true);
  assert.equal(h.calls.filter(x => x === "pages").length, 2);
});
