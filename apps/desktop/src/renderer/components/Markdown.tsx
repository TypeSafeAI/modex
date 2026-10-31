import { cloneElement, createContext, isValidElement, memo, useContext, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import type { Definition, ListItem, Nodes, Parents, PhrasingContent, RootContent, TableRow } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { safeHref } from "../../shared/inline";
import { CodeBlock } from "./transcript/CodeBlock";

/**
 * Markdown as the transcript shows it: CommonMark with GitHub's extensions (tables, task lists,
 * strikethrough, autolinks, footnotes), parsed by micromark and rendered as React elements only.
 * Raw HTML stays text, only http(s) links are links (main hands them to the system browser), and
 * images are never fetched. An unclosed code fence runs to the end, so a streaming fence shows its
 * code so far.
 */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  // Text that changed in the last moment is still streaming: parse only its last block again, and
  // the whole text once it has rested, so the settled rendering is always the exact one.
  const [settled, setSettled] = useState(text);
  useEffect(() => {
    if (text === settled) return;
    const timer = setTimeout(() => setSettled(text), STREAM_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [text, settled]);
  // Far from the newest turns, text shows as written until it nears the transcript's view, then
  // parses once and stays parsed. Text parsed earlier in this session renders at once.
  const root = useContext(DeferMarkdown);
  const [near, setNear] = useState(() => !root || settledRenders.has(text));
  const deferred = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = deferred.current;
    if (near || !root || !el) return;
    const observer = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) setNear(true); },
      { root: root.current, rootMargin: DEFER_MARGIN });
    observer.observe(el);
    return () => observer.disconnect();
  }, [near, root]);
  if (!near) return <div className="md md-deferred" ref={deferred} data-markdown-deferred="">{text}</div>;
  if (text === settled) return <div className="md">{settledBlocks(text)}</div>;
  // Keep the same top-level React structure during streaming and settling. Wrapping chunks
  // in component boundaries remounted every code block on the first delta and at settlement,
  // dropping keyboard focus, selections and Copy state even when that block was unchanged.
  const chunks = streamingChunks(text);
  const nodes = chunks.flatMap((chunk, index) => index < chunks.length - 1 ? settledBlocks(chunk) : render(chunk));
  return <div className="md">{nodes.map((node, key) => isValidElement(node) ? cloneElement(node, { key }) : node)}</div>;
});

/** How long text must stop changing before it is parsed whole again. */
const STREAM_SETTLE_MS = 300;

/**
 * Provided around transcript turns far from the newest, with the transcript's scroller: Markdown
 * inside parses only once it comes within `DEFER_MARGIN` of that view. Opening a long thread then
 * parses what is on screen, not every answer above it.
 */
export const DeferMarkdown = createContext<RefObject<HTMLElement | null> | null>(null);
const DEFER_MARGIN = "1500px 0px";

function render(text: string): ReactNode[] {
  const tree = fromMarkdown(text, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  const definitions = new Map<string, Definition>();
  collectDefinitions(tree, definitions);
  return blocks(tree.children, { source: text, definitions, tight: false });
}

/** Renders by text, keeping the most recent `entries` results for texts of at most `maxChars`. */
export class RenderCache {
  private readonly kept = new Map<string, unknown>();
  constructor(private readonly entries: number, private readonly maxChars: number) {}
  get size(): number { return this.kept.size; }
  has(text: string): boolean { return this.kept.has(text); }
  get<T>(text: string, make: () => T): T {
    if (text.length > this.maxChars) return make();
    if (this.kept.has(text)) {
      const hit = this.kept.get(text) as T;
      this.kept.delete(text);
      this.kept.set(text, hit);
      return hit;
    }
    const made = make();
    this.kept.set(text, made);
    if (this.kept.size > this.entries) this.kept.delete(this.kept.keys().next().value!);
    return made;
  }
}

/**
 * Settled text, rendered once per app session: reopening a thread or switching back to one reuses
 * the elements instead of parsing every message again. Only completed streaming chunks are cached;
 * the changing tail and very long text such as a fetched page are not kept.
 */
const settledRenders = new RenderCache(400, 64_000);
function settledBlocks(text: string): ReactNode[] {
  return settledRenders.get(text, () => render(text));
}

/**
 * Splits text after each blank line that is outside a fenced code block, so a streaming reply
 * re-parses only its last piece. Joining the pieces gives the text back. Context-dependent
 * documents stay whole so references and nested containers retain their meaning.
 */
export function streamingChunks(text: string): string[] {
  // These constructs reach across blank lines; retain their document context while streaming.
  if (/^(?: {0,3}(?:>|[-+*]\s|\d+[.)]\s|\[[^\n]+\]:)| {4}|\t)/m.test(text)) return [text];
  const chunks: string[] = [];
  let start = 0;
  let fence: { char: string; length: number } | null = null;
  for (let at = 0; at < text.length;) {
    const newline = text.indexOf("\n", at);
    const end = newline < 0 ? text.length : newline + 1;
    const line = text.slice(at, newline < 0 ? text.length : newline);
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1]![0] === fence.char && marker[1]!.length >= fence.length && !marker[2]!.trim()) fence = null;
    } else if (marker && !(marker[1]![0] === "`" && marker[2]!.includes("`"))) {
      fence = { char: marker[1]![0]!, length: marker[1]!.length };
    } else if (!line.trim() && at > start) {
      chunks.push(text.slice(start, end));
      start = end;
    }
    at = end;
  }
  if (start < text.length) chunks.push(text.slice(start));
  return chunks;
}

interface Context {
  source: string;
  definitions: Map<string, Definition>;
  /** Inside a tight list item, paragraphs render as bare text. */
  tight: boolean;
}

function collectDefinitions(node: Nodes, into: Map<string, Definition>): void {
  if (node.type === "definition" && !into.has(node.identifier)) into.set(node.identifier, node);
  if ("children" in node) for (const child of node.children) collectDefinitions(child, into);
}

/** The Markdown exactly as written, for constructs Modex will not turn into elements. */
function written(node: Nodes, ctx: Context): string {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  return start === undefined || end === undefined ? "" : ctx.source.slice(start, end);
}

function blocks(nodes: RootContent[], ctx: Context): ReactNode[] {
  return nodes.map((node, key) => block(node, key, ctx));
}

function block(node: RootContent, key: number, ctx: Context): ReactNode {
  switch (node.type) {
    case "paragraph":
      return ctx.tight ? <span key={key}>{inline(node.children, ctx)}</span> : <p key={key}>{inline(node.children, ctx)}</p>;
    case "heading": {
      // The transcript's own titles sit above a reply's headings: `#` reads as a section, not the page.
      const Tag = (["h2", "h3", "h4", "h5", "h6", "h6"] as const)[node.depth - 1]!;
      return <Tag key={key}>{inline(node.children, ctx)}</Tag>;
    }
    case "code":
      return <CodeBlock key={key} code={node.value} lang={node.lang ?? undefined} />;
    case "blockquote":
      return <blockquote key={key}>{blocks(node.children, { ...ctx, tight: false })}</blockquote>;
    case "list": {
      const items = node.children.map((item, i) => listItem(item, i, { ...ctx, tight: !node.spread && !item.spread }));
      return node.ordered ? <ol key={key} start={node.start != null && node.start !== 1 ? node.start : undefined}>{items}</ol> : <ul key={key}>{items}</ul>;
    }
    case "thematicBreak":
      return <hr key={key} />;
    case "table": {
      const [head, ...body] = node.children;
      const align = node.align ?? [];
      const row = (r: TableRow, i: number, Cell: "th" | "td") => (
        <tr key={i}>{r.children.map((cell, c) => <Cell key={c} style={align[c] ? { textAlign: align[c]! } : undefined}>{inline(cell.children, ctx)}</Cell>)}</tr>
      );
      return (
        <div key={key} className="md-table" tabIndex={0} role="region" aria-label="Markdown table">
          <table>
            {head && <thead>{row(head, 0, "th")}</thead>}
            {body.length > 0 && <tbody>{body.map((r, i) => row(r, i, "td"))}</tbody>}
          </table>
        </div>
      );
    }
    case "html":
      // Raw HTML is shown, never interpreted.
      return <p key={key}>{node.value}</p>;
    case "footnoteDefinition":
      return <div key={key} className="footnote"><sup>{node.label ?? node.identifier}</sup> {blocks(node.children, { ...ctx, tight: true })}</div>;
    case "definition":
      return null;
    default:
      return "children" in node ? <div key={key}>{blocks((node as Parents).children as RootContent[], ctx)}</div> : null;
  }
}

function listItem(item: ListItem, key: number, ctx: Context): ReactNode {
  const children = blocks(item.children, ctx);
  if (typeof item.checked !== "boolean") return <li key={key}>{children}</li>;
  // A task list's boxes are a record of the text, not controls: they cannot be ticked.
  return <li key={key} className="task"><input type="checkbox" disabled defaultChecked={item.checked} /> {children}</li>;
}

function inline(nodes: PhrasingContent[], ctx: Context): ReactNode[] {
  return nodes.map((node, key) => phrase(node, key, ctx));
}

function phrase(node: PhrasingContent, key: number, ctx: Context): ReactNode {
  switch (node.type) {
    case "text":
      return node.value;
    case "emphasis":
      return <em key={key}>{inline(node.children, ctx)}</em>;
    case "strong":
      return <strong key={key}>{inline(node.children, ctx)}</strong>;
    case "delete":
      return <del key={key}>{inline(node.children, ctx)}</del>;
    case "inlineCode":
      return <code key={key}>{node.value}</code>;
    case "break":
      return <br key={key} />;
    case "html":
      return node.value;
    case "link":
      return link(node.url, inline(node.children, ctx), node, key, ctx);
    case "linkReference": {
      const target = ctx.definitions.get(node.identifier);
      return target ? link(target.url, inline(node.children, ctx), node, key, ctx) : written(node, ctx);
    }
    case "image":
      return image(node.url, node.alt, node, key, ctx);
    case "imageReference": {
      const target = ctx.definitions.get(node.identifier);
      return target ? image(target.url, node.alt, node, key, ctx) : written(node, ctx);
    }
    case "footnoteReference":
      return <sup key={key} className="footnote-ref">[{node.label ?? node.identifier}]</sup>;
    default:
      return written(node, ctx);
  }
}

/** Links open in the system browser: main denies the new window and hands http(s) URLs to the OS. Other targets stay as written. */
function link(url: string, children: ReactNode, node: Nodes, key: number, ctx: Context): ReactNode {
  const href = safeHref(url);
  if (!href) return written(node, ctx);
  return <a key={key} href={href} target="_blank" rel="noreferrer" title={href}>{children}</a>;
}

/** An image is a link to it, named by its alt text: nothing is fetched while reading. */
function image(url: string, alt: string | null | undefined, node: Nodes, key: number, ctx: Context): ReactNode {
  const href = safeHref(url);
  if (!href) return written(node, ctx);
  return <a key={key} href={href} target="_blank" rel="noreferrer" title={href}>{alt ? `Image: ${alt}` : "Image"}</a>;
}
