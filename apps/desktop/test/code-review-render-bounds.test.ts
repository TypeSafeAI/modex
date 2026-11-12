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

test("real use: bot comments made of raw HTML are shown as their text, and code and look-alikes are untouched", async () => {
  const { readableRemoteText } = await import("../src/renderer/code-review/remote-text.js");
  // As Vercel's and Copilot's comments arrive (shapes from real pull requests; the text here is made up).
  const vercel = '<a href="https://vercel.example/team/app"><sup><img src="https://vercel.example/avatar?s=32" width="16" height="16" align="middle" alt="" /></sup></a> app | ![Ready](https://vercel.example/ready.svg) Ready | <relative-time datetime="2026-11-04T01:35:44.438Z">Nov 4, 2026 1:35am UTC</relative-time>';
  assert.equal(readableRemoteText(vercel), " app | ![Ready](https://vercel.example/ready.svg) Ready | Nov 4, 2026 1:35am UTC");
  const copilot = '<picture><source media="(prefers-color-scheme: dark)" srcset="https://example.test/dark.svg"><img src="https://example.test/light.png" alt="Medium severity" width="62" height="18" align="texttop"></picture> Contrast gate omits text runs';
  assert.equal(readableRemoteText(copilot), "Image: Medium severity Contrast gate omits text runs");
  assert.equal(readableRemoteText("before<!-- hidden\nnote -->after<br>next<br/>last"), "before\nafter\nnext\nlast");
  assert.equal(readableRemoteText("<details><summary>Why</summary>Because <b>this</b>.</details>"), "\n\nWhy\nBecause this.\n");
  // Nothing that is code, and nothing that only looks like a tag, changes.
  const code = "Use `<img alt=\"x\">` or:\n```html\n<a href=\"https://example.test\">link</a>\n```\nand ~~~\n";
  assert.equal(readableRemoteText(code), code);
  for (const same of ["Array<string> and Map<K, V>", "a < b > c", "x <notatag> y", "<custom-element>kept</custom-element>", "no markup at all", "5 <3 and 2> 1"]) assert.equal(readableRemoteText(same), same);
  // A hidden destination never survives as a link: only the visible text does.
  const cleaned = readableRemoteText('<a href="https://evil.example/login">https://github.com/safe</a>');
  assert.equal(cleaned, "https://github.com/safe");
  assert.ok(!readableRemoteText('<img src="https://tracker.example/pixel.gif" alt="">').includes("tracker.example"), "an image address is never kept");
  // Attributes may hold a '>' inside quotes; an unterminated tag is left as written.
  assert.equal(readableRemoteText('<a title="a > b" href="x">t</a>'), "t");
  assert.equal(readableRemoteText("<a href=\"x\" t"), "<a href=\"x\" t");
  // Hostile shapes cost their own length: a tag that never closes, and many openers in a row.
  for (const hostile of [`<A${" ".repeat(150_000)}`, "<a ".repeat(60_000), `<img alt=${"alt=".repeat(40_000)}`, `x<!--${"<!--".repeat(40_000)}`]) {
    const started = performance.now();
    assert.equal(typeof readableRemoteText(hostile), "string");
    assert.ok(performance.now() - started < 500, `scanned ${hostile.length} characters in under half a second`);
  }
  assert.equal(readableRemoteText("a<!-- x --><!-- y -->b<!-"), "ab<!-", "comments go; a lone opener stays text");
  const huge = "<b>x</b>".repeat(30_000);
  assert.equal(readableRemoteText(huge), huge, "text past the limit is shown as written rather than scanned");
});
