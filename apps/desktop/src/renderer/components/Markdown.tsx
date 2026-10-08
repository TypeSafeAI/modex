import { memo, type ReactNode } from "react";
import { tokenizeInline, type InlineToken } from "../../shared/inline";

/** Small, dependency-free Markdown subset: headings, fenced code, inline code, bold, links, lists, paragraphs. */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith("```")) code.push(lines[i++]!);
      i++;
      blocks.push(<pre key={key++} className="code" data-lang={lang}>{code.join("\n")}</pre>);
      continue;
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1]!.length;
      const content = inline(h[2]!);
      blocks.push(level === 1 ? <h2 key={key++}>{content}</h2> : level === 2 ? <h3 key={key++}>{content}</h3> : <h4 key={key++}>{content}</h4>);
      i++;
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const items: ReactNode[] = [];
      const ordered = /^\s*\d+\./.test(line);
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i]!)) items.push(<li key={i}>{inline(lines[i]!.replace(/^\s*([-*]|\d+\.)\s+/, ""))}</li>), i++;
      blocks.push(ordered ? <ol key={key++}>{items}</ol> : <ul key={key++}>{items}</ul>);
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !lines[i]!.startsWith("```") && !/^(#{1,3})\s/.test(lines[i]!) && !/^\s*([-*]|\d+\.)\s+/.test(lines[i]!)) para.push(lines[i++]!);
    blocks.push(<p key={key++}>{inline(para.join(" "))}</p>);
  }
  return <div className="md">{blocks}</div>;
});

function inline(s: string): ReactNode[] {
  return nodes(tokenizeInline(s));
}

/** Links open in the system browser: main denies the new window and hands http(s) URLs to the OS. */
function nodes(tokens: InlineToken[]): ReactNode[] {
  return tokens.map((t, k) =>
    t.type === "text" ? t.text
    : t.type === "code" ? <code key={k}>{t.text}</code>
    : t.type === "bold" ? <b key={k}>{nodes(t.children)}</b>
    : <a key={k} href={t.href} target="_blank" rel="noreferrer" title={t.href}>{nodes(t.children)}</a>,
  );
}
