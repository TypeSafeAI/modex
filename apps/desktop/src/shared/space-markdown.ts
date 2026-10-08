import { tokenize, parse, parseInlineContent, paragraph, bulletList, numberedList, checkListItem, isListToken, type Block, type Token } from "@create-markdown/core";

/** The package parser skips indented list tokens. Retain them using its own block model. */
export function parseSpaceBlocks(markdown: string): Block[] {
  const tokens = tokenize(markdown);
  const lines = markdown.split("\n");
  const blocks: Block[] = [];
  let line = 0;
  for (let i = 0; i < tokens.length;) {
    if (!isListToken(tokens[i]!)) { i++; continue; }
    const start = i;
    while (i < tokens.length && isListToken(tokens[i]!)) i++;
    blocks.push(...parse(lines.slice(line, tokens[start]!.line - 1).join("\n")));
    blocks.push(...parseListTokens(tokens.slice(start, i)));
    line = tokens[i - 1]!.line;
  }
  blocks.push(...parse(lines.slice(line).join("\n")));
  return blocks;
}

function parseListTokens(tokens: Token[]): Block[] {
  let i = 0;
  const level = (indent: number): Block[] => {
    const blocks: Block[] = [];
    while (i < tokens.length && tokens[i]!.indent >= indent) {
      const token = tokens[i]!;
      if (token.indent > indent && blocks.length) {
        const previous = blocks.at(-1)!;
        const parent = previous.type === "checkList" ? previous : previous.children.at(-1)!;
        parent.children.push(...level(token.indent));
        continue;
      }
      const content = parseInlineContent(token.content);
      if (token.type === "check_list_item") blocks.push(checkListItem(content, token.meta?.checked));
      else {
        const type = token.type === "bullet_list_item" ? "bulletList" : "numberedList";
        let list = blocks.at(-1);
        if (list?.type !== type) { list = type === "bulletList" ? bulletList([]) : numberedList([]); blocks.push(list); }
        list.children.push(paragraph(content));
      }
      i++;
    }
    return blocks;
  };
  // Imported Markdown can begin indented, then resume at a shallower root level.
  const blocks: Block[] = [];
  while (i < tokens.length) blocks.push(...level(tokens[i]!.indent));
  return blocks;
}

export interface EditorBlock { id: string; source: string; separator?: string }

/** Use package token positions, never parse/stringify, to split editable raw Markdown losslessly. */
export function splitMarkdown(markdown: string): EditorBlock[] {
  if (!markdown) return [{ id: crypto.randomUUID(), source: "" }];
  const offsets = [0];
  for (let i = 0; i < markdown.length; i++) if (markdown[i] === "\n") offsets.push(i + 1);
  const starts = [0];
  let hasContent = false;
  let gap = false;
  for (const token of tokenize(markdown)) {
    if (token.type === "blank") { gap = hasContent; continue; }
    if (gap) starts.push(offsets[token.line - 1] ?? markdown.length);
    hasContent = true; gap = false;
  }
  return starts.map((start, i) => {
    const raw = markdown.slice(start, starts[i + 1] ?? markdown.length);
    const separator = raw.match(/(?:\r?\n[\t ]*)+$/)?.[0] ?? "";
    return { id: crypto.randomUUID(), source: raw.slice(0, raw.length - separator.length), separator };
  });
}

export function joinMarkdown(blocks: EditorBlock[]): string {
  return blocks.map((block, i) => {
    let separator = block.separator ?? "";
    // A former last block may have only one newline. Once followed by another
    // block, it needs a blank line so the two remain distinct when reopened.
    if (i < blocks.length - 1) {
      const newlines = separator.match(/\n/g)?.length ?? 0;
      if (newlines < 2) separator += (separator.includes("\r\n") ? "\r\n" : "\n").repeat(2 - newlines);
    }
    return block.source + separator;
  }).join("");
}

/** Toggle only the requested source marker; no other Markdown is rewritten. */
export function toggleChecklist(source: string, index: number, checked: boolean): string {
  const token = tokenize(source).filter((t: { type: string }) => t.type === "check_list_item")[index];
  if (!token) return source;
  const lines = source.split("\n");
  const line = lines[token.line - 1];
  if (line === undefined) return source;
  lines[token.line - 1] = line.replace(/^(\s*[-*+]\s+\[)[ xX](\])/i, `$1${checked ? "x" : " "}$2`);
  return lines.join("\n");
}
/** Extract an imported page title without changing Markdown indentation in its body. */
export function importMarkdownPage(markdown: string, filename: string): { title: string; markdown: string } {
  const heading = markdown.match(/^# ([^\r\n]+)\r?\n/);
  return { title: (heading?.[1] ?? filename.replace(/\.(md|markdown|txt)$/i, "")).slice(0, 200), markdown: heading ? markdown.slice(heading[0].length).replace(/^(?:[\t ]*\r?\n)+/, "") : markdown };
}
