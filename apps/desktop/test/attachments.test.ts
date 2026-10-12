import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { AttachmentStore, type AttachmentDraft } from "../src/main/engine/attachments.js";
import { type Attachment, LIMITS, attachmentUrl, describeAttachments, formatBytes, kindFor, mimeFor, rejectReason, relFromUrl, safeName } from "../src/shared/attachments.js";
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

test("resolve rejects symlink files, symlink directories, and noncanonical relative paths", () => {
  const home = tmpdir();
  const store = new AttachmentStore(path.join(home, "attachments"));
  const outside = path.join(home, "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "secret.txt"), "private");
  fs.symlinkSync(path.join(outside, "secret.txt"), path.join(store.staging, "linked.txt"));
  fs.symlinkSync(outside, path.join(store.root, "linked-thread"));
  const { staged } = store.stage([{ name: "ok.txt", data: "b2s=" }]);
  const rel = staged[0]!.rel;
  assert.equal(store.resolve(rel), path.join(store.root, rel));
  for (const bad of [
    "staging/linked.txt", "linked-thread/secret.txt", `staging/../${rel}`,
    `./${rel}`, rel.replace("/", "//"), "staging/.", "staging/..",
    "staging/a\\b.txt", "C:\\secret.txt", "staging/folder/nested.txt",
  ]) assert.equal(store.resolve(bad), null, bad);
  fs.mkdirSync(path.join(store.staging, "folder"));
  assert.equal(store.resolve("staging/folder"), null);
});

test("store accepts a canonicalized home ancestor and copies explicitly selected source symlinks", () => {
  const home = tmpdir();
  const alias = path.join(home, "alias");
  fs.mkdirSync(path.join(home, "real"));
  fs.symlinkSync(path.join(home, "real"), alias);
  const store = new AttachmentStore(path.join(alias, "attachments"));
  fs.writeFileSync(path.join(home, "source.txt"), "source bytes");
  fs.symlinkSync(path.join(home, "source.txt"), path.join(home, "source-link.txt"));
  const { staged, errors } = store.stage([{ name: "notes.txt", path: path.join(home, "source-link.txt") }]);
  assert.deepEqual(errors, []);
  assert.equal(fs.readFileSync(store.resolve(staged[0]!.rel)!, "utf8"), "source bytes");
});

test("new attachment directories and files are private", () => {
  const store = new AttachmentStore(path.join(tmpdir(), "attachments"));
  const source = path.join(tmpdir(), "source.txt");
  fs.writeFileSync(source, "hello", { mode: 0o644 });
  const { staged } = store.stage([{ name: "paste.txt", data: "YQ==" }, { name: "source.txt", path: source }]);
  const claimed = store.claim("thread-1", staged);
  for (const dir of [store.root, store.staging, path.join(store.root, "thread-1")]) {
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700, dir);
  }
  for (const file of claimed) assert.equal(fs.statSync(store.resolve(file.rel)!).mode & 0o777, 0o600, file.rel);
});

for (const replaced of ["staging", "root"] as const) {
  for (const operation of ["resolve", "stage", "claim", "discard", "sweep", "removeThread"] as const) {
    test(`${operation} refuses a symlink replacing the attachment ${replaced} directory`, () => {
      const home = tmpdir();
      const store = new AttachmentStore(path.join(home, "attachments"));
      const { staged } = store.stage([{ name: "notes.txt", data: "YQ==" }]);
      const file = staged[0]!;
      const outside = path.join(home, "outside");
      fs.mkdirSync(outside);
      const outsideStaging = replaced === "root" ? path.join(outside, "staging") : outside;
      fs.mkdirSync(outsideStaging, { recursive: true });
      const target = path.join(outsideStaging, path.basename(file.rel));
      fs.writeFileSync(target, "outside bytes");
      const past = new Date(0);
      fs.utimesSync(target, past, past);
      if (replaced === "root") {
        fs.mkdirSync(path.join(outside, "thread-1"));
        fs.writeFileSync(path.join(outside, "thread-1", "keep.txt"), "keep");
      }
      const dir = replaced === "root" ? store.root : store.staging;
      fs.renameSync(dir, `${dir}-original`);
      fs.symlinkSync(outside, dir);
      if (operation === "resolve") assert.equal(store.resolve(file.rel), null);
      if (operation === "stage") {
        const result = store.stage([{ name: "new.txt", data: "Yg==" }]);
        assert.deepEqual(result.staged, []);
        assert.equal(result.errors.length, 1);
      }
      if (operation === "claim") assert.throws(() => store.claim("thread-1", staged), /attachment/i);
      if (operation === "discard") store.discard([file.id]);
      if (operation === "sweep") assert.equal(store.sweepStaging(), 0);
      if (operation === "removeThread") store.removeThread("thread-1");
      assert.equal(fs.readFileSync(target, "utf8"), "outside bytes");
      assert.deepEqual(fs.readdirSync(outsideStaging), [path.basename(file.rel)]);
      if (replaced === "root") assert.equal(fs.readFileSync(path.join(outside, "thread-1", "keep.txt"), "utf8"), "keep");
    });
  }
}

for (const replaced of ["root", "staging"] as const) {
  test(`resolve and mutations reject a different directory installed at the original ${replaced} path`, () => {
    const store = new AttachmentStore(path.join(tmpdir(), "attachments"));
    const { staged } = store.stage([{ name: "notes.txt", data: "YQ==" }]);
    const original = replaced === "root" ? store.root : store.staging;
    fs.renameSync(original, `${original}-original`);
    fs.mkdirSync(store.staging, { recursive: true });
    const target = path.join(store.root, staged[0]!.rel);
    fs.writeFileSync(target, "replacement");
    assert.equal(store.resolve(staged[0]!.rel), null);
    assert.equal(store.stage([{ name: "new.txt", data: "Yg==" }]).staged.length, 0);
    store.discard([staged[0]!.id]);
    assert.equal(store.sweepStaging(0, Date.now() + 1000), 0);
    assert.throws(() => store.claim("thread-1", staged), /attachment/i);
    assert.equal(fs.readFileSync(target, "utf8"), "replacement");
  });
}

for (const operation of ["resolve", "claim", "retry", "removeThread"] as const) {
  test(`${operation} refuses a regular directory replacing an owned thread directory`, () => {
    const store = new AttachmentStore(path.join(tmpdir(), "attachments"));
    const { staged } = store.stage([{ name: "notes.txt", data: "YQ==" }]);
    const claimed = store.claim("thread-1", staged);
    const dir = path.join(store.root, "thread-1");
    fs.renameSync(dir, `${dir}-original`);
    fs.mkdirSync(dir);
    const target = path.join(store.root, claimed[0]!.rel);
    fs.writeFileSync(target, "replacement bytes");
    if (operation === "resolve") assert.equal(store.resolve(claimed[0]!.rel), null);
    if (operation === "claim") assert.throws(() => store.claim("thread-1", store.stage([{ name: "next.txt", data: "Yg==" }]).staged), /attachment/i);
    if (operation === "retry") assert.throws(() => store.claim("thread-1", claimed), /attachment/i);
    if (operation === "removeThread") {
      store.removeThread("thread-1");
      assert.equal(store.resolve(claimed[0]!.rel), null, "refused deletion must not forget the original identity");
    }
    assert.equal(fs.readFileSync(target, "utf8"), "replacement bytes");
  });
}

test("an intentionally removed thread directory can be recreated for a later claim", () => {
  const store = new AttachmentStore(path.join(tmpdir(), "attachments"));
  const first = store.claim("thread-1", store.stage([{ name: "first.txt", data: "YQ==" }]).staged);
  store.removeThread("thread-1");
  assert.equal(store.resolve(first[0]!.rel), null);
  const second = store.claim("thread-1", store.stage([{ name: "second.txt", data: "Yg==" }]).staged);
  assert.equal(fs.readFileSync(store.resolve(second[0]!.rel)!, "utf8"), "b");
});

test("removing a thread preserves replaced and adjacent unowned files through restart cleanup", () => {
  const root = path.join(tmpdir(), "attachments");
  const store = new AttachmentStore(root);
  const [replaced, owned] = store.claim("thread-1", store.stage([
    { name: "replaced.txt", data: "YQ==" }, { name: "owned.txt", data: "Yg==" },
  ]).staged);
  const dir = path.join(root, "thread-1");
  const target = path.join(root, replaced!.rel);
  fs.renameSync(target, `${target}.old`);
  fs.writeFileSync(target, "unowned replacement");
  fs.writeFileSync(path.join(dir, "unowned.txt"), "adjacent bytes");
  fs.mkdirSync(path.join(dir, "unowned-directory"));
  fs.writeFileSync(path.join(dir, "unowned-directory", "nested.txt"), "nested bytes");
  assert.equal(store.resolve(replaced!.rel), null);

  store.removeThread("thread-1");
  const preserved = () => {
    assert.equal(fs.readFileSync(target, "utf8"), "unowned replacement");
    assert.equal(fs.readFileSync(`${target}.old`, "utf8"), "a");
    assert.equal(fs.readFileSync(path.join(dir, "unowned.txt"), "utf8"), "adjacent bytes");
    assert.equal(fs.readFileSync(path.join(dir, "unowned-directory", "nested.txt"), "utf8"), "nested bytes");
    assert.equal(fs.existsSync(path.join(root, owned!.rel)), false, "verified owned bytes are removed");
  };
  preserved();
  const restarted = new AttachmentStore(root);
  restarted.sweepStaging();
  restarted.removeThread("thread-1");
  preserved();
});

test("claim and thread removal refuse symlinked thread directories and the reserved staging ID", () => {
  const store = new AttachmentStore(path.join(tmpdir(), "attachments"));
  const { staged } = store.stage([{ name: "notes.txt", data: "YQ==" }]);
  const outside = tmpdir();
  fs.writeFileSync(path.join(outside, "keep.txt"), "keep");
  fs.symlinkSync(outside, path.join(store.root, "thread-1"));
  assert.throws(() => store.claim("thread-1", staged), /attachment/i);
  store.removeThread("thread-1");
  assert.equal(fs.readFileSync(path.join(outside, "keep.txt"), "utf8"), "keep");
  assert.deepEqual(fs.readdirSync(outside), ["keep.txt"]);
  assert.throws(() => store.claim("staging", staged), /bad thread id/);
  store.removeThread("staging");
  assert.ok(store.resolve(staged[0]!.rel));
});

test("constructor refuses preexisting attachment root and staging symlinks", () => {
  for (const leaf of ["root", "root-trailing-slash", "staging"] as const) {
    const home = tmpdir();
    const root = path.join(home, "attachments");
    const outside = tmpdir();
    if (leaf === "staging") fs.mkdirSync(root);
    fs.symlinkSync(outside, leaf === "staging" ? path.join(root, "staging") : root);
    assert.throws(() => new AttachmentStore(leaf === "root-trailing-slash" ? root + path.sep : root), /attachment/i);
    assert.deepEqual(fs.readdirSync(outside), []);
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

// Inputs cross IPC; TypeScript declarations are not runtime validation.
for (const value of [null, {}, "files", 1]) {
  test(`stage rejects a non-array request: ${JSON.stringify(value)}`, () => {
    const store = new AttachmentStore(path.join(tmpdir(), "attachments"));
    const result = store.stage(value as never);
    assert.deepEqual(result.staged, []);
    assert.match(result.errors.join(" "), /array/i);
  });
}

for (const value of [null, {}, 3, { name: 3, data: "YQ==" }, { name: "bad", mime: null, data: "YQ==" },
  { name: "bad", data: 1 }, { name: "bad", path: 1 }, { name: "bad", path: "x", data: "YQ==" },
  ...[-1, NaN, Infinity, "1", null].map(size => ({ name: "bad", size, data: "YQ==" }))]) {
  test(`stage reports malformed file: ${JSON.stringify(value)}`, () => {
    const store = new AttachmentStore(path.join(tmpdir(), "attachments"));
    const result = store.stage([value, { name: "valid.txt", data: "" }] as never);
    assert.equal(result.errors.length, 1);
    assert.equal(result.staged.length, 1);
    assert.equal(result.staged[0]!.size, 0);
  });
}

test("stage rejects 21 files before decoding or copying anything", (t) => {
  const store = new AttachmentStore(path.join(tmpdir(), "attachments"));
  const copy = t.mock.method(fs, "readFileSync", () => { throw new Error("must not read"); });
  const result = store.stage(Array.from({ length: 21 }, () => ({ name: "x", data: "YQ==" })));
  assert.deepEqual(result.staged, []);
  assert.match(result.errors.join(" "), /20/);
  assert.equal(copy.mock.callCount(), 0);
  assert.deepEqual(fs.readdirSync(store.staging), []);
});

for (const data of ["!", "Y===", "YQ=", "Y Q==", "YQ==junk", "YR==", "a"]) {
  test(`stage rejects malformed base64 ${JSON.stringify(data)}`, () => {
    const store = new AttachmentStore(path.join(tmpdir(), "attachments"));
    const result = store.stage([{ name: "x.png", data }]);
    assert.deepEqual(result.staged, []);
    assert.match(result.errors.join(" "), /base64/i);
  });
}

test("stage rejects an oversized encoding before Buffer allocation", (t) => {
  const store = new AttachmentStore(path.join(tmpdir(), "attachments"));
  const data = "A".repeat(4 * Math.ceil(LIMITS.imageBytes / 3) + 4);
  const original = Buffer.from;
  let decoded = false;
  t.mock.method(Buffer, "from", (...args: Parameters<typeof Buffer.from>) => {
    if (args[0] === data) decoded = true;
    return Reflect.apply(original, Buffer, args);
  });
  const result = store.stage([{ name: "x.png", data }]);
  assert.deepEqual(result.staged, []);
  assert.match(result.errors.join(" "), /limit/i);
  assert.equal(decoded, false);
});

test("stage rejects decoded bytes above the image limit despite a smaller hint", () => {
  const store = new AttachmentStore(path.join(tmpdir(), "attachments"));
  const result = store.stage([{ name: "x.png", size: 1, data: Buffer.alloc(LIMITS.imageBytes + 1).toString("base64") }]);
  assert.deepEqual(result.staged, []);
  assert.match(result.errors.join(" "), /limit/i);
});

test("stage bounds actual source bytes when the file grows after its size check", (t) => {
  const store = new AttachmentStore(path.join(tmpdir(), "attachments"));
  const source = path.join(tmpdir(), "x.png");
  fs.writeFileSync(source, Buffer.alloc(LIMITS.imageBytes + 1));
  const originalStat = fs.statSync;
  const originalFstat = fs.fstatSync;
  t.mock.method(fs, "statSync", (...args: Parameters<typeof fs.statSync>) => {
    const stat = Reflect.apply(originalStat, fs, args);
    if (args[0] === source && stat) stat.size = 1;
    return stat;
  });
  t.mock.method(fs, "fstatSync", (...args: Parameters<typeof fs.fstatSync>) => {
    const stat = Reflect.apply(originalFstat, fs, args);
    stat.size = 1;
    return stat;
  });
  const result = store.stage([{ name: "x.png", path: source }]);
  assert.deepEqual(result.staged, []);
  assert.match(result.errors.join(" "), /limit/i);
});

function stagedPair(store: AttachmentStore) {
  return store.stage([{ name: "a.txt", data: "YQ==" }, { name: "b.txt", data: "Yg==" }]).staged;
}

for (const value of [null, {}, "", { length: 0 }, [null]]) {
  test(`claim rejects a malformed attachment list: ${JSON.stringify(value)}`, () => {
    const store = new AttachmentStore(path.join(tmpdir(), "attachments"));
    assert.throws(() => store.claim("thread-1", value as never), /attachment/i);
  });
}

test("claim rejects 21 files before creating a thread directory", () => {
  const store = new AttachmentStore(path.join(tmpdir(), "attachments"));
  const [file] = stagedPair(store);
  assert.throws(() => store.claim("thread-1", Array(21).fill(file)), /20/);
  assert.ok(!fs.existsSync(path.join(store.root, "thread-1")));
  assert.ok(store.resolve(file!.rel));
});

test("claim prevalidates duplicate IDs and paths without consuming any staged file", () => {
  const store = new AttachmentStore(path.join(tmpdir(), "attachments"));
  const [a, b] = stagedPair(store);
  for (const files of [[a, a], [a, { ...b, rel: a!.rel }], [a, { ...b, id: a!.id }]]) {
    assert.throws(() => store.claim("thread-1", files as never), /duplicate|metadata/i);
    assert.ok(store.resolve(a!.rel));
    assert.ok(store.resolve(b!.rel));
  }
});

test("a missing second source leaves the first staged reference usable for retry", () => {
  const store = new AttachmentStore(path.join(tmpdir(), "attachments"));
  const files = stagedPair(store);
  fs.unlinkSync(store.resolve(files[1]!.rel)!);
  assert.throws(() => store.claim("thread-1", files), /attachment/i);
  assert.ok(store.resolve(files[0]!.rel));
  assert.equal(store.claim("thread-1", files.slice(0, 1)).length, 1);
});

test("a failed second destination write rolls back owned copies and preserves staged sources", (t) => {
  const store = new AttachmentStore(path.join(tmpdir(), "attachments"));
  const files = stagedPair(store);
  const original = fs.writeSync;
  let writes = 0;
  const copy = t.mock.method(fs, "writeSync", (...args: Parameters<typeof fs.writeSync>) => {
    if (++writes === 2) throw new Error("forced write failure");
    return Reflect.apply(original, fs, args);
  });
  assert.throws(() => store.claim("thread-1", files), /forced write failure/);
  copy.mock.restore();
  for (const file of files) assert.ok(store.resolve(file.rel));
  assert.deepEqual(fs.readdirSync(path.join(store.root, "thread-1")), []);
  assert.equal(new AttachmentStore(store.root).claim("thread-1", files).length, 2);
});

test("claim preserves a preexisting destination instead of overwriting it", () => {
  const store = new AttachmentStore(path.join(tmpdir(), "attachments"));
  const files = stagedPair(store);
  const dir = path.join(store.root, "thread-1");
  fs.mkdirSync(dir);
  const dest = path.join(dir, path.basename(files[1]!.rel));
  fs.writeFileSync(dest, "do not replace");
  assert.throws(() => store.claim("thread-1", files), /exist|collision/i);
  assert.equal(fs.readFileSync(dest, "utf8"), "do not replace");
  for (const file of files) assert.ok(store.resolve(file.rel));
});

test("foreign-thread files cannot be adopted, and deleting their owner cannot invalidate another thread", () => {
  const store = new AttachmentStore(path.join(tmpdir(), "attachments"));
  const a = store.claim("thread-a", stagedPair(store));
  assert.throws(() => store.claim("thread-b", a), /thread|owner/i);
  const b = store.claim("thread-b", stagedPair(store));
  store.removeThread("thread-a");
  for (const file of b) assert.ok(store.resolve(file.rel));
});

for (const patch of [{ name: "forged.txt" }, { mime: "image/png" }, { kind: "image" }, { size: 99 }, { id: "forged" }]) {
  test(`claim rejects tampered metadata ${JSON.stringify(patch)}`, () => {
    const store = new AttachmentStore(path.join(tmpdir(), "attachments"));
    const files = stagedPair(store);
    assert.throws(() => store.claim("thread-1", [{ ...files[0], ...patch }] as never), /metadata|unknown/i);
    assert.ok(store.resolve(files[0]!.rel));
  });
}

test("staged metadata and same-thread retry remain authoritative after restart", () => {
  const store = new AttachmentStore(path.join(tmpdir(), "attachments"));
  const files = stagedPair(store);
  const fresh = new AttachmentStore(store.root);
  assert.throws(() => fresh.claim("thread-1", [{ ...files[0]!, name: "forged" }]), /metadata/i);
  const claimed = fresh.claim("thread-1", files);
  assert.deepEqual(new AttachmentStore(store.root).claim("thread-1", claimed), claimed);
  assert.throws(() => new AttachmentStore(store.root).claim("thread-other", claimed), /thread|owner/i);
});

test("claim never adopts an arbitrary file from disk, even after restart", () => {
  const store = new AttachmentStore(path.join(tmpdir(), "attachments"));
  const forged = { id: "unowned", name: "x.txt", mime: "text/plain", kind: "file" as const, size: 1, rel: "staging/unowned-x.txt" };
  fs.writeFileSync(path.join(store.root, forged.rel), "x");
  assert.throws(() => new AttachmentStore(store.root).claim("thread-1", [forged]), /metadata|unknown/i);
});

test("claim rejects a replacement regular file using its persisted identity", () => {
  const store = new AttachmentStore(path.join(tmpdir(), "attachments"));
  const files = stagedPair(store);
  const abs = store.resolve(files[0]!.rel)!;
  fs.renameSync(abs, `${abs}.old`);
  fs.writeFileSync(abs, "x");
  assert.throws(() => new AttachmentStore(store.root).claim("thread-1", files), /attachment/i);
});

test("metadata commit failure leaves all sources usable and rolls back new destinations", (t) => {
  const store = new AttachmentStore(path.join(tmpdir(), "attachments"));
  const files = stagedPair(store);
  const original = fs.renameSync;
  const rename = t.mock.method(fs, "renameSync", (...args: Parameters<typeof fs.renameSync>) => {
    if (String(args[1]).endsWith(".manifest.json")) throw new Error("forced metadata failure");
    return Reflect.apply(original, fs, args);
  });
  assert.throws(() => store.claim("thread-1", files), /forced metadata failure/);
  rename.mock.restore();
  for (const file of files) assert.ok(store.resolve(file.rel));
  assert.deepEqual(fs.readdirSync(path.join(store.root, "thread-1")), []);
  assert.equal(new AttachmentStore(store.root).claim("thread-1", files).length, 2);
});

test("MIME hints never inherit image types from Object.prototype", () => {
  for (const mime of ["constructor", "__proto__", "toString"]) assert.equal(kindFor(mime), "file");
});

for (const paths of [null, {}, "a.txt", [null], [3], Array(21).fill("x.txt")]) {
  test(`native picker paths are runtime validated: ${JSON.stringify(paths)}`, () => {
    const store = new AttachmentStore(path.join(tmpdir(), "attachments"));
    const result = store.stagePaths(paths);
    assert.deepEqual(result.staged, []);
    assert.equal(result.errors.length, 1);
    assert.deepEqual(fs.readdirSync(store.staging), []);
  });
}

test("native picker remaining slots reject excess before reading selected files", () => {
  const store = new AttachmentStore(path.join(tmpdir(), "attachments"));
  const pick = store;
  const file = path.join(tmpdir(), "x.txt");
  fs.writeFileSync(file, "x");
  assert.match(pick.stagePaths([file, file], 1).errors.join(" "), /1/);
  for (const remaining of [-1, 21, NaN, null, "1", 0.5]) assert.equal(pick.stagePaths([file], remaining).errors.length, 1);
  assert.equal(pick.stagePaths([file], 1).staged.length, 1);
});

test("removing a thread persists enough state for a new claim after restart", () => {
  const store = new AttachmentStore(path.join(tmpdir(), "attachments"));
  store.claim("thread-1", stagedPair(store));
  store.removeThread("thread-1");
  const fresh = new AttachmentStore(store.root);
  const files = stagedPair(fresh);
  assert.equal(fresh.claim("thread-1", files).length, 2);
});

test("a retirement cleanup failure still returns committed attachments and survives restart", (t) => {
  const store = new AttachmentStore(path.join(tmpdir(), "attachments"));
  const files = stagedPair(store);
  const unlink = t.mock.method(fs, "unlinkSync", () => { throw new Error("forced retirement failure"); });
  const claimed = store.claim("thread-1", files);
  unlink.mock.restore();
  assert.equal(fs.readdirSync(store.staging).length, 2);
  const fresh = new AttachmentStore(store.root);
  assert.deepEqual(fresh.claim("thread-1", claimed), claimed);
  fresh.sweepStaging();
  assert.equal(fs.readdirSync(store.staging).length, 0);
  assert.deepEqual(fs.readdirSync(path.join(store.root, "thread-1")).sort(), claimed.map(file => path.basename(file.rel)).sort());
  for (const file of claimed) assert.ok(fresh.resolve(file.rel));
});

for (const action of ["discard", "sweep", "removeThread"] as const) {
  test(`${action} preserves ownership and bytes when the manifest commit fails`, (t) => {
    const store = new AttachmentStore(path.join(tmpdir(), "attachments"));
    const files = action === "removeThread" ? store.claim("thread-1", stagedPair(store)) : stagedPair(store);
    const rename = t.mock.method(fs, "renameSync", () => { throw new Error("forced metadata failure"); });
    assert.throws(() => {
      if (action === "discard") store.discard(files.map(f => f.id));
      if (action === "sweep") store.sweepStaging(-1);
      if (action === "removeThread") store.removeThread("thread-1");
    }, /forced metadata failure/);
    rename.mock.restore();
    for (const file of files) assert.ok(new AttachmentStore(store.root).resolve(file.rel));
  });
}

test("stage removes a private partial file when its metadata write fails", (t) => {
  const store = new AttachmentStore(path.join(tmpdir(), "attachments"));
  t.mock.method(fs, "renameSync", () => { throw new Error("forced metadata failure"); });
  const result = store.stage([{ name: "x.txt", data: "YQ==" }]);
  assert.deepEqual(result.staged, []);
  assert.match(result.errors.join(" "), /forced metadata failure/);
  assert.deepEqual(fs.readdirSync(store.staging), []);
});

test("an unexpected manifest cannot be overwritten by staging", () => {
  const store = new AttachmentStore(path.join(tmpdir(), "attachments"));
  const manifest = path.join(store.root, ".manifest.json");
  fs.writeFileSync(manifest, "unowned metadata");
  const result = store.stage([{ name: "x.txt", data: "YQ==" }]);
  assert.deepEqual(result.staged, []);
  assert.match(result.errors.join(" "), /metadata|manifest/i);
  assert.equal(fs.readFileSync(manifest, "utf8"), "unowned metadata");
});

test("a stale store cannot overwrite another store's committed metadata", () => {
  const stale = new AttachmentStore(path.join(tmpdir(), "attachments"));
  const files = stagedPair(stale);
  const fresh = new AttachmentStore(stale.root);
  const other = fresh.stage([{ name: "new.txt", data: "Yw==" }]).staged;
  assert.throws(() => stale.claim("thread-1", files), /metadata|manifest/i);
  const current = new AttachmentStore(stale.root);
  assert.equal(current.claim("thread-1", [...files, ...other]).length, 3);
});

test("a file changed during claim copying is never committed or retired", (t) => {
  const store = new AttachmentStore(path.join(tmpdir(), "attachments"));
  const files = stagedPair(store);
  const original = fs.readSync;
  let changed = false;
  const read = t.mock.method(fs, "readSync", (...args: Parameters<typeof fs.readSync>) => {
    if (!changed) { changed = true; fs.appendFileSync(path.join(store.root, files[0]!.rel), "changed"); }
    return Reflect.apply(original, fs, args);
  });
  assert.throws(() => store.claim("thread-1", files), /attachment.*changed/i);
  read.mock.restore();
  for (const file of files) assert.ok(fs.existsSync(path.join(store.root, file.rel)));
  assert.deepEqual(fs.readdirSync(path.join(store.root, "thread-1")), []);
});

test("extension inference never inherits MIME values from Object.prototype", () => {
  for (const name of ["x.constructor", "x.__proto__", "x.toString"]) assert.equal(mimeFor(name), "application/octet-stream");
});

test("claim rejects sparse arrays instead of skipping unvalidated slots", () => {
  const store = new AttachmentStore(path.join(tmpdir(), "attachments"));
  assert.throws(() => store.claim("thread-1", new Array(1)), /attachment/i);
});

test("staging a selected FIFO returns a per-file error without blocking the main process", () => {
  const root = path.join(tmpdir(), "attachments");
  const fifo = path.join(tmpdir(), "pipe");
  execFileSync("mkfifo", [fifo]);
  const script = `import { AttachmentStore } from ${JSON.stringify(new URL("../src/main/engine/attachments.js", import.meta.url).href)};
    const store = new AttachmentStore(${JSON.stringify(root)});
    const result = store.stage([{name: 'pipe', path: ${JSON.stringify(fifo)}}]);
    if (result.staged.length || !result.errors.some(error => error.includes('not a file'))) process.exit(1);`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { timeout: 2000, encoding: "utf8" });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
});

test("a metadata read failure after the second copy rolls back both owned destinations", (t) => {
  const store = new AttachmentStore(path.join(tmpdir(), "attachments"));
  const files = stagedPair(store);
  const dest = path.join(store.root, "thread-1", path.basename(files[1]!.rel));
  const original = fs.lstatSync;
  let failed = false;
  const stat = t.mock.method(fs, "lstatSync", (...args: Parameters<typeof fs.lstatSync>) => {
    const value = Reflect.apply(original, fs, args);
    if (args[0] === dest && value && !failed) {
      failed = true;
      throw Object.assign(new Error("forced post-copy metadata read failure"), { code: "EIO" });
    }
    return value;
  });
  assert.throws(() => store.claim("thread-1", files), /forced post-copy metadata read failure/);
  stat.mock.restore();
  for (const file of files) assert.ok(store.resolve(file.rel));
  assert.deepEqual(fs.readdirSync(path.join(store.root, "thread-1")), []);
  assert.equal(new AttachmentStore(store.root).claim("thread-1", files).length, 2);
});

for (const persistent of [false, true]) {
  test(`an initial destination identity failure leaves final names free for retry (persistent=${persistent})`, (t) => {
    const store = new AttachmentStore(path.join(tmpdir(), "attachments"));
    const files = stagedPair(store);
    const open = fs.openSync;
    const stat = fs.fstatSync;
    let destinationFd = -1;
    let failed = false;
    const opens = t.mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
      const fd = Reflect.apply(open, fs, args);
      if (String(args[0]).includes("/.claim-")) destinationFd = fd;
      return fd;
    });
    const stats = t.mock.method(fs, "fstatSync", (...args: Parameters<typeof fs.fstatSync>) => {
      if (args[0] === destinationFd && (persistent || !failed)) {
        failed = true;
        throw new Error("forced initial identity failure");
      }
      return Reflect.apply(stat, fs, args);
    });
    assert.throws(() => store.claim("thread-1", files), /forced initial identity failure/);
    opens.mock.restore(); stats.mock.restore();
    for (const file of files) {
      assert.ok(store.resolve(file.rel));
      assert.ok(!fs.existsSync(path.join(store.root, "thread-1", path.basename(file.rel))));
    }
    const leftovers = fs.readdirSync(path.join(store.root, "thread-1"));
    assert.equal(leftovers.length, persistent ? 1 : 0);
    for (const name of leftovers) assert.equal(fs.statSync(path.join(store.root, "thread-1", name)).size, 0);
    assert.equal(new AttachmentStore(store.root).claim("thread-1", files).length, 2);
  });
}

test("a manifest identity read failure closes the temporary descriptor and preserves staged sources", (t) => {
  const store = new AttachmentStore(path.join(tmpdir(), "attachments"));
  const files = stagedPair(store);
  const originalOpen = fs.openSync;
  const originalStat = fs.fstatSync;
  let manifestFd = -1;
  const open = t.mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
    const fd = Reflect.apply(originalOpen, fs, args);
    if (String(args[0]).includes("/.manifest-") && String(args[0]).endsWith(".tmp")) manifestFd = fd;
    return fd;
  });
  const stat = t.mock.method(fs, "fstatSync", (...args: Parameters<typeof fs.fstatSync>) => {
    if (args[0] === manifestFd) throw new Error("forced manifest identity failure");
    return Reflect.apply(originalStat, fs, args);
  });
  assert.throws(() => store.claim("thread-1", files), /forced manifest identity failure/);
  open.mock.restore(); stat.mock.restore();
  assert.throws(() => fs.fstatSync(manifestFd), { code: "EBADF" });
  for (const file of files) assert.ok(store.resolve(file.rel));
  assert.equal(new AttachmentStore(store.root).claim("thread-1", files).length, 2);
});

for (const fault of ["stat", "unlink", "commit-and-unlink"] as const) {
  test(`failed rollback retains ownership for restart recovery (${fault})`, (t) => {
    const store = new AttachmentStore(path.join(tmpdir(), "attachments"));
    const files = stagedPair(store);
    const destinations = files.map(file => path.join(store.root, "thread-1", path.basename(file.rel)));
    const originalStat = fs.lstatSync;
    const originalUnlink = fs.unlinkSync;
    const originalRename = fs.renameSync;
    let statFailed = false;
    const stat = t.mock.method(fs, "lstatSync", (...args: Parameters<typeof fs.lstatSync>) => {
      const value = Reflect.apply(originalStat, fs, args);
      if (fault !== "commit-and-unlink" && args[0] === destinations[1] && value && (fault === "stat" || !statFailed)) {
        statFailed = true;
        throw Object.assign(new Error("forced destination metadata failure"), { code: "EIO" });
      }
      return value;
    });
    const unlink = t.mock.method(fs, "unlinkSync", (...args: Parameters<typeof fs.unlinkSync>) => {
      if (fault !== "stat" && destinations.includes(String(args[0]))) throw new Error("forced rollback deletion failure");
      return Reflect.apply(originalUnlink, fs, args);
    });
    const rename = t.mock.method(fs, "renameSync", (...args: Parameters<typeof fs.renameSync>) => {
      if (fault === "commit-and-unlink" && String(args[1]).endsWith(".manifest.json")) {
        const manifest = JSON.parse(fs.readFileSync(args[0], "utf8"));
        if (manifest.files.some((file: { attachment: { rel: string } }) => file.attachment.rel.startsWith("thread-1/"))) throw new Error("forced final metadata commit failure");
      }
      return Reflect.apply(originalRename, fs, args);
    });
    assert.throws(() => store.claim("thread-1", files), /forced/);
    stat.mock.restore(); unlink.mock.restore(); rename.mock.restore();
    for (const file of files) assert.ok(store.resolve(file.rel));
    assert.ok(destinations.some(dest => fs.existsSync(dest)), "fault leaves a known destination to recover");
    const fresh = new AttachmentStore(store.root);
    fresh.sweepStaging();
    assert.equal(fresh.claim("thread-1", files).length, 2);
  });
}

test("a stale empty store cannot remove a newer store's claimed attachments", () => {
  const stale = new AttachmentStore(path.join(tmpdir(), "attachments"));
  const current = new AttachmentStore(stale.root);
  const files = current.claim("thread-1", stagedPair(current));
  assert.throws(() => stale.removeThread("thread-1"), /metadata/i);
  for (const file of files) assert.ok(current.resolve(file.rel));
});

test("rollback recovery preserves a later unrelated replacement at the reserved final path", (t) => {
  const store = new AttachmentStore(path.join(tmpdir(), "attachments"));
  const files = stagedPair(store);
  const dest = path.join(store.root, "thread-1", path.basename(files[1]!.rel));
  const originalStat = fs.lstatSync;
  const originalUnlink = fs.unlinkSync;
  let failed = false;
  const stat = t.mock.method(fs, "lstatSync", (...args: Parameters<typeof fs.lstatSync>) => {
    const value = Reflect.apply(originalStat, fs, args);
    if (args[0] === dest && value && !failed) { failed = true; throw new Error("forced metadata failure"); }
    return value;
  });
  const unlink = t.mock.method(fs, "unlinkSync", (...args: Parameters<typeof fs.unlinkSync>) => {
    if (args[0] === dest) throw new Error("forced cleanup failure");
    return Reflect.apply(originalUnlink, fs, args);
  });
  assert.throws(() => store.claim("thread-1", files), /forced metadata failure/);
  stat.mock.restore(); unlink.mock.restore();
  fs.renameSync(dest, `${dest}.old`);
  fs.writeFileSync(dest, "unrelated replacement");
  const fresh = new AttachmentStore(store.root);
  fresh.sweepStaging();
  assert.equal(fs.readFileSync(dest, "utf8"), "unrelated replacement");
  assert.throws(() => fresh.claim("thread-1", files), /destination already exists/);
  for (const file of files) assert.ok(fresh.resolve(file.rel));
  fs.unlinkSync(dest);
  assert.equal(fresh.claim("thread-1", files).length, 2);
});

test("a same-instance retry recovers known failed rollback files before collision checks", (t) => {
  const store = new AttachmentStore(path.join(tmpdir(), "attachments"));
  const files = stagedPair(store);
  const dest = path.join(store.root, "thread-1", path.basename(files[1]!.rel));
  const original = fs.lstatSync;
  const stat = t.mock.method(fs, "lstatSync", (...args: Parameters<typeof fs.lstatSync>) => {
    const value = Reflect.apply(original, fs, args);
    if (args[0] === dest && value) throw new Error("forced persistent metadata failure");
    return value;
  });
  assert.throws(() => store.claim("thread-1", files), /forced persistent metadata failure/);
  stat.mock.restore();
  assert.equal(store.claim("thread-1", files).length, 2);
});

test("staging synchronizes attachment bytes and directory entries before acknowledgment", t => {
  const store = new AttachmentStore(path.join(tmpdir(), "attachments"));
  const events: string[] = [];
  const open = fs.openSync, close = fs.closeSync, sync = fs.fsyncSync, rename = fs.renameSync;
  const opened = new Map<number, string>();
  t.mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
    const fd = Reflect.apply(open, fs, args); opened.set(fd, String(args[0])); return fd;
  });
  t.mock.method(fs, "closeSync", (fd: number) => { opened.delete(fd); return close(fd); });
  t.mock.method(fs, "fsyncSync", (fd: number) => { events.push(`sync:${opened.get(fd)}`); return sync(fd); });
  t.mock.method(fs, "renameSync", (...args: Parameters<typeof fs.renameSync>) => {
    const result = Reflect.apply(rename, fs, args); events.push(`rename:${args[1]}`); return result;
  });
  const result = store.stage([{ name: "durable.txt", data: Buffer.from("original bytes").toString("base64") }]);
  assert.deepEqual(result.errors, []); assert.equal(result.staged.length, 1);
  const file = result.staged[0]!;
  const contentSync = events.indexOf(`sync:${path.join(store.root, file.rel)}`);
  const stagingSync = events.indexOf(`sync:${store.staging}`);
  const publication = events.indexOf(`rename:${path.join(store.root, ".manifest.json")}`);
  const manifestDirectorySync = events.lastIndexOf(`sync:${store.root}`);
  assert.ok(contentSync >= 0, "staged file contents must be synchronized");
  if (process.platform !== "win32") {
    assert.ok(stagingSync > contentSync && stagingSync < publication, "staged directory entry precedes manifest publication");
    assert.ok(manifestDirectorySync > publication, "manifest directory must be synchronized after publication");
  }
});

test("post-publication manifest sync failure keeps staged bytes and ownership for restart", { skip: process.platform === "win32" }, t => {
  const store = new AttachmentStore(path.join(tmpdir(), "attachments"));
  const rename = fs.renameSync, sync = fs.fsyncSync;
  let published = false;
  t.mock.method(fs, "renameSync", (...args: Parameters<typeof fs.renameSync>) => {
    const result = Reflect.apply(rename, fs, args);
    if (String(args[1]) === path.join(store.root, ".manifest.json")) published = true;
    return result;
  });
  const fault = t.mock.method(fs, "fsyncSync", (fd: number) => {
    if (published && fs.fstatSync(fd).isDirectory()) throw new Error("forced published-directory sync failure");
    return sync(fd);
  });
  const result = store.stage([{ name: "preserve.txt", data: Buffer.from("preserve original bytes").toString("base64") }]);
  assert.deepEqual(result.staged, [], "an uncertain durable write cannot acknowledge staging");
  assert.match(result.errors.join(" "), /sync|durab|storage/i);
  const manifest = JSON.parse(fs.readFileSync(path.join(store.root, ".manifest.json"), "utf8"));
  const retained: Attachment = manifest.files[0].attachment;
  assert.equal(fs.readFileSync(path.join(store.root, retained.rel), "utf8"), "preserve original bytes");
  fault.mock.restore();
  const fresh = new AttachmentStore(store.root);
  assert.ok(fresh.resolve(retained.rel), "the published manifest must still name owned original bytes");
});

for (const phase of ["checkpoint", "final"] as const) {
  test(`uncertain ${phase} claim commit preserves staged, copied and write-ahead bytes`, { skip: process.platform === "win32" }, t => {
    const store = new AttachmentStore(path.join(tmpdir(), "attachments"));
    const files = stagedPair(store);
    const originalBytes = new Map(files.map(file => [file.id, fs.readFileSync(path.join(store.root, file.rel))]));
    const rename = fs.renameSync, sync = fs.fsyncSync;
    let inject = false;
    t.mock.method(fs, "renameSync", (...args: Parameters<typeof fs.renameSync>) => {
      let requested = false;
      if (String(args[1]) === path.join(store.root, ".manifest.json")) {
        const record = JSON.parse(fs.readFileSync(String(args[0]), "utf8"));
        const final = record.files.some((file: { attachment: Attachment }) => file.attachment.rel.startsWith("thread-1/"));
        requested = phase === "final" ? final : !final;
      }
      const result = Reflect.apply(rename, fs, args); inject ||= requested; return result;
    });
    const fault = t.mock.method(fs, "fsyncSync", (fd: number) => {
      if (inject && fs.fstatSync(fd).isDirectory()) throw new Error("forced claim directory sync failure");
      return sync(fd);
    });
    assert.throws(() => store.claim("thread-1", files), /sync/i);
    fault.mock.restore();
    assert.throws(() => store.discard(files.map(file => file.id)), /uncertain/i);
    assert.throws(() => store.sweepStaging(-1), /uncertain/i);
    assert.throws(() => store.removeThread("thread-1"), /uncertain/i);
    assert.deepEqual(store.stage([{ name: "blocked.txt", data: "Yw==" }]).staged, []);
    for (const file of files) assert.deepEqual(fs.readFileSync(path.join(store.root, file.rel)), originalBytes.get(file.id));
    const before = fs.readFileSync(path.join(store.root, ".manifest.json"));
    const fresh = new AttachmentStore(store.root);
    assert.deepEqual(fs.readFileSync(path.join(store.root, ".manifest.json")), before);
    const record = JSON.parse(before.toString());
    const owned = [...record.files, ...record.retired] as { attachment: Attachment }[];
    let preservedTemporary = 0, preservedDestination = 0;
    for (const { attachment } of owned) {
      const absolute = path.join(store.root, attachment.rel);
      if (!fs.existsSync(absolute)) continue; // checkpoint includes future final names.
      assert.deepEqual(fs.readFileSync(absolute), originalBytes.get(attachment.id));
      if (attachment.rel.includes("/.claim-")) preservedTemporary++;
      else if (attachment.rel.startsWith("thread-1/")) preservedDestination++;
    }
    assert.equal(preservedTemporary, 2);
    assert.equal(preservedDestination, phase === "final" ? 2 : 0);
    for (const { attachment } of record.files) assert.ok(fresh.resolve(attachment.rel));
  });
}

const protectRecovery = (store: AttachmentStore, references: readonly Attachment[] | null): boolean => {
  return store.setRecoveryRetention(references);
};

test("recovery retains referenced expired staging using a copied main-owned identity set", () => {
  const store = new AttachmentStore(path.join(tmpdir(), "attachments"));
  const [keep, expire] = stagedPair(store) as [Attachment, Attachment];
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
  for (const file of [keep, expire]) fs.utimesSync(path.join(store.root, file.rel), old, old);
  const references = [{ ...keep }];
  assert.equal(protectRecovery(store, references), true); references[0]!.name = "caller mutation"; references.length = 0;
  assert.equal(store.sweepStaging(), 1);
  assert.equal(fs.readFileSync(path.join(store.root, keep.rel), "utf8"), "a");
  assert.equal(fs.existsSync(path.join(store.root, expire.rel)), false);
  store.discard([keep.id]);
  assert.equal(fs.readFileSync(path.join(store.root, keep.rel), "utf8"), "a");
  const fresh = new AttachmentStore(store.root);
  protectRecovery(fresh, [keep]);
  assert.equal(fresh.sweepStaging(-1), 0);
  assert.equal(fs.readFileSync(path.join(store.root, keep.rel), "utf8"), "a");
  protectRecovery(fresh, []); fresh.sweepStaging();
  assert.equal(fs.existsSync(path.join(store.root, keep.rel)), false);
});

test("unreadable recovery preserves active and retired evidence through cleanup and restart", t => {
  const store = new AttachmentStore(path.join(tmpdir(), "attachments"));
  const files = stagedPair(store);
  const unlink = t.mock.method(fs, "unlinkSync", () => { throw new Error("defer cleanup"); });
  const claimed = store.claim("thread-1", files);
  unlink.mock.restore();
  const metadata = JSON.parse(fs.readFileSync(path.join(store.root, ".manifest.json"), "utf8"));
  const paths = [...metadata.files, ...metadata.retired].map((file: { attachment: Attachment }) => file.attachment.rel)
    .filter((rel: string) => fs.existsSync(path.join(store.root, rel)));
  assert.ok(paths.length >= 6);
  protectRecovery(store, null);
  assert.equal(store.sweepStaging(-1), 0);
  store.removeThread("thread-1");
  for (const rel of paths) assert.ok(fs.existsSync(path.join(store.root, rel)), rel);
  const fresh = new AttachmentStore(store.root); protectRecovery(fresh, null);
  assert.equal(fresh.sweepStaging(-1), 0);
  for (const rel of paths) assert.ok(fs.existsSync(path.join(store.root, rel)), rel);
  assert.equal(claimed.length, 2);
});

test("known recovery protection preserves sources without blocking failed-claim rollback and retry", t => {
  const store = new AttachmentStore(path.join(tmpdir(), "attachments"));
  const files = stagedPair(store); protectRecovery(store, files);
  const write = fs.writeSync;
  let writes = 0;
  const fault = t.mock.method(fs, "writeSync", (...args: Parameters<typeof fs.writeSync>) => {
    if (++writes === 2) throw new Error("forced second copy failure");
    return Reflect.apply(write, fs, args);
  });
  assert.throws(() => store.claim("thread-1", files), /second copy failure/);
  fault.mock.restore();
  assert.deepEqual(fs.readdirSync(path.join(store.root, "thread-1")), []);
  for (const file of files) assert.ok(store.resolve(file.rel));
  assert.equal(store.claim("thread-1", files).length, 2);
  for (const file of files) assert.ok(fs.existsSync(path.join(store.root, file.rel)), "referenced staging remains recoverable");
});


test("recovery protects an exact claimed reference after retirement and restart", () => {
  const store = new AttachmentStore(path.join(tmpdir(), "attachments"));
  const claimed = store.claim("thread-1", stagedPair(store));
  assert.equal(protectRecovery(store, claimed), true);
  store.removeThread("thread-1");
  const fresh = new AttachmentStore(store.root);
  assert.equal(protectRecovery(fresh, claimed), true);
  fresh.sweepStaging(-1);
  for (const file of claimed) assert.ok(fs.existsSync(path.join(store.root, file.rel)));
});

test("unresolved or replaced recovery references preserve all possible evidence", () => {
  const store = new AttachmentStore(path.join(tmpdir(), "attachments"));
  const files = stagedPair(store);
  assert.equal(protectRecovery(store, [{ ...files[0]!, id: "unknown-id" }]), false);
  assert.equal(store.sweepStaging(-1), 0);
  const original = path.join(store.root, files[0]!.rel);
  fs.renameSync(original, original + ".preserved"); fs.writeFileSync(original, "replacement");
  assert.equal(protectRecovery(store, files), false);
  assert.equal(store.sweepStaging(-1), 0);
  assert.equal(fs.readFileSync(original, "utf8"), "replacement");
  assert.ok(fs.existsSync(path.join(store.root, files[1]!.rel)));
});

type TestOwner = { kind: "thread"; threadId: string } | { kind: "project"; key: string; projectId: string };
const projectOwner = (): TestOwner => ({ kind: "project", key: "draft:1:project-1", projectId: "project-1" });
const ownedStore = (root: string, authorizeDraft: (owner: TestOwner) => boolean = () => true,
  authorizeTransfer: (owner: TestOwner, threadId: string) => boolean = () => true): AttachmentStore =>
  new AttachmentStore(root, { authorizeDraft, authorizeTransfer });
const mintDraft = (store: AttachmentStore, owner: TestOwner): AttachmentDraft => store.mintDraft(owner);
const stageDraft = (store: AttachmentStore, draft: object, files: unknown = [{ name: "draft.txt", data: "YQ==" }]) =>
  store.stage(files, { draft: draft as AttachmentDraft });
const validateRecovery = (store: AttachmentStore, file: Attachment, owner: TestOwner): boolean =>
  store.validateRecovery(file, owner);

test("authorized draft ownership survives restart without adopting renderer metadata", () => {
  const root = path.join(tmpdir(), "attachments");
  const owner = projectOwner();
  const store = ownedStore(root);
  const draft = mintDraft(store, owner);
  assert.ok(Object.isFrozen(draft));
  if (owner.kind === "project") owner.projectId = "mutated-project";
  const result = stageDraft(store, draft);
  assert.deepEqual(result.errors, []);
  const file = result.staged[0]!;
  const manifest = path.join(root, ".manifest.json");
  const before = fs.readFileSync(manifest);
  assert.equal(JSON.parse(before.toString()).version, 2);
  const fresh = ownedStore(root);
  assert.equal(validateRecovery(fresh, file, projectOwner()), true);
  assert.equal(validateRecovery(fresh, file, { kind: "thread", threadId: "thread-1" }), false);
  assert.equal(validateRecovery(fresh, { ...file, mime: "changed" }, projectOwner()), false);
  assert.deepEqual(fs.readFileSync(manifest), before, "validation cannot rewrite or rebind metadata");
  assert.equal(fs.readFileSync(path.join(root, file.rel), "utf8"), "a");
});

test("forged cross-instance revoked and stale draft handles fail before reading sources", t => {
  const store = ownedStore(path.join(tmpdir(), "attachments"));
  const other = ownedStore(path.join(tmpdir(), "attachments"));
  let active = true;
  const live = ownedStore(path.join(tmpdir(), "attachments"), () => active);
  const stale = mintDraft(live, projectOwner());
  active = false;
  const revoked = mintDraft(store, projectOwner());
  store.revokeDraft(revoked);
  const foreign = mintDraft(other, projectOwner());
  const open = fs.openSync;
  let sourceReads = 0;
  t.mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
    if (args[0] === "/never-read-draft-source") { sourceReads++; throw new Error("source was read"); }
    return Reflect.apply(open, fs, args);
  });
  for (const [target, handle] of [[store, {}], [store, foreign], [store, revoked], [live, stale]] as const) {
    const result = stageDraft(target, handle, [{ name: "source.txt", path: "/never-read-draft-source" }]);
    assert.equal(result.staged.length, 0); assert.equal(result.errors.length, 1);
    assert.match(result.errors[0]!, /draft|authoriz|capabilit/i);
  }
  assert.equal(sourceReads, 0);
});

test("legacy unbound staging remains sendable but cannot be rebound by recovery", () => {
  const root = path.join(tmpdir(), "attachments");
  const old = new AttachmentStore(root);
  const files = stagedPair(old);
  const manifest = path.join(root, ".manifest.json");
  const value = JSON.parse(fs.readFileSync(manifest, "utf8")); value.version = 1;
  fs.writeFileSync(manifest, JSON.stringify(value));
  const original = fs.readFileSync(manifest);
  const fresh = ownedStore(root);
  assert.equal(validateRecovery(fresh, files[0]!, projectOwner()), false);
  assert.deepEqual(fs.readFileSync(manifest), original);
  assert.equal(fresh.claim("thread-1", files).length, 2);
});

test("bound staging requires its draft and an explicitly authorized project transfer", () => {
  const store = ownedStore(path.join(tmpdir(), "attachments"), () => true, (_owner, thread) => thread === "thread-1");
  const draft = mintDraft(store, projectOwner());
  const files = stageDraft(store, draft).staged;
  assert.throws(() => store.discard(files.map(file => file.id)), /draft|authoriz|capabilit/i);
  assert.throws(() => store.claim("thread-1", files), /draft|authoriz|capabilit/i);
  assert.throws(() => Reflect.apply(store.claim, store, ["thread-1", files, { draft }]), /transfer/i);
  assert.throws(() => store.mintTransfer(draft, "thread-2"), /authoriz|transfer/i);
  const transfer = store.mintTransfer(draft, "thread-1");
  const claimed = Reflect.apply(store.claim, store, ["thread-1", files, { draft, transfer }]) as Attachment[];
  assert.equal(validateRecovery(store, claimed[0]!, { kind: "thread", threadId: "thread-1" }), true);
  assert.equal(validateRecovery(store, claimed[0]!, projectOwner()), false);
});

test("thread draft claim and discard require the exact authorized context", () => {
  const store = ownedStore(path.join(tmpdir(), "attachments"));
  const context: TestOwner = { kind: "thread", threadId: "thread-1" };
  const draft = mintDraft(store, context);
  const foreign = mintDraft(store, { kind: "thread", threadId: "thread-2" });
  const [first, second] = stageDraft(store, draft, [{ name: "a.txt", data: "YQ==" }, { name: "b.txt", data: "Yg==" }]).staged;
  assert.throws(() => Reflect.apply(store.discard, store, [[first!.id], { draft: foreign }]), /draft|owner|authoriz/i);
  Reflect.apply(store.discard, store, [[first!.id], { draft }]);
  assert.equal(fs.existsSync(path.join(store.root, first!.rel)), false);
  const claimed = Reflect.apply(store.claim, store, ["thread-1", [second], { draft }]) as Attachment[];
  assert.equal(validateRecovery(store, claimed[0]!, context), true);
});

for (const ambiguous of [false, true]) {
  test(`retention ${ambiguous ? "refuses differing" : "deduplicates matching"} authoritative identities`, () => {
    const store = new AttachmentStore(path.join(tmpdir(), "attachments"));
    const files = stagedPair(store);
    const manifest = path.join(store.root, ".manifest.json");
    const value = JSON.parse(fs.readFileSync(manifest, "utf8"));
    const duplicate = structuredClone(value.files[0]);
    if (ambiguous) duplicate.identity.ino++;
    value.retired.push(duplicate);
    fs.writeFileSync(manifest, JSON.stringify(value));
    const fresh = new AttachmentStore(store.root);
    assert.equal(protectRecovery(fresh, [files[0]!]), !ambiguous);
    assert.equal(fresh.sweepStaging(-1), ambiguous ? 0 : 1);
    assert.ok(fs.existsSync(path.join(store.root, files[0]!.rel)));
    assert.equal(fs.existsSync(path.join(store.root, files[1]!.rel)), ambiguous);
  });
}

test("draft authorization refuses truthy asynchronous results and reentrant mutations", () => {
  for (const answer of [undefined, {}, Promise.resolve(true)]) {
    const store = ownedStore(path.join(tmpdir(), "attachments"), (() => answer) as () => boolean);
    assert.throws(() => mintDraft(store, projectOwner()), /authoriz/i);
  }
  let nested = false;
  const store = ownedStore(path.join(tmpdir(), "attachments"), () => {
    if (nested) assert.equal(store.stage([{ name: "unauthorized.txt", data: "YQ==" }]).staged.length, 0);
    return true;
  });
  const draft = mintDraft(store, projectOwner());
  nested = true;
  const result = stageDraft(store, draft);
  assert.equal(result.staged.length, 0); assert.match(result.errors[0]!, /authoriz/i);
  assert.deepEqual(fs.readdirSync(store.staging), []);
});

test("live authority is rechecked before publication and cannot replace a writer's manifest", () => {
  let checks = 0;
  const store = ownedStore(path.join(tmpdir(), "attachments"), () => ++checks < 3);
  const draft = mintDraft(store, projectOwner());
  const result = stageDraft(store, draft);
  assert.equal(result.staged.length, 0); assert.equal(result.errors.length, 1);
  assert.deepEqual(fs.readdirSync(store.staging), []);
  let replace = false;
  const root = path.join(tmpdir(), "attachments");
  const racing = ownedStore(root, () => {
    if (replace) {
      new AttachmentStore(root).stage([{ name: "new-writer.txt", data: "Yg==" }]);
      replace = false;
    }
    return true;
  });
  const handle = mintDraft(racing, projectOwner());
  replace = true;
  assert.equal(stageDraft(racing, handle).staged.length, 0);
  assert.equal(fs.readdirSync(racing.staging).length, 1, "the other writer's file survives");
});

test("a failed project claim preserves draft bindings across restart and transfer retry", t => {
  const root = path.join(tmpdir(), "attachments");
  const store = ownedStore(root); const draft = mintDraft(store, projectOwner());
  const files = stageDraft(store, draft).staged;
  const transfer = store.mintTransfer(draft, "thread-1");
  const rename = fs.renameSync;
  const fault = t.mock.method(fs, "renameSync", (...args: Parameters<typeof fs.renameSync>) => {
    if (String(args[1]).endsWith(".manifest.json")) {
      const value = JSON.parse(fs.readFileSync(args[0], "utf8"));
      if (value.files.some((file: { attachment: Attachment }) => file.attachment.rel.startsWith("thread-1/"))) throw new Error("final owner commit refused");
    }
    return Reflect.apply(rename, fs, args);
  });
  assert.throws(() => Reflect.apply(store.claim, store, ["thread-1", files, { draft, transfer }]), /final owner commit refused/);
  fault.mock.restore();
  const fresh = ownedStore(root); const nextDraft = mintDraft(fresh, projectOwner());
  assert.equal(validateRecovery(fresh, files[0]!, projectOwner()), true);
  const nextTransfer = fresh.mintTransfer(nextDraft, "thread-1");
  const result = Reflect.apply(fresh.claim, fresh, ["thread-1", files, { draft: nextDraft, transfer: nextTransfer }]) as Attachment[];
  assert.equal(validateRecovery(fresh, result[0]!, { kind: "thread", threadId: "thread-1" }), true);
});

test("draft contexts reject inherited fields and non-data properties before authorization", () => {
  let authorizations = 0;
  const store = ownedStore(path.join(tmpdir(), "attachments"), () => { authorizations++; return true; });
  const inherited = Object.assign(Object.create({ kind: "thread", threadId: "thread-1" }), { extra: true, another: true });
  assert.throws(() => mintDraft(store, inherited), /draft/i);
  const getter = { kind: "thread", get threadId(): string { throw new Error("getter evaluated"); } } as TestOwner;
  assert.throws(() => mintDraft(store, getter), /draft/i);
  assert.equal(authorizations, 0);
});

test("unsupported manifest fields and ambiguous active ownership fail without rewriting evidence", () => {
  const root = path.join(tmpdir(), "attachments");
  const store = ownedStore(root); stageDraft(store, mintDraft(store, projectOwner()));
  const manifest = path.join(root, ".manifest.json");
  const original = JSON.parse(fs.readFileSync(manifest, "utf8"));
  const invalid = [
    { ...original, version: 99 },
    { ...original, extra: true },
    { ...original, version: 1 },
    { ...original, files: [...original.files, original.files[0]] },
    { ...original, files: [{ ...original.files[0], owner: { ...projectOwner(), extra: true } }] },
  ];
  for (const value of invalid) {
    const bytes = JSON.stringify(value); fs.writeFileSync(manifest, bytes);
    assert.throws(() => ownedStore(root), /manifest|metadata|draft/i);
    assert.equal(fs.readFileSync(manifest, "utf8"), bytes);
  }
});

// Durable replay compares this captured proof, not just the restored path/metadata.
test("attachment fingerprints preserve ownership and detect same-size content changes", () => {
  const store = ownedStore(path.join(tmpdir(), "attachments"));
  const owner = projectOwner();
  const file = stageDraft(store, mintDraft(store, owner)).staged[0]!;
  const manifest = fs.readFileSync(path.join(store.root, ".manifest.json"));
  const before = store.fingerprint(file, owner);
  assert.equal(before.sha256, "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb");
  assert.equal(before.size, 1);
  assert.ok(Object.isFrozen(before));
  assert.throws(() => { (before as { sha256: string }).sha256 = "forged"; }, TypeError);
  assert.deepEqual(ownedStore(store.root).fingerprint(file, owner), before);
  fs.writeFileSync(path.join(store.root, file.rel), "b");
  const changed = store.fingerprint(file, owner);
  assert.equal(changed.ino, before.ino);
  assert.equal(changed.size, before.size);
  assert.notEqual(changed.sha256, before.sha256);
  assert.deepEqual(fs.readFileSync(path.join(store.root, ".manifest.json")), manifest);
});

test("fingerprints refuse wrong owners, unbound staging, and invalid sizes", () => {
  const store = ownedStore(path.join(tmpdir(), "attachments"));
  const owner = projectOwner();
  const file = stageDraft(store, mintDraft(store, owner)).staged[0]!;
  assert.throws(() => store.fingerprint(file, { kind: "thread", threadId: "thread-1" }), /ownership/i);
  const unbound = store.stage([{ name: "legacy.txt", data: "YQ==" }]).staged[0]!;
  assert.throws(() => store.fingerprint(unbound, owner), /ownership/i);
  for (const size of [-1, 0.5, NaN, Infinity, LIMITS.fileBytes + 1]) {
    assert.throws(() => store.fingerprint({ ...file, size }, owner), /ownership/i);
  }
});

for (const fault of ["missing", "replacement", "symlink", "oversize"] as const) {
  test(`fingerprints reject ${fault} without changing evidence`, () => {
    const store = ownedStore(path.join(tmpdir(), "attachments"));
    const owner = projectOwner();
    const file = stageDraft(store, mintDraft(store, owner)).staged[0]!;
    const target = path.join(store.root, file.rel);
    const manifest = fs.readFileSync(path.join(store.root, ".manifest.json"));
    if (fault === "oversize") fs.truncateSync(target, LIMITS.fileBytes + 1);
    else {
      fs.renameSync(target, target + ".original");
      if (fault === "replacement") fs.writeFileSync(target, "b");
      if (fault === "symlink") fs.symlinkSync(target + ".original", target);
    }
    assert.throws(() => store.fingerprint(file, owner), /attachment/i);
    assert.deepEqual(fs.readFileSync(path.join(store.root, ".manifest.json")), manifest);
    if (fault !== "oversize") assert.equal(fs.readFileSync(target + ".original", "utf8"), "a");
  });
}

for (const fault of ["same-size", "growth", "replacement"] as const) {
  test(`fingerprints reject ${fault} mutation during the bounded read and close the descriptor`, () => {
    const store = ownedStore(path.join(tmpdir(), "attachments"));
    const owner = projectOwner();
    const file = stageDraft(store, mintDraft(store, owner)).staged[0]!;
    const target = path.join(store.root, file.rel);
    const read = fs.readSync;
    let observed: number | undefined;
    fs.readSync = ((...args: Parameters<typeof fs.readSync>) => {
      const count = Reflect.apply(read, fs, args) as number;
      if (observed === undefined) {
        observed = args[0];
        if (fault === "replacement") { fs.renameSync(target, target + ".original"); fs.writeFileSync(target, "b"); }
        else {
          fs.writeFileSync(target, fault === "growth" ? "bb" : "b");
          // Deterministic metadata change even on filesystems with coarse clocks.
          fs.utimesSync(target, new Date(0), new Date(0));
        }
      }
      return count;
    }) as typeof fs.readSync;
    try { assert.throws(() => store.fingerprint(file, owner), /attachment/i); }
    finally { fs.readSync = read; }
    assert.notEqual(observed, undefined);
    assert.throws(() => fs.fstatSync(observed!), { code: "EBADF" });
  });
}
