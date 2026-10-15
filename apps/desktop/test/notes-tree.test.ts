import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { NotesStore } from "../src/main/engine/notes-store.js";
import type { NotesFolder, NotesNode, NotesProject, NotesWorkspace } from "../src/shared/notes.js";
import { tmpdir } from "./helpers.js";

function withStore(run: (store: NotesStore, root: string) => void): void {
  const home = tmpdir("modex-notes-tree-");
  const root = path.join(home, "notes");
  try { run(new NotesStore(root), root); } finally { fs.rmSync(home, { recursive: true, force: true }); }
}
const named = (nodes: NotesNode[], name: string) => nodes.find(n => n.name === name)!;
const shape = (nodes: NotesNode[]) => nodes.map(n => `${n.kind}:${n.rel}`).sort();

test("the tree lists workspaces, projects, folders, notes and files, with the default workspace first", () => withStore((store, root) => {
  const note = store.create({ title: "Hello" });
  fs.writeFileSync(path.join(root, "Personal", "Notes", "sketch.png"), "png");
  const tree = store.tree();
  assert.deepEqual(shape(tree.nodes), ["file:Personal/Notes/sketch.png", "note:Personal/Notes/Hello.md", "project:Personal/Notes", "workspace:Personal"]);
  const workspace = named(tree.nodes, "Personal") as NotesWorkspace;
  const project = named(tree.nodes, "Notes") as NotesProject;
  assert.equal(workspace.isDefault, true);
  assert.equal(project.parentId, workspace.id);
  assert.equal(named(tree.nodes, "Hello").id, note.id, "a note node is its page");
  assert.equal(named(tree.nodes, "Hello").parentId, project.id);
  assert.equal((named(tree.nodes, "sketch.png") as { preview: string }).preview, "image");
  assert.equal(store.tree().version, tree.version, "nothing changed, same version");
  store.save({ ...store.list()[0]!, markdown: "changed" });
  assert.notEqual(store.tree().version, tree.version);
}));

test("workspaces, projects and folders are created, and pages can be made in a project or folder", () => withStore((store, root) => {
  const work = store.createWorkspace("TypeSafeAI");
  const modex = store.createProject(work.id, "modex", "proj-1");
  const folder = store.createFolder(modex.id, "Design: v2");
  assert.ok(fs.existsSync(path.join(root, "TypeSafeAI", "modex", "Design- v2")));
  assert.equal(modex.modexProjectId, "proj-1");
  const page = store.create({ title: "Spec", containerId: folder.id });
  assert.ok(fs.existsSync(path.join(root, "TypeSafeAI", "modex", "Design- v2", "Spec.md")));
  assert.equal(page.parentId, null, "a folder without a folder note gives no parent page");
  const tree = store.tree();
  assert.equal(named(tree.nodes, "Spec").parentId, folder.id);
  assert.equal(named(tree.nodes, "Design: v2").id, folder.id, "a folder keeps the name as typed, though its folder cannot carry the colon");
  assert.equal((named(tree.nodes, "TypeSafeAI") as NotesWorkspace).order, 1, "a new workspace goes after the default one");
  assert.throws(() => store.createFolder(work.id, "Loose"), /project or folder/);
  assert.throws(() => store.createProject(modex.id, "Nested"), /workspace/);
  assert.throws(() => store.create({ title: "x", containerId: work.id }), /project or folder/);
  assert.throws(() => store.createWorkspace("  "), /name/);
  // Ids survive a restart.
  const again = new NotesStore(root).tree();
  assert.deepEqual(shape(again.nodes), shape(tree.nodes));
  assert.equal(named(again.nodes, "Spec").parentId, folder.id);
}));

test("rename keeps ids; a folder with a folder note is renamed through its page", () => withStore((store, root) => {
  const work = store.createWorkspace("Clients");
  const project = store.createProject(work.id, "Acme");
  const plan = store.create({ title: "Plan", containerId: project.id });
  store.create({ title: "Step", parentId: plan.id });
  const planFolder = store.tree().nodes.find(n => n.kind === "folder" && (n as NotesFolder).noteId === plan.id)!;
  store.rename(planFolder.id, "Roadmap");
  assert.ok(fs.existsSync(path.join(root, "Clients", "Acme", "Roadmap", "Roadmap.md")));
  assert.ok(fs.existsSync(path.join(root, "Clients", "Acme", "Roadmap", "Step.md")));
  assert.equal(store.list().find(p => p.id === plan.id)?.title, "Roadmap");
  assert.equal(store.history(plan.id).at(-1)!.summary, "Renamed folder");
  store.rename(work.id, "Customers");
  assert.ok(fs.existsSync(path.join(root, "Customers", "Acme")));
  assert.equal(store.tree().nodes.find(n => n.id === work.id)?.name, "Customers");
  assert.equal(store.tree().nodes.find(n => n.id === project.id)?.rel, "Customers/Acme", "the project moved with its workspace");
  fs.writeFileSync(path.join(root, "Customers", "Acme", "brief.pdf"), "pdf");
  const brief = named(store.tree().nodes, "brief.pdf");
  store.rename(brief.id, "Final brief");
  assert.ok(fs.existsSync(path.join(root, "Customers", "Acme", "Final brief.pdf")), "a file keeps its extension");
  assert.equal(named(store.tree().nodes, "Final brief.pdf").id, brief.id);
  assert.throws(() => store.rename(plan.id, "x"), /title/);
}));

test("moving notes, folders and files records page versions and keeps the tree consistent", () => withStore((store, root) => {
  const project = store.tree().nodes.find(n => n.kind === "project")!;
  const box = store.createFolder(project.id, "Box");
  const loose = store.create({ title: "Loose" });
  const parent = store.create({ title: "Parent" });
  const child = store.create({ title: "Child", parentId: parent.id });
  store.moveNodes([loose.id], box.id);
  assert.ok(fs.existsSync(path.join(root, "Personal", "Notes", "Box", "Loose.md")));
  assert.deepEqual(store.history(loose.id).map(v => v.summary).at(-1), "Moved page");
  assert.equal(store.list().find(p => p.id === loose.id)?.revision, 2, "no extra 'outside Modex' version on the next read");
  const parentFolder = store.tree().nodes.find(n => n.kind === "folder" && (n as NotesFolder).noteId === parent.id)!;
  store.moveNodes([parentFolder.id], box.id);
  assert.ok(fs.existsSync(path.join(root, "Personal", "Notes", "Box", "Parent", "Child.md")));
  assert.equal(store.list().find(p => p.id === child.id)?.parentId, parent.id, "children stay under their folder note");
  assert.equal(store.list().find(p => p.id === child.id)?.revision, 1, "a child that moved with its folder is unchanged");
  fs.writeFileSync(path.join(root, "Personal", "Notes", "data.csv"), "a,b");
  store.moveNodes([named(store.tree().nodes, "data.csv").id], box.id);
  assert.ok(fs.existsSync(path.join(root, "Personal", "Notes", "Box", "data.csv")));
  assert.throws(() => store.moveNodes([box.id], parentFolder.id), /inside itself/);
  const work = store.tree().nodes.find(n => n.kind === "workspace")!;
  assert.throws(() => store.moveNodes([loose.id], work.id), /cannot go into/);
  const other = store.createWorkspace("Other");
  store.moveNodes([project.id], other.id);
  assert.ok(fs.existsSync(path.join(root, "Other", "Notes", "Box", "Loose.md")));
  assert.equal(new NotesStore(root).list().find(p => p.id === loose.id)?.revision, 2);
}));

test("folders and files moved or renamed in Finder keep their ids; only empty containers can be deleted", () => withStore((store, root) => {
  const project = store.tree().nodes.find(n => n.kind === "project")!;
  const folder = store.createFolder(project.id, "Drafts");
  fs.writeFileSync(path.join(root, "Personal", "Notes", "Drafts", "a.txt"), "a");
  const file = named(store.tree().nodes, "a.txt");
  fs.renameSync(path.join(root, "Personal", "Notes", "Drafts"), path.join(root, "Personal", "Notes", "Drafts 2026"));
  const tree = store.tree();
  assert.equal(tree.nodes.find(n => n.id === folder.id)?.rel, "Personal/Notes/Drafts 2026");
  assert.equal(tree.nodes.find(n => n.id === file.id)?.rel, "Personal/Notes/Drafts 2026/a.txt");
  assert.throws(() => store.deleteEmpty(folder.id), /inside/);
  fs.rmSync(path.join(root, "Personal", "Notes", "Drafts 2026", "a.txt"));
  store.deleteEmpty(folder.id);
  assert.ok(!fs.existsSync(path.join(root, "Personal", "Notes", "Drafts 2026")));
  const work = store.tree().nodes.find(n => n.kind === "workspace")!;
  assert.throws(() => store.deleteEmpty(work.id), /default/);
}));
