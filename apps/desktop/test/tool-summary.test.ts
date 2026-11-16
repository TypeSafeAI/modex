import { test } from "node:test";
import assert from "node:assert/strict";
import { toolFoldsAsWork, toolKind, toolStatusLabel, toolSummary, toolVerb } from "../src/shared/tool-summary.js";
import type { ThreadItem } from "../src/shared/types.js";
const tool = (patch: Partial<Extract<ThreadItem, { kind: "tool" }>>) => ({ id: "1", kind: "tool" as const, name: "tool", title: "", args: {}, status: "running" as const, at: "", ...patch });

test("tool summaries preserve meaningful titles and infer missing intent from structured arguments", () => {
  assert.equal(toolSummary(tool({ title: " $ git\n   status " })), "$ git status");
  assert.equal(toolSummary(tool({ name: "Bash", title: "Bash", args: { command: "npm\n test" } })), "$ npm test");
  assert.equal(toolSummary(tool({ name: "read_file", args: { file_path: "src/app.ts" } })), "read file src/app.ts");
  assert.equal(toolSummary(tool({ name: "repo.search", title: "repo.search", args: { query: "theme\n colors" } })), "repo.search · theme colors");
  assert.equal(toolSummary(tool({ name: "Agent", title: "Agent", args: { description: "Check colors" } })), "agent: Check colors");
  assert.equal(toolSummary(tool({ name: "tool", args: { unrelated: "never dump an object into the summary" } })), "tool");
});

test("a finished tool's status comes from its outcome; unknown and interrupted never read as Done", () => {
  const done = (patch: Partial<Extract<ThreadItem, { kind: "tool" }>>) => tool({ status: "done", ...patch });
  assert.deepEqual([
    toolStatusLabel(tool({})),
    toolStatusLabel(done({ outcome: "succeeded", ok: true })),
    toolStatusLabel(done({ outcome: "failed", ok: false })),
    toolStatusLabel(done({ outcome: "denied", ok: false })),
    toolStatusLabel(done({ outcome: "interrupted" })),
    toolStatusLabel(done({ outcome: "unknown" })),
  ], ["Working", "Done", "Failed", "Denied", "Stopped", "Status unavailable"]);
  // Items saved before outcomes existed read as they always did.
  assert.deepEqual([toolStatusLabel(done({ ok: true })), toolStatusLabel(done({})), toolStatusLabel(done({ ok: false }))], ["Done", "Done", "Failed"]);
  assert.equal(toolStatusLabel(done({ outcome: "succeeded", agent: { id: "a", label: "x", state: "stopped" } })), "Stopped", "an agent row reads its agent state");
});

test("only finished work that succeeded folds under the turn header; failed, denied, stopped and unknown work stays in view", () => {
  const done = (patch: Partial<Extract<ThreadItem, { kind: "tool" }>>) => tool({ status: "done", ...patch });
  assert.deepEqual(["succeeded", "unknown", "failed", "denied", "interrupted"].map((outcome) => toolFoldsAsWork(done({ outcome: outcome as "succeeded" }))), [true, false, false, false, false]);
  assert.equal(toolFoldsAsWork(tool({})), false, "running work stays in view");
  assert.deepEqual([toolFoldsAsWork(done({ ok: true })), toolFoldsAsWork(done({})), toolFoldsAsWork(done({ ok: false }))], [true, true, false]);
  assert.equal(toolFoldsAsWork(done({ outcome: "succeeded", agent: { id: "a", label: "x", state: "running" } })), false);
});

test("a row's kind follows the tool, and only a command line gets a verb", () => {
  assert.deepEqual([
    toolKind(tool({ name: "shell", args: { command: "git status" } })), toolKind(tool({ name: "Bash", title: "Bash", args: { command: "npm test" } })),
    toolKind(tool({ name: "apply_patch" })), toolKind(tool({ name: "Write", args: { file_path: "a.ts" } })), toolKind(tool({ name: "write_file", args: { path: "a.ts" } })),
    toolKind(tool({ name: "WebSearch" })), toolKind(tool({ name: "webSearch" })), toolKind(tool({ name: "WebFetch" })),
    toolKind(tool({ name: "Agent", args: { description: "x" } })), toolKind(tool({ name: "read_file", args: { file_path: "a.ts" } })), toolKind(tool({ name: "mystery" })),
  ], ["command", "command", "edit", "edit", "edit", "search", "search", "fetch", "agent", "file", "other"]);
  assert.equal(toolKind(tool({ name: "mystery", args: { command: "  " } })), "other", "a blank command is not a command");
  assert.equal(toolVerb(tool({ name: "shell", args: { command: "git status" } })), "Running");
  assert.equal(toolVerb(tool({ name: "shell", status: "done", args: { command: "git status" } })), "Ran");
  assert.equal(toolVerb(tool({ title: "$ git status", status: "done" })), "Ran");
  assert.equal(toolVerb(tool({ name: "Bash", title: "Run the tests", status: "done", args: { command: "npm test" } })), null, "a CLI title is already a phrase");
  assert.equal(toolVerb(tool({ name: "read_file", status: "done", args: { file_path: "a.ts" } })), null);
});
