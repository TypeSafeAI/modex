import { test } from "node:test";
import assert from "node:assert/strict";
import { toolSummary } from "../src/shared/tool-summary.js";
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
