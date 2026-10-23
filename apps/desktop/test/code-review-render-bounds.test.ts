import test from "node:test";
import assert from "node:assert/strict";
import { highlightRows, REMOTE_TEXT_LIMITS } from "../src/renderer/code-review/remote-highlight.js";

test("remote highlighting preserves dense source as plain text without allocating unbounded spans", () => {
  const dense = { text: "'x' ".repeat(100000) };
  const normal = { text: "const count = 42;" };
  const tokens = highlightRows([dense, normal]);
  assert.equal(tokens.has(dense), false);
  assert.equal(tokens.get(normal)?.join(""), normal.text);
});

test("a file-wide highlight budget caps token fragments across many hunks and keeps source exact", () => {
  const rows = Array.from({ length: 4000 }, () => ({ text: "const x = 'value';" }));
  const tokens = highlightRows(rows);
  assert.ok(tokens.size > 0 && tokens.size < rows.length);
  assert.ok([...tokens.values()].reduce((n, parts) => n + parts.length, 0) <= REMOTE_TEXT_LIMITS.tokens);
  for (const [row, parts] of tokens) assert.equal(parts.join(""), row.text);
});
