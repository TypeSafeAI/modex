import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as gitx from "../src/main/engine/git.js";
import { execFileSync } from "node:child_process";
import { gitRepo, tmpdir } from "./helpers.js";

test("diff treats wildcard filenames literally", async () => {
  const repo = gitRepo();
  for (const name of ["file*.txt", "file-one.txt"]) fs.writeFileSync(path.join(repo, name), "before\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "user.name=test", "-c", "user.email=test@example.test", "commit", "-qm", "files"], { cwd: repo });
  fs.appendFileSync(path.join(repo, "file*.txt"), "wanted change\n");
  fs.appendFileSync(path.join(repo, "file-one.txt"), "unrelated change\n");
  const diff = await gitx.diff(repo, "file*.txt");
  assert.match(diff, /wanted change/);
  assert.doesNotMatch(diff, /unrelated change/);
});

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

test("discarding files before the first commit clears intent-to-add and staged edits", async () => {
  const repo = tmpdir("modex-unborn-repo-");
  await gitx.git(repo, ["init", "-q", "-b", "main"]);
  fs.writeFileSync(path.join(repo, "intent.txt"), "draft\n");
  fs.writeFileSync(path.join(repo, "staged.txt"), "staged\n");
  fs.writeFileSync(path.join(repo, "keep.txt"), "keep\n");
  await gitx.git(repo, ["add", "-N", "intent.txt"]);
  await gitx.git(repo, ["add", "staged.txt"]);
  fs.appendFileSync(path.join(repo, "staged.txt"), "unstaged edit\n");

  assert.deepEqual((await gitx.status(repo)).files.map((f) => [f.path, f.code]), [
    ["intent.txt", " A"], ["keep.txt", "??"], ["staged.txt", "AM"],
  ]);
  await gitx.revert(repo, "intent.txt");
  await gitx.revert(repo, "staged.txt");

  assert.equal(fs.existsSync(path.join(repo, "intent.txt")), false);
  assert.equal(fs.existsSync(path.join(repo, "staged.txt")), false);
  assert.equal(fs.readFileSync(path.join(repo, "keep.txt"), "utf8"), "keep\n");
  assert.deepEqual((await gitx.status(repo)).files.map((f) => f.path), ["keep.txt"]);
});

test("discarding newly added files also works after the first commit", async () => {
  const repo = gitRepo();
  fs.writeFileSync(path.join(repo, "intent.txt"), "draft\n");
  fs.writeFileSync(path.join(repo, "staged.txt"), "staged\n");
  await gitx.git(repo, ["add", "-N", "intent.txt"]);
  await gitx.git(repo, ["add", "staged.txt"]);
  fs.appendFileSync(path.join(repo, "staged.txt"), "unstaged edit\n");

  await gitx.revert(repo, "intent.txt");
  await gitx.revert(repo, "staged.txt");

  assert.equal(fs.existsSync(path.join(repo, "intent.txt")), false);
  assert.equal(fs.existsSync(path.join(repo, "staged.txt")), false);
  assert.deepEqual((await gitx.status(repo)).files, []);
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

test("diff for a renamed file renders rename and modified lines, not full addition", async () => {
  const repo = gitRepo();
  await gitx.git(repo, ["mv", "README.md", "renamed.md"]);
  fs.appendFileSync(path.join(repo, "renamed.md"), "new changes\n");
  const diff = await gitx.diff(repo, "renamed.md");
  assert.match(diff, /rename from README\.md/);
  assert.match(diff, /rename to renamed\.md/);
  assert.match(diff, /\+new changes/);
  assert.doesNotMatch(diff, /--- \/dev\/null/);
});

test("diff for a heavily rewritten renamed file renders exactly one diff header", async () => {
  const repo = gitRepo();
  await gitx.git(repo, ["mv", "README.md", "renamed.md"]);
  fs.writeFileSync(path.join(repo, "renamed.md"), "completely different content\nrewritten entirely\n");
  const diff = await gitx.diff(repo, "renamed.md");
  const headers = diff.match(/^diff --git /gm) || [];
  assert.equal(headers.length, 1);
  assert.match(diff, /\+completely different content/);
  assert.doesNotMatch(diff, /deleted file mode/);
});

test("diff for a rewritten rename handles a destination beginning with a dash", async () => {
  const repo = gitRepo();
  await gitx.git(repo, ["mv", "--", "README.md", "-renamed.md"]);
  fs.writeFileSync(path.join(repo, "-renamed.md"), "completely different content\nrewritten entirely\n");
  const diff = await gitx.diff(repo, "-renamed.md");
  assert.equal((diff.match(/^diff --git /gm) || []).length, 1);
  assert.match(diff, /^-# demo/m);
  assert.match(diff, /^\+completely different content/m);
  assert.doesNotMatch(diff, /--- \/dev\/null/);
});

test("diff surfaces Git errors instead of showing an empty textual diff", async () => {
  const repo = gitRepo();
  await assert.rejects(gitx.diff(repo, "../outside"), /outside repository/);
});

test("diff for a pure rename shows similarity and rename metadata", async () => {
  const repo = gitRepo();
  await gitx.git(repo, ["mv", "README.md", "renamed.md"]);
  const diff = await gitx.diff(repo, "renamed.md");
  assert.match(diff, /similarity index 100%/);
  assert.match(diff, /rename from README\.md/);
  assert.match(diff, /rename to renamed\.md/);
});

test("diff from a project subdirectory resolves relative paths", async () => {
  const repo = gitRepo();
  const sub = path.join(repo, "packages", "app");
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, "test.txt"), "hello\n");
  await gitx.git(repo, ["add", "."]);
  await gitx.git(repo, ["-c", "commit.gpgsign=false", "commit", "-m", "sub"]);
  fs.appendFileSync(path.join(sub, "test.txt"), "world\n");
  const diff = await gitx.diff(sub, "packages/app/test.txt");
  assert.match(diff, /\+world/);
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
