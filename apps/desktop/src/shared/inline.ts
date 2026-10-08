/**
 * Inline Markdown as tokens: code, bold, links and bare URLs. Pure, so the renderer's Markdown is a
 * thin mapper over it and the rules are unit-tested from test/inline.test.ts.
 */
export type InlineToken =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "bold"; children: InlineToken[] }
  | { type: "link"; href: string; children: InlineToken[] };

const CODE = "`[^`]+`";
const BOLD = "\\*\\*[^*]+\\*\\*";
/** `[label](target)`; the target may hold one level of parentheses, as Wikipedia URLs do. */
const LINK = "\\[[^\\]\\n]+\\]\\((?:[^\\s()]|\\([^\\s()]*\\))+\\)";
const BARE_URL = "https?:\\/\\/[^\\s<>`]+";

/** Only web links are clickable: the window hands http(s) to the system browser and nothing else. */
export function safeHref(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

/** `https://www.example.com/a` → `example.com`. */
export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** A bare URL stops before trailing sentence punctuation, and before a `)` it did not open. */
export function trimBareUrl(raw: string): string {
  let end = raw.length;
  while (end > 0) {
    const last = raw[end - 1]!;
    const url = raw.slice(0, end);
    if (/[.,;:!?'"\]}*]/.test(last)) end--;
    else if (last === ")" && url.split(")").length > url.split("(").length) end--;
    else break;
  }
  return raw.slice(0, end);
}

export function tokenizeInline(s: string, opts: { links?: boolean } = {}): InlineToken[] {
  const links = opts.links !== false;
  const re = new RegExp(links ? `${CODE}|${LINK}|${BOLD}|${BARE_URL}` : `${CODE}|${BOLD}`, "g");
  const out: InlineToken[] = [];
  const text = (t: string) => {
    if (!t) return;
    const prev = out.at(-1);
    if (prev?.type === "text") prev.text += t;
    else out.push({ type: "text", text: t });
  };
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    text(s.slice(last, m.index));
    const tok = m[0];
    last = m.index + tok.length;
    if (tok.startsWith("`")) out.push({ type: "code", text: tok.slice(1, -1) });
    else if (tok.startsWith("**")) out.push({ type: "bold", children: tokenizeInline(tok.slice(2, -2), opts) });
    else if (tok.startsWith("[")) {
      const split = tok.indexOf("](");
      const href = safeHref(tok.slice(split + 2, -1));
      // A label never nests another link. Targets that are not web links (file paths, other schemes) stay as written.
      if (href) out.push({ type: "link", href, children: tokenizeInline(tok.slice(1, split), { links: false }) });
      else text(tok);
    } else {
      const url = trimBareUrl(tok);
      const href = safeHref(url);
      if (href) out.push({ type: "link", href, children: [{ type: "text", text: url }] });
      else text(url);
      text(tok.slice(url.length));
    }
  }
  text(s.slice(last));
  return out;
}
