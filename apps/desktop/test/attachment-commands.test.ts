import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { registerCommands, type RegisterCommand } from "../src/main/commands.js";
import { Store } from "../src/main/engine/store.js";
import type { ThreadRunner } from "../src/main/engine/runner.js";
import type { TerminalManager } from "../src/main/engine/terminal.js";
import { AttachmentStore } from "../src/main/engine/attachments.js";
import { tmpdir } from "./helpers.js";

test("shared send command forwards the exact attachment list to the runner", async () => {
  const home = tmpdir(); const store = new Store(home);
  const handlers = new Map<string, (payload: any) => any>();
  let args: unknown[] = [];
  const runner = { send: async (...input: unknown[]) => { args = input; }, attachments: new AttachmentStore(path.join(home, "attachments")) } as unknown as ThreadRunner;
  registerCommands(((channel, handler) => handlers.set(channel, handler)) as RegisterCommand, {
    store, runner, terminals: {} as TerminalManager, emit: () => {}, pickDirectory: async () => null,
    openPath: async () => {}, openTerminal: async () => {},
  });
  const files = runner.attachments.stage([{ name: "note.txt", data: "aGk=" }]).staged;
  assert.deepEqual(await handlers.get("thread:send")!({ threadId: "thread", text: "", attachments: files }), { ok: true });
  assert.equal(args[2], files);
  fs.rmSync(home, { recursive: true, force: true });
});

test("thumbnail reads reject swapped files and directories and never serve executable kinds", () => {
  const home = tmpdir(); const root = path.join(home, "attachments"); const store = new AttachmentStore(root);
  const read = (rel: string) => store.readImage(rel);
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
  const stage = (name: string, data = png, mime?: string) => store.stage([{ name, data: data.toString("base64"), mime }]).staged[0]!;
  const image = stage("a.png");
  assert.deepEqual(read(image.rel)?.data, png);
  assert.equal(read(stage("a.svg", Buffer.from("<svg/>")).rel), null);
  assert.equal(read(stage("fake.sh", Buffer.from("#!/bin/sh\necho hello"), "image/png").rel), null);
  const abs = path.join(root, image.rel); const external = path.join(home, "external.png"); fs.writeFileSync(external, png);
  fs.renameSync(abs, `${abs}.old`); fs.symlinkSync(external, abs); assert.equal(read(image.rel), null);
  fs.unlinkSync(abs); fs.renameSync(`${abs}.old`, abs);
  const directory = path.join(root, "staging"); fs.renameSync(directory, `${directory}.old`); fs.symlinkSync(`${directory}.old`, directory); assert.equal(read(image.rel), null);
  fs.unlinkSync(directory); fs.renameSync(`${directory}.old`, directory);
  fs.renameSync(root, `${root}.old`); fs.symlinkSync(`${root}.old`, root); assert.equal(read(image.rel), null);
  fs.rmSync(home, { recursive: true, force: true });
});

test("attachment commands reveal every type through store resolution and refuse arbitrary paths", async () => {
  const { registerAttachmentCommands } = await import("../src/main/attachment-commands.js");
  const { attachmentRevealCommand } = await import("../src/main/reveal-attachment.js");
  const home = tmpdir(); const store = new AttachmentStore(path.join(home, "attachments"));
  const handlers = new Map<string, (payload: any) => any>(); const revealed: string[] = [];
  registerAttachmentCommands(((channel, handler) => handlers.set(channel, handler)) as RegisterCommand, store, { bytesOnly: true, reveal: file => { revealed.push(file); } });
  for (const mime of ["text/x-shellscript", "image/png", "image/jpeg", "image/gif", "image/webp"]) {
    const attachment = store.stage([{ name: "run.sh", mime, data: Buffer.from("#!/bin/sh\necho wrong").toString("base64") }]).staged[0]!;
    await handlers.get("attachments:open")!({ rel: attachment.rel });
    assert.equal(revealed.at(-1), store.resolve(attachment.rel));
    const file = store.resolve(attachment.rel)!;
    assert.deepEqual(attachmentRevealCommand(file, "darwin"), ["open", ["-R", file]]);
    assert.deepEqual(attachmentRevealCommand(file, "win32"), ["explorer.exe", [`/select,${file}`]]);
    assert.deepEqual(attachmentRevealCommand(file, "linux"), ["xdg-open", [path.dirname(file)]]);
  }
  for (const rel of ["/bin/sh", "../secret", "staging/../secret", null]) await assert.rejects(handlers.get("attachments:open")!({ rel }), /no longer on disk/);
  assert.equal(revealed.length, 5);
  fs.rmSync(home, { recursive: true, force: true });
});

test("an attachment whose file was deleted cannot be opened, and nothing is revealed", async () => {
  const { registerAttachmentCommands } = await import("../src/main/attachment-commands.js");
  const home = tmpdir(); const store = new AttachmentStore(path.join(home, "attachments"));
  const handlers = new Map<string, (payload: any) => any>(); const revealed: string[] = [];
  registerAttachmentCommands(((channel, handler) => handlers.set(channel, handler)) as RegisterCommand, store, { bytesOnly: true, reveal: file => { revealed.push(file); } });
  const attachment = store.stage([{ name: "notes.txt", mime: "text/plain", data: Buffer.from("kept for later").toString("base64") }]).staged[0]!;
  fs.rmSync(store.resolve(attachment.rel)!);
  await assert.rejects(handlers.get("attachments:open")!({ rel: attachment.rel }), /no longer on disk/);
  assert.deepEqual(revealed, []);
  fs.rmSync(home, { recursive: true, force: true });
});

test("thumbnail descriptor revalidation rejects a file replaced during the read", () => {
  const home = tmpdir(); const store = new AttachmentStore(path.join(home, "attachments"));
  const data = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
  const image = store.stage([{ name: "a.png", data: data.toString("base64") }]).staged[0]!;
  const abs = store.resolve(image.rel)!; const original = fs.readSync;
  fs.readSync = ((...args: Parameters<typeof original>) => {
    fs.readSync = original;
    const n = Reflect.apply(original, fs, args);
    fs.renameSync(abs, `${abs}.old`); fs.writeFileSync(abs, data);
    return n;
  }) as typeof original;
  try { assert.equal(store.readImage(image.rel), null); }
  finally { fs.readSync = original; fs.rmSync(home, { recursive: true, force: true }); }
});
