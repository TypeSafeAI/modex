import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";
import type { NotesNode, NotesTree } from "../src/shared/notes.js";
import type { SpacePage } from "../src/shared/space.js";
import { indexTree } from "../src/renderer/space/tree-index.js";

// The tree renders every row on each change, and Space re-renders it on every keystroke in a page.
// Reading its nodes is the work that grew with the square of the tree (issue #241).
const appDir = fileURLToPath(new URL("../../", import.meta.url));

/** One workspace of projects, each with folders of notes: `projects` × `folders` × `notes`. */
function notesFolder(projects: number, folders: number, notes: number): { nodes: NotesNode[]; pages: SpacePage[] } {
  const nodes: NotesNode[] = [{ id: "w", kind: "workspace", parentId: null, name: "Personal", rel: "Personal", order: 0, isDefault: true }];
  const pages: SpacePage[] = [];
  for (let p = 0; p < projects; p++) {
    const project = { id: `p${p}`, rel: `Personal/Project ${p}` };
    nodes.push({ ...project, kind: "project", parentId: "w", name: `Project ${p}`, order: p, isDefault: p === 0, modexProjectId: null });
    for (let f = 0; f < folders; f++) {
      const folder = { id: `${project.id}f${f}`, rel: `${project.rel}/Folder ${f}` };
      nodes.push({ ...folder, kind: "folder", parentId: project.id, name: `Folder ${f}`, noteId: null });
      for (let n = 0; n < notes; n++) {
        const id = `${folder.id}n${n}`;
        nodes.push({ id, kind: "note", parentId: folder.id, name: `Note ${n}`, rel: `${folder.rel}/Note ${n}.md` });
        pages.push({ id, parentId: null, title: `Note ${n}`, markdown: "", favorite: false, createdAt: "", updatedAt: "", trashedAt: null, revision: 1 });
      }
    }
  }
  return { nodes, pages };
}

test("rendering the notes tree reads each node a few times, not once per row, while its menus are closed", async t => {
  const window = { modex: { platform: "web", invoke: async () => { throw new Error("not in this test"); }, onEvent: () => () => {}, onTerminalEvent: () => () => {} } };
  Object.assign(globalThis, { window });
  const server = await createServer({ configFile: false, root: appDir, plugins: [react()], logLevel: "error", appType: "custom", server: { middlewareMode: true, hmr: false, ws: false } });
  t.after(() => server.close());
  const { NotesTreeView } = await server.ssrLoadModule("/src/renderer/space/NotesTree.tsx") as { NotesTreeView: ComponentType<Record<string, unknown>> };
  const noop = () => {};
  const actions = new Proxy({}, { get: () => noop });

  // The reviewer's trees: about 1,050 nodes in 55 folders, then twice that.
  for (const projects of [5, 10]) {
    const { nodes, pages } = notesFolder(projects, 11, 18);
    const budget = 4 * nodes.length;
    let reads = 0;
    const counted = new Proxy(nodes, {
      get(target, key, receiver) {
        // Stop as soon as the budget is spent: the quadratic render takes 89,000 reads per node.
        if (typeof key === "string" && /^\d+$/.test(key) && ++reads > budget) throw new Error(`read more than ${budget} nodes`);
        return Reflect.get(target, key, receiver);
      },
    });
    const tree: NotesTree = { version: "1", nodes: counted, truncated: false };
    let html = "";
    try {
      html = renderToStaticMarkup(createElement(NotesTreeView, { tree, pages, selected: null, actions, newWorkspace: 0, onFocusApplied: noop }));
    } catch (err) { assert.fail(`${nodes.length} nodes: ${(err as Error).message} to render`); }
    assert.ok(reads <= budget, `${nodes.length} nodes: ${reads} reads`);
    const rows = [...html.matchAll(/data-node-id="([^"]+)"/g)].map(match => match[1]);
    assert.deepEqual(rows, nodes.map(node => node.id), "every row is shown, in tree order");
    assert.doesNotMatch(html, /Move to/, "menus are closed");
  }
});

test("the tree index finds children in order and offers every other place a node may move to", () => {
  const { nodes } = notesFolder(2, 2, 1);
  nodes.push({ id: "w2", kind: "workspace", parentId: null, name: "Clients", rel: "Clients", order: 1, isDefault: false });
  // A sibling whose name starts like a folder is not inside it.
  nodes.push({ id: "p0f0b", kind: "folder", parentId: "p0", name: "Folder 0b", rel: "Personal/Project 0/Folder 0b", noteId: null });
  nodes.push({ id: "p0f0s", kind: "folder", parentId: "p0f0", name: "Sub", rel: "Personal/Project 0/Folder 0/Sub", noteId: null });
  const index = indexTree({ version: "1", nodes, truncated: false });
  const ids = (list: NotesNode[]) => list.map(node => node.id);
  assert.deepEqual(ids(index.children(null)), ["w", "w2"]);
  assert.deepEqual(ids(index.children("p0")), ["p0f0", "p0f1", "p0f0b"]);
  assert.deepEqual(ids(index.children("p0f0n0")), []);
  assert.equal(index.get("p1f1")?.name, "Folder 1");
  assert.deepEqual(ids(index.targetsFor(index.get("p0f0n0")!)), ["p0", "p0f1", "p1", "p1f0", "p1f1", "p0f0b", "p0f0s"], "not the folder it is in");
  assert.deepEqual(ids(index.targetsFor(index.get("p0f0")!)), ["p0f1", "p1", "p1f0", "p1f1", "p0f0b"], "not its project, itself or its subfolder");
  assert.deepEqual(ids(index.targetsFor(index.get("p1")!)), ["w2"], "a project moves between workspaces");
  assert.deepEqual(ids(index.targetsFor(index.get("w")!)), [], "a workspace stays at the top");
});
