import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { checkPatch, PATCH_FILE_MAX_BYTES } from "../src/main/engine/patch-state.js";
import type { ThreadItem } from "../src/shared/types.js";
import { tmpdir } from "./helpers.js";

type Tool = Extract<ThreadItem, { kind: "tool" }>;

/** A finished patch tool the CLI reported as applied. */
const tool = (name: string, args: Record<string, unknown>, extra: Partial<Tool> = {}): Tool =>
  ({ id: "t1", kind: "tool", name, title: name, args, status: "done", outcome: "succeeded", ok: true, at: "2026-10-18T00:00:00.000Z", ...extra });

/** A thread folder with a file outside it that no check may report on. */
function project() {
  const root = tmpdir("modex-patch-state-");
  const cwd = path.join(root, "repo");
  fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
  const outside = path.join(root, "outside.txt");
  fs.writeFileSync(outside, "outside the thread folder\n");
  const write = (rel: string, text: string) => fs.writeFileSync(path.join(cwd, rel), text);
  return { cwd, outside, write, abs: (rel: string) => path.join(cwd, rel) };
}

const states = async (cwd: string, item: Tool) => (await checkPatch(cwd, item)).files.map((f) => [f.path, f.state, ...(f.reason ? [f.reason] : [])]);

test("a Write is as the turn left it until the file changes or goes", async () => {
  const p = project();
  p.write("src/new.ts", "export const a = 1;\n");
  const write = tool("Write", { file_path: p.abs("src/new.ts"), content: "export const a = 1;\n" });
  assert.deepEqual(await states(p.cwd, write), [["src/new.ts", "as-left"]]);
  p.write("src/new.ts", "export const a = 2;\n");
  assert.deepEqual(await states(p.cwd, write), [["src/new.ts", "changed"]]);
  fs.rmSync(p.abs("src/new.ts"));
  assert.deepEqual(await states(p.cwd, write), [["src/new.ts", "deleted"]]);
});

test("an Edit still has the turn's edit while its new text is in the file, and changed once it is not", async () => {
  const p = project();
  p.write("greeting.txt", "hello, patch 👋\nsecond line\n");
  const edit = tool("Edit", { file_path: p.abs("greeting.txt"), old_string: "hello", new_string: "hello, patch 👋" });
  assert.deepEqual(await states(p.cwd, edit), [["greeting.txt", "has-edit"]]);
  p.write("greeting.txt", "hello, patch 👋\nsecond line edited later\n");
  assert.deepEqual(await states(p.cwd, edit), [["greeting.txt", "has-edit"]], "only the edited text is known, not the whole file");
  p.write("greeting.txt", "goodbye\n");
  assert.deepEqual(await states(p.cwd, edit), [["greeting.txt", "changed"]]);
});

test("an Edit that only removed text cannot be checked by its new text and says so", async () => {
  const p = project();
  p.write("a.txt", "kept\n");
  const file = (await checkPatch(p.cwd, tool("Edit", { file_path: p.abs("a.txt"), old_string: "gone\n", new_string: "" }))).files[0]!;
  assert.equal(file.state, "unknown");
  assert.match(file.reason!, /removed text/);
});

test("a MultiEdit has the turn's edit only while every new text is in the file", async () => {
  const p = project();
  p.write("m.ts", "const one = 1;\nconst two = 2;\n");
  const multi = tool("MultiEdit", { file_path: p.abs("m.ts"), edits: [{ old_string: "a", new_string: "const one = 1;" }, { old_string: "b", new_string: "const two = 2;" }] });
  assert.deepEqual(await states(p.cwd, multi), [["m.ts", "has-edit"]]);
  p.write("m.ts", "const one = 1;\nconst two = 3;\n");
  assert.deepEqual(await states(p.cwd, multi), [["m.ts", "changed"]]);
});

/** Codex's fileChange as Modex records it: the diffs joined in `patch`, and how many of its lines each file owns. */
function codexPatch(changes: { path: string; kind: "add" | "delete" | "update"; movePath?: string; diff: string }[]): Record<string, unknown> {
  return {
    patch: changes.map((c) => c.diff).join("\n"),
    files: changes.map((c) => ({ path: c.path, kind: c.kind, ...(c.movePath ? { movePath: c.movePath } : {}), lines: c.diff.split("\n").length })),
  };
}

test("a Codex patch is checked file by file: an add by its content, an update by each hunk's new lines, a delete by absence", async () => {
  const p = project();
  p.write("src/app.ts", "import a from 'a';\n\nconst port = 8080;\nconst host = 'localhost';\nstart(port);\n");
  p.write("NOTE.md", "# Note\nhi\n");
  const update = "@@ -2,3 +2,3 @@\n \n-const port = 3000;\n+const port = 8080;\n const host = 'localhost';\n";
  const item = tool("apply_patch", codexPatch([
    { path: p.abs("src/app.ts"), kind: "update", diff: update },
    { path: p.abs("NOTE.md"), kind: "add", diff: "# Note\nhi\n" },
    { path: p.abs("old.txt"), kind: "delete", diff: "was here\n" },
  ]));
  assert.deepEqual(await states(p.cwd, item), [["src/app.ts", "has-edit"], ["NOTE.md", "as-left"], ["old.txt", "as-left"]]);

  p.write("src/app.ts", "import a from 'a';\n\nconst port = 9090;\nconst host = 'localhost';\nstart(port);\n");
  p.write("NOTE.md", "# Note\nhi, edited\n");
  p.write("old.txt", "back again\n");
  assert.deepEqual(await states(p.cwd, item), [["src/app.ts", "changed"], ["NOTE.md", "changed"], ["old.txt", "changed"]]);

  fs.rmSync(p.abs("src/app.ts"));
  fs.rmSync(p.abs("NOTE.md"));
  assert.deepEqual((await states(p.cwd, item)).slice(0, 2), [["src/app.ts", "deleted"], ["NOTE.md", "deleted"]]);
});

test("a Codex update reads its hunks the way codex-cli 0.163.0 writes them, without file headers", async () => {
  const p = project();
  p.write("a.txt", "one\ntwo\nthree\nfour\nfive\nsix\nseven\n");
  // Two hunks; the second ends at a file with no final newline marker.
  const diff = "@@ -1,2 +1,2 @@\n-uno\n+one\n two\n@@ -6,2 +6,2 @@\n six\n-siete\n+seven\n\\ No newline at end of file\n";
  const item = tool("apply_patch", codexPatch([{ path: p.abs("a.txt"), kind: "update", diff }]));
  assert.deepEqual(await states(p.cwd, item), [["a.txt", "has-edit"]]);
  p.write("a.txt", "one\ntwo\nthree\nfour\nfive\nsix\n7\n");
  assert.deepEqual(await states(p.cwd, item), [["a.txt", "changed"]], "the second hunk's new line is gone");
});

test("a moved Codex file is checked at its new path, and the old path must stay gone", async () => {
  const p = project();
  p.write("src/new-name.ts", "export const moved = true;\n");
  const item = tool("apply_patch", codexPatch([{ path: p.abs("src/old-name.ts"), kind: "update", movePath: p.abs("src/new-name.ts"), diff: "@@ -1 +1 @@\n-export const moved = false;\n+export const moved = true;\n" }]));
  assert.deepEqual(await states(p.cwd, item), [["src/new-name.ts", "has-edit"]]);
  p.write("src/old-name.ts", "export const moved = false;\n");
  assert.deepEqual(await states(p.cwd, item), [["src/new-name.ts", "changed"]], "the old file is back");
});

test("a move from outside the thread's folder is judged by its new path alone", async () => {
  const p = project();
  p.write("src/in.ts", "export const moved = true;\n");
  const item = tool("apply_patch", codexPatch([{ path: p.outside, kind: "update", movePath: p.abs("src/in.ts"), diff: "@@ -1 +1 @@\n-x\n+export const moved = true;\n" }]));
  assert.deepEqual(await states(p.cwd, item), [["src/in.ts", "has-edit"]], "the outside file is not read, and does not count as the old file coming back");
});

test("a Codex patch recorded before per-file paths were kept cannot be compared and says so", async () => {
  const p = project();
  const file = (await checkPatch(p.cwd, tool("apply_patch", { patch: "@@ -1 +1 @@\n-a\n+b\n" }))).files[0]!;
  assert.equal(file.state, "unknown");
  assert.match(file.reason!, /no per-file record/);
});

test("nothing outside the thread's folder is read: absolute paths, .. and symlinks out stay unknown", async () => {
  const p = project();
  fs.symlinkSync(p.outside, p.abs("link.txt"));
  const check = async (file_path: string) => (await checkPatch(p.cwd, tool("Write", { file_path, content: "outside the thread folder\n" }))).files[0]!;
  for (const target of [p.outside, "../outside.txt", path.join(p.cwd, "..", "outside.txt")]) {
    const file = await check(target);
    assert.equal(file.state, "unknown", target);
    assert.match(file.reason!, /outside this thread's folder/, target);
  }
  const link = await check(p.abs("link.txt"));
  assert.equal(link.state, "unknown");
  assert.match(link.reason!, /leads outside this thread's folder/);
});

test("a directory or an oversized file is not compared", async () => {
  const p = project();
  const dir = await checkPatch(p.cwd, tool("Write", { file_path: p.abs("src"), content: "x" }));
  assert.equal(dir.files[0]!.state, "unknown");
  assert.match(dir.files[0]!.reason!, /not a file/);
  fs.writeFileSync(p.abs("big.txt"), Buffer.alloc(PATCH_FILE_MAX_BYTES + 1, 0x61));
  const big = await checkPatch(p.cwd, tool("Write", { file_path: p.abs("big.txt"), content: "a" }));
  assert.equal(big.files[0]!.state, "unknown");
  assert.match(big.files[0]!.reason!, /too large/);
});

test("a notebook edit is listed but not compared", async () => {
  const p = project();
  p.write("n.ipynb", "{}");
  assert.deepEqual((await checkPatch(p.cwd, tool("NotebookEdit", { notebook_path: p.abs("n.ipynb"), new_source: "x" }))).files.map((f) => [f.path, f.state]), [["n.ipynb", "unknown"]]);
});

test("only a patch the CLI reported as applied is compared", async () => {
  const p = project();
  p.write("a.txt", "x");
  const args = { file_path: p.abs("a.txt"), content: "x" };
  for (const extra of [{ outcome: "denied", ok: false }, { outcome: "failed", ok: false }, { outcome: "unknown", ok: undefined }, { outcome: "interrupted", ok: undefined }, { status: "running", outcome: "running", ok: undefined }] as Partial<Tool>[]) {
    await assert.rejects(checkPatch(p.cwd, tool("Write", args, extra)), /not reported as applied/, JSON.stringify(extra));
  }
  // An item from before outcomes were recorded: `ok` alone says it succeeded.
  const legacy = tool("Write", args, { outcome: undefined, ok: true });
  assert.equal((await checkPatch(p.cwd, legacy)).files[0]!.state, "as-left");
  await assert.rejects(checkPatch(p.cwd, tool("shell", { command: "ls" })), /not a patch/);
  await assert.rejects(checkPatch(p.cwd, undefined), /no longer in this thread/);
});

test("a check says when it was made", async () => {
  const p = project();
  p.write("a.txt", "x");
  const check = await checkPatch(p.cwd, tool("Write", { file_path: p.abs("a.txt"), content: "x" }), () => new Date("2026-10-18T12:00:00.000Z"));
  assert.equal(check.checkedAt, "2026-10-18T12:00:00.000Z");
});
