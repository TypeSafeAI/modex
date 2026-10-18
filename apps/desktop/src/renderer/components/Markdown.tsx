import { memo, useEffect, useRef, useState, type ReactNode } from "react";
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
  // Text that changed in the last moment is still streaming: parse only its last piece again, and
  // the whole text once it has rested, so the settled rendering is always the exact one.
  const [settled, setSettled] = useState(text);
  useEffect(() => {
    if (text === settled) return;
    const timer = setTimeout(() => setSettled(text), STREAM_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [text, settled]);
  // This instance's renders of streaming pieces, by piece text: an unchanged piece is not parsed again.
  const streamed = useRef(new Map<string, ReactNode[]>());
  let pieces: ReactNode[][];
  if (text === settled) {
    pieces = settledPieces(text);
    streamed.current = new Map();
  } else {
    const next = new Map<string, ReactNode[]>();
    pieces = streamingChunks(text).map((chunk) => {
      const rendered = streamed.current.get(chunk) ?? next.get(chunk) ?? render(chunk);
      next.set(chunk, rendered);
      return rendered;
    });
    streamed.current = next;
  }
  // Both ways give one Piece per streaming piece, so settling updates each piece where it stands:
  // a selection, keyboard focus or a code block's Copied state inside the reply survives it.
  return <div className="md">{pieces.map((nodes, i) => <Piece key={i} nodes={nodes} />)}</div>;
});

/** How long text must stop changing before it is parsed whole again. */
const STREAM_SETTLE_MS = 300;

const Piece = memo(function Piece({ nodes }: { nodes: ReactNode[] }) {
  return <>{nodes}</>;
});

function parse(text: string) {
  const tree = fromMarkdown(text, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  const definitions = new Map<string, Definition>();
  collectDefinitions(tree, definitions);
  return { tree, ctx: { source: text, definitions, tight: false } as Context };
}

function render(text: string): ReactNode[] {
  const { tree, ctx } = parse(text);
  return blocks(tree.children, ctx);
}

/** Renders by text, keeping the most recent `entries` results for texts of at most `maxChars`. */
export class RenderCache {
  private readonly kept = new Map<string, unknown>();
  constructor(private readonly entries: number, private readonly maxChars: number) {}
  get size(): number { return this.kept.size; }
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
 * Settled text, parsed whole and grouped back into its streaming pieces: each top-level block goes to
 * the piece it starts in. Rendered once per app session, so reopening a thread or switching back to
 * one reuses the elements instead of parsing every message again. Streaming pieces are never cached
 * here, nor is very long text such as a fetched page.
 */
const settledRenders = new RenderCache(400, 64_000);
function settledPieces(text: string): ReactNode[][] {
  return settledRenders.get(text, () => {
    const chunks = streamingChunks(text);
    if (!chunks.length) return [];
    const { tree, ctx } = parse(text);
    const ends: number[] = [];
    let offset = 0;
    for (const chunk of chunks) ends.push(offset += chunk.length);
    const groups: RootContent[][] = chunks.map(() => []);
    for (const node of tree.children) {
      const start = node.position?.start.offset ?? 0;
      const at = ends.findIndex((end) => start < end);
      groups[at < 0 ? groups.length - 1 : at]!.push(node);
    }
    return groups.map((nodes) => blocks(nodes, ctx));
  });
}

/**
 * Splits text after each blank line that is outside a fenced code block, so a streaming reply
 * re-parses only its last piece. Joining the pieces gives the text back. A piece can read slightly
 * differently from the whole (a loose list shows as two lists) until the text settles.
 */
export function streamingChunks(text: string): string[] {
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
        <div key={key} className="md-table">
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
