import { test } from "node:test";
import assert from "node:assert/strict";
import { domainOf, safeHref, tokenizeInline, trimBareUrl } from "../src/shared/inline.js";

const text = (t: string) => ({ type: "text" as const, text: t });
const link = (href: string, label: string) => ({ type: "link" as const, href, children: [text(label)] });

test("code and bold read as they always have", () => {
  assert.deepEqual(tokenizeInline("run `npm test` and **wait** here"), [
    text("run "),
    { type: "code", text: "npm test" },
    text(" and "),
    { type: "bold", children: [text("wait")] },
    text(" here"),
  ]);
  assert.deepEqual(tokenizeInline("nothing special"), [text("nothing special")]);
  assert.deepEqual(tokenizeInline(""), []);
});

test("Markdown links and bare URLs become links", () => {
  assert.deepEqual(tokenizeInline("see [the docs](https://example.com/a) now"), [text("see "), link("https://example.com/a", "the docs"), text(" now")]);
  assert.deepEqual(tokenizeInline("at https://example.com/a?b=1#c ok"), [text("at "), link("https://example.com/a?b=1#c", "https://example.com/a?b=1#c"), text(" ok")]);
});

test("a bare URL leaves the sentence's punctuation outside the link", () => {
  assert.deepEqual(tokenizeInline("Read https://example.com/a."), [text("Read "), link("https://example.com/a", "https://example.com/a"), text(".")]);
  assert.deepEqual(tokenizeInline("(https://example.com/a)"), [text("("), link("https://example.com/a", "https://example.com/a"), text(")")]);
  assert.deepEqual(tokenizeInline("one https://a.example/x, two"), [text("one "), link("https://a.example/x", "https://a.example/x"), text(", two")]);
  assert.equal(trimBareUrl("https://example.com/a)."), "https://example.com/a");
});

test("parentheses that belong to the URL stay in it", () => {
  const wiki = "https://en.wikipedia.org/wiki/Claude_(language_model)";
  assert.deepEqual(tokenizeInline(`see ${wiki}`), [text("see "), link(wiki, wiki)]);
  assert.deepEqual(tokenizeInline(`[Claude](${wiki}) is`), [link(wiki, "Claude"), text(" is")]);
  assert.equal(trimBareUrl(`${wiki})`), wiki);
});

test("emphasis and links nest one way each", () => {
  assert.deepEqual(tokenizeInline("**[a](https://example.com/)**"), [{ type: "bold", children: [link("https://example.com/", "a")] }]);
  assert.deepEqual(tokenizeInline("[**a** `b`](https://example.com/)"), [
    { type: "link", href: "https://example.com/", children: [{ type: "bold", children: [text("a")] }, text(" "), { type: "code", text: "b" }] },
  ]);
  // A label is never linkified again.
  assert.deepEqual(tokenizeInline("[https://shown.example](https://real.example/)"), [link("https://real.example/", "https://shown.example")]);
});

test("code is never linkified", () => {
  assert.deepEqual(tokenizeInline("`https://example.com`"), [{ type: "code", text: "https://example.com" }]);
  assert.deepEqual(tokenizeInline("`[a](https://example.com)`"), [{ type: "code", text: "[a](https://example.com)" }]);
});

test("only web links are clickable; other targets stay as written", () => {
  for (const s of ["[x](javascript:alert(1))", "[a.ts](src/a.ts)", "[mail](mailto:a@example.com)", "[f](file:///etc/passwd)"]) {
    assert.deepEqual(tokenizeInline(s), [text(s)], s);
  }
  assert.equal(safeHref("https://example.com"), "https://example.com/");
  assert.equal(safeHref(" http://example.com/a "), "http://example.com/a");
  for (const bad of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,x", "/relative", "example.com", "https://", ""]) assert.equal(safeHref(bad), null, bad);
});

test("domainOf drops the www prefix and survives junk", () => {
  assert.equal(domainOf("https://www.anthropic.com/news/x"), "anthropic.com");
  assert.equal(domainOf("https://docs.example.com:8443/a"), "docs.example.com");
  assert.equal(domainOf("not a url"), "not a url");
});
