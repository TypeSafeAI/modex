import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import react from "@vitejs/plugin-react";
import { createServer, type ViteDevServer } from "vite";

// The transcript's Markdown (#277): CommonMark with GitHub's extensions, rendered as React elements only.
const appDir = fileURLToPath(new URL("../../", import.meta.url));
let server: ViteDevServer | undefined;
let Markdown: ComponentType<{ text: string }>;

async function render(text: string): Promise<string> {
  if (!server) {
    // Code blocks reach the clipboard through the bridge, which reads `window.modex` when it loads.
    Object.assign(globalThis, { window: { modex: { platform: "web", invoke: async () => {}, onEvent: () => () => {}, onTerminalEvent: () => () => {} } } });
    server = await createServer({ configFile: false, root: appDir, plugins: [react()], logLevel: "error", appType: "custom", server: { middlewareMode: true, hmr: false, ws: false } });
    ({ Markdown } = await server.ssrLoadModule("/src/renderer/components/Markdown.tsx") as { Markdown: ComponentType<{ text: string }> });
  }
  return renderToStaticMarkup(createElement(Markdown, { text }));
}

/** The visible text, with tags removed and the few entities React writes decoded. */
function visible(html: string): string {
  return html.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&");
}

test.after(async () => { await server?.close(); });

test("tables, blockquotes, nested and task lists, emphasis and strikethrough render as their elements", async () => {
  const html = await render([
    "| File | Lines |", "| :--- | ---: |", "| a.ts | 12 |", "| b.ts | 3 |", "",
    "> Quoted **advice**", "",
    "- one", "  1. inner first", "  2. inner second", "- two", "",
    "- [x] done", "- [ ] todo", "",
    "*soft* and ~~gone~~ and `code`",
  ].join("\n"));
  assert.match(html, /<table>.*<thead>.*<th[^>]*>File<\/th>.*<th[^>]*>Lines<\/th>.*<tbody>.*<td[^>]*>a\.ts<\/td>.*<td[^>]*>12<\/td>/s);
  assert.match(html, /<th style="text-align:right"[^>]*>Lines<\/th>/);
  assert.match(html, /<blockquote>.*Quoted <strong>advice<\/strong>.*<\/blockquote>/s);
  assert.match(html, /<ul><li>.*one.*<ol><li>.*inner first.*<\/li><li>.*inner second.*<\/li><\/ol><\/li><li>.*two/s);
  assert.match(html, /<input type="checkbox" disabled="" checked=""[^>]*\/>.*done/s);
  assert.match(html, /<input type="checkbox" disabled=""(?! checked)[^>]*\/>.*todo/s);
  assert.match(html, /<em>soft<\/em> and <del>gone<\/del> and <code>code<\/code>/);
});

test("headings keep their place below the transcript's own titles, and a fence keeps its language and indentation", async () => {
  const html = await render("# One\n## Two\n### Three\n#### Four\n\n```ts\nif (a) {\n    return 1;\n}\n```");
  assert.match(html, /<h2>One<\/h2><h3>Two<\/h3><h4>Three<\/h4><h5>Four<\/h5>/);
  assert.match(html, /<pre class="code" data-lang="ts"><code>if \(a\) \{\n    return 1;\n\}<\/code><\/pre>/);
});

test("a fence that is still streaming shows its code so far, and the closing fence changes nothing before it", async () => {
  const open = await render("Here:\n\n```js\nconst a = 1;\nconst b = ");
  assert.match(open, /<pre class="code" data-lang="js"><code>const a = 1;\nconst b = <\/code><\/pre>/);
  const closed = await render("Here:\n\n```js\nconst a = 1;\nconst b = 2;\n```\n\nDone.");
  assert.match(closed, /<code>const a = 1;\nconst b = 2;<\/code><\/pre>.*?<p>Done\.<\/p>/s);
});

test("every prefix of a streamed reply renders, and no prefix loses or doubles its text", async () => {
  const reply = "Fix **the `parse()` call** in [the docs](https://example.com/d).\n\n- [ ] add a test\n- ~~old~~ new\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n```py\nprint('hi')\n```\n";
  // Each word occurs once in the reply and never inside a URL, so a reader must see it exactly as often as the prefix holds it whole.
  const words = ["Fix", "parse", "call", "docs", "add", "test", "old", "new", "print", "hi"];
  for (let end = 1; end <= reply.length; end++) {
    const prefix = reply.slice(0, end);
    const shown = visible(await render(prefix));
    for (const word of words) {
      const count = (s: string) => s.split(word).length - 1;
      // A word the prefix is still in the middle of may legitimately be absent or partial.
      const whole = count(prefix.replace(/\w+$/, ""));
      assert.ok(count(shown) >= whole && count(shown) <= count(prefix), `prefix ${end} ${JSON.stringify(prefix.slice(-14))}: "${word}" shown ${count(shown)} times`);
    }
  }
});

test("Unicode passes through untouched", async () => {
  const text = "Café ✓ — naïve 日本語 👩🏽‍💻 é";
  assert.equal(visible(await render(text)), text);
});

test("raw HTML stays text: no element, attribute or handler reaches the page", async () => {
  const html = await render('<script>alert(1)</script>\n\nhi <img src=x onerror="alert(2)"> <b onclick="x()">b</b>\n\n<div style="position:fixed">over</div>');
  assert.doesNotMatch(html, /<script|<img|<b |<div style|onerror="|onclick="/);
  assert.match(visible(html), /<script>alert\(1\)<\/script>/);
  assert.match(visible(html), /<img src=x onerror="alert\(2\)">/);
});

test("only web links are links; other schemes stay as the text that was written", async () => {
  const html = await render("[ok](https://example.com/a) [js](javascript:alert(1)) [file](file:///etc/passwd) <javascript:alert(3)> [rel](./notes.md) [data](data:text/html,x)");
  assert.equal([...html.matchAll(/<a /g)].length, 1, html);
  assert.match(html, /<a href="https:\/\/example\.com\/a" target="_blank" rel="noreferrer" title="https:\/\/example\.com\/a">ok<\/a>/);
  for (const literal of ["[js](javascript:alert(1))", "[file](file:///etc/passwd)", "[rel](./notes.md)", "[data](data:text/html,x)"]) assert.ok(visible(html).includes(literal), literal);
  assert.doesNotMatch(html, /href="(javascript|file|data):/);
});

test("bare URLs link without the sentence's punctuation, and reference links resolve", async () => {
  const html = await render("Read https://example.com/a. Or (https://example.com/b).\n\nSee [the spec][s].\n\n[s]: https://spec.commonmark.org/");
  assert.match(html, /Read <a href="https:\/\/example\.com\/a"[^>]*>https:\/\/example\.com\/a<\/a>\. Or \(<a href="https:\/\/example\.com\/b"[^>]*>https:\/\/example\.com\/b<\/a>\)\./);
  assert.match(html, /See <a href="https:\/\/spec\.commonmark\.org\/"[^>]*>the spec<\/a>\./);
});

test("images are never fetched: a web image becomes a link named by its alt text", async () => {
  const html = await render("![build graph](https://example.com/g.png) ![local](./x.png) ![](https://example.com/n.png)");
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /<a href="https:\/\/example\.com\/g\.png"[^>]*>Image: build graph<\/a>/);
  assert.ok(visible(html).includes("![local](./x.png)"));
  assert.match(html, /<a href="https:\/\/example\.com\/n\.png"[^>]*>Image<\/a>/);
});

// While a reply streams, only its last block is parsed again (see streamingChunks).
async function chunksOf(text: string): Promise<string[]> {
  await render("");
  const { streamingChunks } = await server!.ssrLoadModule("/src/renderer/components/Markdown.tsx") as { streamingChunks: (text: string) => string[] };
  return streamingChunks(text);
}

test("a streaming reply splits at blank lines outside code fences, and the pieces join back to the text", async () => {
  const text = "Intro line\nstill intro\n\n```py\nfirst\n\nsecond\n```\n\n~~~\na\n\n~~~~\nclosed by a longer fence\n\n- item\n\nTail";
  const chunks = await chunksOf(text);
  assert.equal(chunks.join(""), text);
  assert.deepEqual(chunks, ["Intro line\nstill intro\n\n", "```py\nfirst\n\nsecond\n```\n\n", "~~~\na\n\n~~~~\nclosed by a longer fence\n\n", "- item\n\n", "Tail"]);
  // An unclosed fence keeps everything after it in one piece, blank lines included.
  assert.deepEqual(await chunksOf("Before\n\n```js\nconst a = 1;\n\nconst b"), ["Before\n\n", "```js\nconst a = 1;\n\nconst b"]);
  assert.deepEqual(await chunksOf(""), []);
});

test("rendering a reply piece by piece shows the same text as rendering it whole", async () => {
  const reply = "Fix **the `parse()` call** in [the docs](https://example.com/d).\n\n- [ ] add a test\n- ~~old~~ new\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n```py\nprint('hi')\n\nprint('there')\n```\n\n> quoted\n\nDone 日本語 ✓";
  // Blocks sit side by side in the page, so compare the text without the whitespace between them.
  const whole = visible(await render(reply)).replace(/\s+/g, "");
  const pieces = (await Promise.all((await chunksOf(reply)).map(render))).map(visible).join("").replace(/\s+/g, "");
  assert.equal(pieces, whole);
});

test("the settled cache keeps recent renders, drops the oldest past its limit, and never holds very long text", async () => {
  await render("");
  const { RenderCache } = await server!.ssrLoadModule("/src/renderer/components/Markdown.tsx") as { RenderCache: new (entries: number, maxChars: number) => { get<T>(text: string, make: () => T): T; size: number } };
  const cache = new RenderCache(2, 10);
  let made = 0;
  const make = () => ++made;
  assert.equal(cache.get("a", make), 1);
  assert.equal(cache.get("a", make), 1, "a hit renders nothing again");
  cache.get("b", make);
  cache.get("a", make); // "a" is now the most recent
  cache.get("c", make); // past the limit: "b", the least recent, goes
  assert.equal(cache.size, 2);
  assert.equal(cache.get("a", make), 1);
  assert.equal(cache.get("b", make), 4, "b was rendered again");
  const long = "x".repeat(11);
  assert.equal(cache.get(long, make), 5);
  assert.equal(cache.get(long, make), 6, "text past the size limit is rendered each time, never kept");
  assert.equal(cache.size, 2);
});

test("a code block names its language and offers Copy", async () => {
  const html = await render("```ts\nconst a = 1;\n```\n\n```\nplain\n```");
  assert.match(html, /<span class="code-lang">ts<\/span><button type="button" class="code-copy" data-testid="code-copy" aria-label="Copy ts code">Copy<\/button><\/div><pre class="code" data-lang="ts"><code>const a = 1;<\/code><\/pre>/);
  assert.match(html, /<span class="code-lang">text<\/span><button[^>]*aria-label="Copy code">Copy<\/button><\/div><pre class="code"><code>plain<\/code>/);
});
