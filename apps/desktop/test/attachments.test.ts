import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { AttachmentStore } from "../src/main/engine/attachments.js";
import { LIMITS, attachmentUrl, describeAttachments, formatBytes, kindFor, mimeFor, rejectReason, relFromUrl, safeName } from "../src/shared/attachments.js";
import { PNG_B64, tmpdir } from "./helpers.js";

test("the type comes from a specific OS hint, else the extension; only web image types are images", () => {
  assert.equal(mimeFor("shot.png"), "image/png");
  assert.equal(mimeFor("shot.PNG", ""), "image/png");
  assert.equal(mimeFor("shot.png", "application/octet-stream"), "image/png");
  assert.equal(mimeFor("photo.HEIC", "image/heic"), "image/heic");
  assert.equal(mimeFor("notes.md"), "text/markdown");
  assert.equal(mimeFor("Makefile"), "application/octet-stream");
  assert.equal(mimeFor("archive.tar.gz"), "application/octet-stream");
  for (const m of ["image/png", "image/jpeg", "image/gif", "image/webp"]) assert.equal(kindFor(m), "image", m);
  for (const m of ["image/heic", "image/svg+xml", "application/pdf", "text/plain"]) assert.equal(kindFor(m), "file", m);
});

test("names are made safe to write under the root", () => {
  assert.equal(safeName("report.pdf"), "report.pdf");
  assert.equal(safeName("/etc/passwd"), "passwd");
  assert.equal(safeName("..\\..\\x.txt"), "x.txt");
  assert.equal(safeName("../../.hidden"), "hidden");
  assert.equal(safeName("a\u0000b\u001f.png"), "ab.png");
  assert.equal(safeName("   "), "file");
  assert.equal(safeName("."), "file");
  const long = safeName(`${"x".repeat(200)}.jpeg`);
  assert.equal(long.length, 120);
  assert.ok(long.endsWith(".jpeg"));
});

test("sizes read as people write them, and the limits name the file", () => {
  assert.equal(formatBytes(980), "980 B");
  assert.equal(formatBytes(12 * 1024), "12 KB");
  assert.equal(formatBytes(3.4 * 1024 * 1024), "3.4 MB");
  assert.equal(formatBytes(26 * 1024 * 1024), "26 MB");
  assert.equal(rejectReason("a.png", LIMITS.imageBytes, "image"), null);
  assert.equal(rejectReason("a.png", LIMITS.imageBytes + 1, "image"), "a.png is 5.0 MB; the limit for images is 5.0 MB.");
  assert.equal(rejectReason("big.zip", 30 * 1024 * 1024, "file"), "big.zip is 30 MB; the limit for files is 25 MB.");
});

test("stage copies paths, writes pasted bytes, and reports what it cannot take", () => {
  const home = tmpdir();
  const store = new AttachmentStore(path.join(home, "attachments"));
  const src = tmpdir("modex-src-");
  fs.writeFileSync(path.join(src, "notes.txt"), "hello");
  fs.mkdirSync(path.join(src, "folder"));
  const { staged, errors } = store.stage([
    { name: "notes.txt", path: path.join(src, "notes.txt") },
    { name: "dot.png", mime: "image/png", data: PNG_B64 },
    { name: "gone.txt", path: path.join(src, "gone.txt") },
    { name: "folder", path: path.join(src, "folder") },
  ]);
  assert.deepEqual(staged.map((a) => [a.name, a.kind, a.mime, a.size]), [["notes.txt", "file", "text/plain", 5], ["dot.png", "image", "image/png", Buffer.from(PNG_B64, "base64").length]]);
  for (const a of staged) {
    assert.match(a.rel, new RegExp(`^staging/${a.id}-${a.name}$`));
    assert.ok(fs.existsSync(path.join(store.root, a.rel)));
  }
  assert.deepEqual(errors, ["gone.txt: not found", "folder is not a file."]);
  // The source file is untouched: staging holds a copy.
  assert.equal(fs.readFileSync(path.join(src, "notes.txt"), "utf8"), "hello");
});

test("claim moves staged files into the thread folder and passes already-sent ones through", () => {
  const store = new AttachmentStore(path.join(tmpdir(), "attachments"));
  const { staged } = store.stage([{ name: "dot.png", mime: "image/png", data: PNG_B64 }, { name: "a.txt", data: Buffer.from("a").toString("base64") }]);
  const claimed = store.claim("thread-1", staged);
  assert.deepEqual(claimed.map((a) => a.rel), staged.map((a) => `thread-1/${path.basename(a.rel)}`));
  assert.equal(fs.readdirSync(store.staging).length, 0);
  assert.equal(fs.readdirSync(path.join(store.root, "thread-1")).length, 2);
  // A retry claims the same list again: nothing to move, nothing lost.
  assert.deepEqual(store.claim("thread-1", claimed), claimed);
  assert.throws(() => store.claim("thread-1", staged), /no longer staged/);
  assert.throws(() => store.claim("../x", claimed), /bad thread id/);
  store.removeThread("thread-1");
  assert.ok(!fs.existsSync(path.join(store.root, "thread-1")));
});

test("resolve never leaves the root", () => {
  const home = tmpdir();
  const store = new AttachmentStore(path.join(home, "attachments"));
  fs.writeFileSync(path.join(home, "secret.txt"), "no");
  const { staged } = store.stage([{ name: "ok.txt", data: Buffer.from("ok").toString("base64") }]);
  assert.equal(store.resolve(staged[0]!.rel), path.join(store.root, staged[0]!.rel));
  for (const bad of ["../secret.txt", "staging/../../secret.txt", "/etc/passwd", path.join(home, "secret.txt"), "", "staging", "staging/missing.txt", "staging/a\u0000b"]) {
    assert.equal(store.resolve(bad), null, bad);
  }
});

test("discard removes a chip's file; the sweep drops staged files nobody sent", () => {
  const store = new AttachmentStore(path.join(tmpdir(), "attachments"));
  const { staged } = store.stage([{ name: "a.txt", data: "YQ==" }, { name: "b.txt", data: "Yg==" }, { name: "c.txt", data: "Yw==" }]);
  store.discard([staged[0]!.id, "../../etc", "nope"]);
  assert.deepEqual(fs.readdirSync(store.staging).sort(), [staged[1]!.rel, staged[2]!.rel].map((r) => path.basename(r)).sort());
  const old = path.join(store.root, staged[1]!.rel);
  const past = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  fs.utimesSync(old, past, past);
  assert.equal(store.sweepStaging(), 1);
  assert.deepEqual(fs.readdirSync(store.staging), [path.basename(staged[2]!.rel)]);
});

test("the prompt names files by path and leaves images to the content blocks", () => {
  const files = [
    { name: "shot.png", path: "/a/shot.png", kind: "image" as const },
    { name: "spec.md", path: "/a/spec.md", kind: "file" as const },
    { name: "data.csv", path: "/a/data.csv", kind: "file" as const },
  ];
  assert.equal(describeAttachments("look", []), "look");
  assert.equal(describeAttachments("look", [files[0]!]), "look");
  assert.equal(describeAttachments("look", files), "look\n\nAttached files (read as needed):\n- /a/spec.md\n- /a/data.csv");
  assert.equal(describeAttachments("", [files[1]!]), "Attached file (read as needed):\n- /a/spec.md");
});

test("attachment URLs round-trip, and anything else is refused", () => {
  const rel = "staging/abc-my shot (1).png";
  const url = attachmentUrl({ rel });
  assert.equal(url, "modex-attachment://attachment/staging/abc-my%20shot%20(1).png");
  assert.equal(relFromUrl(url), rel);
  assert.equal(relFromUrl("modex-attachment://attachment/thread-1/x.png"), "thread-1/x.png");
  for (const bad of [
    "modex-attachment://attachment/../secret",
    "modex-attachment://attachment/staging/..%2F..%2Fsecret",
    "modex-attachment://attachment/staging",
    "modex-attachment://attachment/a/b/c",
    "modex-attachment://other/staging/x.png",
    "file:///etc/passwd",
    "modex-attachment://attachment/staging/%00",
    "not a url",
  ]) assert.equal(relFromUrl(bad), null, bad);
});
