import { Icon } from "./ui/Icon";

export function FileIcon({ path }: { path: string }) {
  return /\.(jsonl?|[cm]?[jt]sx?)$/.test(path) ? <span className="file-code-icon" aria-hidden="true">{"{}"}</span> : <Icon name="file" size={15} />;
}

/** Gutter numbers follow each hunk, including removed lines; headers never masquerade as code. */
export interface DiffRow { kind: "context" | "add" | "del"; text: string; oldLine: number | null; newLine: number | null; noNewline: boolean }

export function Diff({ text = "", rows, wrap = true, highlight = true, onExpand, onLine, tokens, tabbable = false }: { text?: string; rows?: readonly DiffRow[]; tokens?: ReadonlyMap<DiffRow, readonly string[]>; tabbable?: boolean; wrap?: boolean; highlight?: boolean; onExpand?: () => void; onLine?: (side: "base" | "head", line: number) => void }) {
  if (rows) return <div className={`review-code cr-code${wrap ? " wrap" : ""}${highlight ? " highlight" : ""}`} data-testid="diff">
    {rows.map((row, i) => <div key={i}>
      <div className={`review-code-line ${row.kind}`} data-line={row.kind} data-old-line={row.oldLine ?? undefined} data-new-line={row.newLine ?? undefined}>
        {(["base", "head"] as const).map(side => {
          const n = side === "base" ? row.oldLine : row.newLine;
          return <button key={side} type="button" className="line-number" tabIndex={tabbable && i === 0 && (side === "base" ? row.oldLine !== null : row.oldLine === null) ? 0 : -1} disabled={n === null} aria-label={`${side === "base" ? "Old" : "New"} line ${n ?? "absent"}`} onClick={() => { if (n !== null) onLine?.(side, n); }}>{n ?? ""}</button>;
        })}
        <span className="cr-line-sign" aria-label={row.kind === "add" ? "Added" : row.kind === "del" ? "Removed" : "Unchanged"}>{row.kind === "add" ? "+" : row.kind === "del" ? "−" : " "}</span>
        <code>{highlight && tokens?.has(row) ? <Syntax text={row.text} parts={tokens.get(row)} /> : row.text}</code>
      </div>
      {row.noNewline && <div className="diff-no-newline">No newline at end of file</div>}
    </div>)}
  </div>;
  if (!text) return <p className="hint pad">No textual diff.</p>;
  let oldLine = 0, newLine = 0, end = 0, inHunk = false;
  return <div className={`review-code${wrap ? " wrap" : ""}${highlight ? " highlight" : ""}`} data-testid="diff">
    {text.split("\n").map((line, i) => {
      const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (hunk) {
        oldLine = Number(hunk[1]); newLine = Number(hunk[2]); inHunk = true;
        const hidden = Math.max(0, newLine - end - 1);
        return hidden ? <button key={i} className="diff-fold" onClick={onExpand}><Icon name="chevron-up" size={14} /><span>{hidden} unmodified lines</span></button> : null;
      }
      if (!inHunk) return /^(Binary files|GIT binary patch|rename from|rename to)/.test(line) ? <div className="hint pad" key={i}>{line}</div> : null;
      if (line.startsWith("\\")) return <div key={i} className="diff-no-newline">{line.slice(2)}</div>;
      if (!/^[ +\-]/.test(line)) return null;
      const kind = line[0] === "+" ? "add" : line[0] === "-" ? "del" : "context";
      const number = kind === "del" ? oldLine++ : newLine++;
      if (kind === "context") oldLine++;
      if (kind !== "del") end = number;
      return <div key={i} className={`review-code-line ${kind}`} data-line={kind}><span className="line-number">{number}</span><code><Syntax text={line.slice(1)} /></code></div>;
    })}
  </div>;
}

function Syntax({ text, parts }: { text: string; parts?: readonly string[] }) {
  return <>{(parts ?? text.split(/("(?:[^"\\]|\\.)*"\s*:|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\b\d+(?:\.\d+)?\b|\b(?:true|false|null|const|let|return|function|export|import|from)\b)/g)).map((part, i) =>
    <span key={i} className={/^".*":$/.test(part) ? "syntax-key" : /^['"]/.test(part) ? "syntax-string" : /^(true|false|null|const|let|return|function|export|import|from)$/.test(part) ? "syntax-keyword" : /^\d/.test(part) ? "syntax-number" : undefined}>{part}</span>)}</>;
}
