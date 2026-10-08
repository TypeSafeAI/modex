import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { BlockRenderer, InlineContent } from "@create-markdown/react";
import type { Block } from "@create-markdown/core";
import { IconButton } from "../components/ui/IconButton";
import { BLOCK_COMMANDS, safeBlocks } from "./markdown";
import { joinMarkdown, splitMarkdown, toggleChecklist, type EditorBlock } from "../../shared/space-markdown";

export function BlockEditor({ markdown, onChange }: { markdown: string; onChange: (value: string) => void }) {
  const [blocks, setBlocks] = useState(() => splitMarkdown(markdown));
  const [editing, setEditing] = useState<string | null>(() => markdown ? null : blocks[0]!.id);
  const [choice, setChoice] = useState(0);
  const inputs = useRef(new Map<string, HTMLTextAreaElement>());
  const commit = (next: EditorBlock[]) => { setBlocks(next); onChange(joinMarkdown(next)); };
  const update = (id: string, source: string) => commit(blocks.map(b => b.id === id ? { ...b, source } : b));
  const focus = (id: string, position?: number) => {
    setEditing(id);
    requestAnimationFrame(() => {
      const input = inputs.current.get(id);
      input?.focus();
      const at = position ?? input?.value.length ?? 0;
      input?.setSelectionRange(at, at);
    });
  };
  const insert = (index: number, source = "") => {
    const next = { id: crypto.randomUUID(), source };
    commit([...blocks.slice(0, index + 1), next, ...blocks.slice(index + 1)]);
    focus(next.id);
  };
  const remove = (index: number) => {
    if (blocks.length === 1) { update(blocks[0]!.id, ""); focus(blocks[0]!.id); return; }
    const next = blocks.filter((_, i) => i !== index);
    commit(next);
    focus(next[Math.max(0, index - 1)]!.id);
  };
  const move = (index: number, delta: number) => {
    const next = [...blocks];
    const [block] = next.splice(index, 1);
    next.splice(index + delta, 0, block!);
    commit(next);
    focus(block!.id);
  };
  const format = (marker: string) => {
    const input = editing ? inputs.current.get(editing) : null;
    if (!input || !editing) return;
    const { selectionStart: start, selectionEnd: end, value } = input;
    update(editing, value.slice(0, start) + marker + value.slice(start, end) + marker + value.slice(end));
    requestAnimationFrame(() => { input.focus(); input.setSelectionRange(start + marker.length, end + marker.length); });
  };
  const applyCommand = (id: string, source: string) => { update(id, source); setChoice(0); focus(id, source.startsWith("```") ? 4 : undefined); };

  return <section className="space-editor" aria-label="Page content">
    <div className="space-format-bar" role="toolbar" aria-label="Text formatting">
      <button aria-label="Bold" disabled={!editing} onMouseDown={e => e.preventDefault()} onClick={() => format("**")}><strong>B</strong></button>
      <button aria-label="Italic" disabled={!editing} onMouseDown={e => e.preventDefault()} onClick={() => format("*")}><em>I</em></button>
      <button aria-label="Inline code" disabled={!editing} onMouseDown={e => e.preventDefault()} onClick={() => format("`")}>‹/›</button>
      <span />
      <span className="space-writing-hint">Markdown supported <span aria-hidden="true">·</span> <kbd>/</kbd> for blocks</span>
    </div>
    {blocks.map((block, index) => {
      const slash = editing === block.id && /^\/[^\n]*$/.test(block.source);
      const commands = slash ? BLOCK_COMMANDS.filter(c => `${c.name} ${c.hint}`.toLowerCase().includes(block.source.slice(1).toLowerCase())) : [];
      const activeChoice = Math.min(choice, Math.max(0, commands.length - 1));
      return <div className={`space-block${editing === block.id ? " editing" : ""}`} key={block.id} data-testid="space-block">
        <div className="space-block-tools">
          <IconButton icon="plus" label={`Insert block after ${index + 1}`} onClick={() => insert(index, "/")} />
          <details className="space-block-actions">
            <summary aria-label={`Actions for block ${index + 1}`}>⠿</summary>
            <div className="space-block-popover">
              <button disabled={index === 0} onClick={() => move(index, -1)}>Move up</button>
              <button disabled={index === blocks.length - 1} onClick={() => move(index, 1)}>Move down</button>
              <button onClick={() => insert(index, block.source)}>Duplicate block</button>
              <button onClick={() => remove(index)}>Delete block</button>
            </div>
          </details>
        </div>
        {editing === block.id ? <>
          <BlockInput value={block.source} label={`Block ${index + 1}`} inputRef={el => { if (el) inputs.current.set(block.id, el); else inputs.current.delete(block.id); }}
            onChange={value => { setChoice(0); update(block.id, value); }}
            onBlur={event => {
              if (event.relatedTarget && (event.relatedTarget as HTMLElement).closest(".space-format-bar, .space-slash")) return;
              if (!slash) setEditing(null);
            }}
            onKeyDown={event => {
              if (event.nativeEvent.isComposing) return;
              if ((event.metaKey || event.ctrlKey) && ["b", "i"].includes(event.key.toLowerCase())) { event.preventDefault(); format(event.key.toLowerCase() === "b" ? "**" : "*"); return; }
              if (slash && ["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); setChoice((activeChoice + (event.key === "ArrowDown" ? 1 : -1) + commands.length) % Math.max(1, commands.length)); return; }
              if (slash && event.key === "Enter") { event.preventDefault(); if (commands[activeChoice]) applyCommand(block.id, commands[activeChoice]!.source); return; }
              if (event.key === "Escape") { event.preventDefault(); if (slash) update(block.id, ""); setEditing(null); return; }
              if (event.key === "Backspace" && !block.source) { event.preventDefault(); remove(index); return; }
              if (event.key !== "Enter" || event.shiftKey || block.source.startsWith("```") || block.source.startsWith("|")) return;
              event.preventDefault();
              const input = event.currentTarget;
              const before = block.source.slice(0, input.selectionStart);
              const after = block.source.slice(input.selectionEnd);
              const lineStart = before.lastIndexOf("\n") + 1;
              const line = before.slice(lineStart);
              const prefix = line.match(/^(\s*(?:[-*+] \[[ xX]\] |[-*+] |\d+\. ))/)?.[1]?.replace(/\[[xX]\]/, "[ ]") ?? "";
              if (prefix && (line.trim() !== prefix.trim() || after.trim())) {
                const continuation = prefix.replace(/\d+(?=\. )/, n => String(Number(n) + 1));
                update(block.id, before + "\n" + continuation + after);
                focus(block.id, before.length + 1 + continuation.length);
                return;
              }
              if (prefix && lineStart > 0) {
                const next = { id: crypto.randomUUID(), source: "" };
                commit([...blocks.slice(0, index), { ...block, source: before.slice(0, lineStart).trimEnd() }, next, ...blocks.slice(index + 1)]);
                focus(next.id);
                return;
              }
              if (prefix && before.trim() === prefix.trim() && !after.trim()) { update(block.id, ""); return; }
              const next = { id: crypto.randomUUID(), source: prefix + after };
              commit([...blocks.slice(0, index), { ...block, source: before }, next, ...blocks.slice(index + 1)]);
              focus(next.id);
            }} />
          {slash && <div className="space-slash" role="listbox" aria-label="Insert a block">
            <div className="space-slash-heading">ADD A BLOCK <span>↑ ↓ to browse</span></div>
            {commands.map((command, i) => <button key={command.name} role="option" aria-selected={i === activeChoice}
              onMouseDown={event => event.preventDefault()} onClick={() => applyCommand(block.id, command.source)}>
              <span className="space-command-symbol">{command.symbol}</span><span><strong>{command.name}</strong><small>{command.hint}</small></span>
            </button>)}
            {!commands.length && <p>No matching blocks. Try “heading” or “list”.</p>}
          </div>}
        </> : <BlockPreview source={block.source} label={`Edit block ${index + 1}`} onEdit={() => focus(block.id)} onChange={source => update(block.id, source)} />}
      </div>;
    })}
    <button aria-label="Add a block" className="space-add-block" onClick={() => insert(blocks.length - 1, "/")}><span>+</span> Add a block</button>
  </section>;
}

function BlockInput({ value, label, inputRef, ...events }: {
  value: string; label: string; inputRef: (node: HTMLTextAreaElement | null) => void; onChange: (value: string) => void;
  onKeyDown: React.KeyboardEventHandler<HTMLTextAreaElement>; onBlur: React.FocusEventHandler<HTMLTextAreaElement>;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useLayoutEffect(() => { if (ref.current) { ref.current.style.height = "0px"; ref.current.style.height = `${ref.current.scrollHeight}px`; } }, [value]);
  const heading = value.match(/^(#{1,3}) /)?.[1]?.length;
  return <textarea ref={el => { ref.current = el; inputRef(el); }} className={`space-block-input${heading ? ` heading-${heading}` : ""}${value.startsWith("```") ? " code" : ""}`} rows={1} aria-label={label} placeholder="Type / for blocks, or just start writing…" value={value} onChange={e => events.onChange(e.target.value)} onKeyDown={events.onKeyDown} onBlur={events.onBlur} spellCheck={!value.startsWith("```")} />;
}

function BlockPreview({ source, label, onEdit, onChange }: { source: string; label: string; onEdit: () => void; onChange: (value: string) => void }) {
  const blocks = useMemo(() => safeBlocks(source), [source]);
  const checklists: Block[] = [];
  const collect = (items: Block[]) => { for (const item of items) { if (item.type === "checkList") checklists.push(item); collect(item.children); } };
  collect(blocks);
  const list = (block: Block) => {
    const Tag = block.type === "numberedList" ? "ol" : "ul";
    return <Tag>{block.children.map(item => <li key={item.id}><InlineContent spans={item.content} /><BlockRenderer blocks={item.children} customRenderers={renderers} /></li>)}</Tag>;
  };
  const renderers: NonNullable<React.ComponentProps<typeof BlockRenderer>["customRenderers"]> = {
    bulletList: ({ block }) => list(block),
    numberedList: ({ block }) => list(block),
    checkList: ({ block }) => <><label className="space-check"><input type="checkbox" checked={block.props.checked} onChange={e => onChange(toggleChecklist(source, checklists.indexOf(block), e.target.checked))} /><span><InlineContent spans={block.content} /></span></label><BlockRenderer blocks={block.children} customRenderers={renderers} /></>,
    callout: ({ block }) => <aside className="space-callout"><InlineContent spans={block.content} /></aside>,
  };
  const ref = useRef<HTMLDivElement>(null);
  // The package renderer does not expose link attributes. Apply the app's external-link contract.
  useLayoutEffect(() => { ref.current?.querySelectorAll("a").forEach(link => { link.target = "_blank"; link.rel = "noopener noreferrer"; }); }, [blocks]);
  return <div ref={ref} className="space-block-preview" tabIndex={0} aria-label={label}
    onClick={event => { if (!(event.target as HTMLElement).closest("a, input, button")) onEdit(); }}
    onKeyDown={event => { if (event.target === event.currentTarget && ["Enter", " "].includes(event.key)) { event.preventDefault(); onEdit(); } }}>
    {blocks.length ? <BlockRenderer blocks={blocks} customRenderers={renderers} /> : <p className="space-placeholder">Type / for blocks, or just start writing…</p>}
  </div>;
}
