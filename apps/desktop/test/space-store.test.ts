import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SpaceStore } from "../src/main/engine/space-store.js";

test("Space persists edits, checks revisions, and restores a trashed subtree", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "modex-space-"));
  try {
    const store = new SpaceStore(dir);
    const parent = store.create({ title: "Plan" });
    const child = store.create({ title: "Notes", parentId: parent.id });
    const saved = store.save({ ...parent, markdown: "# Idea\n\n- [x] Ship", favorite: true });
    assert.equal(new SpaceStore(dir).list().find(p => p.id === parent.id)?.markdown, saved.markdown);
    assert.throws(() => store.save({ ...parent, title: "Stale" }), /changed/);
    assert.throws(() => store.save({ ...saved, parentId: child.id }), /inside itself/);
    store.trash(parent.id, true);
    assert.equal(store.list().filter(p => p.trashedAt).length, 2);
    store.trash(child.id, false);
    assert.equal(store.list().filter(p => p.trashedAt).length, 0);
    assert.equal(store.list().find(p => p.id === child.id)?.parentId, parent.id);
    const sibling = store.create({ title: "Unrelated", parentId: parent.id });
    store.trash(sibling.id, true);
    store.trash(child.id, true);
    store.trash(child.id, false);
    assert.ok(store.list().find(p => p.id === sibling.id)?.trashedAt, "restoring a child must not restore its siblings");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("Space rejects malformed writes and never overwrites unreadable data", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "modex-space-"));
  try {
    const store = new SpaceStore(dir);
    const page = store.create({ title: "Keep" });
    assert.throws(() => store.save({ ...page, title: 42 } as never), /title/);
    assert.throws(() => store.create({ parentId: "missing" }), /parent/);
    const file = path.join(dir, "space.json");
    fs.writeFileSync(file, "broken data");
    assert.throws(() => new SpaceStore(dir).list(), /Space/);
    assert.throws(() => store.create({ title: "Must not replace" }), /Space/);
    assert.equal(fs.readFileSync(file, "utf8"), "broken data");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

function withStore(run: (store: SpaceStore, dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "modex-space-history-"));
  try { run(new SpaceStore(dir), dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test("Space records attributed versions atomically and reloads them", () => withStore((store, dir) => {
  const page = store.create({ title: "Draft", markdown: "original" });
  const saved = store.save({ ...page, markdown: "agent edit" }, { actor: "agent:thread-1", summary: "Added findings" });
  const history = new SpaceStore(dir).history(page.id);
  assert.deepEqual(history.map(v => [v.page.revision, v.page.markdown, v.actor]), [[1, "original", "human"], [2, "agent edit", "agent:thread-1"]]);
  assert.equal(history[1]!.summary, "Added findings");
  assert.deepEqual(history[1]!.page, saved);
  assert.throws(() => store.save({ ...page, markdown: "stale" }), /changed/);
  assert.deepEqual(store.history(page.id), history);
}));

test("Space rejects stale trash and revert without changing saved data", () => withStore((store, dir) => {
  const page = store.create({ title: "Draft" });
  store.save({ ...page, markdown: "new" });
  const before = fs.readFileSync(path.join(dir, "space.json"), "utf8");
  assert.throws(() => store.trash(page.id, true, page.revision), /changed/);
  assert.throws(() => store.revert(page.id, page.revision, 1), /changed/);
  assert.equal(fs.readFileSync(path.join(dir, "space.json"), "utf8"), before);
}));

test("Space revert restores content and placement as a new version", () => withStore(store => {
  const parent = store.create({ title: "Parent" });
  const page = store.create({ title: "Original", markdown: "original", parentId: parent.id });
  const saved = store.save({ ...page, title: "Changed", markdown: "changed", favorite: true, parentId: null });
  const reverted = store.revert(page.id, saved.revision, 1, { actor: "human", summary: "Undo agent edit" });
  assert.deepEqual({ ...reverted, revision: page.revision, updatedAt: page.updatedAt }, page);
  assert.equal(reverted.revision, 3);
  assert.equal(store.history(page.id).length, 3);
  assert.equal(store.history(page.id)[2]!.summary, "Undo agent edit");
  store.trash(page.id, true, reverted.revision);
  assert.throws(() => store.revert(page.id, 4, 1), /Restore/);
  store.trash(page.id, false, 4);
  assert.equal(store.revert(page.id, 5, 1).revision, 6);
}));

test("Space migrates legacy pages without losing original snapshots or sibling trash", () => withStore((store, dir) => {
  const root = store.create({ title: "Root" });
  const child = store.create({ title: "Child", parentId: root.id });
  const leaf = store.create({ title: "Leaf", parentId: child.id });
  const sibling = store.create({ title: "Sibling", parentId: root.id });
  const original = store.list();
  fs.writeFileSync(path.join(dir, "space.json"), JSON.stringify({ version: 1, pages: original }));
  assert.deepEqual(store.list(), original);
  assert.deepEqual(store.history(root.id).map(v => v.page), [root]);
  store.trash(root.id, true, 1, { actor: "agent:thread-1", summary: "Archive tree" });
  for (const page of original) {
    const history = store.history(page.id);
    assert.deepEqual(history.map(v => v.page.revision), [1, 2]);
    assert.deepEqual(history[0]!.page, page);
    assert.equal(history[1]!.actor, "agent:thread-1");
  }
  store.trash(child.id, false, 2);
  const reloaded = new SpaceStore(dir);
  for (const id of [root.id, child.id, leaf.id]) {
    assert.equal(reloaded.list().find(p => p.id === id)?.trashedAt, null);
    assert.deepEqual(reloaded.history(id).map(v => v.page.revision), [1, 2, 3]);
  }
  assert.ok(reloaded.list().find(p => p.id === sibling.id)?.trashedAt);
  assert.deepEqual(reloaded.history(sibling.id).map(v => v.page.revision), [1, 2]);
}));

test("Space legacy save retains the prior revision", () => withStore((store, dir) => {
  const page = { ...store.create({ title: "Legacy", markdown: "never lose" }), revision: 7 };
  fs.writeFileSync(path.join(dir, "space.json"), JSON.stringify({ version: 1, pages: [page] }));
  store.save({ ...page, markdown: "replacement" });
  assert.deepEqual(store.history(page.id).map(v => [v.page.revision, v.page.markdown]), [[7, "never lose"], [8, "replacement"]]);
}));

test("Space rejects corrupt history and preserves the entire file", () => withStore((store, dir) => {
  const page = store.create({ title: "Keep" });
  const file = path.join(dir, "space.json");
  const good = JSON.parse(fs.readFileSync(file, "utf8"));
  const variants = [
    { ...good, history: null },
    { ...good, history: [{ page, actor: 42, summary: "bad" }] },
    { ...good, history: [{ page: { ...page, markdown: "different" }, actor: "human", summary: "bad" }] },
    { ...good, history: [] },
    { ...good, history: [good.history[0], good.history[0]] },
    { ...good, history: [{ page: { ...page, id: "missing" }, actor: "human", summary: "bad" }, ...good.history] },
    { ...good, version: 1 },
    { ...good, pages: [page, page] },
  ];
  for (const data of variants) {
    const broken = JSON.stringify(data);
    fs.writeFileSync(file, broken);
    assert.throws(() => store.list(), /preserved/);
    assert.throws(() => store.create({ title: "Must not replace" }), /preserved/);
    assert.equal(fs.readFileSync(file, "utf8"), broken);
  }
}));

test("Space rejects invalid attribution and unsafe revert placement without writing", () => withStore((store, dir) => {
  const parent = store.create({ title: "Parent" });
  const page = store.create({ title: "Child", parentId: parent.id });
  const moved = store.save({ ...page, parentId: null });
  store.trash(parent.id, true);
  const before = fs.readFileSync(path.join(dir, "space.json"), "utf8");
  assert.throws(() => store.revert(page.id, moved.revision, 1), /parent/);
  assert.throws(() => store.revert(page.id, moved.revision, 99), /version/i);
  assert.throws(() => store.save(moved, { actor: "", summary: "bad" }), /actor/i);
  assert.equal(fs.readFileSync(path.join(dir, "space.json"), "utf8"), before);
}));

test("Space coalesces human typing checkpoints while preserving pre-agent recovery", () => withStore((store, dir) => {
  let page = store.create({ title: "Long note", markdown: "x".repeat(100_000) });
  for (let i = 0; i < 30; i++) page = store.save({ ...page, markdown: `${page.markdown}.` });
  assert.equal(store.history(page.id).length, 2, "a typing burst retains the original and latest checkpoint");
  assert.ok(fs.statSync(path.join(dir, "space.json")).size < 400_000);
  const beforeAgent = page;
  page = store.save({ ...page, markdown: "Agent change" }, { actor: "thread:agent", summary: "Agent edit" });
  page = store.save({ ...page, markdown: "Human after agent" });
  page = store.save({ ...page, markdown: "Human after agent, continued" });
  assert.deepEqual(store.history(page.id).map(v => v.page.revision), [1, 31, 32, 34]);
  assert.equal(store.revert(page.id, page.revision, beforeAgent.revision).markdown, beforeAgent.markdown);
  assert.equal(new SpaceStore(dir).list()[0]?.revision, 35);
}));

test("Space starts a fresh checkpoint after a typing interval", () => withStore((store, dir) => {
  let page = store.create({ title: "Checkpoints", markdown: "Original" });
  page = store.save({ ...page, markdown: "First typing burst" });
  const file = path.join(dir, "space.json");
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  data.history.at(-1).checkpointAt = new Date(Date.now() - 31_000).toISOString();
  fs.writeFileSync(file, JSON.stringify(data));
  page = store.save({ ...page, markdown: "Next typing burst" });
  assert.deepEqual(store.history(page.id).map(v => v.page.markdown), ["Original", "First typing burst", "Next typing burst"]);
  page = store.save({ ...page, markdown: "Next typing burst continued" });
  assert.deepEqual(store.history(page.id).map(v => v.page.revision), [1, 2, 4]);
}));
