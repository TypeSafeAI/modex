/**
 * Remote comment and description text, made readable before the inert Markdown view shows it (D4).
 *
 * GitHub comments from bots are largely raw HTML: `<picture><source …><img alt="…"></picture>`, `<a href=…>`,
 * `<sup>`, `<details>`. The Markdown view never interprets HTML, so that source was printed as it stands and
 * the comment could not be read. Here known HTML tags are removed and their text kept: an image becomes its
 * alt text, a line break a new line, a comment nothing. No element, link target or image request comes of it:
 * the result is still only text for the same inert view, and an `href` hidden in a tag is dropped, never
 * followed. Code spans and fenced code are left exactly as written, and so is anything that merely looks
 * like a tag (`Array<string>`, `a < b`).
 */
const TAGS = new Set(["a", "abbr", "b", "blockquote", "br", "caption", "center", "cite", "code", "col", "colgroup", "dd", "del", "details", "dfn", "div", "dl", "dt",
  "em", "figcaption", "figure", "font", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img", "ins", "kbd", "li", "mark", "ol", "p", "picture", "pre", "q", "relative-time",
  "s", "samp", "small", "source", "span", "strike", "strong", "sub", "summary", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "time", "tr", "tt", "u", "ul", "var", "video"]);
const BLOCK = new Set(["br", "p", "div", "tr", "li", "summary", "details", "blockquote", "table", "h1", "h2", "h3", "h4", "h5", "h6", "hr"]);
const LIMIT = 200_000;

const NAME = /[A-Za-z0-9-]/;

/** The `alt` of a tag's attributes, read without a pattern that could backtrack. */
function alt(attributes: string): string {
  const lower = attributes.toLowerCase();
  for (let at = lower.indexOf("alt"); at >= 0; at = lower.indexOf("alt", at + 1)) {
    if (at > 0 && !/\s/.test(lower[at - 1]!)) continue;
    let i = at + 3;
    while (/\s/.test(lower[i] ?? "")) i++;
    if (lower[i] !== "=") continue;
    i++;
    while (/\s/.test(lower[i] ?? "")) i++;
    const quote = attributes[i];
    if (quote !== '"' && quote !== "'") continue;
    const end = attributes.indexOf(quote, i + 1);
    if (end >= 0) return attributes.slice(i + 1, end).trim();
  }
  return "";
}

/**
 * One pass over the text, a character at a time: every `<` is read as a comment, a known tag, or itself.
 * There is no pattern to backtrack and nothing is scanned twice, so hostile input costs its own length.
 */
function prose(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const lt = text.indexOf("<", i);
    if (lt < 0) { out += text.slice(i); break; }
    out += text.slice(i, lt);
    if (text.startsWith("<!--", lt)) {
      const end = text.indexOf("-->", lt + 4);
      // A comment that does not end here is left for the caller, which drops it across lines.
      if (end < 0) { out += text.slice(lt); break; }
      i = end + 3;
      continue;
    }
    let j = lt + 1;
    if (text[j] === "/") j++;
    const start = j;
    if (!/[A-Za-z]/.test(text[j] ?? "")) { out += "<"; i = lt + 1; continue; }
    while (j < text.length && NAME.test(text[j]!)) j++;
    const name = text.slice(start, j).toLowerCase();
    const after = text[j];
    // Attributes run to the closing `>`; a quoted value may hold one. Another `<` or the end means no tag.
    let k = j, quote = "", closed = false;
    if (after === ">" || after === "/" || /\s/.test(after ?? "")) {
      for (; k < text.length; k++) {
        const c = text[k]!;
        if (quote) { if (c === quote) quote = ""; continue; }
        if (c === '"' || c === "'") quote = c;
        else if (c === ">") { closed = true; break; }
        else if (c === "<") break;
      }
    }
    if (!closed || !TAGS.has(name)) { out += "<"; i = lt + 1; continue; }
    if (name === "img") { const label = alt(text.slice(j, k)); if (label) out += `Image: ${label}`; }
    else if (BLOCK.has(name)) out += "\n";
    i = k + 1;
  }
  return out;
}

/** `text` with HTML outside code turned into its plain text. Text past the limit is returned as written. */
export function readableRemoteText(text: string): string {
  if (!text.includes("<") || text.length > LIMIT) return text;
  const out: string[] = [];
  let fence: string | null = null;
  let comment = false;
  for (let line of text.split("\n")) {
    // An HTML comment may run over several lines; none of it is shown.
    if (comment) {
      const end = line.indexOf("-->");
      if (end < 0) continue;
      comment = false;
      line = line.slice(end + 3);
    }
    const mark = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      out.push(line);
      if (mark && mark[0] === fence[0] && mark.length >= fence.length && /^ {0,3}[`~]+\s*$/.test(line)) fence = null;
      continue;
    }
    if (mark) { fence = mark; out.push(line); continue; }
    // Inline code spans keep their text; only the prose between them is cleaned.
    const parts = line.split(/(`+[^`]*`+)/).map((part, i) => (i % 2 ? part : prose(part)));
    const open = parts.findIndex((part, i) => i % 2 === 0 && part.includes("<!--"));
    if (open >= 0) {
      comment = true;
      parts[open] = parts[open]!.slice(0, parts[open]!.indexOf("<!--"));
      parts.length = open + 1;
    }
    out.push(parts.join(""));
  }
  // Removing block tags can leave runs of empty lines; Markdown reads two the same as five.
  return out.join("\n").replace(/\n{4,}/g, "\n\n\n");
}
