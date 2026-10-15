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

for (const change of ["project rename", "workspace rename", "project move"] as const) test(`default page creation follows a ${change}`, () => withStore((store, root) => {
  const project = store.tree().nodes.find(n => n.kind === "project")!;
  const workspace = store.tree().nodes.find(n => n.kind === "workspace")!;
  if (change === "project rename") store.rename(project.id, "Journal");
  else if (change === "workspace rename") store.rename(workspace.id, "Home");
  else store.moveNodes([project.id], store.createWorkspace("Work").id);
  const rel = store.tree().nodes.find(n => n.id === project.id)!.rel;
  const reopened = new NotesStore(root);
  const page = reopened.create({ title: "Next" });
  assert.equal(reopened.tree().nodes.find(n => n.id === page.id)?.rel, `${rel}/Next.md`);
  assert.equal(reopened.tree().nodes.filter(n => n.kind === "project").length, 1);
}));

for (const interruption of [null, "link", "unlink"] as const) test(`moving a folder avoids child collisions and recovers ${interruption ?? "without interruption"}`, () => withStore((store, root) => {
  const parent = store.create({ title: "Parent", markdown: "parent body" });
  const child = store.create({ title: "Parent 2", markdown: "child body", parentId: parent.id });
  const folder = store.tree().nodes.find(n => n.kind === "folder" && n.noteId === parent.id)!;
  const destPage = store.create({ title: "Destination" });
  store.create({ title: "Existing", parentId: destPage.id });
  const dest = store.tree().nodes.find(n => n.kind === "folder" && n.noteId === destPage.id)!;
  store.createFolder(dest.id, "Parent");
  const originalLink = fs.linkSync;
  const originalUnlink = fs.unlinkSync;
  if (interruption === "link") fs.linkSync = () => { throw new Error("injected folder move interruption"); };
  if (interruption === "unlink") fs.unlinkSync = ((file) => {
    if (path.basename(String(file)) === "Parent.md") throw new Error("injected folder move interruption");
    return originalUnlink(file);
  }) as typeof fs.unlinkSync;
  try {
    if (interruption) assert.throws(() => store.moveNodes([folder.id], dest.id), /injected folder move/);
    else store.moveNodes([folder.id], dest.id);
  } finally { fs.linkSync = originalLink; fs.unlinkSync = originalUnlink; }
  for (const reader of [new NotesStore(root), store, new NotesStore(root)]) {
    const pages = reader.list();
    assert.equal(pages.find(p => p.id === parent.id)?.parentId, destPage.id);
    assert.equal(pages.find(p => p.id === parent.id)?.title, "Parent");
    assert.equal(pages.find(p => p.id === child.id)?.parentId, parent.id);
    assert.equal(pages.find(p => p.id === child.id)?.revision, 1);
    assert.equal(pages.find(p => p.id === child.id)?.markdown, "child body");
    assert.equal(reader.history(parent.id).at(-1)?.summary, "Moved folder");
    assert.equal(reader.tree().nodes.find(n => n.id === folder.id)?.rel, `${dest.rel}/Parent 3`);
  }
  assert.ok(fs.existsSync(path.join(root, dest.rel, "Parent 3", "Parent 3.md")));
}));

for (const basename of ["Parent.MD", "parent.md"]) test(`moving a folder uses its exact folder note basename ${basename}`, () => withStore((store, root) => {
  const parent = store.create({ title: "Parent" });
  const child = store.create({ title: "Child", parentId: parent.id });
  const folder = store.tree().nodes.find(n => n.kind === "folder" && n.noteId === parent.id)!;
  const project = store.tree().nodes.find(n => n.kind === "project")!;
  fs.renameSync(path.join(root, folder.rel, "Parent.md"), path.join(root, folder.rel, basename));
  const dest = store.createFolder(project.id, "Destination");
  store.createFolder(dest.id, "Parent");
  const read = fs.readFileSync;
  fs.readFileSync = ((file, ...args) => {
    const name = String(file);
    if (/\.md$/i.test(name) && fs.existsSync(path.dirname(name)) && !fs.readdirSync(path.dirname(name)).includes(path.basename(name))) {
      throw Object.assign(new Error("exact filename required"), { code: "ENOENT" });
    }
    return read(file, ...args);
  }) as typeof fs.readFileSync;
  try { store.moveNodes([folder.id], dest.id); } finally { fs.readFileSync = read; }
  const reopened = new NotesStore(root);
  assert.equal(reopened.list().find(p => p.id === child.id)?.parentId, parent.id);
  assert.equal(reopened.tree().nodes.find(n => n.id === folder.id)?.rel, `${dest.rel}/Parent 2`);
}));

for (const change of ["project rename", "workspace rename", "project move"] as const) test(`default project location recovers a crash after ${change}`, () => withStore((store, root) => {
  const project = store.tree().nodes.find(n => n.kind === "project")!;
  const workspace = store.tree().nodes.find(n => n.kind === "workspace")!;
  const other = store.createWorkspace("Work");
  const expected = change === "project rename" ? "Personal/Journal" : change === "workspace rename" ? "Home/Notes" : "Work/Notes";
  const internal = store as unknown as { writeIndex(index: unknown): void };
  const write = internal.writeIndex.bind(store);
  internal.writeIndex = index => {
    if (fs.existsSync(path.join(root, expected))) throw new Error("crash before index");
    write(index);
  };
  try {
    assert.throws(() => {
      if (change === "project rename") store.rename(project.id, "Journal");
      else if (change === "workspace rename") store.rename(workspace.id, "Home");
      else store.moveNodes([project.id], other.id);
    }, /crash before index/);
  } finally { internal.writeIndex = write; }
  const reopened = new NotesStore(root);
  const page = reopened.create({ title: "After" });
  assert.equal(reopened.tree().nodes.find(n => n.id === page.id)?.rel, `${expected}/After.md`);
  assert.ok(!fs.existsSync(path.join(root, "Personal/Notes")));
}));

test("folder move recovery retains external edits made after interruption", () => withStore((store, root) => {
  const parent = store.create({ title: "Parent", markdown: "Original" });
  store.create({ title: "Child", parentId: parent.id });
  const project = store.tree().nodes.find(n => n.kind === "project")!;
  const folder = store.tree().nodes.find(n => n.kind === "folder" && n.noteId === parent.id)!;
  const dest = store.createFolder(project.id, "Dest");
  store.createFolder(dest.id, "Parent");
  const unlink = fs.unlinkSync;
  fs.unlinkSync = ((file) => {
    if (path.basename(String(file)) === "Parent.md") throw new Error("interrupted");
    return unlink(file);
  }) as typeof fs.unlinkSync;
  try { assert.throws(() => store.moveNodes([folder.id], dest.id), /interrupted/); }
  finally { fs.unlinkSync = unlink; }
  const moved = path.join(root, dest.rel, "Parent 2/Parent 2.md");
  fs.writeFileSync(moved, fs.readFileSync(moved, "utf8").replace("Original", "Human edit after crash"));
  const reopened = new NotesStore(root);
  assert.equal(reopened.list().find(p => p.id === parent.id)?.markdown, "Human edit after crash");
  assert.ok(reopened.history(parent.id).some(v => v.actor === "external" && v.page.markdown === "Human edit after crash"));
}));
