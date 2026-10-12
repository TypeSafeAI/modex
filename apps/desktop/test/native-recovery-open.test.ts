import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { test, type TestContext } from "node:test";
import { UpdateRecovery } from "../src/main/engine/update-recovery.js";
import { readUpdateStartup } from "../src/main/engine/update-startup.js";

function fixture(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "modex-readonly-open-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const recovery = new UpdateRecovery(dir);
  const drafts = { threads: [], projects: [{ key: "draft:0:p", projectId: "p", text: "  saved raw  ", attachments: [] }],
    draft: { revision: 0, projectId: "p", worktree: false, settings: { backend: "mock" as const, mode: "chat" as const, model: "mock", plan: false, auto: false } }, selectedThreadId: null };
  recovery.saveDrafts(drafts);
  const handlers = new Map<string, Function>(), frame = {}, counts = { opened: 0, swept: 0, read: 0 };
  const context: any = { nativeDraftFailure: undefined, nativeStartup: { drafts, recovery: null }, restartCoordinator: undefined, servicesTouched: false,
    nativeDocument: undefined, readOnlyDocument: undefined, documentEpoch: 1, store: { dir }, app: { getVersion: () => "0.0.10" },
    UpdateRecovery, readUpdateStartup, isTrustedTerminalSender: () => true, win: {},
    attachments: { sweepStaging: () => { counts.swept++; } },
    nativeDrafts: { recovery, invalidate: () => {},
      readOnly: () => { counts.read++; return { drafts, pending: [{ id: "original", rawText: "  pending raw  ", files: [] }] }; },
      open: () => { counts.opened++; return { session: "editing", drafts, pendingIds: [] }; } },
    handle: (name: string, fn: Function) => handlers.set(name, fn) };
  const code = fs.readFileSync(path.resolve(import.meta.dirname, "../src/main/index.js"), "utf8");
  const helperStart = code.indexOf("function currentDraftRecovery("), start = code.indexOf('handle("drafts:open",');
  const end = code.indexOf('handle("drafts:save",', start);
  assert.ok(start >= 0 && end > start);
  vm.createContext(context);
  if (helperStart >= 0) vm.runInContext(code.slice(helperStart, code.indexOf("// Explicitly local-only", helperStart)), context);
  vm.runInContext(code.slice(start, end), context);
  return { context, counts, recovery, drafts, dir, frame, open: () => handlers.get("drafts:open")!(undefined, { senderFrame: frame }) };
}

test("main opens interrupted update recovery without granting or resetting native editing", t => {
  const h = fixture(t);
  h.recovery.beginAttempt({ from: "0.0.10", to: "0.0.11", sha512: Buffer.alloc(64, 1).toString("base64"), revision: 1 });
  h.context.nativeStartup = readUpdateStartup(h.recovery, "0.0.10");
  const file = path.join(h.dir, "update-recovery.json"), before = fs.readFileSync(file);
  const result = h.open();
  assert.equal(result.readOnly, true); assert.equal(result.session, undefined);
  assert.deepEqual(result.drafts, h.drafts); assert.equal(result.pending[0].rawText, "  pending raw  ");
  assert.equal(result.recovery.outcome, "uncertain"); assert.equal(h.context.nativeDocument, undefined);
  assert.equal(h.context.readOnlyDocument.frame, h.frame);
  assert.deepEqual(h.counts, { opened: 0, swept: 0, read: 1 }); assert.deepEqual(fs.readFileSync(file), before);
});

test("main re-evaluates post-drain phase for a replacement renderer", t => {
  const h = fixture(t);
  h.context.restartCoordinator = { state: "recovery" };
  const result = h.open();
  assert.equal(result.readOnly, true); assert.equal(result.recovery.outcome, "recovery");
  assert.deepEqual(h.counts, { opened: 0, swept: 0, read: 1 });
});

test("ordinary Quit disposal permanently fences a replacement renderer even without an updater", t => {
  const h = fixture(t); h.context.servicesTouched = true;
  const result = h.open();
  assert.equal(result.readOnly, true); assert.equal(result.recovery.outcome, "recovery");
  assert.deepEqual(h.counts, { opened: 0, swept: 0, read: 1 });
  h.context.nativeDrafts = undefined;
  const withoutNative = h.open();
  assert.equal(withoutNative.readOnly, true); assert.equal(withoutNative.recovery.outcome, "recovery");
});

test("failed native startup still exposes preserved drafts read-only and preserves corrupt evidence", t => {
  const h = fixture(t);
  h.context.nativeDrafts = undefined; h.context.nativeDraftFailure = "Pending recovery could not be read.";
  const result = h.open();
  assert.equal(result.readOnly, true); assert.deepEqual(JSON.parse(JSON.stringify(result.drafts)), h.drafts);
  assert.equal(result.recovery.outcome, "unreadable"); assert.equal(result.session, undefined);
  const file = path.join(h.dir, "update-recovery.json"); fs.writeFileSync(file, "unsupported bytes");
  const corrupt = h.open(); assert.equal(corrupt.readOnly, true); assert.equal(corrupt.drafts, null);
  assert.equal(fs.readFileSync(file, "utf8"), "unsupported bytes"); assert.deepEqual(h.counts, { opened: 0, swept: 0, read: 0 });
});

test("ordinary native open still owns an editing session", t => {
  const h = fixture(t), result = h.open();
  assert.equal(result.session, "editing"); assert.equal(result.readOnly, undefined);
  assert.equal(h.context.nativeDocument.frame, h.frame);
  assert.deepEqual(h.counts, { opened: 1, swept: 1, read: 0 });
});
