import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Store } from "../src/main/engine/store.js";
import { NotesStore } from "../src/main/engine/notes-store.js";
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
