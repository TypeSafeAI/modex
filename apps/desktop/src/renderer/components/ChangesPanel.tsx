import { useEffect, useRef, useState } from "react";
import type { ChangesSnapshot, Thread } from "../../shared/types";
import { bridge } from "../bridge";
import { Icon } from "./ui/Icon";
import { IconButton } from "./ui/IconButton";
import { Menu, MenuItem } from "./ui/Menu";

interface Props { thread: Thread; changes: ChangesSnapshot | null; onRefresh: () => void; onRevert: (path: string) => void }

/** Review occupies a workspace tab; the diff and its file tree scroll independently. */
export function ChangesPanel({ thread, changes, onRefresh, onRevert }: Props) {
  const [selection, setSelection] = useState<string | null>(null);
  const file = changes?.files.some((entry) => entry.path === selection) ? selection : changes?.files[0]?.path ?? null;
  const entry = changes?.files.find((entry) => entry.path === file);
  const [expanded, setExpanded] = useState(false);
  const [result, setResult] = useState<{ file: string; snapshot: ChangesSnapshot | null; expanded: boolean; text: string; error?: string } | null>(null);
  const diff = result?.file === file && result.snapshot === changes && result.expanded === expanded ? result : null;
  const [filter, setFilter] = useState("");
  const [tree, setTree] = useState(true);
  const [highlight, setHighlight] = useState(true);
  const [wrap, setWrap] = useState(true);
  const [menu, setMenu] = useState(false);
  const [branchMenu, setBranchMenu] = useState(false);
  const menuRef = useRef<HTMLButtonElement>(null);
  const branchRef = useRef<HTMLButtonElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  useEffect(() => { setExpanded(false); }, [file]);
  useEffect(() => {
    if (!file) return;
    let live = true;
    void bridge.invoke("changes:diff", { threadId: thread.id, path: file, original: entry?.original, fullContext: expanded }).then(
      (text) => { if (live) setResult({ file, snapshot: changes, expanded, text }); },
      (error: Error) => { if (live) setResult({ file, snapshot: changes, expanded, text: "", error: error.message }); },
    );
    return () => { live = false; };
  }, [file, thread.id, changes, entry?.original, expanded]);
  const totals = (changes?.files ?? []).reduce((acc, f) => ({ a: acc.a + f.additions, d: acc.d + f.deletions }), { a: 0, d: 0 });
  const paths = (changes?.files ?? []).filter((f) => f.path.toLowerCase().includes(filter.toLowerCase())).sort((a, b) => Number(a.code === "??") - Number(b.code === "??") || a.path.localeCompare(b.path));
  const groups = new Map<string, typeof paths>();
  for (const f of paths) {
    const folder = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "";
    groups.set(folder, [...(groups.get(folder) ?? []), f]);
  }
  return <section className="review-panel" data-testid="changes-panel" aria-label="Review changes">
    <header className="review-toolbar">
      <span className="workspace-menu-anchor">
        <button className="review-branch" ref={branchRef} aria-haspopup="menu" aria-expanded={branchMenu} onClick={() => setBranchMenu(!branchMenu)}>Branch <Icon name="chevron-down" size={12} /></button>
        <Menu open={branchMenu} anchorRef={branchRef} onClose={() => setBranchMenu(false)} label="Review scope" placement="bottom-start">
          <MenuItem checkable selected onClick={() => setBranchMenu(false)}>Working tree against HEAD</MenuItem>
        </Menu>
      </span>
      <span className="stat add">+{totals.a}</span><span className="stat del">-{totals.d}</span>
      <span className="spacer" />
      <div className="review-actions">
        <span className="workspace-menu-anchor">
          <IconButton ref={menuRef} icon="more" label="Review options" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)} />
          <Menu open={menu} anchorRef={menuRef} onClose={() => setMenu(false)} label="Review options" placement="bottom-end">
            <MenuItem toggle selected={expanded} onClick={() => { setExpanded(!expanded); setMenu(false); }}>Show all unchanged lines</MenuItem>
            <MenuItem disabled={!file} onClick={() => { setMenu(false); if (file) void bridge.invoke("clipboard:write", { text: file }); }}>Copy file path</MenuItem>
            <MenuItem disabled={!file} className="danger" onClick={() => { setMenu(false); if (file) onRevert(file); }}>Discard changes to file</MenuItem>
          </Menu>
        </span>
        <IconButton icon="search" label="Filter changed files" onClick={() => { setTree(true); requestAnimationFrame(() => filterRef.current?.focus()); }} />
        <IconButton icon="restart" label="Refresh changes" data-testid="changes-refresh" onClick={onRefresh} />
        <IconButton icon="wrap" label="Wrap lines" aria-pressed={wrap} onClick={() => setWrap(!wrap)} />
        <IconButton icon="fold" label="Show all unchanged lines" aria-pressed={expanded} onClick={() => setExpanded(!expanded)} />
        <IconButton icon="diff-color" label="Highlight changes" aria-pressed={highlight} onClick={() => setHighlight(!highlight)} />
        <IconButton icon="folder" label="Show file tree" className={tree ? "on" : ""} aria-pressed={tree} onClick={() => setTree(!tree)} />
      </div>
    </header>
    <div className="review-base"><span>{changes?.branch ?? "Working tree"}</span><Icon name="arrow-right" size={13} /><span>HEAD</span><Icon name="chevron-down" size={12} /></div>
    {!changes ? <p className="hint pad" role="status">Loading…</p> : !changes.isRepo ? <p className="hint pad">Not a git repository — changes can't be tracked here.</p> : !changes.files.length ? <p className="hint pad">Working tree clean.</p> :
      <div className={`review-body${tree ? "" : " tree-hidden"}`}>
        <div className="review-diff" data-testid="changes-diff">
          <div className="review-file-heading"><FileIcon path={file ?? ""} /><span title={file ?? ""}><bdi dir="ltr">{file}</bdi></span><span className="stat add">+{entry?.additions ?? 0}</span><span className="stat del">-{entry?.deletions ?? 0}</span></div>
          {!diff ? <p className="hint pad" role="status">Loading diff…</p> : diff.error ? <p className="hint pad" role="alert">Could not load diff: {diff.error}</p> : <Diff text={diff.text} wrap={wrap} highlight={highlight} onExpand={() => setExpanded(true)} />}
        </div>
        {tree && <aside className="review-tree" data-testid="review-tree" aria-label="Changed files">
          <label className="review-filter"><Icon name="search" size={13} /><input ref={filterRef} data-testid="review-filter" aria-label="Filter files" placeholder="Filter files..." value={filter} onChange={(e) => setFilter(e.target.value)} /></label>
          {!paths.length && <p className="hint pad">No matching files.</p>}
          {[...groups].map(([folder, files]) => <FileGroup key={folder} folder={folder}>
            {files.map((f) => <div key={f.path} className={`review-file${file === f.path ? " selected" : ""}`} data-testid="changes-file" data-path={f.path} aria-current={file === f.path ? "true" : undefined}>
              <button className="review-file-select" aria-label={`View diff for ${f.path}`} aria-pressed={file === f.path} onClick={() => setSelection(f.path)}>
                <FileIcon path={f.path} /><span data-testid="changes-file-path" title={f.path}>{f.path.split("/").at(-1)}</span><span className={`review-status ${f.code === "??" ? "add" : "modified"}`}>{f.code === "??" ? "U" : f.code.includes("D") ? "D" : "▪"}</span>
              </button>
              <button className="review-revert" data-testid="changes-revert" aria-label={`Discard changes to ${f.path}`} title="Discard changes to this file" onClick={() => onRevert(f.path)}>↶</button>
            </div>)}
          </FileGroup>)}
        </aside>}
      </div>}
  </section>;
}

export function FileIcon({ path }: { path: string }) {
  return /\.(jsonl?|[cm]?[jt]sx?)$/.test(path) ? <span className="file-code-icon" aria-hidden="true">{"{}"}</span> : <Icon name="file" size={15} />;
}

export function FileGroup({ folder, children }: { folder: string; children: React.ReactNode }) {
  if (!folder) return <div>{children}</div>;
  return <details className="review-folder" open><summary><Icon name="chevron-down" size={12} /><span>{folder}</span><i className="folder-change-dot" aria-hidden="true" /></summary>{children}</details>;
}

/** Gutter numbers follow each hunk, including removed lines; headers never masquerade as code. */
export function Diff({ text, wrap = true, highlight = true, onExpand }: { text: string; wrap?: boolean; highlight?: boolean; onExpand?: () => void }) {
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

function Syntax({ text }: { text: string }) {
  return <>{text.split(/("(?:[^"\\]|\\.)*"\s*:|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\b\d+(?:\.\d+)?\b|\b(?:true|false|null|const|let|return|function|export|import|from)\b)/g).map((part, i) =>
    <span key={i} className={/^".*":$/.test(part) ? "syntax-key" : /^['"]/.test(part) ? "syntax-string" : /^(true|false|null|const|let|return|function|export|import|from)$/.test(part) ? "syntax-keyword" : /^\d/.test(part) ? "syntax-number" : undefined}>{part}</span>)}</>;
}
