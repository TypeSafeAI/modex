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

test("an untracked symlink to a directory diffs as a new link, the way git shows any other link", async () => {
  const repo = gitRepo();
  fs.mkdirSync(path.join(repo, "target"));
  fs.writeFileSync(path.join(repo, "target", "inside.txt"), "one\ntwo\nthree\n");
  fs.symlinkSync("target", path.join(repo, "to dir"));
  const shown = await gitx.diff(repo, "to dir");
  assert.equal(shown, "diff --git a/to dir b/to dir\nnew file mode 120000\n--- /dev/null\n+++ b/to dir\t\n@@ -0,0 +1 @@\n+target\n\\ No newline at end of file\n");
  assert.equal(await gitx.diff(repo, "to dir", undefined, true), shown, "the expanded view has no other lines to add");
  assert.doesNotMatch(shown, /inside\.txt|one/, "the link is shown, not what it points at");

  // With the target gone git can diff the same link itself, which keeps the two from drifting apart.
  fs.rmSync(path.join(repo, "target"), { recursive: true });
  assert.equal(shown, (await gitx.diff(repo, "to dir")).replace(/^index .*\n/m, ""));
});

test("the other untracked links keep git's own diff, and the list counts every link as one line", async () => {
  const repo = gitRepo();
  fs.writeFileSync(path.join(repo, "real.txt"), "one\ntwo\nthree\n");
  execFileSync("git", ["add", "real.txt"], { cwd: repo });
  fs.mkdirSync(path.join(repo, "target"));
  fs.writeFileSync(path.join(repo, "target", ".keep"), "");
  execFileSync("git", ["add", "target"], { cwd: repo });
  execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "user.name=test", "-c", "user.email=test@example.test", "commit", "-qm", "files"], { cwd: repo });
  fs.symlinkSync("real.txt", path.join(repo, "to-file"));
  fs.symlinkSync("target", path.join(repo, "to-dir"));
  fs.symlinkSync("nowhere", path.join(repo, "dangling"));
  fs.symlinkSync("loop", path.join(repo, "loop"));
  for (const [name, target] of [["to-file", "real.txt"], ["dangling", "nowhere"], ["loop", "loop"], ["to-dir", "target"]] as const) {
    const shown = await gitx.diff(repo, name);
    assert.match(shown, /^new file mode 120000$/m, name);
    assert.ok(shown.endsWith(`@@ -0,0 +1 @@\n+${target}\n\\ No newline at end of file\n`), `${name}: ${shown}`);
  }
  assert.deepEqual((await gitx.status(repo)).files.map((f) => [f.path, f.additions]), [["dangling", 1], ["loop", 1], ["to-dir", 1], ["to-file", 1]]);
});

test("an untracked symlink to a directory diffs from a project inside the repository", async () => {
  const repo = gitRepo();
  fs.mkdirSync(path.join(repo, "app", "target"), { recursive: true });
  fs.symlinkSync("target", path.join(repo, "app", "link"));
  const project = path.join(repo, "app");
  assert.deepEqual((await gitx.status(project)).files.map((f) => f.path), ["link"]);
  const shown = await gitx.diff(project, "link");
  assert.match(shown, /^\+\+\+ b\/app\/link$/m);
  assert.match(shown, /^\+target$/m);
});

test("an untracked nested repository has no diff to show and does not fail", async () => {
  const repo = gitRepo();
  const nested = path.join(repo, "vendor", "lib");
  fs.mkdirSync(nested, { recursive: true });
  await gitx.git(nested, ["init", "-q", "-b", "main"]);
  fs.writeFileSync(path.join(nested, "f.txt"), "x\n");
  await gitx.git(nested, ["add", "f.txt"]);
  await gitx.git(nested, ["-c", "commit.gpgsign=false", "-c", "user.name=test", "-c", "user.email=test@example.test", "commit", "-qm", "x"]);
  assert.deepEqual((await gitx.status(repo)).files.map((f) => [f.path, f.code]), [["vendor/lib/", "??"]]);
  assert.equal(await gitx.diff(repo, "vendor/lib/"), "");
  await gitx.revert(repo, "vendor/lib/");
  assert.equal(fs.readFileSync(path.join(nested, "f.txt"), "utf8"), "x\n", "discarding must never delete another repository");
});

test("discarding an untracked symlink to a directory removes the link and keeps what it points at", async () => {
  const repo = gitRepo();
  const outside = tmpdir("modex-link-target-");
  fs.writeFileSync(path.join(outside, "precious.txt"), "keep\n");
  fs.symlinkSync(outside, path.join(repo, "link"));
  await gitx.revert(repo, "link");
  assert.equal(fs.lstatSync(path.join(repo, "link"), { throwIfNoEntry: false }), undefined);
  assert.equal(fs.readFileSync(path.join(outside, "precious.txt"), "utf8"), "keep\n");
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

test("Changes in a project subdirectory stay scoped to that workspace", async () => {
  const repo = gitRepo();
  const app = path.join(repo, "packages", "app");
  const sibling = path.join(repo, "packages", "sibling");
  fs.mkdirSync(app, { recursive: true });
  fs.mkdirSync(sibling, { recursive: true });
  fs.writeFileSync(path.join(app, "tracked.txt"), "app before\n");
  fs.writeFileSync(path.join(sibling, "tracked.txt"), "sibling before\n");
  await gitx.git(repo, ["add", "."]);
  await gitx.git(repo, ["-c", "commit.gpgsign=false", "commit", "-m", "subdirectories"]);
  fs.appendFileSync(path.join(app, "tracked.txt"), "app after\n");
  fs.writeFileSync(path.join(app, "new.txt"), "one\ntwo\n");
  fs.appendFileSync(path.join(sibling, "tracked.txt"), "sibling after\n");
  fs.writeFileSync(path.join(sibling, "new.txt"), "leave alone\n");

  const snapshot = await gitx.status(app);
  assert.deepEqual(snapshot.files.map((file) => [file.path, file.code, file.additions, file.deletions]), [
    ["new.txt", "??", 2, 0],
    ["tracked.txt", " M", 1, 0],
  ]);
  assert.match(await gitx.diff(app, "tracked.txt"), /\+app after/);
  assert.match(await gitx.diff(app, "new.txt"), /\+one\n\+two/);
  await assert.rejects(gitx.diff(app, "../sibling/tracked.txt"), /outside repository workspace/);
  await assert.rejects(gitx.revert(app, "../sibling/tracked.txt"), /outside the workspace/);
  await gitx.revert(app, "tracked.txt");
  await gitx.revert(app, "new.txt");
  assert.deepEqual((await gitx.status(app)).files, []);
  assert.equal(fs.readFileSync(path.join(sibling, "tracked.txt"), "utf8"), "sibling before\nsibling after\n");
  assert.equal(fs.readFileSync(path.join(sibling, "new.txt"), "utf8"), "leave alone\n");
});

test("discarding a rename within a project subdirectory restores its workspace-relative source", async () => {
  const repo = gitRepo();
  const app = path.join(repo, "packages", "app");
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(app, "before.txt"), "original\n");
  await gitx.git(repo, ["add", "."]);
  await gitx.git(repo, ["-c", "commit.gpgsign=false", "commit", "-m", "subdirectory"]);
  await gitx.git(repo, ["mv", "packages/app/before.txt", "packages/app/after.txt"]);
  fs.appendFileSync(path.join(app, "after.txt"), "edited\n");

  const snapshot = await gitx.status(app);
  assert.deepEqual(snapshot.files.map((file) => [file.path, file.original]), [["after.txt", "before.txt"]]);
  await gitx.revert(app, "after.txt");
  assert.equal(fs.readFileSync(path.join(app, "before.txt"), "utf8"), "original\n");
  assert.equal(fs.existsSync(path.join(app, "after.txt")), false);
  assert.deepEqual((await gitx.status(app)).files, []);
});

test("discarding a cross-workspace rename never changes the sibling workspace", async () => {
  const repo = gitRepo();
  const app = path.join(repo, "packages", "app");
  const sibling = path.join(repo, "packages", "sibling");
  fs.mkdirSync(app, { recursive: true });
  fs.mkdirSync(sibling, { recursive: true });
  fs.writeFileSync(path.join(app, "out.txt"), "from app\n");
  fs.writeFileSync(path.join(sibling, "in.txt"), "from sibling\n");
  await gitx.git(repo, ["add", "."]);
  await gitx.git(repo, ["-c", "commit.gpgsign=false", "commit", "-m", "cross workspace"]);
  await gitx.git(repo, ["mv", "packages/sibling/in.txt", "packages/app/in.txt"]);
  await gitx.git(repo, ["mv", "packages/app/out.txt", "packages/sibling/out.txt"]);

  assert.deepEqual((await gitx.status(app)).files.map((file) => [file.path, file.code]), [
    ["in.txt", "A "], ["out.txt", "D "],
  ]);
  const incomingDiff = await gitx.diff(app, "in.txt");
  assert.match(incomingDiff, /\+from sibling/);
  assert.doesNotMatch(incomingDiff, /packages\/sibling/);
  const outgoingDiff = await gitx.diff(app, "out.txt");
  assert.match(outgoingDiff, /-from app/);
  assert.doesNotMatch(outgoingDiff, /packages\/sibling/);
  await gitx.revert(app, "in.txt");
  await gitx.revert(app, "out.txt");
  assert.equal(fs.existsSync(path.join(app, "in.txt")), false);
  assert.equal(fs.readFileSync(path.join(app, "out.txt"), "utf8"), "from app\n");
  assert.equal(fs.existsSync(path.join(sibling, "in.txt")), false);
  assert.equal(fs.readFileSync(path.join(sibling, "out.txt"), "utf8"), "from app\n");
  assert.deepEqual((await gitx.status(app)).files, []);
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
