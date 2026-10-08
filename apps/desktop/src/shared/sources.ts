import { domainOf, safeHref, trimBareUrl } from "./inline.js";

/**
 * The links behind a web answer, read from text the CLIs already produce: the "Sources:" list a
 * model ends its answer with, and Claude Code's WebSearch tool result. Pure and unit-tested from
 * test/sources.test.ts; parsing happens at render time, so saved threads need no migration.
 */
export interface SourceLink {
  title: string;
  url: string;
  domain: string;
}

const HEADING = /^\s*(?:#{1,6}\s+)?(?:\*\*|__)?\s*(?:sources?|references)\s*:?\s*(?:\*\*|__)?\s*:?\s*$/i;
const LIST_ITEM = /^\s*(?:[-*+•]|\d+[.)])\s+(.*)$/;
const MD_LINK = /\[([^\]\n]+)\]\(((?:[^\s()]|\([^\s()]*\))+)\)/;
const BARE_URL = /https?:\/\/[^\s<>`]+/;
function link(title: string, url: string): SourceLink {
  const domain = domainOf(url);
  const clean = title.replace(/\*\*|__|`/g, "").replace(/\s+/g, " ").trim();
  return { title: clean || domain, url, domain };
}

/** `[Title](url)`, `Title: url` or a bare `url`; null when the line names no web link. */
function sourceFrom(content: string): SourceLink | null {
  const md = MD_LINK.exec(content);
  const fromMd = md ? safeHref(md[2]!) : null;
  // Cards replace the entire source line; preserve prose or additional links around a citation.
  if (md) {
    if (md[0] !== content.trim()) return null;
    return fromMd ? link(md[1]!, fromMd) : null;
  }
  const bare = BARE_URL.exec(content);
  if (!bare) return null;
  const raw = trimBareUrl(bare[0]);
  if (!/^[\s).,\]>!?;'"]*$/.test(content.slice(bare.index + raw.length))) return null;
  const url = safeHref(raw);
  if (!url) return null;
  // What is left once the URL is lifted out is the title: drop the separators and brackets that held it.
  const label = (content.slice(0, bare.index) + content.slice(bare.index + raw.length))
    .replace(/\(\s*\)|\[\s*\]|<\s*>/g, "")
    .replace(/^[\s\-–—:|]+/, "")
    .replace(/[\s\-–—:|.,;]+$/, "");
  return link(label, url);
}

/**
 * Splits a trailing "Sources:" list off an answer. Only a heading followed by nothing but links
 * counts; anything else (prose after the list, a heading inside a code block) leaves the text whole.
 */
export function splitSources(text: string): { body: string; sources: SourceLink[] } {
  const whole = { body: text, sources: [] };
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let at = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (HEADING.test(lines[i]!)) { at = i; break; }
  }
  if (at < 0) return whole;
  if (lines.slice(0, at).filter((l) => l.startsWith("```")).length % 2 === 1) return whole;
  const sources: SourceLink[] = [];
  const seen = new Set<string>();
  for (const line of lines.slice(at + 1)) {
    if (!line.trim()) continue;
    const source = sourceFrom(LIST_ITEM.exec(line)?.[1] ?? line);
    if (!source) return whole;
    if (seen.has(source.url)) continue;
    seen.add(source.url);
    sources.push(source);
  }
  if (!sources.length) return whole;
  return { body: lines.slice(0, at).join("\n").trimEnd(), sources };
}

export interface WebSearch {
  query: string;
  links: SourceLink[];
  /** What the search tool told the model about the results, as Markdown. */
  summary: string;
}

const PAIR = /\{\s*"title"\s*:\s*("(?:[^"\\]|\\.)*")\s*,\s*"url"\s*:\s*("(?:[^"\\]|\\.)*")/g;

function linksFrom(json: string): SourceLink[] {
  let entries: unknown;
  try {
    entries = JSON.parse(json);
  } catch {
    // A cut-off array still yields every complete entry.
    entries = [...json.matchAll(PAIR)].flatMap((m) => {
      try {
        return [{ title: JSON.parse(m[1]!) as unknown, url: JSON.parse(m[2]!) as unknown }];
      } catch {
        return [];
      }
    });
  }
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((e: { title?: unknown; url?: unknown } | null) => {
    const url = typeof e?.url === "string" ? safeHref(e.url) : null;
    return url ? [link(typeof e?.title === "string" ? e.title : "", url)] : [];
  });
}

/**
 * Reads Claude Code's WebSearch tool result: a `Web search results for query: "…"` line, one or
 * more `Links: [{"title","url"}, …]` lines, and a summary. Null when the output is something else
 * (an error, another CLI's format), so the caller shows it verbatim.
 */
export function parseWebSearch(output: string): WebSearch | null {
  let query = "";
  let matched = false;
  const links: SourceLink[] = [];
  const seen = new Set<string>();
  const rest: string[] = [];
  for (const line of output.replace(/\r\n/g, "\n").split("\n")) {
    const head = /^Web search results for query: "(.*)"\s*$/.exec(line);
    if (head) {
      query ||= head[1]!;
      matched = true;
    } else if (/^Links:\s*\[/.test(line)) {
      matched = true;
      for (const l of linksFrom(line.replace(/^Links:\s*/, ""))) {
        if (seen.has(l.url)) continue;
        seen.add(l.url);
        links.push(l);
      }
    } else if (!/^\s*REMINDER:/.test(line)) {
      // The reminder is an instruction to the model, not part of the results.
      rest.push(line);
    }
  }
  if (!matched) return null;
  return { query, links, summary: rest.join("\n").replace(/\n{3,}/g, "\n\n").trim() };
}
