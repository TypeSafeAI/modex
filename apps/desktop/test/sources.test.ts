import { test } from "node:test";
import assert from "node:assert/strict";
import { parseWebSearch, splitSources } from "../src/shared/sources.js";

const ANSWER = "The latest Sonnet is **Claude Sonnet 5.5**.\n\nIt replaces Sonnet 5.";

test("a trailing Sources list is split off the answer", () => {
  const { body, sources } = splitSources(`${ANSWER}\n\nSources:\n- [Anthropic upgrades Claude (9to5Mac)](https://9to5mac.com/2026/09/28/sonnet-5-5/)\n- [Claude Sonnet - Anthropic](https://www.anthropic.com/claude/sonnet)\n`);
  assert.equal(body, ANSWER);
  assert.deepEqual(sources, [
    { title: "Anthropic upgrades Claude (9to5Mac)", url: "https://9to5mac.com/2026/09/28/sonnet-5-5/", domain: "9to5mac.com" },
    { title: "Claude Sonnet - Anthropic", url: "https://www.anthropic.com/claude/sonnet", domain: "anthropic.com" },
  ]);
});

test("the heading and the list come in a few shapes", () => {
  const link = "[A](https://a.example/x)";
  for (const heading of ["Sources:", "Sources", "**Sources:**", "**Sources**:", "## Sources", "### Sources:", "Source:", "References:", "sources:"]) {
    for (const marker of ["- ", "* ", "1. ", "1) ", "• ", ""]) {
      const { body, sources } = splitSources(`Answer.\n\n${heading}\n\n${marker}${link}`);
      assert.equal(body, "Answer.", `${heading} / ${marker}`);
      assert.deepEqual(sources.map((s) => s.url), ["https://a.example/x"], `${heading} / ${marker}`);
    }
  }
});

test("bare URLs take their title from the line, or from the domain", () => {
  const { sources } = splitSources([
    "Sources:",
    "- Anthropic news: https://www.anthropic.com/news.",
    "- https://docs.example.com/models",
    "- **Model card** (https://example.com/card)",
    "- https://en.wikipedia.org/wiki/Claude_(language_model)",
  ].join("\n"));
  assert.deepEqual(sources.map((s) => [s.title, s.url]), [
    ["Anthropic news", "https://www.anthropic.com/news"],
    ["docs.example.com", "https://docs.example.com/models"],
    ["Model card", "https://example.com/card"],
    ["en.wikipedia.org", "https://en.wikipedia.org/wiki/Claude_(language_model)"],
  ]);
});

test("the same link is listed once", () => {
  const { sources } = splitSources("Sources:\n- [A](https://a.example/)\n- [A again](https://a.example/)\n- [B](https://b.example/)");
  assert.deepEqual(sources.map((s) => s.title), ["A", "B"]);
});

test("text that is not a trailing list of links is left whole", () => {
  const whole = [
    ANSWER,
    `${ANSWER}\n\nSources:`,
    `${ANSWER}\n\nSources:\n- [A](https://a.example/)\n\nAnd one more thought.`,
    `${ANSWER}\n\nSources:\n- [A](https://a.example/)\n- the team's own notes`,
    `${ANSWER}\n\nSources:\n- [A](javascript:alert(1))`,
    `${ANSWER}\n\nSources:\n- [a.ts](src/a.ts)`,
    "Example output:\n```\nSources:\n- [A](https://a.example/)",
    "My sources: [A](https://a.example/)",
  ];
  for (const text of whole) assert.deepEqual(splitSources(text), { body: text, sources: [] }, text);
});

test("the last heading wins, and an answer can be sources alone", () => {
  const two = splitSources("Sources:\n- [Old](https://old.example/)\n\nMore prose.\n\nSources:\n- [New](https://new.example/)");
  assert.equal(two.body, "Sources:\n- [Old](https://old.example/)\n\nMore prose.");
  assert.deepEqual(two.sources.map((s) => s.title), ["New"]);
  assert.deepEqual(splitSources("Sources:\n- [Only](https://only.example/)"), { body: "", sources: [{ title: "Only", url: "https://only.example/", domain: "only.example" }] });
});

const LINKS = [
  { title: "Introducing Claude Sonnet 5.5", url: "https://www.anthropic.com/news/claude-sonnet-5-5" },
  { title: "Claude (language model)", url: "https://en.wikipedia.org/wiki/Claude_(language_model)" },
];
const SEARCH = [
  'Web search results for query: "latest Claude Sonnet model 2026"',
  "",
  `Links: ${JSON.stringify(LINKS)}`,
  "",
  "Based on the search results, the latest is **Sonnet 5.5**.",
  "",
  "## Pricing",
  "",
  "It keeps Sonnet 5's pricing.",
  "",
  "",
  "REMINDER: You MUST include the sources above in your response to the user using markdown hyperlinks.",
].join("\n");

test("a WebSearch result is read into its query, links and summary", () => {
  assert.deepEqual(parseWebSearch(SEARCH), {
    query: "latest Claude Sonnet model 2026",
    links: [
      { title: "Introducing Claude Sonnet 5.5", url: "https://www.anthropic.com/news/claude-sonnet-5-5", domain: "anthropic.com" },
      { title: "Claude (language model)", url: "https://en.wikipedia.org/wiki/Claude_(language_model)", domain: "en.wikipedia.org" },
    ],
    summary: "Based on the search results, the latest is **Sonnet 5.5**.\n\n## Pricing\n\nIt keeps Sonnet 5's pricing.",
  });
});

test("several result sets merge, without repeats or unusable entries", () => {
  const out = [
    'Web search results for query: "a"',
    `Links: ${JSON.stringify([LINKS[0], { title: "No link" }, { title: "Local", url: "file:///etc/passwd" }, "junk", null])}`,
    "First.",
    `Links: ${JSON.stringify([LINKS[0], LINKS[1], { url: "https://untitled.example/page" }])}`,
    "Second.",
  ].join("\n");
  const r = parseWebSearch(out)!;
  assert.deepEqual(r.links.map((l) => [l.title, l.domain]), [["Introducing Claude Sonnet 5.5", "anthropic.com"], ["Claude (language model)", "en.wikipedia.org"], ["untitled.example", "untitled.example"]]);
  assert.equal(r.summary, "First.\nSecond.");
});

test("a cut-off link list still yields its complete entries", () => {
  const cut = `Web search results for query: "a"\n\nLinks: ${JSON.stringify(LINKS).slice(0, -30)}`;
  const r = parseWebSearch(cut)!;
  assert.deepEqual(r.links.map((l) => l.url), ["https://www.anthropic.com/news/claude-sonnet-5-5"]);
  assert.equal(r.summary, "");
  const quoted = parseWebSearch('Links: [{"title":"A \\"quoted\\" title","url":"https://a.example/"},{"title":"B","url":"https://b.exam')!;
  assert.deepEqual(quoted.links.map((l) => l.title), ['A "quoted" title']);
});

test("output in any other shape is not a search result", () => {
  for (const out of ["", "Error: web search is unavailable", "Did 0 searches", "Links are below: none", "$ ls\nLinks.md"]) assert.equal(parseWebSearch(out), null, out);
});

test("a search that found nothing is still a search", () => {
  assert.deepEqual(parseWebSearch('Web search results for query: "zxqv"\n\nNo links found.'), { query: "zxqv", links: [], summary: "No links found." });
});


test("annotated citations and additional links keep the original answer", () => {
  for (const line of [
    "[Guide](https://a.example/) — applies only to v2; v1 is unsupported.",
    "Read [Guide](https://a.example/) before running the command.",
    "[Guide](https://a.example/) [Mirror](https://b.example/)",
    "Guide: https://a.example/ — applies only to v2.",
    "https://a.example/ https://b.example/",
  ]) {
    const answer = `Answer.\n\nSources:\n- ${line}`;
    assert.deepEqual(splitSources(answer), { body: answer, sources: [] }, line);
  }
});
