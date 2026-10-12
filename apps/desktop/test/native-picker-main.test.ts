import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { test } from "node:test";

function fixture(paths: string[], cancelled = false) {
  const code = fs.readFileSync(path.resolve(import.meta.dirname, "../src/main/index.js"), "utf8");
  const start = code.indexOf('handle("drafts:pick",'), end = code.indexOf('handle("drafts:discard",', start);
  assert.ok(start >= 0 && end > start);
  const handlers = new Map<string, Function>(), chosen: string[][] = [];
  let dialogs = 0;
  const context = { win: {}, LIMITS: { perTurn: 20 },
    dialog: { showOpenDialog: async () => { dialogs++; return { canceled: cancelled, filePaths: paths }; } },
    nativeFor: () => ({ pick: async (_session: string, _owner: unknown, remaining: number, choose: () => Promise<string[]>) => {
      if (!Number.isInteger(remaining) || remaining < 0 || remaining > 20) throw new Error("Invalid attachment capacity.");
      const selected = await choose(); chosen.push([...selected]);
      return { staged: selected.map(name => ({ name })), errors: [] as string[] };
    } }), handle: (channel: string, handler: Function) => handlers.set(channel, handler) };
  vm.runInNewContext(code.slice(start, end), context);
  return { chosen, dialogs: () => dialogs, pick: (remaining: number) => handlers.get("drafts:pick")!({ session: "document", owner: {}, remaining }, {}) };
}

test("native picker reports trusted selection overflow while staging only reserved capacity", async () => {
  for (const remaining of [20, 1, 0]) {
    const paths = Array.from({ length: 21 }, (_, index) => `selected-${index}`), h = fixture(paths);
    const result = await h.pick(remaining);
    assert.deepEqual(h.chosen, [paths.slice(0, remaining)]);
    assert.equal(result.staged.length, remaining);
    assert.deepEqual([...result.errors], [`Up to 20 attachments per message; ${21 - remaining} left out.`]);
  }
});
test("cancelled native picker stages nothing and does not report the discarded selection", async () => {
  const h = fixture(["cancelled"], true), result = await h.pick(0);
  assert.deepEqual(h.chosen, [[]]); assert.deepEqual([...result.errors], []);
});
test("invalid native capacities are rejected before opening a dialog", async () => {
  for (const remaining of [-1, 21, 1.5]) {
    const h = fixture(["selected"]);
    await assert.rejects(h.pick(remaining), /Invalid attachment capacity/);
    assert.equal(h.dialogs(), 0); assert.deepEqual(h.chosen, []);
  }
});
