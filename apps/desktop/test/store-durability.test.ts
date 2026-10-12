import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { Store } from "../src/main/engine/store.js";
import type { Thread, ThreadItem } from "../src/shared/types.js";

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "modex-store-durability-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "new", "nested", "home");
  const store = new Store(home), project = store.addProject(root);
  const thread: Thread = { id: "thread-1", projectId: project.id, title: "New thread", createdAt: "2026-10-11T00:00:00.000Z",
    updatedAt: "2026-10-11T00:00:00.000Z", cwd: root, backend: "mock", mode: "agent", plan: false, model: "mock", status: "idle" };
  const user: ThreadItem = { id: "stable-user-1", kind: "user", text: "  original raw text\n\t😀  ", at: thread.createdAt };
  return { root, home, store, thread, user, stateFile: path.join(store.dir, "state.json"), itemsFile: path.join(store.dir, "threads", "thread-1.json") };
}

test("a fresh nested home checkpoint syncs every directory ancestor before strong admission", { skip: process.platform === "win32" }, t => {
  const h = fixture(t); h.store.addThread(h.thread);
  const sync = fs.fsyncSync, synced = new Set<string>();
  fs.fsyncSync = fd => { const s = fs.fstatSync(fd); if (s.isDirectory()) synced.add(`${s.dev}:${s.ino}`); sync(fd); };
  let checkpoint: Readonly<Thread>;
  try { checkpoint = h.store.checkpointThread(h.thread.id); }
  finally { fs.fsyncSync = sync; }
  assert.ok(Object.isFrozen(checkpoint!));
  assert.deepEqual(checkpoint!, h.thread);
  let directory = fs.realpathSync(path.dirname(h.itemsFile));
  while (true) {
    const s = fs.statSync(directory); assert.ok(synced.has(`${s.dev}:${s.ino}`), directory);
    const parent = path.dirname(directory); if (directory === parent) break; directory = parent;
  }
  assert.deepEqual(new Store(h.home).thread(h.thread.id), h.thread);
});

test("an existing legacy state gets an explicit checkpoint and later transcript replacements preserve the admitted message", { skip: process.platform === "win32" }, t => {
  const h = fixture(t); h.store.addThread(h.thread);
  // Prior versions used ordinary writes without the new durability boundary.
  fs.writeFileSync(h.stateFile, JSON.stringify(h.store.snapshot()));
  const reopened = new Store(h.home); reopened.checkpointThread(h.thread.id);
  const items: ThreadItem[] = [h.user];
  for (let i = 0; i < 3; i++) {
    reopened.saveItems(h.thread.id, items);
    assert.deepEqual(new Store(h.home).items(h.thread.id), items);
    assert.equal(fs.statSync(h.itemsFile).mode & 0o777, 0o600);
    items.push({ id: `assistant-${i}`, kind: "assistant", text: `reply ${i}`, at: h.thread.createdAt });
  }
});

for (const phase of ["file-sync", "rename", "parent-sync", "file-close", "parent-close"] as const) {
  test(`${phase} failure preserves transcript evidence and prevents further writes`, { skip: process.platform === "win32" }, t => {
    const h = fixture(t); h.store.addThread(h.thread); h.store.saveItems(h.thread.id, [h.user]);
    const before = fs.readFileSync(h.itemsFile), candidate: ThreadItem[] = [h.user, { id: "reply", kind: "assistant", text: "new reply", at: h.thread.createdAt }];
    const sync = fs.fsyncSync, rename = fs.renameSync, close = fs.closeSync, open = fs.openSync;
    const opened = new Set<number>(); let injected = false;
    fs.openSync = ((...args: Parameters<typeof fs.openSync>) => { const fd = Reflect.apply(open, fs, args) as number; opened.add(fd); return fd; }) as typeof fs.openSync;
    fs.fsyncSync = fd => {
      const directory = fs.fstatSync(fd).isDirectory();
      if (!injected && ((phase === "file-sync" && !directory) || (phase === "parent-sync" && directory))) { injected = true; throw new Error(`injected ${phase}`); }
      sync(fd);
    };
    fs.renameSync = (from, to) => { if (!injected && phase === "rename") { injected = true; throw new Error("injected rename"); } rename(from, to); };
    fs.closeSync = fd => {
      let directory = false;
      try { directory = fs.fstatSync(fd).isDirectory(); } catch { /* A failed close may already have closed its fd. */ }
      close(fd);
      if (!injected && ((phase === "file-close" && !directory) || (phase === "parent-close" && directory))) { injected = true; throw new Error(`injected ${phase}`); }
    };
    try { assert.throws(() => h.store.saveItems(h.thread.id, candidate)); }
    finally { fs.openSync = open; fs.fsyncSync = sync; fs.renameSync = rename; fs.closeSync = close; }
    assert.equal(injected, true);
    for (const fd of opened) assert.throws(() => fs.fstatSync(fd), { code: "EBADF" }, `descriptor ${fd} leaked`);
    assert.equal(h.store.supportsDurableAdmission, false);
    assert.throws(() => h.store.saveItems(h.thread.id, []), /recovery/i);
    const afterRename = phase === "parent-sync" || phase === "parent-close";
    if (afterRename) assert.deepEqual(JSON.parse(fs.readFileSync(h.itemsFile, "utf8")), candidate);
    else {
      assert.deepEqual(fs.readFileSync(h.itemsFile), before);
      const temporaries = fs.readdirSync(path.dirname(h.itemsFile)).filter(name => name.endsWith(".tmp"));
      assert.equal(temporaries.length, 1, "preserve the attempted candidate for recovery");
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(path.dirname(h.itemsFile), temporaries[0]!), "utf8")), candidate);
    }
  });
}

for (const operation of ["add", "update"] as const) {
  for (const phase of ["file-sync", "parent-sync"] as const) {
    test(`failed ${operation} thread ${phase} never publishes a phantom in-memory mutation`, { skip: process.platform === "win32" }, t => {
      const h = fixture(t); if (operation === "update") h.store.addThread(h.thread);
      const before = h.store.snapshot(), sync = fs.fsyncSync;
      fs.fsyncSync = fd => { if (fs.fstatSync(fd).isDirectory() === (phase === "parent-sync")) throw new Error("injected sync"); sync(fd); };
      try { assert.throws(() => operation === "add" ? h.store.addThread(h.thread) : h.store.updateThread(h.thread.id, { title: "changed" })); }
      finally { fs.fsyncSync = sync; }
      assert.deepEqual(h.store.snapshot(), before);
      assert.equal(h.store.supportsDurableAdmission, false);
      const onDisk = new Store(h.home).thread(h.thread.id);
      if (phase === "parent-sync") assert.equal(onDisk?.title, operation === "add" ? "New thread" : "changed");
      else assert.deepEqual(onDisk, operation === "add" ? undefined : h.thread);
    });
  }
}

for (const fault of ["file-symlink", "directory-symlink", "directory-replaced", "file-replaced-during-write"] as const) {
  test(`atomic transcript replacement refuses ${fault} and preserves foreign bytes`, { skip: process.platform === "win32" }, t => {
    const h = fixture(t); h.store.addThread(h.thread); h.store.saveItems(h.thread.id, [h.user]);
    const outside = path.join(h.root, "outside"); fs.mkdirSync(outside);
    const foreign = path.join(outside, "thread-1.json"); fs.writeFileSync(foreign, "foreign bytes");
    const original = fs.readFileSync(h.itemsFile), sync = fs.fsyncSync;
    if (fault === "file-symlink") { fs.renameSync(h.itemsFile, h.itemsFile + ".preserved"); fs.symlinkSync(foreign, h.itemsFile); }
    if (fault.startsWith("directory-")) {
      const directory = path.dirname(h.itemsFile); fs.renameSync(directory, directory + ".preserved");
      if (fault === "directory-symlink") fs.symlinkSync(outside, directory);
      else { fs.mkdirSync(directory); fs.writeFileSync(h.itemsFile, "replacement bytes"); }
    }
    let replaced = false;
    if (fault === "file-replaced-during-write") fs.fsyncSync = fd => {
      sync(fd);
      if (!replaced && fs.fstatSync(fd).isFile()) {
        replaced = true; fs.renameSync(h.itemsFile, h.itemsFile + ".preserved"); fs.writeFileSync(h.itemsFile, "replacement bytes");
      }
    };
    try { assert.throws(() => h.store.saveItems(h.thread.id, []), /storage/i); }
    finally { fs.fsyncSync = sync; }
    assert.equal(fs.readFileSync(foreign, "utf8"), "foreign bytes");
    const preserved = fault.startsWith("directory-") ? path.join(path.dirname(h.itemsFile) + ".preserved", "thread-1.json") : h.itemsFile + ".preserved";
    assert.deepEqual(fs.readFileSync(preserved), original);
    if (fault.includes("replaced")) assert.equal(fs.readFileSync(h.itemsFile, "utf8"), "replacement bytes");
  });
}

test("a failed ancestor sync refuses a strong admission and preserves the target", { skip: process.platform === "win32" }, t => {
  const h = fixture(t); h.store.addThread(h.thread);
  const home = fs.statSync(h.home), sync = fs.fsyncSync;
  fs.fsyncSync = fd => { const s = fs.fstatSync(fd); if (s.dev === home.dev && s.ino === home.ino) throw new Error("injected ancestor sync"); sync(fd); };
  try { assert.throws(() => h.store.checkpointThread(h.thread.id), /ancestor/i); }
  finally { fs.fsyncSync = sync; }
  assert.equal(h.store.supportsDurableAdmission, false);
  assert.deepEqual(new Store(h.home).thread(h.thread.id), h.thread);
});

test("Windows ordinary persistence works while strong native admission explicitly refuses", { skip: process.platform !== "win32" }, t => {
  const h = fixture(t); h.store.addThread(h.thread); h.store.saveItems(h.thread.id, [h.user]);
  assert.deepEqual(new Store(h.home).items(h.thread.id), [h.user]);
  assert.equal(h.store.supportsDurableAdmission, false);
  assert.throws(() => h.store.checkpointThread(h.thread.id), /unavailable/i);
  h.store.updateThread(h.thread.id, { title: "manual updates still work" });
  assert.equal(new Store(h.home).thread(h.thread.id)?.title, "manual updates still work");
});

for (const fault of ["unchanged", "candidate-created", "original-replaced"] as const) {
  test(`exclusive-open refusal with ${fault} state permits retry only when no write is proven`, t => {
    const h = fixture(t); h.store.addThread(h.thread); h.store.saveItems(h.thread.id, [h.user]);
    const before = fs.readFileSync(h.itemsFile), open = fs.openSync;
    let candidate: string | undefined;
    fs.openSync = ((...args: Parameters<typeof fs.openSync>) => {
      if (typeof args[0] === "string" && args[0].startsWith(h.itemsFile + ".") && args[0].endsWith(".tmp")) {
        candidate = args[0];
        if (fault === "candidate-created") { const fd = open(args[0], "wx", 0o600); fs.closeSync(fd); }
        if (fault === "original-replaced") { fs.renameSync(h.itemsFile, h.itemsFile + ".preserved"); fs.writeFileSync(h.itemsFile, "[]"); }
        throw Object.assign(new Error("injected exclusive-open refusal"), { code: "EACCES" });
      }
      return Reflect.apply(open, fs, args);
    }) as typeof fs.openSync;
    try { assert.throws(() => h.store.saveItems(h.thread.id, []), /exclusive-open/); }
    finally { fs.openSync = open; }
    assert.ok(candidate);
    if (fault === "unchanged") {
      assert.deepEqual(fs.readFileSync(h.itemsFile), before);
      assert.equal(fs.existsSync(candidate), false);
      h.store.saveItems(h.thread.id, [h.user]);
      assert.deepEqual(new Store(h.home).items(h.thread.id), [h.user]);
    } else {
      assert.equal(h.store.supportsDurableAdmission, false);
      assert.throws(() => h.store.saveItems(h.thread.id, [h.user]), /recovery/i);
      if (fault === "candidate-created") { assert.equal(fs.statSync(candidate).size, 0); assert.deepEqual(fs.readFileSync(h.itemsFile), before); }
      else { assert.equal(fs.readFileSync(h.itemsFile, "utf8"), "[]"); assert.deepEqual(fs.readFileSync(h.itemsFile + ".preserved"), before); }
    }
  });
}
