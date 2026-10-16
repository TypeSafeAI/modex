import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { NotesStore } from "../src/main/engine/notes-store.js";
import type { NotesFolder, NotesNode, NotesProject, NotesWorkspace } from "../src/shared/notes.js";
import { pageImageFromUrl, pageImageUrl } from "../src/shared/notes.js";
import { tmpdir } from "./helpers.js";

async function withStore(run: (store: NotesStore, root: string) => void | Promise<void>): Promise<void> {
  const home = tmpdir("modex-notes-tree-");
  const root = path.join(home, "notes");
  try { await run(new NotesStore(root), root); } finally { fs.rmSync(home, { recursive: true, force: true }); }
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

test("importing files copies them into a folder without replacing anything, and Markdown becomes a page", () => withStore(async (store, root) => {
  const outside = tmpdir("modex-import-src-");
  try {
    const project = store.tree().nodes.find(n => n.kind === "project")!;
    const folder = store.createFolder(project.id, "Assets");
    fs.writeFileSync(path.join(outside, "logo.png"), "png-bytes");
    fs.writeFileSync(path.join(outside, "Brief.md"), "# Brief\nimported");
    fs.writeFileSync(path.join(root, "Personal", "Notes", "Assets", "logo.png"), "already here");
    fs.mkdirSync(path.join(outside, "a-folder"));
    fs.symlinkSync(path.join(outside, "logo.png"), path.join(outside, "link.png"));
    const result = await store.importFiles(folder.id, [path.join(outside, "logo.png"), path.join(outside, "Brief.md"), path.join(outside, "a-folder"), path.join(outside, "link.png"), "relative.txt"]);
    assert.deepEqual(result.imported.map(n => n.name).sort(), ["Brief", "logo 2.png"]);
    assert.equal(result.errors.length, 3, "a folder, a link and a relative path are refused");
    assert.equal(fs.readFileSync(path.join(root, "Personal", "Notes", "Assets", "logo.png"), "utf8"), "already here", "nothing is replaced");
    assert.equal(fs.readFileSync(path.join(root, "Personal", "Notes", "Assets", "logo 2.png"), "utf8"), "png-bytes");
    const brief = store.list().find(p => p.title === "Brief")!;
    assert.equal(brief.markdown, "# Brief\nimported");
    await assert.rejects(store.importFiles(store.tree().nodes.find(n => n.kind === "workspace")!.id, []), /project or folder/);
    await assert.rejects(store.importFiles(folder.id, Array.from({ length: 51 }, (_, i) => path.join(outside, `${i}.txt`))), /50 files/);

    fs.writeFileSync(path.join(outside, "mark.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
    fs.writeFileSync(path.join(outside, "big.png"), Buffer.alloc(25 * 1024 * 1024 + 1));
    fs.writeFileSync(path.join(outside, "notes.v1:final"), "odd");
    const more = await store.importFiles(folder.id, ["mark.svg", "big.png", "notes.v1:final"].map(name => path.join(outside, name)));
    assert.deepEqual(more.errors, []);
    const byName = new Map(more.imported.map(n => [n.name, n]));
    assert.equal(store.readImage(byName.get("mark.svg")!.id)?.mime, "image/svg+xml");
    const big = byName.get("big.png")!;
    assert.equal(big.kind === "file" ? big.preview : "not a file", null, "an image too large to preview is just a file");
    assert.equal(store.readImage(byName.get("big.png")!.id), null);
    assert.ok([...byName.keys()].some(name => !name.includes(":") && name.startsWith("notes")), "an extension a name cannot carry is made safe");
    assert.equal(store.readImage(store.list().find(p => p.title === "Brief")!.id), null, "a page is never served as an image");
  } finally { fs.rmSync(outside, { recursive: true, force: true }); }
}));

test("importing waits for each copy without blocking, and a file still copying never shows in the folder", async () => {
  const home = tmpdir("modex-notes-import-");
  const outside = tmpdir("modex-import-src-");
  const root = path.join(home, "notes");
  const promises = fs.promises as { copyFile: typeof fs.promises.copyFile };
  const copyFile = promises.copyFile;
  try {
    const store = new NotesStore(root);
    const project = store.tree().nodes.find(n => n.kind === "project")!;
    const folder = store.createFolder(project.id, "Assets");
    for (const from of ["a", "b"]) {
      fs.mkdirSync(path.join(outside, from));
      fs.writeFileSync(path.join(outside, from, "Report.md"), `# Report\nfrom ${from}`);
    }
    fs.writeFileSync(path.join(outside, "broken.png"), "png");
    // Each copy writes its bytes, then holds until released, like a slow volume still copying.
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let copied = () => {};
    const nextCopy = () => new Promise<void>(resolve => { copied = resolve; });
    promises.copyFile = async (from, to, mode) => {
      if (String(from).endsWith("broken.png")) {
        fs.writeFileSync(to, "half");
        throw Object.assign(new Error("EIO: i/o error, copyfile"), { code: "EIO" });
      }
      await copyFile(from, to, mode);
      copied();
      await held;
    };
    const first = nextCopy();
    const one = store.importFiles(folder.id, [path.join(outside, "a", "Report.md")]);
    assert.equal(await Promise.race([first.then(() => "copying"), one.then(() => "imported")]), "copying", "the import waits for its copy instead of blocking until it is done");
    assert.ok(!store.tree().nodes.some(n => n.name.startsWith("Report")), "a file still copying is not in the folder");
    assert.ok(!store.list().some(p => p.title.startsWith("Report")), "nor recorded as a page");
    // While it copies, the folder can be renamed and a file of the same name imported into it.
    store.rename(folder.id, "Library");
    const second = nextCopy();
    const two = store.importFiles(folder.id, [path.join(outside, "b", "Report.md"), path.join(outside, "broken.png")]);
    await second;
    release();
    const results = await Promise.all([one, two]);
    assert.deepEqual(results.flatMap(result => result.imported.map(n => n.name)).sort(), ["Report", "Report 2"]);
    const library = path.join(root, "Personal", "Notes", "Library");
    assert.deepEqual(fs.readdirSync(library).sort(), ["Report 2.md", "Report.md"], "both follow the renamed folder, and nothing is replaced");
    assert.deepEqual(["Report.md", "Report 2.md"].map(name => fs.readFileSync(path.join(library, name), "utf8")).sort(), ["# Report\nfrom a", "# Report\nfrom b"]);
    assert.deepEqual(results.map(result => result.errors), [[], ["broken.png i/o error, copyfile"]], "a failed copy is reported for its own file");
    assert.deepEqual(fs.readdirSync(root, { recursive: true }).filter(name => String(name).endsWith(".tmp")), [], "no partial copy is left behind");
  } finally {
    promises.copyFile = copyFile;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("a watched folder is walked again only after something changes, or every 10 seconds", async () => {
  const home = tmpdir("modex-notes-watch-");
  const root = path.join(home, "notes");
  let clock = Date.parse("2026-10-15T09:00:00Z");
  const store = new NotesStore(root, { now: () => clock });
  const readdir = fs.readdirSync;
  let walks = 0;
  const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (check: () => boolean, what: string) => {
    // The clock runs faster than the wait, so the 10-second re-look catches what an event the
    // operating system delivers late (or not at all, under load) would have.
    for (let i = 0; i < 100 && !check(); i++) { await wait(50); clock += 200; }
    assert.ok(check(), what);
  };
  try {
    store.create({ title: "First", markdown: "one" });
    store.watch();
    (fs as unknown as { readdirSync: unknown }).readdirSync = (dir: fs.PathLike, ...rest: unknown[]) => { if (String(dir) === root) walks++; return (readdir as (...args: unknown[]) => unknown)(dir, ...rest); };
    // Modex's own first writes arrive as events too; once they have, reads stop walking.
    await until(() => { walks = 0; store.tree(); store.list(); return walks === 0; }, "reads settle on the last look");
    store.tree(); store.list(); store.history(store.list()[0]!.id);
    assert.equal(walks, 0, "nothing changed, so nothing is walked");

    store.create({ title: "Second", markdown: "two" });
    assert.ok(store.list().some(p => p.title === "Second"), "a change made in Modex shows at once");

    fs.writeFileSync(path.join(root, "Personal", "Notes", "Outside.md"), "# Outside\nfrom an editor");
    await until(() => store.list().some(p => p.title === "Outside"), "an edit outside Modex is seen once its event arrives");

    fs.rmSync(path.join(root, "Personal", "Notes", "First.md"));
    await until(() => store.list().find(p => p.title === "First")?.trashedAt != null, "a file deleted outside goes to Trash after its second look");

    await until(() => { walks = 0; store.list(); return walks === 0; }, "reads settle again");
    clock += 10_001;
    store.list();
    assert.ok(walks > 0, "a read looks again after 10 seconds even without an event");
  } finally {
    (fs as unknown as { readdirSync: unknown }).readdirSync = readdir;
    store.unwatch();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a page's images beside it are served by relative path, only from inside its project", () => withStore((store, root) => {
  const outside = tmpdir("modex-page-image-");
  try {
    const project = store.tree().nodes.find(n => n.kind === "project")!;
    const folder = store.createFolder(project.id, "Design");
    const page = store.create({ title: "Spec", markdown: "![diagram](assets/diagram.png)", containerId: folder.id });
    const dir = path.join(root, "Personal", "Notes", "Design");
    fs.mkdirSync(path.join(dir, "assets"));
    fs.writeFileSync(path.join(dir, "assets", "diagram.png"), "png");
    fs.writeFileSync(path.join(root, "Personal", "Notes", "shared.png"), "shared");
    fs.writeFileSync(path.join(dir, "notes.txt"), "text");
    fs.mkdirSync(path.join(dir, ".hidden"));
    fs.writeFileSync(path.join(dir, ".hidden", "x.png"), "hidden");
    fs.writeFileSync(path.join(outside, "secret.png"), "secret");
    fs.symlinkSync(path.join(outside, "secret.png"), path.join(dir, "link.png"));
    fs.symlinkSync(outside, path.join(dir, "out"));
    const other = store.createProject(store.tree().nodes.find(n => n.kind === "workspace")!.id, "Other");
    fs.writeFileSync(path.join(root, "Personal", "Other", "theirs.png"), "theirs");

    assert.equal(store.readPageImage(page.id, "assets/diagram.png")?.data.toString(), "png");
    assert.equal(store.readPageImage(page.id, "../shared.png")?.data.toString(), "shared", "up a folder, still in the project");
    for (const relative of ["../../Other/theirs.png", "../../../outside.png", "notes.txt", ".hidden/x.png", "link.png", "out/secret.png", "missing.png", "/etc/hosts"]) {
      assert.equal(store.readPageImage(page.id, relative), null, relative);
    }
    assert.equal(store.readPageImage("no-such-page", "assets/diagram.png"), null);
    assert.ok(other);

    const url = pageImageUrl(page.id, "../assets dir/a%20b.png")!;
    assert.deepEqual(pageImageFromUrl(url), { pageId: page.id, relative: "../assets dir/a b.png" }, "a `..` and encoded names survive the URL");
    for (const external of ["https://example.com/a.png", "file:///etc/hosts", "/abs.png", "#frag", "", "data:image/png;base64,AA"]) assert.equal(pageImageUrl(page.id, external), null, external);
    assert.equal(pageImageFromUrl("modex-notes://file/abc"), null);
  } finally { fs.rmSync(outside, { recursive: true, force: true }); }
}));

test("cached file previews revalidate current size and symlinks before reading", () => withStore((store, root) => {
  const outside = tmpdir("modex-cached-read-");
  try {
    store.tree();
    const dir = path.join(root, "Personal", "Notes");
    fs.writeFileSync(path.join(dir, "text.txt"), "small");
    fs.mkdirSync(path.join(dir, "assets"));
    fs.writeFileSync(path.join(dir, "assets", "image.png"), "image");
    store.watch();
    const nodes = store.tree().nodes;
    const text = nodes.find(n => n.name === "text.txt")!;
    const image = nodes.find(n => n.name === "image.png")!;
    // Keep the cached layout: no event-loop turn occurs between the change and read.
    fs.writeFileSync(path.join(dir, "text.txt"), Buffer.alloc(1_048_577, 97));
    assert.throws(() => store.readFile(text.id));
    fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
    fs.unlinkSync(path.join(dir, "text.txt"));
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(dir, "text.txt"));
    assert.throws(() => store.readFile(text.id));
    fs.writeFileSync(path.join(outside, "image.png"), "outside");
    fs.renameSync(path.join(dir, "assets"), path.join(dir, "old-assets"));
    fs.symlinkSync(outside, path.join(dir, "assets"));
    assert.equal(store.readImage(image.id), null);
  } finally { store.unwatch(); fs.rmSync(outside, { recursive: true, force: true }); }
}));

test("page images reject hidden directories reached through a visible alias", () => withStore((store, root) => {
  const page = store.create({ title: "Aliases", markdown: "hello" });
  const dir = path.join(root, "Personal", "Notes");
  fs.mkdirSync(path.join(dir, ".hidden"));
  fs.writeFileSync(path.join(dir, ".hidden", "secret.png"), "hidden");
  fs.symlinkSync(path.join(dir, ".hidden"), path.join(dir, "visible"));
  assert.equal(store.readPageImage(page.id, "visible/secret.png"), null);
}));

test("cached previews cannot follow aliases into another project", () => withStore((store, root) => {
  const workspace = store.tree().nodes.find(n => n.kind === "workspace")!;
  const other = store.createProject(workspace.id, "Other");
  const page = store.create({ title: "Scoped", markdown: "hello" });
  const dir = path.join(root, "Personal", "Notes");
  const otherDir = path.join(root, other.rel);
  fs.mkdirSync(path.join(dir, "assets"));
  fs.writeFileSync(path.join(dir, "assets", "text.txt"), "own text");
  fs.writeFileSync(path.join(dir, "assets", "image.png"), "own image");
  fs.mkdirSync(path.join(otherDir, "assets"));
  fs.writeFileSync(path.join(otherDir, "assets", "text.txt"), "other text");
  fs.writeFileSync(path.join(otherDir, "assets", "image.png"), "other image");
  store.watch();
  try {
    const nodes = store.tree().nodes;
    const text = nodes.find(n => n.rel === "Personal/Notes/assets/text.txt")!;
    const image = nodes.find(n => n.rel === "Personal/Notes/assets/image.png")!;
    fs.renameSync(path.join(dir, "assets"), path.join(dir, "old-assets"));
    fs.symlinkSync(path.join(otherDir, "assets"), path.join(dir, "assets"));
    assert.throws(() => store.readFile(text.id));
    assert.equal(store.readImage(image.id), null);
    assert.equal(store.readPageImage(page.id, "assets/image.png"), null);
    fs.unlinkSync(path.join(dir, "assets"));
    fs.renameSync(path.join(dir, "old-assets"), path.join(dir, "assets"));
    // Replacing the project itself must not redefine its allowed root.
    fs.renameSync(dir, `${dir}-original`);
    fs.symlinkSync(otherDir, dir);
    assert.throws(() => store.readFile(text.id));
    assert.equal(store.readImage(image.id), null);
    assert.equal(store.readPageImage(page.id, "assets/image.png"), null);
    fs.unlinkSync(dir);
    fs.renameSync(`${dir}-original`, dir);
    const mirror = path.join(root, "Mirror");
    fs.mkdirSync(mirror);
    fs.cpSync(otherDir, path.join(mirror, "Notes"), { recursive: true });
    fs.renameSync(path.join(root, "Personal"), path.join(root, "Original"));
    fs.symlinkSync(mirror, path.join(root, "Personal"));
    assert.throws(() => store.readFile(text.id));
    assert.equal(store.readImage(image.id), null);
    assert.equal(store.readPageImage(page.id, "assets/image.png"), null);
  } finally { store.unwatch(); }
}));


test("a preview replaced by a FIFO at open cannot block the main process", { skip: process.platform === "win32" }, () => {
  const home = tmpdir("modex-preview-fifo-");
  try {
    // A child bounds the regression: blocking open on a FIFO otherwise hangs the test runner.
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import fs from "node:fs";
      import path from "node:path";
      import { execFileSync } from "node:child_process";
      import { NotesStore } from ${JSON.stringify(new URL("../src/main/engine/notes-store.js", import.meta.url).href)};
      const store = new NotesStore(path.join(process.argv[1], "notes"));
      store.tree();
      const file = path.join(store.root, "Personal", "Notes", "image.png");
      fs.writeFileSync(file, "image");
      store.watch();
      const image = store.tree().nodes.find(node => node.name === "image.png");
      const open = fs.openSync;
      fs.openSync = (target, ...args) => {
        if (target === fs.realpathSync(file)) {
          fs.openSync = open;
          fs.unlinkSync(file);
          execFileSync("mkfifo", [file]);
        }
        return open(target, ...args);
      };
      try { console.log(JSON.stringify(store.readImage(image.id))); }
      finally { store.unwatch(); }
    `, home], { encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL" });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "null");
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

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

for (const change of ["project rename", "workspace rename", "project move", "folder rename", "folder move"] as const) test(`notes trashed before a ${change} are restored where it went, without making the old place again`, () => withStore((store, root) => {
  const project = store.tree().nodes.find(n => n.kind === "project")!;
  const workspace = store.tree().nodes.find(n => n.kind === "workspace")!;
  const folder = store.createFolder(project.id, "Drafts");
  const loose = store.create({ title: "Loose" });
  const drafted = store.create({ title: "Drafted", containerId: folder.id });
  store.create({ title: "Kept", containerId: folder.id });
  store.trash(loose.id, true);
  store.trash(drafted.id, true);
  if (change === "project rename") store.rename(project.id, "Journal");
  else if (change === "workspace rename") store.rename(workspace.id, "Home");
  else if (change === "project move") store.moveNodes([project.id], store.createWorkspace("Work").id);
  else if (change === "folder rename") store.rename(folder.id, "Final");
  else store.moveNodes([folder.id], store.createProject(workspace.id, "Later").id);
  const containers = (nodes: NotesNode[]) => nodes.filter(n => n.kind !== "note").map(n => n.rel).sort();
  const before = containers(store.tree().nodes);
  store.trash(loose.id, false);
  store.trash(drafted.id, false);
  for (const reader of [store, new NotesStore(root)]) {
    const nodes = reader.tree().nodes;
    const rel = (id: string) => nodes.find(n => n.id === id)?.rel;
    assert.equal(rel(loose.id), `${rel(project.id)}/Loose.md`);
    assert.equal(rel(drafted.id), `${rel(folder.id)}/Drafted.md`);
    assert.deepEqual(containers(nodes), before, "no workspace, project or folder is made at the old place");
  }
  assert.ok(!fs.existsSync(path.join(root, "Personal", "Notes", "Drafts")));
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

for (const change of ["move", "rename"] as const) test(`a ${change} of a folder with a backslash in its name leaves notes readable`, () => withStore((store, root) => {
  const project = store.tree().nodes.find(n => n.kind === "project")!;
  // Finder allows a backslash in a name; Modex never makes one.
  const rel = `${project.rel}/R\\D`;
  fs.mkdirSync(path.join(root, rel));
  fs.writeFileSync(path.join(root, rel, "R\\D.md"), "plans");
  fs.writeFileSync(path.join(root, rel, "Child.md"), "child body");
  const folder = store.tree().nodes.find(n => n.kind === "folder" && n.rel === rel) as NotesFolder;
  const child = store.list().find(p => p.markdown === "child body")!;
  assert.ok(folder.noteId);
  const dest = store.createFolder(project.id, "Dest");
  if (change === "move") assert.throws(() => store.moveNodes([folder.id], dest.id), /backslash.*Finder/);
  else store.rename(folder.id, "Research");
  for (const reader of [store, new NotesStore(root), new NotesStore(root)]) {
    const node = reader.tree().nodes.find(n => n.id === folder.id);
    assert.equal(node?.rel, rel, "the folder stays where it was, under its own name");
    assert.equal(node?.name, change === "move" ? "R\\D" : "Research");
    assert.equal(reader.list().find(p => p.id === child.id)?.parentId, folder.noteId);
  }
  assert.ok(!fs.existsSync(path.join(root, ".modex", "settlement.json")));
}));


test("layout keeps shared-inode file aliases distinct when one moves before or after the other", () => withStore((store, root) => {
  const project = store.tree().nodes.find(n => n.kind === "project")!;
  const dir = path.join(root, project.rel);
  fs.writeFileSync(path.join(dir, "a.txt"), "shared bytes");
  fs.linkSync(path.join(dir, "a.txt"), path.join(dir, "b.txt"));
  const initial = store.tree().nodes;
  const a = named(initial, "a.txt"), b = named(initial, "b.txt");
  assert.notEqual(a.id, b.id, "hard-linked paths are separate tree nodes");
  assert.equal(fs.statSync(path.join(dir, "a.txt")).ino, fs.statSync(path.join(dir, "b.txt")).ino);

  // The moved alias sorts before the still-existing path. Its inode must not steal that path's id.
  fs.renameSync(path.join(dir, "b.txt"), path.join(dir, "0.txt"));
  const movedFirst = new NotesStore(root).tree().nodes;
  assert.equal(named(movedFirst, "0.txt").id, b.id);
  assert.equal(named(movedFirst, "a.txt").id, a.id);
  // Now the moved alias sorts after the other alias, which has already claimed its own id.
  fs.renameSync(path.join(dir, "a.txt"), path.join(dir, "z.txt"));
  for (const reader of [new NotesStore(root), store, new NotesStore(root)]) {
    const nodes = reader.tree().nodes;
    assert.equal(named(nodes, "0.txt").id, b.id);
    assert.equal(named(nodes, "z.txt").id, a.id);
    assert.equal(new Set(nodes.map(node => node.id)).size, nodes.length);
  }
}));

test("layout prioritizes a replaced indexed path without reusing its id for the relocated old inode", () => withStore((store, root) => {
  const project = store.tree().nodes.find(n => n.kind === "project")!;
  const dir = path.join(root, project.rel);
  const original = path.join(dir, "a.txt"), relocated = path.join(dir, "z.txt");
  fs.writeFileSync(original, "old file");
  const id = named(store.tree().nodes, "a.txt").id;
  const oldInode = fs.statSync(original).ino;
  fs.renameSync(original, relocated);
  fs.writeFileSync(original, "replacement");
  assert.equal(fs.statSync(relocated).ino, oldInode);
  assert.notEqual(fs.statSync(original).ino, oldInode);

  const nodes = store.tree().nodes;
  assert.equal(named(nodes, "a.txt").id, id, "an existing indexed path takes precedence over inode matching");
  const movedId = named(nodes, "z.txt").id;
  assert.notEqual(movedId, id, "the stale inode bucket must not claim the same id twice");
  for (const reader of [new NotesStore(root), store]) {
    const again = reader.tree().nodes;
    assert.equal(named(again, "a.txt").id, id);
    assert.equal(named(again, "z.txt").id, movedId);
    assert.equal(new Set(again.map(node => node.id)).size, again.length);
    assert.equal(reader.readFile(id), "replacement");
    assert.equal(reader.readFile(movedId), "old file");
  }
}));

test("layout preserves folder and file ids across repeated external renames and restarts", () => withStore((store, root) => {
  const project = store.tree().nodes.find(n => n.kind === "project")!;
  const folder = store.createFolder(project.id, "Drafts");
  let folderRel = folder.rel, filename = "a.txt";
  fs.writeFileSync(path.join(root, folderRel, filename), "retained bytes");
  const fileId = named(store.tree().nodes, filename).id;
  for (const [nextFolder, nextFile] of [["Final", "z.txt"], ["Drafts", "a.txt"], ["Archived", "final.txt"]] as const) {
    const nextRel = `${project.rel}/${nextFolder}`;
    fs.renameSync(path.join(root, folderRel), path.join(root, nextRel));
    fs.renameSync(path.join(root, nextRel, filename), path.join(root, nextRel, nextFile));
    folderRel = nextRel; filename = nextFile;
    const reopened = new NotesStore(root);
    const nodes = reopened.tree().nodes;
    assert.equal(nodes.find(node => node.id === folder.id)?.rel, folderRel);
    const file = nodes.find(node => node.id === fileId);
    assert.equal(file?.rel, `${folderRel}/${filename}`);
    assert.equal(file?.parentId, folder.id);
    assert.equal(reopened.readFile(fileId), "retained bytes");
    assert.equal(new Set(nodes.map(node => node.id)).size, nodes.length);
  }
}));
