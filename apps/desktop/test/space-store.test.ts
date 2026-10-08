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
