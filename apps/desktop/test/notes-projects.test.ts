import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Store } from "../src/main/engine/store.js";
import { NotesStore, watchedChange } from "../src/main/engine/notes-store.js";
import { gitRepo, tmpdir } from "./helpers.js";

const marker = (home: string, ...rel: string[]) => JSON.parse(fs.readFileSync(path.join(home, "notes", ...rel, ".modex-project.json"), "utf8"));

test("adding a Modex project gives it notes in the default workspace, once", () => {
  const home = tmpdir("modex-notes-projects-");
  const store = new Store(home);
  const repo = gitRepo();
  const project = store.addProject(repo);
  const notes = store.space.projectFor(project.id)!;
  assert.equal(notes.rel, `Personal/${path.basename(repo)}`);
  assert.equal(marker(home, "Personal", path.basename(repo)).codePath, project.path);
  assert.equal(store.space.linkProject(project).id, notes.id, "linking again finds the same notes");
  assert.equal(store.addProject(repo).id, project.id);
  assert.equal(store.space.tree().nodes.filter(n => n.kind === "project").length, 2, "the default Notes project, and this one");
});

test("removing a project keeps its notes, and adding its folder again links them back", () => {
  const home = tmpdir("modex-notes-projects-");
  const store = new Store(home);
  const repo = gitRepo();
  const first = store.addProject(repo);
  const notes = store.space.projectFor(first.id)!;
  store.space.create({ title: "Decisions", containerId: notes.id });
  store.removeProject(first.id);
  assert.equal(store.space.projectFor(first.id), undefined);
  assert.equal(marker(home, ...notes.rel.split("/")).modexProjectId, null);
  assert.ok(marker(home, ...notes.rel.split("/")).detachedAt);
  assert.ok(store.space.list().some(p => p.title === "Decisions"), "the notes stay in Space");
  const again = store.addProject(repo);
  assert.notEqual(again.id, first.id);
  assert.equal(store.space.projectFor(again.id)?.id, notes.id, "same folder, same notes");
});

test("two projects with one name get separate notes, and existing projects are linked when notes open", () => {
  const home = tmpdir("modex-notes-projects-");
  const a = path.join(tmpdir("modex-a-"), "app");
  const b = path.join(tmpdir("modex-b-"), "app");
  fs.mkdirSync(a); fs.mkdirSync(b);
  const store = new Store(home);
  const pa = store.addProject(a);
  const pb = store.addProject(b);
  assert.deepEqual([store.space.projectFor(pa.id)?.rel, store.space.projectFor(pb.id)?.rel], ["Personal/app", "Personal/app 2"]);
  // A home whose projects predate the notes folder: notes open and link them all.
  const older = tmpdir("modex-notes-projects-");
  fs.mkdirSync(path.join(older, "app"), { recursive: true });
  fs.writeFileSync(path.join(older, "app", "state.json"), JSON.stringify({ version: 1, projects: [{ id: "p-old", name: "legacy", path: a, addedAt: "2026-01-01T00:00:00.000Z" }], threads: [], settings: {} }));
  const reopened = new Store(older);
  assert.equal(reopened.space.projectFor("p-old")?.rel, "Personal/legacy");
});

test("the workspace summary says which Modex projects each workspace holds", () => {
  const home = tmpdir("modex-notes-projects-");
  const notes = new NotesStore(path.join(home, "notes"));
  const linked = notes.linkProject({ id: "p1", name: "site", path: "/code/site" });
  const work = notes.createWorkspace("Clients");
  notes.moveNodes([linked.id], work.id);
  const summary = notes.workspaces();
  assert.deepEqual(summary.map(w => [w.name, w.isDefault, w.modexProjectIds]), [["Personal", true, []], ["Clients", false, ["p1"]]]);
  assert.equal(notes.projectFor("p1")?.rel, "Clients/site", "a project moved between workspaces keeps its link");
});

test("a project folder copied in Finder becomes a project of its own instead of making the notes unreadable", () => {
  const home = tmpdir("modex-notes-copies-");
  const notes = new NotesStore(path.join(home, "notes"));
  const at = (...rel: string[]) => path.join(notes.root, ...rel);
  const mine = notes.linkProject({ id: "project", name: "mine", path: "/code/mine" });
  notes.create({ title: "Plan", markdown: "keep", containerId: mine.id });
  const defaultId = notes.tree().nodes.find(n => n.kind === "project" && n.isDefault)!.id;
  // The default project, copied and then renamed away from its recorded place; a linked project, copied.
  fs.cpSync(at("Personal", "Notes"), at("Personal", "Notes copy"), { recursive: true });
  fs.renameSync(at("Personal", "Notes"), at("Personal", "Zeta"));
  fs.cpSync(at("Personal", "mine"), at("Personal", "mine copy"), { recursive: true });
  const projects = notes.tree().nodes.filter(n => n.kind === "project");
  assert.equal(new Set(projects.map(p => p.id)).size, projects.length, "every project has its own id");
  assert.equal(projects.filter(p => p.kind === "project" && p.isDefault).length, 1, "one default project");
  assert.equal(projects.find(p => p.id === defaultId)?.rel, "Personal/Notes copy", "the default stays with the first in sorted order");
  assert.equal(notes.projectFor("project")?.rel, "Personal/mine", "the original keeps its Modex project");
  assert.equal(JSON.parse(fs.readFileSync(at("Personal", "mine copy", ".modex-project.json"), "utf8")).modexProjectId, null, "the copy is linked to none");
  assert.ok(notes.list().some(p => p.title === "Plan"));
  fs.rmSync(home, { recursive: true, force: true });
});

test("changes in dot folders do not count as changes to the notes; markers do", () => {
  for (const name of [".modex/index.json", ".modex/history/x.json", ".ok/state.json", ".git/HEAD", "Personal/mine/.git/HEAD", "Personal/Notes/.Plan.md.tmp"]) assert.equal(watchedChange(name), false, name);
  for (const name of ["Personal/Notes/Plan.md", "Personal/mine", "Personal/.modex-workspace.json", "Personal/mine/.modex-project.json", null, ""]) assert.equal(watchedChange(name), true, String(name));
});

test("a watched notes folder shows a detached project at once, and links a linked project without walking", async () => {
  const home = tmpdir("modex-notes-watched-");
  const notes = new NotesStore(path.join(home, "notes"));
  const root = notes.root;
  notes.linkProject({ id: "project", name: "mine", path: "/code/mine" });
  const readdir = fs.readdirSync;
  let walks = 0;
  const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  // Quiet means three reads in a row that reuse the last look; file events can arrive late.
  const settle = async () => { let quiet = 0; for (let i = 0; i < 100 && quiet < 3; i++) { walks = 0; notes.tree(); notes.list(); quiet = walks === 0 ? quiet + 1 : 0; await wait(100); } assert.equal(quiet, 3, "reads settle"); };
  notes.watch();
  (fs as unknown as { readdirSync: unknown }).readdirSync = (dir: fs.PathLike, ...rest: unknown[]) => { if (String(dir) === root) walks++; return (readdir as (...args: unknown[]) => unknown)(dir, ...rest); };
  try {
    await settle();
    assert.equal(notes.linkProject({ id: "project", name: "mine", path: "/code/mine" }).rel, "Personal/mine");
    assert.equal(walks, 0, "linking a linked project reuses the last look");

    notes.detachProject("project");
    assert.equal(notes.projectFor("project"), undefined, "a detached project is gone from the very next read");
    assert.ok(!notes.workspaces().some(w => w.modexProjectIds.includes("project")));
  } finally {
    (fs as unknown as { readdirSync: unknown }).readdirSync = readdir;
    notes.unwatch();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
