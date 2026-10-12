import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { Store } from "../src/main/engine/store.js";
import { ThreadRunner } from "../src/main/engine/runner.js";
import type { DraftRemovalScope } from "../src/shared/native-drafts.js";
import { gitRepo, tmpdir } from "./helpers.js";

function fixture(t: TestContext, guard: (scope: DraftRemovalScope, run: () => Promise<void>) => Promise<void>, beforeDeleteThread = async (_id: string) => {}) {
  const home = tmpdir("modex-owner-removal-"), repo = gitRepo(), store = new Store(home), project = store.addProject(repo);
  const runner = new ThreadRunner({ home, store, emit: () => {}, beforeDeleteThread, withOwnerRemoval: guard } as any);
  t.after(async () => { await runner.dispose(); fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(repo, { recursive: true, force: true }); });
  return { home, repo, store, project, runner };
}

for (const mode of ["thread", "project", "retire"] as const) test(`runner ${mode} removal refuses before stopping resources or changing owners`, async t => {
  const scopes: DraftRemovalScope[] = [], resources: string[] = [];
  const h = fixture(t, async scope => { scopes.push(scope); throw new Error("Unsent draft preserved"); }, async id => { resources.push(id); });
  const thread = await h.runner.createThread(h.project.id, { backend: "mock", worktree: mode === "retire" });
  const action = () => mode === "project" ? h.runner.removeProject(h.project.id) : mode === "thread" ? h.runner.deleteThread(thread.id)
    : h.runner.retireThread(thread.id, { number: 1, url: "https://example.test/pr/1", headSha: "unneeded-before-guard" });
  await assert.rejects(action, /Unsent draft preserved/);
  assert.deepEqual(scopes, [{ kind: mode === "project" ? "project" : "thread", id: mode === "project" ? h.project.id : thread.id }]);
  assert.deepEqual(resources, []); assert.ok(h.store.project(h.project.id)); assert.ok(h.store.thread(thread.id));
  assert.equal(h.store.thread(thread.id)!.retired, undefined);
  if (thread.worktree) assert.ok(fs.existsSync(thread.worktree.path));
});

test("project removal uses one guard for all children and retains it through awaited cleanup and Store deletion", async t => {
  let inside = false, guards = 0, resume!: () => void, entered!: () => void;
  const blocked = new Promise<void>(resolve => { resume = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  const h = fixture(t, async (_scope, run) => {
    guards++; assert.equal(inside, false); inside = true;
    try { await run(); } finally { inside = false; }
  }, async () => { entered(); await blocked; assert.equal(inside, true); });
  const first = await h.runner.createThread(h.project.id, { backend: "mock", worktree: false });
  const second = await h.runner.createThread(h.project.id, { backend: "mock", worktree: false });
  const remove = h.store.removeProject.bind(h.store), removeThread = h.store.deleteThread.bind(h.store);
  h.store.removeProject = id => { assert.equal(inside, true); return remove(id); };
  h.store.deleteThread = id => { assert.equal(inside, true); return removeThread(id); };
  const operation = h.runner.removeProject(h.project.id);
  void operation.catch(() => {});
  t.after(() => resume());
  try { await started; assert.ok(h.store.thread(first.id)); assert.ok(h.store.thread(second.id)); assert.equal(inside, true); }
  finally { resume(); }
  await operation;
  assert.equal(guards, 1); assert.equal(inside, false); assert.equal(h.store.project(h.project.id), undefined);
  assert.equal(h.store.snapshot().threads.length, 0);
  assert.ok(fs.existsSync(path.join(h.repo, "README.md")));
});
