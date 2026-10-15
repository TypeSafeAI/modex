import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SpaceStore } from "../src/main/engine/space-store.js";
import { NotesStore } from "../src/main/engine/notes-store.js";
import { planMigration } from "../src/main/engine/notes-migration.js";
import type { SpacePage } from "../src/shared/space.js";
import { tmpdir } from "./helpers.js";

/** A home whose `app/space.json` was written by today's SpaceStore. */
function legacyHome(seed: (space: SpaceStore) => void): { home: string; app: string; legacy: string; root: string } {
  const home = tmpdir("modex-notes-migration-");
  const app = path.join(home, "app");
  fs.mkdirSync(app);
  seed(new SpaceStore(app));
  return { home, app, legacy: path.join(app, "space.json"), root: path.join(home, "notes") };
}
const open = (h: { legacy: string; root: string }) => new NotesStore(h.root, { legacySpaceFile: h.legacy });
const project = (root: string) => path.join(root, "Personal", "Notes");

test("migration keeps every page's id, revision, history and comments, and lays nesting out as folders", () => {
  let ids: Record<string, string> = {};
  let comment = "";
  const h = legacyHome(space => {
    const plan = space.create({ title: "Plan", markdown: "# Plan" });
    const child = space.create({ title: "Child", parentId: plan.id });
    const leaf = space.create({ title: "Leaf", parentId: child.id, markdown: "deep" });
    const odd = space.create({ title: "A/B: plan" });
    const twin = space.create({ title: "plan" });
    space.save({ ...plan, markdown: "# Plan v2", favorite: true });
    comment = space.addComment(child.id, "Check this", "Child").id;
    ids = { plan: plan.id, child: child.id, leaf: leaf.id, odd: odd.id, twin: twin.id };
  });
  try {
    const before = fs.readFileSync(h.legacy, "utf8");
    const legacyPages = new SpaceStore(h.app).list();
    const notes = open(h);
    const pages = notes.list();
    assert.deepEqual(pages.map(p => p.id).sort(), legacyPages.map(p => p.id).sort());
    for (const legacy of legacyPages) {
      assert.deepEqual(pages.find(p => p.id === legacy.id), legacy, "the page is exactly what it was");
      assert.deepEqual(notes.history(legacy.id), new SpaceStore(h.app).history(legacy.id), "and so is its history");
    }
    assert.deepEqual(notes.comments(ids.child!).map(c => c.id), [comment]);
    assert.ok(fs.existsSync(path.join(project(h.root), "Plan", "Plan.md")));
    assert.ok(fs.existsSync(path.join(project(h.root), "Plan", "Child", "Child.md")));
    assert.ok(fs.existsSync(path.join(project(h.root), "Plan", "Child", "Leaf.md")));
    assert.ok(fs.existsSync(path.join(project(h.root), "A-B- plan.md")));
    assert.ok(fs.existsSync(path.join(project(h.root), "plan 2.md")), "a title that differs only in case still gets its own file");
    assert.equal(fs.readFileSync(h.legacy, "utf8"), before, "space.json is never written");
    const backups = fs.readdirSync(h.app).filter(n => n.startsWith("space.json.pre-notes-"));
    assert.equal(backups.length, 1);
    assert.equal(fs.readFileSync(path.join(h.app, backups[0]!), "utf8"), before);
    const receipt = JSON.parse(fs.readFileSync(path.join(h.root, ".modex", "migration.json"), "utf8"));
    assert.equal(receipt.source, "app/space.json");
    assert.equal(receipt.revisions[ids.plan!], 2);
    // A second launch neither migrates again nor duplicates anything.
    assert.equal(open(h).list().length, legacyPages.length);
    assert.equal(fs.readdirSync(path.dirname(h.root)).filter(n => n.startsWith("notes.migrating-")).length, 0);
  } finally { fs.rmSync(h.home, { recursive: true, force: true }); }
});

test("migration keeps trashed pages in the trash, restorable to their place", () => {
  let ids: Record<string, string> = {};
  const h = legacyHome(space => {
    const folder = space.create({ title: "Old" });
    const inside = space.create({ title: "Inside", parentId: folder.id });
    const kept = space.create({ title: "Kept" });
    space.trash(folder.id, true);
    ids = { folder: folder.id, inside: inside.id, kept: kept.id };
  });
  try {
    const notes = open(h);
    assert.equal(notes.list().filter(p => p.trashedAt).length, 2);
    assert.ok(!fs.existsSync(path.join(project(h.root), "Old")), "a trashed page is not in the folder");
    notes.trash(ids.inside!, false);
    assert.ok(fs.existsSync(path.join(project(h.root), "Old", "Old.md")), "restoring a child restores its parent folder note");
    assert.ok(fs.existsSync(path.join(project(h.root), "Old", "Inside.md")));
    assert.equal(notes.list().find(p => p.id === ids.inside)?.parentId, ids.folder);
  } finally { fs.rmSync(h.home, { recursive: true, force: true }); }
});

test("a version 1 space.json migrates with its baseline versions", () => {
  const h = legacyHome(() => {});
  try {
    const page: SpacePage = { id: "legacy-1", parentId: null, title: "Legacy", markdown: "never lose", favorite: false, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", trashedAt: null, revision: 7 };
    fs.writeFileSync(h.legacy, JSON.stringify({ version: 1, pages: [page] }));
    const notes = open(h);
    assert.deepEqual(notes.list(), [page]);
    assert.deepEqual(notes.history(page.id).map(v => [v.page.revision, v.actor]), [[7, "unknown"]]);
    const saved = notes.save({ ...page, markdown: "replacement" });
    assert.equal(saved.revision, 8);
  } finally { fs.rmSync(h.home, { recursive: true, force: true }); }
});

test("an unreadable space.json stops the migration and is kept as it is", () => {
  const h = legacyHome(space => { space.create({ title: "Keep" }); });
  try {
    fs.writeFileSync(h.legacy, "broken data");
    assert.throws(() => open(h).list(), /preserved/);
    assert.equal(fs.readFileSync(h.legacy, "utf8"), "broken data");
    assert.ok(!fs.existsSync(h.root), "nothing is published");
  } finally { fs.rmSync(h.home, { recursive: true, force: true }); }
});

test("a crashed migration's staging folder is discarded and the migration runs again", () => {
  const h = legacyHome(space => { space.create({ title: "Once" }); });
  try {
    const stale = `${h.root}.migrating-crashed`;
    fs.mkdirSync(path.join(stale, "Personal"), { recursive: true });
    fs.writeFileSync(path.join(stale, "Personal", "half.md"), "half");
    const notes = open(h);
    assert.deepEqual(notes.list().map(p => p.title), ["Once"]);
    assert.ok(!fs.existsSync(stale));
  } finally { fs.rmSync(h.home, { recursive: true, force: true }); }
});

test("pages an older Modex changed in space.json come back under Recovered, never over newer notes", () => {
  let id = "";
  const h = legacyHome(space => { id = space.create({ title: "Shared", markdown: "v1" }).id; });
  try {
    const notes = open(h);
    const current = notes.list()[0]!;
    notes.save({ ...current, markdown: "newer in notes" });
    // Downgrade: the old build edits space.json, then the new build opens again.
    const old = new SpaceStore(h.app);
    old.save({ ...old.list()[0]!, markdown: "edited by an older build" });
    old.create({ title: "Made while downgraded" });
    const reopened = open(h);
    const pages = reopened.list();
    assert.equal(pages.find(p => p.id === id)?.markdown, "newer in notes", "the newer note is untouched");
    const recovered = pages.find(p => p.title.startsWith("Recovered from earlier Modex"))!;
    assert.deepEqual(pages.filter(p => p.parentId === recovered.id).map(p => p.markdown).sort(), ["", "edited by an older build"]);
    assert.equal(open(h).list().length, pages.length, "the same changes are not recovered twice");
  } finally { fs.rmSync(h.home, { recursive: true, force: true }); }
});

test("a fresh home gets the default workspace and project, with no space.json", () => {
  const home = tmpdir("modex-notes-fresh-");
  try {
    const notes = new NotesStore(path.join(home, "notes"), { legacySpaceFile: path.join(home, "app", "space.json") });
    assert.deepEqual(notes.list(), []);
    assert.ok(fs.existsSync(path.join(home, "notes", "Personal", "Notes", ".modex-project.json")));
    assert.equal(JSON.parse(fs.readFileSync(path.join(home, "notes", ".modex", "migration.json"), "utf8")).source, null);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("the plan places a page whose parent is missing at the top level and warns", () => {
  const page = (id: string, parentId: string | null, title: string): SpacePage => ({ id, parentId, title, markdown: "", favorite: false, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", trashedAt: null, revision: 1 });
  const plan = planMigration([page("a", null, "Index"), page("b", "gone", "Orphan"), page("c", null, "")], "Personal/Notes", dir => dir === "Personal/Notes" ? ["Orphan.md"] : []);
  assert.deepEqual(plan.notes.map(n => n.rel), ["Personal/Notes/Index note.md", "Personal/Notes/Orphan 2.md", "Personal/Notes/Untitled.md"]);
  assert.equal(plan.warnings.length, 1);
});
