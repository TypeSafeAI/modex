import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { MAX_STEM_BYTES, nameKey, noteStem, uniqueName } from "../src/shared/notes-names.js";
import { formatNote, parseNote, splitFrontmatter } from "../src/main/engine/notes-frontmatter.js";
import { moveNoClobber, writeFileDurably } from "../src/main/engine/durable-file.js";
import { tmpdir } from "./helpers.js";

test("note names are safe on every platform and never hidden, reserved or empty", () => {
  assert.equal(noteStem("A/B: plan?"), "A-B- plan-");
  assert.equal(noteStem("  .hidden  "), "hidden");
  assert.equal(noteStem("trailing dots..."), "trailing dots");
  assert.equal(noteStem(""), "Untitled");
  assert.equal(noteStem("..."), "Untitled");
  assert.equal(noteStem("CON"), "CON note");
  assert.equal(noteStem("index"), "index note", "Open Knowledge reserves index.md");
  assert.equal(noteStem("__x__"), "__x__ note");
  assert.equal(noteStem("tab\there\nnew"), "tab here new");
  assert.equal(noteStem("été"), "été", "titles are NFC");
  const long = noteStem("é".repeat(300));
  assert.ok(new TextEncoder().encode(long).length <= MAX_STEM_BYTES);
  assert.ok(!long.includes("�"), "a cut never splits a character");
});

test("unique names compare without case and treat a note and a folder of one name as taken", () => {
  assert.equal(uniqueName("Plan", ".md", []), "Plan.md");
  assert.equal(uniqueName("Plan", ".md", ["plan.MD"]), "Plan 2.md");
  assert.equal(uniqueName("Plan", ".md", ["Plan"]), "Plan 2.md", "a folder named Plan takes the note name");
  assert.equal(uniqueName("Plan", "", ["Plan.md", "Plan 2"]), "Plan 3");
  assert.equal(uniqueName("logo", ".png", ["logo.png"]), "logo 2.png", "any extension, not only .md");
  assert.equal(uniqueName("logo", ".png", ["logo"]), "logo.png", "a folder named logo does not take logo.png");
  assert.equal(nameKey("É"), nameKey("É"));
});

test("frontmatter round-trips the body exactly and keeps other tools' keys", () => {
  const body = "line one\r\n\r\n---\r\nnot frontmatter\n";
  const text = formatNote({ id: "abc", title: "Plan", stem: "Plan", body });
  assert.equal(text, `---\nmodex_id: abc\n---\n${body}`);
  assert.deepEqual(parseNote(text), { id: "abc", body, frontmatter: true });
  const other = "---\n# a comment\ntags:\n  - x\nmodex_id: old\n---\nbody";
  const rewritten = formatNote({ id: "new", title: "A: B", stem: "A- B", body: "body" }, other);
  assert.match(rewritten, /# a comment/);
  assert.match(rewritten, /tags:/);
  assert.deepEqual(parseNote(rewritten), { id: "new", title: "A: B", body: "body", frontmatter: true });
  assert.doesNotMatch(formatNote({ id: "new", title: "Same", stem: "Same", body: "" }, rewritten), /title:/);
  assert.deepEqual(parseNote("---\n- a list\n---\nbody"), { body: "---\n- a list\n---\nbody", frontmatter: false }, "a non-mapping header is body");
  assert.deepEqual(parseNote("no header"), { body: "no header", frontmatter: false });
  assert.equal(splitFrontmatter("---\nunclosed"), null);
  assert.deepEqual(parseNote("---\n---\nempty header"), { body: "empty header", frontmatter: true });
});

test("durable writes replace atomically, and moves never overwrite", () => {
  const dir = tmpdir("modex-durable-");
  const file = path.join(dir, "note.md");
  writeFileDurably(file, "one");
  writeFileDurably(file, "two");
  assert.equal(fs.readFileSync(file, "utf8"), "two");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(dir), ["note.md"], "no temporary file is left behind");
  fs.writeFileSync(path.join(dir, "taken.md"), "keep");
  assert.throws(() => moveNoClobber(file, path.join(dir, "taken.md")), { code: "EEXIST" });
  assert.equal(fs.readFileSync(path.join(dir, "taken.md"), "utf8"), "keep");
  fs.mkdirSync(path.join(dir, "folder"));
  fs.mkdirSync(path.join(dir, "busy"));
  assert.throws(() => moveNoClobber(path.join(dir, "folder"), path.join(dir, "busy")), { code: "EEXIST" });
  moveNoClobber(file, path.join(dir, "sub", "moved.md"));
  assert.equal(fs.readFileSync(path.join(dir, "sub", "moved.md"), "utf8"), "two");
  assert.ok(!fs.existsSync(file));
});
