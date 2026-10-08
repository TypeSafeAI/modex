import { test } from "node:test";
import assert from "node:assert/strict";
import { importMarkdownPage, joinMarkdown, splitMarkdown, toggleChecklist, parseSpaceBlocks } from "../src/shared/space-markdown.js";

test("importing an H1 title preserves code and list indentation in the body", () => {
  for (const newline of ["\n", "\r\n"]) {
    for (const body of [`    const value = 1;${newline}    console.log(value);${newline}`, `  - first${newline}    - nested${newline}`, `\tcode${newline}`]) {
      assert.deepEqual(importMarkdownPage(`# Example${newline}${newline}${body}`, "example.md"), { title: "Example", markdown: body });
      assert.deepEqual(importMarkdownPage(body, "example.md"), { title: "example", markdown: body });
    }
  }
});

test("adding or moving after an imported terminal newline keeps blocks separate on reopen", () => {
  for (const ending of ["\n", "\r\n", "\n  "]) {
    const imported = splitMarkdown(`First${ending}`);
    assert.equal(joinMarkdown(imported), `First${ending}`, "an unchanged import stays exact");
    const saved = joinMarkdown([...imported, { id: "new", source: "Second" }]);
    assert.deepEqual(splitMarkdown(saved).map(block => block.source), ["First", "Second"]);
  }
  const original = splitMarkdown("First\n\nLast\n");
  assert.deepEqual(splitMarkdown(joinMarkdown([original[1]!, original[0]!])).map(block => block.source), ["Last", "First"]);
});

test("editing one block preserves nested lists, inline images, fences and exact whitespace elsewhere", () => {
  const source = "\n# Title\r\n\r\n- parent\r\n  - child\r\n  - child two\r\n\r\nHere is ![logo](https://example.com/logo.png) inline.\n\n```ts\n\nconst x = 1;\n\n```\n\nLast paragraph\n";
  const blocks = splitMarkdown(source);
  assert.equal(joinMarkdown(blocks), source);
  const last = blocks.at(-1)!;
  last.source = last.source.replace("Last paragraph", "An edit");
  assert.equal(joinMarkdown(blocks), source.replace("Last paragraph", "An edit"));
});

test("checking an item changes only that checkbox marker", () => {
  const source = "- [ ] First ![icon](https://example.com/i.png)\n  - nested detail\n- [ ] Second\n";
  assert.equal(toggleChecklist(source, 1, true), source.replace("[ ] Second", "[x] Second"));
  const fenced = "```md\n- [ ] Example\n```\n- [ ] Real task";
  assert.equal(toggleChecklist(fenced, 0, true), fenced.replace("[ ] Real", "[x] Real"));
  assert.equal(toggleChecklist("-  [ ] first\n- [ ] second", 0, true), "-  [x] first\n- [ ] second");
});

test("Space preserves nested mixed lists and checklist order in its preview model", () => {
  const blocks = parseSpaceBlocks("# Tasks\n\n- parent\n  1. **child**\n    - [ ] nested task\n  - sibling\n- second\n\nAfterwards");
  assert.equal(blocks[0]!.type, "heading");
  const list = blocks[1]!;
  assert.equal(list.type, "bulletList");
  assert.equal(list.children.length, 2);
  const nested = list.children[0]!.children;
  assert.equal(nested[0]!.type, "numberedList");
  assert.deepEqual(nested[0]!.children[0]!.content, [{ text: "child", styles: { bold: true } }]);
  assert.equal(nested[0]!.children[0]!.children[0]!.type, "checkList");
  assert.equal(nested[1]!.children[0]!.content[0]!.text, "sibling");
  assert.equal(blocks[2]!.content[0]!.text, "Afterwards");
  const fenced = parseSpaceBlocks("```md\n- parent\n  - child\n```\n\nEnd");
  assert.equal(fenced[0]!.type, "codeBlock");
  assert.match(fenced[0]!.content[0]!.text, /  - child/);
});

test("Space renders every list item after a leading indent and keeps checklist edits aligned", () => {
  const preview = JSON.stringify(parseSpaceBlocks("  - First\n- Second\n- Third"));
  for (const text of ["First", "Second", "Third"]) assert.ok(preview.includes(text), `Missing list item: ${text}`);
  const source = "  - First\n- [ ] Earlier task\nA paragraph\n- [ ] Later task";
  const tasks: string[] = [];
  const visit = (blocks: ReturnType<typeof parseSpaceBlocks>) => {
    for (const block of blocks) {
      if (block.type === "checkList") tasks.push(block.content[0]?.text ?? "");
      visit(block.children);
    }
  };
  visit(parseSpaceBlocks(source));
  assert.deepEqual(tasks, ["Earlier task", "Later task"]);
  assert.equal(toggleChecklist(source, tasks.indexOf("Later task"), true), source.replace("[ ] Later", "[x] Later"));
});
