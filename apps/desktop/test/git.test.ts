import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as gitx from "../src/main/engine/git.js";
import { gitRepo, tmpdir } from "./helpers.js";

test("status/diff/revert over tracked, untracked and deleted files", async () => {
  const repo = gitRepo();
  fs.appendFileSync(path.join(repo, "README.md"), "more\n");
  fs.writeFileSync(path.join(repo, "new.txt"), "a\nb\n");
  fs.rmSync(path.join(repo, "package.json"));
  const snap = await gitx.status(repo);
  assert.equal(snap.isRepo, true);
  assert.equal(snap.branch, "main");
  assert.deepEqual(snap.files.map((f) => [f.path, f.code, f.additions, f.deletions]), [["README.md", " M", 1, 0], ["new.txt", "??", 2, 0], ["package.json", " D", 0, 3]]);
  assert.match(await gitx.diff(repo, "README.md"), /\+more/);
  assert.match(await gitx.diff(repo, "new.txt"), /\+a\n\+b/);
  await gitx.revert(repo, "new.txt");
  await gitx.revert(repo, "package.json");
  await gitx.revert(repo, "README.md");
  assert.deepEqual((await gitx.status(repo)).files, []);
  await assert.rejects(gitx.revert(repo, "../outside"), /outside the workspace/);
});

test("non-repo folders report isRepo=false", async () => {
  const snap = await gitx.status(tmpdir());
  assert.equal(snap.isRepo, false);
  assert.deepEqual(snap.files, []);
});

test("worktree add/remove", async () => {
  const repo = gitRepo();
  const dest = path.join(tmpdir(), "wt");
  const wt = await gitx.worktreeAdd(repo, dest, "modex/test");
  assert.equal(await gitx.currentBranch(dest), "modex/test");
  assert.equal(fs.existsSync(path.join(dest, "README.md")), true);
  await gitx.worktreeRemove(repo, wt.path);
  assert.equal(fs.existsSync(dest), false);
});

test("discarding a staged rename restores its source including destination edits", async () => {
  const repo = gitRepo();
  const before = fs.readFileSync(path.join(repo, "README.md"), "utf8");
  await gitx.git(repo, ["mv", "README.md", "renamed.md"]);
  fs.appendFileSync(path.join(repo, "renamed.md"), "new changes\n");
  await gitx.revert(repo, "renamed.md");
  assert.equal(fs.existsSync(path.join(repo, "README.md")), true);
  assert.equal(fs.readFileSync(path.join(repo, "README.md"), "utf8"), before);
  assert.equal(fs.existsSync(path.join(repo, "renamed.md")), false);
  assert.deepEqual((await gitx.status(repo)).files, []);
});

test("discarding a rename protects a newly recreated source", async () => {
  const repo = gitRepo();
  await gitx.git(repo, ["mv", "README.md", "renamed.md"]);
  fs.writeFileSync(path.join(repo, "README.md"), "new unrelated work\n");
  await assert.rejects(gitx.revert(repo, "renamed.md"), /original path.*exists/i);
  assert.equal(fs.readFileSync(path.join(repo, "README.md"), "utf8"), "new unrelated work\n");
  assert.equal(fs.existsSync(path.join(repo, "renamed.md")), true);
});

test("line counts handle Unicode, tabs, newlines and renamed files", async () => {
  const repo = gitRepo();
  const names = ["naïve.txt", "tab\tname.txt", "line\nname.txt"];
  for (const name of names) fs.writeFileSync(path.join(repo, name), "original\n");
  await gitx.git(repo, ["add", "."]);
  await gitx.git(repo, ["-c", "commit.gpgsign=false", "commit", "-m", "filenames"]);
  for (const name of names) fs.appendFileSync(path.join(repo, name), "added\n");
  await gitx.git(repo, ["mv", "README.md", "renamed.md"]);
  fs.appendFileSync(path.join(repo, "renamed.md"), "added\n");
  const snapshot = await gitx.status(repo);
  assert.deepEqual(snapshot.files.map((file) => [file.path, file.additions, file.deletions]), [...names, "renamed.md"].sort().map((name) => [name, 1, 0]));
});

test("discarding a rename preserves a recreated dangling symlink at its source", async () => {
  const repo = gitRepo();
  await gitx.git(repo, ["mv", "README.md", "renamed.md"]);
  fs.symlinkSync("missing-target", path.join(repo, "README.md"));
  await assert.rejects(gitx.revert(repo, "renamed.md"), /original path.*exists/i);
  assert.equal(fs.readlinkSync(path.join(repo, "README.md")), "missing-target");
});

test("a case-only rename can be discarded", async () => {
  const repo = gitRepo();
  const before = fs.readFileSync(path.join(repo, "README.md"), "utf8");
  await gitx.git(repo, ["mv", "README.md", "readme.md"]);
  await gitx.revert(repo, "readme.md");
  assert.equal(fs.readFileSync(path.join(repo, "README.md"), "utf8"), before);
  assert.deepEqual((await gitx.status(repo)).files, []);
});
