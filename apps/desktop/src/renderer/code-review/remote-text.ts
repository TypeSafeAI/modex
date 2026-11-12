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
const TAG = /<(\/?)([A-Za-z][A-Za-z0-9-]*)((?:\s+[^<>"']*(?:"[^"]*"|'[^']*')?)*)\s*\/?>/g;
const COMMENT = /<!--[\s\S]*?-->/g;
const BLOCK = new Set(["br", "p", "div", "tr", "li", "summary", "details", "blockquote", "table", "h1", "h2", "h3", "h4", "h5", "h6", "hr"]);
const LIMIT = 200_000;

function alt(attributes: string): string {
  const found = /\salt\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attributes);
  return (found?.[1] ?? found?.[2] ?? "").trim();
}

function prose(text: string): string {
  return text.replace(COMMENT, "").replace(TAG, (whole, _closing: string, name: string, attributes: string) => {
    const tag = name.toLowerCase();
    if (!TAGS.has(tag)) return whole;
    if (tag === "img") { const label = alt(attributes); return label ? `Image: ${label}` : ""; }
    return BLOCK.has(tag) ? "\n" : "";
  });
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
