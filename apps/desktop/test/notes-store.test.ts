import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { NotesStore } from "../src/main/engine/notes-store.js";
import { tmpdir } from "./helpers.js";

/** A store over a fresh notes folder in a fresh home, with a clock the test can move. */
function withStore(run: (store: NotesStore, root: string, clock: { now: number }) => void): void {
  const home = tmpdir("modex-notes-");
  const clock = { now: Date.parse("2026-10-15T09:00:00.000Z") };
  const root = path.join(home, "notes");
  try { run(new NotesStore(root, { now: () => clock.now }), root, clock); } finally { fs.rmSync(home, { recursive: true, force: true }); }
}
const reopen = (root: string, clock?: { now: number }) => new NotesStore(root, clock ? { now: () => clock.now } : {});
const project = (root: string) => path.join(root, "Personal", "Notes");
/** Every file under the folder with its bytes, to prove an operation wrote nothing. */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else out[path.relative(root, p)] = fs.readFileSync(p, "utf8"); } };
  walk(root);
  return out;
}

// ── SpaceStore's contract, unchanged ──────────────────────────────────────────────────────────

test("page comments persist independently of content revisions and reject invalid writes", () => withStore((store, root) => {
  const page = store.create({ title: "Weekly update" });
  const added = store.addComment(page.id, "Confirm the dates", "Next week");
  store.save({ ...page, markdown: "Updated content" });
  assert.deepEqual(reopen(root).comments(page.id), [added]);
  assert.equal(store.history(page.id).length, 2, "comments must not create or overwrite page revisions");
  assert.throws(() => store.addComment(page.id, "  ", ""), /comment/i);
  assert.throws(() => store.addComment(page.id, "x".repeat(10_001), ""), /comment/i);
  assert.throws(() => store.addComment("missing", "Keep", ""), /page/i);
  store.trash(page.id, true);
  assert.throws(() => store.addComment(page.id, "Keep", ""), /Restore/);
  store.trash(page.id, false);
  store.deleteComment(page.id, added.id);
  assert.deepEqual(store.comments(page.id), []);
}));

test("notes persist edits, check revisions, and restore a trashed subtree", () => withStore((store, root) => {
  const parent = store.create({ title: "Plan" });
  const child = store.create({ title: "Notes", parentId: parent.id });
  const saved = store.save({ ...store.list().find(p => p.id === parent.id)!, markdown: "# Idea\n\n- [x] Ship", favorite: true });
  assert.equal(reopen(root).list().find(p => p.id === parent.id)?.markdown, saved.markdown);
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
}));

test("notes reject malformed writes and never overwrite unreadable data", () => withStore((store, root) => {
  const page = store.create({ title: "Keep" });
  assert.throws(() => store.save({ ...page, title: 42 } as never), /title/);
  assert.throws(() => store.create({ parentId: "missing" }), /parent/);
  const history = path.join(root, ".modex", "history", `${page.id}.json`);
  fs.writeFileSync(history, "broken data");
  const before = snapshot(root);
  assert.throws(() => reopen(root).list(), /preserved/);
  assert.throws(() => store.create({ title: "Must not replace" }), /preserved/);
  assert.deepEqual(snapshot(root), before);
}));

test("notes record attributed versions atomically and reload them", () => withStore((store, root) => {
  const page = store.create({ title: "Draft", markdown: "original" });
  const saved = store.save({ ...page, markdown: "agent edit" }, { actor: "agent:thread-1", summary: "Added findings" });
  const history = reopen(root).history(page.id);
  assert.deepEqual(history.map(v => [v.page.revision, v.page.markdown, v.actor]), [[1, "original", "human"], [2, "agent edit", "agent:thread-1"]]);
  assert.equal(history[1]!.summary, "Added findings");
  assert.deepEqual(history[1]!.page, saved);
  assert.throws(() => store.save({ ...page, markdown: "stale" }), /changed/);
  assert.deepEqual(store.history(page.id), history);
}));

test("notes reject stale trash and revert without changing saved data", () => withStore((store, root) => {
  const page = store.create({ title: "Draft" });
  store.save({ ...page, markdown: "new" });
  const before = snapshot(root);
  assert.throws(() => store.trash(page.id, true, page.revision), /changed/);
  assert.throws(() => store.revert(page.id, page.revision, 1), /changed/);
  assert.deepEqual(snapshot(root), before);
}));

test("revert restores content and placement as a new version", () => withStore(store => {
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

test("invalid attribution and unsafe revert placement write nothing", () => withStore((store, root) => {
  const parent = store.create({ title: "Parent" });
  const page = store.create({ title: "Child", parentId: parent.id });
  const moved = store.save({ ...page, parentId: null });
  store.trash(parent.id, true);
  const before = snapshot(root);
  assert.throws(() => store.revert(page.id, moved.revision, 1), /parent/);
  assert.throws(() => store.revert(page.id, moved.revision, 99), /version/i);
  assert.throws(() => store.save(moved, { actor: "", summary: "bad" }), /actor/i);
  assert.deepEqual(snapshot(root), before);
}));

test("human typing coalesces into checkpoints while explicit changes stay", () => withStore((store, root) => {
  let page = store.create({ title: "Long note", markdown: "x".repeat(100_000) });
  for (let i = 0; i < 30; i++) page = store.save({ ...page, markdown: `${page.markdown}.` });
  assert.equal(store.history(page.id).length, 2, "a typing burst retains the original and latest checkpoint");
  assert.ok(fs.statSync(path.join(root, ".modex", "history", `${page.id}.json`)).size < 400_000);
  const beforeAgent = page;
  page = store.save({ ...page, markdown: "Agent change" }, { actor: "thread:agent", summary: "Agent edit" });
  page = store.save({ ...page, markdown: "Human after agent" });
  page = store.save({ ...page, markdown: "Human after agent, continued" });
  assert.deepEqual(store.history(page.id).map(v => v.page.revision), [1, 31, 32, 34]);
  assert.equal(store.revert(page.id, page.revision, beforeAgent.revision).markdown, beforeAgent.markdown);
  assert.equal(reopen(root).list()[0]?.revision, 35);
}));

test("a typing interval starts a fresh checkpoint", () => withStore((store, _root, clock) => {
  let page = store.create({ title: "Checkpoints", markdown: "Original" });
  page = store.save({ ...page, markdown: "First typing burst" });
  clock.now += 31_000;
  page = store.save({ ...page, markdown: "Next typing burst" });
  assert.deepEqual(store.history(page.id).map(v => v.page.markdown), ["Original", "First typing burst", "Next typing burst"]);
  page = store.save({ ...page, markdown: "Next typing burst continued" });
  assert.deepEqual(store.history(page.id).map(v => v.page.revision), [1, 2, 4]);
}));

// ── The folder ────────────────────────────────────────────────────────────────────────────────

test("pages are Markdown files in Personal › Notes, and a page with children becomes a folder", () => withStore((store, root) => {
  const plan = store.create({ title: "Plan", markdown: "# Plan\n" });
  assert.equal(fs.readFileSync(path.join(project(root), "Plan.md"), "utf8"), `---\nmodex_id: ${plan.id}\n---\n# Plan\n`);
  const child = store.create({ title: "A/B: next?", parentId: plan.id, markdown: "child" });
  assert.ok(!fs.existsSync(path.join(project(root), "Plan.md")), "the parent moved into its own folder");
  assert.match(fs.readFileSync(path.join(project(root), "Plan", "Plan.md"), "utf8"), new RegExp(`modex_id: ${plan.id}`));
  const childFile = fs.readFileSync(path.join(project(root), "Plan", "A-B- next-.md"), "utf8");
  assert.match(childFile, /title: "A\/B: next\?"/, "a title the file name cannot carry is kept in frontmatter");
  assert.equal(store.list().find(p => p.id === child.id)?.title, "A/B: next?");
  for (const marker of ["Personal/.modex-workspace.json", "Personal/Notes/.modex-project.json"]) assert.ok(fs.existsSync(path.join(root, marker)), marker);
  const second = store.create({ title: "Plan" });
  assert.ok(fs.existsSync(path.join(project(root), "Plan 2.md")), "a name a folder already uses gets a suffix: a note and a folder never share one");
  assert.equal(store.list().find(p => p.id === second.id)?.title, "Plan");
}));

test("moving a folder note moves its whole folder, and settle renames files to their titles", () => withStore((store, root) => {
  const a = store.create({ title: "Area" });
  const b = store.create({ title: "Box", parentId: a.id });
  store.create({ title: "Inside", parentId: b.id });
  const target = store.create({ title: "Target" });
  const box = store.list().find(p => p.id === b.id)!;
  store.save({ ...box, parentId: target.id });
  assert.ok(fs.existsSync(path.join(project(root), "Target", "Box", "Box.md")));
  assert.ok(fs.existsSync(path.join(project(root), "Target", "Box", "Inside.md")));
  assert.equal(reopen(root).list().find(p => p.title === "Inside")?.parentId, b.id);
  const renamed = store.save({ ...store.list().find(p => p.id === b.id)!, title: "Crate" });
  assert.ok(fs.existsSync(path.join(project(root), "Target", "Box", "Box.md")), "typing a title never renames the file");
  store.settle(renamed.id);
  assert.ok(fs.existsSync(path.join(project(root), "Target", "Crate", "Crate.md")));
  assert.ok(fs.existsSync(path.join(project(root), "Target", "Crate", "Inside.md")));
  assert.doesNotMatch(fs.readFileSync(path.join(project(root), "Target", "Crate", "Crate.md"), "utf8"), /title:/, "once the name carries the title, frontmatter drops it");
  const leaf = store.create({ title: "case" });
  store.settle(store.save({ ...leaf, title: "Case" }).id);
  assert.deepEqual(fs.readdirSync(project(root)).filter(n => /^case\.md$/i.test(n)), ["Case.md"], "a case-only rename keeps one file");
}));

test("trash moves files out of the folder and restore puts them back", () => withStore((store, root) => {
  const plan = store.create({ title: "Plan" });
  const kid = store.create({ title: "Kid", parentId: plan.id });
  fs.writeFileSync(path.join(project(root), "Plan", "sketch.png"), "png");
  store.trash(plan.id, true);
  assert.ok(!fs.existsSync(path.join(project(root), "Plan", "Plan.md")));
  assert.ok(fs.existsSync(path.join(project(root), "Plan", "sketch.png")), "files that are not notes stay");
  assert.equal(reopen(root).list().filter(p => p.trashedAt).length, 2);
  store.trash(kid.id, false);
  assert.ok(fs.existsSync(path.join(project(root), "Plan", "Plan.md")));
  assert.ok(fs.existsSync(path.join(project(root), "Plan", "Kid.md")));
  assert.equal(fs.readdirSync(path.join(root, ".modex", "trash")).length, 0, "an emptied trash batch goes");
}));

test("edits outside Modex become versions, and frontmatter-only edits do not", () => withStore((store, root, clock) => {
  const page = store.create({ title: "Outside", markdown: "one" });
  const file = path.join(project(root), "Outside.md");
  fs.writeFileSync(file, `---\nmodex_id: ${page.id}\ntags: [a]\n---\none`);
  assert.equal(store.list()[0]!.revision, 1, "an unrelated frontmatter key is not a page change");
  fs.writeFileSync(file, `---\nmodex_id: ${page.id}\ntags: [a]\n---\ntwo`);
  clock.now += 1_000;
  const edited = store.list()[0]!;
  assert.deepEqual([edited.markdown, edited.revision], ["two", 2]);
  assert.deepEqual(store.history(page.id).map(v => [v.actor, v.summary]).at(-1), ["external", "Edited outside Modex"]);
  assert.throws(() => store.save({ ...page, markdown: "stale" }), /changed/, "a stale window hits the conflict flow");
  const saved = store.save({ ...edited, markdown: "three" });
  assert.match(fs.readFileSync(file, "utf8"), /tags: \[ a \]|tags:\n  - a|tags: \[a\]/, "Modex keeps other tools' keys");
  assert.equal(saved.revision, 3);
}));

test("a file moved or renamed outside Modex keeps its page, and a new file becomes one", () => withStore((store, root) => {
  const page = store.create({ title: "Mover" });
  fs.mkdirSync(path.join(project(root), "Shelf"));
  fs.renameSync(path.join(project(root), "Mover.md"), path.join(project(root), "Shelf", "Renamed.md"));
  const moved = store.list().find(p => p.id === page.id)!;
  assert.equal(moved.title, "Renamed", "without a frontmatter title the file name is the title");
  assert.equal(moved.revision, 2);
  fs.writeFileSync(path.join(project(root), "From Finder.md"), "dropped in");
  const found = store.list().find(p => p.title === "From Finder")!;
  assert.equal(found.markdown, "dropped in");
  assert.equal(store.history(found.id)[0]!.summary, "Found in notes folder");
  assert.equal(fs.readFileSync(path.join(project(root), "From Finder.md"), "utf8"), "dropped in", "listing never writes into a file");
  assert.equal(reopen(root).list().find(p => p.title === "From Finder")?.id, found.id, "its id survives a restart");
}));

test("a file deleted outside Modex is trashed after a second look and can be restored", () => withStore((store, root, clock) => {
  const page = store.create({ title: "Gone", markdown: "keep me" });
  fs.rmSync(path.join(project(root), "Gone.md"));
  assert.equal(store.list()[0]!.trashedAt, null, "one missing look is not a deletion");
  clock.now += 1_500;
  const gone = store.list()[0]!;
  assert.ok(gone.trashedAt);
  assert.equal(store.history(page.id).at(-1)!.summary, "Deleted outside Modex");
  store.trash(page.id, false);
  assert.match(fs.readFileSync(path.join(project(root), "Gone.md"), "utf8"), /keep me$/);
}));

test("a file deleted outside Modex before its project is renamed is restored in the renamed project", () => withStore((store, root, clock) => {
  const page = store.create({ title: "Gone", markdown: "keep me" });
  fs.rmSync(path.join(project(root), "Gone.md"));
  store.list();
  clock.now += 1_500;
  assert.ok(store.list()[0]!.trashedAt);
  store.rename(store.tree().nodes.find(n => n.kind === "project")!.id, "Journal");
  store.trash(page.id, false);
  assert.match(fs.readFileSync(path.join(root, "Personal", "Journal", "Gone.md"), "utf8"), /keep me$/);
  assert.ok(!fs.existsSync(project(root)), "the old project is not made again");
}));

for (const change of ["move", "rename"] as const) test(`a note trashed from a plain folder inside a folder note is restored after the folder note's ${change}`, () => withStore((store, root) => {
  const plan = store.create({ title: "Plan" });
  store.create({ title: "Step", parentId: plan.id });
  const planFolder = store.tree().nodes.find(n => n.kind === "folder" && n.noteId === plan.id)!;
  const sub = store.createFolder(planFolder.id, "Sub");
  const note = store.create({ title: "Note", containerId: sub.id });
  store.trash(note.id, true);
  if (change === "move") store.save({ ...store.list().find(p => p.id === plan.id)!, parentId: store.create({ title: "Target" }).id });
  else store.rename(planFolder.id, "Roadmap");
  const moved = store.tree().nodes.find(n => n.id === planFolder.id)!.rel;
  store.trash(note.id, false);
  assert.equal(store.tree().nodes.find(n => n.id === note.id)?.rel, `${moved}/Sub/Note.md`);
  assert.ok(!fs.existsSync(path.join(project(root), "Plan")), "the folder's old place is not made again");
}));

test("the folder refuses a link and a copied id gets a new one", () => withStore((store, root) => {
  const page = store.create({ title: "Original" });
  fs.copyFileSync(path.join(project(root), "Original.md"), path.join(project(root), "Copy.md"));
  const pages = store.list();
  assert.equal(pages.length, 2);
  assert.equal(pages.find(p => p.title === "Original")!.id, page.id, "the file at the indexed path keeps the id");
  assert.notEqual(pages.find(p => p.title === "Copy")!.id, page.id);
  const home = path.dirname(root);
  const real = path.join(home, "elsewhere");
  fs.mkdirSync(real);
  const linked = path.join(home, "linked-notes");
  fs.symlinkSync(real, linked);
  assert.throws(() => new NotesStore(linked).list(), /real folder/);
}));

test("a crash between the history and the note write is finished on the next read", () => withStore((store, root) => {
  const page = store.create({ title: "Crash", markdown: "before" });
  const history = path.join(root, ".modex", "history", `${page.id}.json`);
  const data = JSON.parse(fs.readFileSync(history, "utf8"));
  // The history already holds revision 2; the note file and the index still describe revision 1.
  data.versions.push({ page: { ...page, markdown: "after", revision: 2, updatedAt: "2026-10-15T09:00:01.000Z" }, actor: "thread:x", summary: "Agent edit" });
  fs.writeFileSync(history, JSON.stringify(data));
  const fresh = reopen(root);
  assert.deepEqual([fresh.list()[0]!.markdown, fresh.list()[0]!.revision], ["after", 2]);
  assert.match(fs.readFileSync(path.join(project(root), "Crash.md"), "utf8"), /after$/, "the note file is rewritten to match");
}));

test("settling a folder title that matches a child preserves the hierarchy", () => withStore((store, root) => {
  const parent = store.create({ title: "A" });
  const child = store.create({ title: "B", parentId: parent.id, markdown: "child body" });
  store.save({ ...store.list().find(p => p.id === parent.id)!, title: "B" });
  assert.doesNotThrow(() => store.settle(parent.id));
  for (const reader of [store, reopen(root)]) {
    const pages = reader.list();
    assert.equal(pages.find(p => p.id === parent.id)?.parentId, null);
    assert.equal(pages.find(p => p.id === parent.id)?.title, "B");
    assert.equal(pages.find(p => p.id === child.id)?.parentId, parent.id);
    assert.equal(pages.find(p => p.id === child.id)?.markdown, "child body");
  }
}));

test("restoring a folder beside a replacement preserves both subtrees", () => withStore((store, root) => {
  const parent = store.create({ title: "A" });
  const child = store.create({ title: "B", parentId: parent.id });
  store.trash(parent.id, true);
  const replacement = store.create({ title: "A" });
  const otherChild = store.create({ title: "C", parentId: replacement.id });
  store.trash(parent.id, false);
  for (const reader of [store, reopen(root)]) {
    const pages = reader.list();
    assert.equal(pages.length, 4);
    assert.equal(pages.find(p => p.id === parent.id)?.parentId, null);
    assert.equal(pages.find(p => p.id === replacement.id)?.parentId, null);
    assert.equal(pages.find(p => p.id === child.id)?.parentId, parent.id);
    assert.equal(pages.find(p => p.id === otherChild.id)?.parentId, replacement.id);
  }
}));


test("interrupted restore beside a replacement preserves both subtrees on recovery", () => withStore((store, root) => {
  const parent = store.create({ title: "A" });
  const child = store.create({ title: "B", parentId: parent.id });
  store.trash(parent.id, true);
  const replacement = store.create({ title: "A" });
  const otherChild = store.create({ title: "C", parentId: replacement.id });
  const link = fs.linkSync;
  fs.linkSync = ((from, to) => {
    if (String(from).includes(`${path.sep}.modex${path.sep}trash${path.sep}`)) throw new Error("injected restore interruption");
    return link(from, to);
  }) as typeof fs.linkSync;
  try { assert.throws(() => store.trash(parent.id, false), /injected restore/); } finally { fs.linkSync = link; }
  for (const reader of [reopen(root), reopen(root)]) {
    const pages = reader.list();
    assert.equal(pages.length, 4);
    assert.equal(pages.find(p => p.id === parent.id)?.parentId, null);
    assert.equal(pages.find(p => p.id === replacement.id)?.parentId, null);
    assert.equal(pages.find(p => p.id === child.id)?.parentId, parent.id);
    assert.equal(pages.find(p => p.id === otherChild.id)?.parentId, replacement.id);
  }
}));

for (const interruption of ["link", "unlink"] as const) test(`folder settlement recovers an interruption at ${interruption}`, () => withStore((store, root) => {
  const parent = store.create({ title: "A", markdown: "parent body" });
  const child = store.create({ title: "B", parentId: parent.id, markdown: "child body" });
  store.save({ ...store.list().find(p => p.id === parent.id)!, title: "B" });
  const original = interruption === "link" ? fs.linkSync : fs.unlinkSync;
  const fail = () => { throw new Error("injected settlement interruption"); };
  if (interruption === "link") fs.linkSync = fail;
  else fs.unlinkSync = ((file) => {
    if (path.basename(String(file)) === "A.md") fail();
    return (original as typeof fs.unlinkSync)(file);
  }) as typeof fs.unlinkSync;
  try { assert.throws(() => store.settle(parent.id), /injected settlement/); }
  finally {
    if (interruption === "link") fs.linkSync = original as typeof fs.linkSync;
    else fs.unlinkSync = original as typeof fs.unlinkSync;
  }
  for (const reader of [reopen(root), store, reopen(root)]) {
    const pages = reader.list();
    assert.equal(pages.length, 2);
    assert.equal(pages.find(p => p.id === parent.id)?.title, "B");
    assert.equal(pages.find(p => p.id === parent.id)?.markdown, "parent body");
    assert.equal(pages.find(p => p.id === child.id)?.parentId, parent.id);
    assert.equal(pages.find(p => p.id === child.id)?.markdown, "child body");
  }
}));

for (const [label, journal] of [
  ["a backslash path, as older versions wrote", JSON.stringify({ version: 1, from: "Personal/Notes/R\\D", to: "Personal/Notes/R-D", note: "R\\D.md" })],
  ["unreadable JSON", "{\"version\":1,"],
] as const) test(`a folder rename journal with ${label} is set aside instead of failing every read`, () => withStore((store, root) => {
  const page = store.create({ title: "Kept" });
  fs.mkdirSync(path.join(project(root), "R\\D"));
  fs.writeFileSync(path.join(project(root), "R\\D", "R\\D.md"), "plans");
  fs.writeFileSync(path.join(root, ".modex", "settlement.json"), journal);
  for (const reader of [reopen(root), store, reopen(root)]) {
    const pages = reader.list();
    assert.equal(pages.length, 2);
    assert.ok(pages.some(p => p.id === page.id));
  }
  assert.equal(fs.readFileSync(path.join(project(root), "R\\D", "R\\D.md"), "utf8").includes("plans"), true, "the folders stay as they are");
  const aside = fs.readdirSync(path.join(root, ".modex")).filter(name => name.startsWith("settlement"));
  assert.equal(aside.length, 1);
  assert.notEqual(aside[0], "settlement.json");
  assert.equal(fs.readFileSync(path.join(root, ".modex", aside[0]!), "utf8"), journal, "the journal is kept to look at");
}));

for (const basename of ["A.MD", "a.md"]) test(`folder settlement preserves the exact source basename ${basename}`, () => withStore((store, root) => {
  const parent = store.create({ title: "A" });
  const child = store.create({ title: "Child", parentId: parent.id });
  fs.renameSync(path.join(project(root), "A", "A.md"), path.join(project(root), "A", basename));
  const fresh = reopen(root);
  fresh.save({ ...fresh.list().find(p => p.id === parent.id)!, title: "B" });
  const lstat = fs.lstatSync;
  // Enforce Linux's exact-name lookup even on a case-insensitive developer volume.
  Object.defineProperty(fs, "lstatSync", { value: ((file, ...args) => {
    const name = String(file);
    if (name.endsWith(".md") && fs.existsSync(path.dirname(name)) &&
        !fs.readdirSync(path.dirname(name)).includes(path.basename(name))) {
      throw Object.assign(new Error("case-sensitive lookup"), { code: "ENOENT" });
    }
    return lstat(file, ...args);
  }) as typeof fs.lstatSync });
  try { fresh.settle(parent.id); } finally { Object.defineProperty(fs, "lstatSync", { value: lstat }); }
  assert.equal(reopen(root).list().find(p => p.id === child.id)?.parentId, parent.id);
}));

test("saved task view keeps the saved revision after edits, replacement and a watched cross-project move", () => withStore((store, root) => {
  const own = store.linkProject({ id: "task-project", name: "Task project", path: "/repo" });
  const other = store.linkProject({ id: "other-project", name: "Other project", path: "/other" });
  const saved = store.create({ title: "Task: fix", markdown: "## Plan\n- [x] Fix (reported done)\n\n## Clarifications\n(hidden)\n\n## Files the turn touched\nsrc/a.ts\n\n## Verification\nNot verified", containerId: own.id }, { actor: "human", summary: "Saved a task record", taskProjectId: "task-project" });
  const view = (notes: NotesStore = store) => notes.taskView(saved.id)!;
  const before = snapshot(root);
  assert.equal(view().markdown, saved.markdown);
  assert.equal(view().edited, false);
  assert.deepEqual(snapshot(root), before, "opening does not write notes or history");
  store.save({ ...saved, markdown: "My edited note" });
  assert.equal(view().markdown, saved.markdown);
  assert.equal(view().edited, true);
  store.create({ title: "Task: fix (saved again)", containerId: own.id }, { actor: "human", summary: "Saved a task record", taskProjectId: "task-project" });
  assert.equal(view(reopen(root)).markdown, saved.markdown, "old note remains readable after replacement and restart");
  store.watch();
  try {
    const rel = store.pageRels().get(saved.id)!;
    fs.renameSync(path.join(root, rel), path.join(root, other.rel, path.basename(rel)));
    assert.equal(view().moved, true, "fresh ownership even before the watcher delivers the move");
    assert.equal(view().markdown, saved.markdown);
  } finally { store.unwatch(); }
}));

test("older task saves use history and state placement uncertainty explicitly", () => withStore((store) => {
  const plain = store.create({ title: "Task: not a saved task", markdown: "From modex thread fake." });
  assert.equal(store.taskView(plain.id), null, "title and text do not establish a task save");
  const saved = store.create({ title: "Old task", markdown: "Saved plan" }, { actor: "human", summary: "Saved a task record" });
  store.save({ ...saved, markdown: "Edited plan" });
  assert.equal(store.taskView(saved.id)!.markdown, "Saved plan");
  assert.equal(store.taskView(saved.id)!.moved, null);
  store.trash(saved.id, true);
  assert.equal(store.taskView(saved.id), null);
  assert.equal(store.taskView("missing"), null);
}));
