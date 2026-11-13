import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Store } from "../src/main/engine/store.js";
import { TaskContextService } from "../src/main/engine/task-context-service.js";
import { TaskContextCapture } from "../src/main/engine/task-context-capture.js";
import type { ContextDraftOwner } from "../src/shared/task-context-evidence.js";
import { tmpdir, gitRepo } from "./helpers.js";

function fixture(listFiles?: (cwd: string) => Promise<{ paths: string[]; truncated: boolean }>) {
  const store = new Store(tmpdir("modex-context-candidates-")), project = store.addProject(gitRepo()), other = store.addProject(gitRepo());
  const service = new TaskContextService({ store, capture: new TaskContextCapture(), ...(listFiles ? { listFiles } : {}) });
  const owner: ContextDraftOwner = { kind: "project", projectId: project.id, key: `draft:0:${project.id}` };
  const binding = service.openContextDraft(owner);
  return { store, project, other, service, owner, binding };
}

test("candidate listing returns own-project metadata without selecting context or creating Notes", async t => {
  const h = fixture();
  const own = h.store.space.create({ containerId: h.store.space.projectFor(h.project.id)!.id, title: "Own note", markdown: "private-own-body" });
  const foreign = h.store.space.create({ containerId: h.store.space.projectFor(h.other.id)!.id, title: "Foreign title", markdown: "foreign-body" });
  const file = path.join(h.store.home, "reference.txt"); fs.writeFileSync(file, "private-file-body");
  const imported = await h.store.space.importFiles(h.store.space.projectFor(h.project.id)!.id, [file]);
  assert.equal(imported.errors.length, 0); const ownFile = imported.imported[0]!; assert.equal(ownFile.kind, "file");
  t.mock.method(h.store.space, "readFile", () => { throw new Error("Candidate listing must not read a Notes file body"); });
  const before = h.store.space.list();
  const result = await h.service.candidates(h.binding);
  assert.ok(result.files.paths.includes("README.md")); assert.equal(result.files.truncated, false);
  assert.ok(result.notes.items.some(row => row.target.kind === "note" && row.target.pageId === own.id && row.title === own.title));
  assert.ok(result.notes.items.some(row => row.target.kind === "notes-file" && row.target.id === ownFile.id && row.title === "reference.txt"));
  for (const secret of [foreign.id, foreign.title, "private-own-body", "foreign-body", "private-file-body", h.project.path, h.other.path]) assert.equal(JSON.stringify(result).includes(secret), false);
  assert.deepEqual(h.service.readDraft(h.binding).refs, []); assert.deepEqual(h.store.space.list(), before);
  await assert.rejects(h.service.candidates({ ...h.binding, owner: { kind: "project", projectId: h.other.id, key: `draft:0:${h.other.id}` } }), /draft|stale/);
});

test("candidate file output is bounded and unsafe or omitted paths are explicit", async () => {
  const exact = Array.from({ length: 523 }, (_, i) => `${String(i).padStart(4, "0")}${"x".repeat(3996)}`);
  exact.push("y".repeat(2 * 1024 * 1024 + 1 - Buffer.byteLength(JSON.stringify(exact)) - 3));
  assert.equal(Buffer.byteLength(JSON.stringify(exact)), 2 * 1024 * 1024 + 1);
  for (const paths of [Array.from({ length: 5001 }, (_, i) => `file-${i}.ts`), Array.from({ length: 1000 }, (_, i) => `${i}-${"x".repeat(3000)}`), ["../outside", "/private/path", "README.md"], exact]) {
    const h = fixture(async () => ({ paths, truncated: false }));
    const result = await h.service.candidates(h.binding);
    assert.equal(result.files.truncated, true); assert.ok(result.files.paths.length <= 5000);
    assert.ok(Buffer.byteLength(JSON.stringify(result.files.paths)) <= 2 * 1024 * 1024);
    assert.equal(result.files.paths.some(p => p.startsWith("/") || p.startsWith("../")), false);
  }
});

for (const mutation of ["replace", "remove", "revision"] as const) {
  test(`candidate listing rechecks its binding after asynchronous files resolve (${mutation})`, async () => {
    let enter!: () => void, resume!: () => void;
    const entered = new Promise<void>(r => { enter = r; }), held = new Promise<void>(r => { resume = r; });
    const h = fixture(async () => { enter(); await held; return { paths: ["README.md"], truncated: false }; });
    const pending = h.service.candidates(h.binding); await entered;
    if (mutation === "replace") h.service.openContextDraft(h.owner);
    if (mutation === "remove") h.store.removeProject(h.project.id);
    if (mutation === "revision") await h.service.selectTaskContext(h.binding, []);
    resume(); await assert.rejects(pending, /draft|stale/);
  });
}

test("candidate Notes are scoped at response time and incomplete file listings stay explicit", async () => {
  let enter!: () => void, resume!: () => void;
  const entered = new Promise<void>(r => { enter = r; }), held = new Promise<void>(r => { resume = r; });
  const h = fixture(async () => { enter(); await held; return { paths: ["README.md"], truncated: true }; });
  const note = h.store.space.create({ containerId: h.store.space.projectFor(h.project.id)!.id, title: "Moved", markdown: "body" });
  const pending = h.service.candidates(h.binding); await entered;
  h.store.space.moveNodes([note.id], h.store.space.projectFor(h.other.id)!.id); resume();
  const result = await pending; assert.equal(result.files.truncated, true);
  assert.equal(result.notes.items.some(row => row.target.kind === "note" && row.target.pageId === note.id), false);
  assert.deepEqual(h.service.readDraft(h.binding).refs, []);
});
