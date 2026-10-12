import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { retireDecision, TaskRetirer } from "../src/main/engine/retire.js";
import { Store } from "../src/main/engine/store.js";
import { ThreadRunner } from "../src/main/engine/runner.js";
import { MockBackend } from "../src/main/engine/backends/mock.js";
import * as gitx from "../src/main/engine/git.js";
import { Router } from "../src/main/engine/routing/router.js";
import type { PullRequestSummary, Thread, ThreadContext } from "../src/shared/types.js";
import { gitRepo, tmpdir } from "./helpers.js";

const SHA = "a".repeat(40);
const merged: PullRequestSummary = { state: "merged", number: 12, title: "t", url: "https://github.com/o/r/pull/12", headSha: SHA };
const task = (over: Partial<Thread> = {}): Thread => ({ id: "t1", projectId: "p", title: "x", createdAt: "", updatedAt: "", cwd: "/wt", worktree: { path: "/wt", branch: "modex-t1" }, backend: "mock", mode: "agent", plan: false, model: "", status: "idle", ...over });
const decide = (over: Partial<Parameters<typeof retireDecision>[0]> = {}) => retireDecision({ thread: task(), busy: false, pullRequest: merged, clean: true, head: SHA, ...over });

test("restart holds wait for existing retirement work and prevent new sweeps without removing tasks", async () => {
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  let reads = 0, retired = 0;
  const service = new TaskRetirer({ enabled: () => false, threads: () => [task()], busy: () => false,
    context: async () => { reads++; await pending; return { isRepo: true, branch: "main", pullRequest: merged }; },
    inspect: async () => ({ clean: true, head: SHA }), retire: async () => { retired++; },
  });
  const sweep = service.sweep();
  assert.throws(() => service.holdForRestart(), /finish/i);
  finish();
  await sweep;
  const release = service.holdForRestart();
  await service.sweep();
  assert.equal(reads, 1);
  assert.equal(retired, 0);
  release();
  const next = service.holdForRestart();
  release();
  await service.sweep();
  assert.equal(reads, 1);
  next();
  await service.sweep();
  assert.equal(reads, 2);
});

test("retire: only an idle task whose merged PR is exactly what the worktree holds", () => {
  assert.deepEqual(decide(), { retire: true, pr: { number: 12, url: merged.state === "merged" ? merged.url : "", headSha: SHA } });
  const why = (over: Parameters<typeof decide>[0]) => { const d = decide(over); return d.retire ? "retire" : d.reason; };
  assert.equal(why({ thread: task({ worktree: undefined }) }), "not-a-task");
  assert.equal(why({ thread: task({ retired: { at: "", reason: "merged", pr: 1, url: "" } }) }), "retired");
  assert.equal(why({ busy: true }), "busy");
  assert.equal(why({ thread: task({ status: "waiting" }) }), "busy");
  assert.equal(why({ pullRequest: undefined }), "no-pr");
  assert.equal(why({ pullRequest: { state: "none", detail: "" } }), "no-pr");
  assert.equal(why({ pullRequest: { ...merged, state: "open" } }), "pr-open");
  assert.equal(why({ pullRequest: { ...merged, state: "closed" } }), "pr-closed", "closed without merging is not finished work");
  assert.equal(why({ pullRequest: { ...merged, headSha: undefined } }), "unverified");
  assert.equal(why({ head: null }), "unverified");
  assert.equal(why({ clean: false }), "uncommitted");
  assert.equal(why({ head: "b".repeat(40) }), "unpushed", "commits made after the PR's last push are not in main");
});

function sweeper(over: { pr?: PullRequestSummary; clean?: boolean; head?: string; enabled?: boolean; busy?: boolean } = {}) {
  const retired: string[] = [];
  const threads = [task(), task({ id: "plain", worktree: undefined, cwd: "/repo" })];
  const retirer = new TaskRetirer({
    enabled: () => over.enabled ?? true,
    threads: () => threads,
    busy: () => over.busy ?? false,
    context: async (): Promise<ThreadContext> => ({ isRepo: true, branch: "b", pullRequest: over.pr ?? merged }),
    inspect: async () => ({ clean: over.clean ?? true, head: over.head ?? SHA }),
    retire: async (id) => { retired.push(id); },
  });
  return { retirer, retired };
}

test("sweep retires a finished task, remembers each PR, and leaves plain checkouts alone", async () => {
  const s = sweeper();
  assert.deepEqual(await s.retirer.sweep(), ["t1"]);
  assert.equal(s.retirer.pullRequest("t1")?.state, "merged");
  assert.equal(s.retirer.pullRequest("plain"), undefined);
});

test("sweep keeps watching but retires nothing when auto-retire is off, the work is dirty, or it is busy", async () => {
  for (const over of [{ enabled: false }, { clean: false }, { busy: true }, { head: "c".repeat(40) }, { pr: { ...merged, state: "open" as const } }]) {
    const s = sweeper(over);
    assert.deepEqual(await s.retirer.sweep(), [], JSON.stringify(over));
    assert.ok(s.retirer.pullRequest("t1"), "the PR is still tracked for the UI and the phone");
  }
});

test("retireThread removes the worktree and branch, keeps the transcript, and refuses further turns", async () => {
  const home = tmpdir("modex-home-");
  const store = new Store(home);
  store.updateSettings({ default_backend: "mock" });
  const router = new Router({ home, policy: () => store.settings.routing, listModels: async () => ({ models: [] }), transport: null });
  const runner = new ThreadRunner({ home, store, router, emit: () => {}, backends: { mock: new MockBackend(() => undefined, home, 0) } });
  const repo = gitRepo();
  const project = store.addProject(repo);
  const thread = await runner.createThread(project.id, { worktree: true });
  const wt = thread.worktree!;
  assert.ok(fs.existsSync(wt.path));
  assert.equal(execFileSync("git", ["branch", "--list", wt.branch], { cwd: repo, encoding: "utf8" }).trim() !== "", true);
  const state = await gitx.worktreeState(wt.path);
  assert.deepEqual([state.clean, state.head?.length], [true, 40]);
  fs.writeFileSync(path.join(wt.path, "scratch.txt"), "x");
  assert.equal((await gitx.worktreeState(wt.path)).clean, false, "an untracked file counts as work that would be lost");
  fs.rmSync(path.join(wt.path, "scratch.txt"));

  await runner.retireThread(thread.id, { number: 12, url: "https://github.com/o/r/pull/12", headSha: state.head! });
  assert.equal(fs.existsSync(wt.path), false);
  assert.equal(execFileSync("git", ["branch", "--list", wt.branch], { cwd: repo, encoding: "utf8" }).trim(), "");
  const after = store.thread(thread.id)!;
  assert.deepEqual([after.retired?.pr, after.retired?.reason], [12, "merged"]);
  assert.match(runner.items(thread.id).at(-1)!.kind === "notice" ? (runner.items(thread.id).at(-1) as { text: string }).text : "", /Pull request #12 merged/);
  await assert.rejects(runner.send(thread.id, "again"), /pull request #12 merged/);
  await runner.retireThread(thread.id, { number: 12, url: "", headSha: state.head! }); // idempotent
  await gitx.worktreeAdd(repo, wt.path, "replacement");
  await runner.deleteThread(thread.id, true);
  assert.equal(fs.existsSync(wt.path), true, "deleting a finished transcript must not remove a replacement checkout");
  await runner.dispose();
});

test("retirement preserves work written while terminals are closing", async () => {
  const home = tmpdir("modex-home-");
  const store = new Store(home);
  const repo = gitRepo();
  const project = store.addProject(repo);
  const runner = new ThreadRunner({ home, store, emit: () => {},
    beforeDeleteThread: async (id) => { fs.writeFileSync(path.join(store.thread(id)!.cwd, "late.txt"), "keep me"); },
  });
  const thread = await runner.createThread(project.id, { worktree: true });
  const head = (await gitx.worktreeState(thread.cwd)).head!;
  await runner.retireThread(thread.id, { number: 12, url: "", ...{ headSha: head } });
  assert.equal(fs.existsSync(path.join(thread.cwd, "late.txt")), true);
  assert.equal(store.thread(thread.id)!.retired, undefined);
  await runner.dispose();
});

for (const missing of [false, true]) {
  test(`project cleanup owns branch retention${missing ? " and cannot fall back when its script disappears" : ""}`, async () => {
    const home = tmpdir("modex-home-");
    const store = new Store(home);
    const runner = new ThreadRunner({ home, store, emit: () => {} });
    const repo = gitRepo();
    fs.mkdirSync(path.join(repo, "scripts"));
    const script = path.join(repo, "scripts/worktree.sh");
    fs.writeFileSync(script, `#!/usr/bin/env bash
set -e
root="$(git rev-parse --show-toplevel)"
case "$1" in
  new) git worktree add -q -b "$2" "$root/.worktrees/$2" HEAD; echo "$root/.worktrees/$2";;
  remove) git worktree remove "$root/.worktrees/$2";;
esac
`);
    const project = store.addProject(repo);
    const thread = await runner.createThread(project.id, { worktree: true });
    const head = (await gitx.worktreeState(thread.cwd)).head!;
    if (missing) {
      fs.unlinkSync(script);
      await assert.rejects(runner.retireThread(thread.id, { number: 12, url: "", headSha: head }), /script.*missing/i);
      await assert.rejects(runner.deleteThread(thread.id, true), /script.*missing/i);
      assert.ok(fs.existsSync(thread.cwd));
      assert.equal(store.thread(thread.id)!.retired, undefined);
    } else {
      await runner.retireThread(thread.id, { number: 12, url: "", headSha: head });
      assert.equal(fs.existsSync(thread.cwd), false);
      assert.equal(store.thread(thread.id)!.retired?.pr, 12);
    }
    assert.equal(execFileSync("git", ["rev-parse", `refs/heads/${thread.worktree!.branch}`], { cwd: repo, encoding: "utf8" }).trim(), head, "the runner must not override the script's retained branch");
    await runner.dispose();
  });
}
