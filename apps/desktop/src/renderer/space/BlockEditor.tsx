import { SecretInput, SecretTextarea } from "../streamer";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, Fragment, type ReactNode } from "react";
import { BlockRenderer, InlineContent } from "@create-markdown/react";
import type { Block } from "@create-markdown/core";
import { Icon } from "../components/ui/Icon";
import { IconButton } from "../components/ui/IconButton";
import { BLOCK_COMMANDS, safeBlocks } from "./markdown";
import { joinMarkdown, splitMarkdown, toggleChecklist, type EditorBlock } from "../../shared/space-markdown";

const commandCaret = (source: string) => source.startsWith("```") ? 4 : undefined;

export function BlockEditor({ markdown, onChange, insertRequest, onComment, onAsk, generation }: { markdown: string; onChange: (value: string) => void; insertRequest?: { source: string; nonce: number }; onComment?: (quote: string) => void; onAsk?: (instruction: string) => void; generation?: ReactNode }) {
  const [blocks, setBlocks] = useState(() => splitMarkdown(markdown));
  const [editing, setEditing] = useState<string | null>(() => markdown ? null : blocks[0]!.id);
  const [choice, setChoice] = useState(0);
  const editor = useRef<HTMLElement>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  const activeBlock = useRef<string | null>(null);
  const pendingToolbarFocus = useRef(false);
  const [selection, setSelection] = useState<{ id: string; text: string; start: number; end: number; top: number; bottom: number; below: boolean } | null>(null);
  const [linkURL, setLinkURL] = useState<string | null>(null);
  const validLink = linkURL !== null && /^(https?:\/\/|mailto:)[^\s<>]+$/i.test(linkURL.trim());
  const [editPrompt, setEditPrompt] = useState<string | null>(null);
  const captureSelection = () => {
    const input = editing ? inputs.current.get(editing) : null;
    const native = window.getSelection();
    const preview = native?.anchorNode?.parentElement?.closest<HTMLElement>(".space-block");
    const id = input ? editing : preview?.dataset.blockId;
    const block = blocks.find(block => block.id === id);
    if (block) activeBlock.current = block.id;
    const text = input ? input.value.slice(input.selectionStart, input.selectionEnd) : native?.toString() ?? "";
    if (!block || !text || !editor.current) { setSelection(null); return; }
    // Formatting a rendered selection is safe when it maps unambiguously to the source.
    let start = input ? input.selectionStart : block.source.indexOf(text);
    const rendered = preview?.querySelector(".space-block-preview");
    const range = native?.rangeCount ? native.getRangeAt(0) : null;
    const withinBlock = rendered && range && rendered.contains(range.startContainer) && rendered.contains(range.endContainer);
    // Plain paragraphs have exact DOM/source offsets, even when words repeat.
    const exactText = withinBlock && rendered.textContent === block.source;
    if (!input && exactText) {
      const before = range.cloneRange();
      before.selectNodeContents(rendered);
      before.setEnd(range.startContainer, range.startOffset);
      start = before.toString().length;
    }
    // Escapes, code and link/HTML syntax do not have one-to-one rendered offsets.
    // Keep those selections available for comments/requests; format them in source editing.
    const syntax = block.source.replace(/^\s*[-*+]\s+\[[ xX]\]\s/gm, "");
    const plain = !/[\\`\[\]<>]/.test(syntax) && !/[*_~\n]/.test(text);
    const mapped = input || (withinBlock && (exactText || plain && start >= 0 && start === block.source.lastIndexOf(text)));
    const rect = input?.getBoundingClientRect() ?? (native?.rangeCount ? native.getRangeAt(0).getBoundingClientRect() : null);
    const editorTop = editor.current.getBoundingClientRect().top;
    setSelection({ id: block.id, text, start: mapped ? start : -1, end: mapped ? start + text.length : -1,
      top: (rect?.top ?? editorTop) - editorTop - 8, bottom: (rect?.bottom ?? editorTop) - editorTop + 8, below: false });
  };
  useLayoutEffect(() => {
    const bar = toolbar.current;
    if (!bar || !selection) return;
    // A wrapped toolbar can be taller than one row. Measure it before paint so it
    // opens below selections that would otherwise cover the page title.
    const place = () => {
      const below = selection.top < bar.getBoundingClientRect().height;
      if (below !== selection.below) setSelection(current => current && { ...current, below });
    };
    place();
    const resize = new ResizeObserver(place);
    resize.observe(bar);
    return () => resize.disconnect();
  }, [selection]);
  useEffect(() => {
    const changed = () => {
      if (!document.activeElement?.closest(".space-format-bar")) captureSelection();
    };
    document.addEventListener("selectionchange", changed);
    return () => document.removeEventListener("selectionchange", changed);
  }, [blocks, editing]);
  const inputs = useRef(new Map<string, HTMLTextAreaElement>());
  const pendingPreviewFocus = useRef<string | null>(null);
  const pendingFocus = useRef<{ id: string; start?: number; end?: number } | null>(null);
  const source = useRef(markdown);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!editor.current?.contains(event.target as Node)) { setSelection(null); setEditPrompt(null); setLinkURL(null); }
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, []);
  useLayoutEffect(() => {
    if (markdown === source.current) return;
    pendingFocus.current = null;
    setSelection(null); setEditPrompt(null); setLinkURL(null);
    source.current = markdown; setBlocks(splitMarkdown(markdown)); setEditing(null);
  }, [markdown]);
  // Apply selection with the textarea commit, before a later user edit can supersede it.
  useLayoutEffect(() => {
    const request = pendingFocus.current;
    pendingFocus.current = null;
    if (!request || request.id !== editing) return;
    const input = inputs.current.get(request.id);
    if (!input) return;
    const start = request.start ?? input.value.length;
    input.focus();
    input.setSelectionRange(start, request.end ?? start);
  });
  useLayoutEffect(() => {
    if (pendingToolbarFocus.current) {
      pendingToolbarFocus.current = false;
      toolbar.current?.querySelector<HTMLButtonElement>("button")?.focus();
    }
    const id = pendingPreviewFocus.current;
    pendingPreviewFocus.current = null;
    if (id) Array.from(editor.current?.querySelectorAll<HTMLElement>(".space-block") ?? [])
      .find(block => block.dataset.blockId === id)?.querySelector<HTMLElement>(".space-block-preview")?.focus({ preventScroll: true });
  });
  const commit = (next: EditorBlock[]) => { source.current = joinMarkdown(next); setBlocks(next); onChange(source.current); };
  const update = (id: string, source: string) => commit(blocks.map(b => b.id === id ? { ...b, source } : b));
  const focus = (id: string, start?: number, end?: number) => {
    activeBlock.current = id;
    pendingFocus.current = { id, start, end };
    setEditing(id);
  };
  const insert = (index: number, source = "", position?: number) => {
    const next = { id: crypto.randomUUID(), source };
    commit([...blocks.slice(0, index + 1), next, ...blocks.slice(index + 1)]);
    focus(next.id, position);
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
  const format = (before: string, after = before) => {
    const input = editing ? inputs.current.get(editing) : null;
    const id = selection?.id ?? editing;
    const block = blocks.find(block => block.id === id);
    const start = selection?.start ?? input?.selectionStart ?? -1;
    const end = selection?.end ?? input?.selectionEnd ?? -1;
    if (!block || start < 0 || end < start) return;
    const value = block.source;
    const left = value.slice(0, start).match(/([*~`]+)$/)?.[0] ?? "";
    const right = value.slice(end).match(/^([*~`]+)/)?.[0] ?? "";
    const matching = before === after && left.endsWith(before) && right.startsWith(after);
    // A single star from **bold** is not an italic delimiter. Triple stars carry both styles.
    const unwrap = matching && (before !== "*" || (left.length % 2 === 1 && right.length % 2 === 1));
    update(block.id, unwrap
      ? value.slice(0, start - before.length) + value.slice(start, end) + value.slice(end + after.length)
      : value.slice(0, start) + before + value.slice(start, end) + after + value.slice(end));
    setSelection(null); setLinkURL(null);
    if (editing) focus(block.id, start + (unwrap ? -before.length : before.length), end + (unwrap ? -before.length : before.length));
    else { pendingPreviewFocus.current = block.id; window.getSelection()?.removeAllRanges(); }
  };
  const selectedBlock = blocks.find(block => block.id === selection?.id);
  const blockType = selectedBlock?.source.match(/^(#{1,3}) /)?.[1] ??
    (/^[-*+] \[[ xX]\] /.test(selectedBlock?.source ?? "") ? "check" : /^[-*+] /.test(selectedBlock?.source ?? "") ? "bullet" : /^\d+\. /.test(selectedBlock?.source ?? "") ? "number" : /^> /.test(selectedBlock?.source ?? "") ? "quote" : "text");
  const changeBlockType = (kind: string) => {
    if (!selectedBlock) return;
    const lines = selectedBlock.source.split("\n").map((line, index) => {
      const text = line.replace(/^(\s*)(?:#{1,6} |[-*+] (?:\[[ xX]\] )?|\d+\. |> )/, "$1");
      const indent = text.match(/^\s*/)?.[0] ?? "";
      const prefix = kind === "check" ? "- [ ] " : kind === "bullet" ? "- " : kind === "number" ? `${index + 1}. ` : kind === "quote" ? "> " : kind.startsWith("#") ? `${kind} ` : "";
      return indent + prefix + text.slice(indent.length);
    });
    pendingPreviewFocus.current = selectedBlock.id;
    update(selectedBlock.id, lines.join("\n")); setSelection(null); setEditing(null); window.getSelection()?.removeAllRanges();
  };
  const applyCommand = (id: string, source: string) => { update(id, source); setChoice(0); focus(id, commandCaret(source)); };
  const generationAnchor = useRef<string | null>(null);
  if (!generation) generationAnchor.current = null;
  else if (!blocks.some(block => block.id === generationAnchor.current)) generationAnchor.current = blocks.find(block => block.id === activeBlock.current)?.id ?? editing ?? blocks[0]?.id ?? null;
  const inserted = useRef(insertRequest?.nonce);
  useLayoutEffect(() => {
    if (!insertRequest || inserted.current === insertRequest.nonce) return;
    inserted.current = insertRequest.nonce;
    const index = blocks.findIndex(block => block.id === activeBlock.current);
    insert(index >= 0 ? index : blocks.length - 1, insertRequest.source, commandCaret(insertRequest.source));
  }, [insertRequest]);

  return <section ref={editor} className={`space-editor${editing ? " is-editing" : ""}`} aria-label="Page content" onMouseUp={captureSelection} onKeyUp={event => { if (event.key !== "Escape") captureSelection(); }} onSelect={captureSelection}
    onFocusCapture={event => { const block = (event.target as HTMLElement).closest<HTMLElement>(".space-block"); if (block) activeBlock.current = block.dataset.blockId ?? null; }}
    onPointerDownCapture={event => { const block = (event.target as HTMLElement).closest<HTMLElement>(".space-block"); if (block) activeBlock.current = block.dataset.blockId ?? null; }}
    onKeyDown={event => {
      if (event.defaultPrevented || event.nativeEvent.isComposing || !selection) return;
      if (event.key === "Escape") {
        event.preventDefault(); event.stopPropagation();
        if (linkURL !== null || editPrompt !== null) { pendingToolbarFocus.current = true; setLinkURL(null); setEditPrompt(null); }
        else { pendingPreviewFocus.current = selection.id; setSelection(null); window.getSelection()?.removeAllRanges(); }
        return;
      }
      if (editing || (event.target as HTMLElement).closest(".space-format-bar") || selection.start < 0) return;
      if (event.key === "Backspace" || event.key === "Delete") {
        const block = blocks.find(block => block.id === selection.id);
        if (!block) return;
        event.preventDefault(); event.stopPropagation();
        update(block.id, block.source.slice(0, selection.start) + block.source.slice(selection.end));
        const caret = selection.start;
        setSelection(null); setLinkURL(null); setEditPrompt(null);
        window.getSelection()?.removeAllRanges();
        focus(block.id, caret);
        return;
      }
      if (event.metaKey || event.ctrlKey) {
        const key = event.key.toLowerCase();
        if (["b", "i", "k"].includes(key)) {
          event.preventDefault();
          if (key === "k") setLinkURL(""); else format(key === "b" ? "**" : "*");
        }
      }
    }}>
    {selection && <div ref={toolbar} className={`space-format-bar${selection.below ? " below-selection" : ""}`} role="toolbar" aria-label="Text formatting" style={{ top: selection.below ? selection.bottom : selection.top }} onSelect={event => event.stopPropagation()} onKeyUp={event => event.stopPropagation()} onMouseUp={event => event.stopPropagation()} onMouseDown={event => event.preventDefault()}>
      {linkURL !== null ? <form className="space-selection-prompt" onSubmit={event => { event.preventDefault(); if (validLink) format("[", `](${linkURL.trim().replace(/\(/g, "%28").replace(/\)/g, "%29")})`); }}>
        <SecretInput aria-label="Link URL" placeholder="Paste a link…" value={linkURL} onChange={event => setLinkURL(event.target.value)} onMouseDown={event => event.stopPropagation()} autoFocus />
        <button aria-label="Apply link" disabled={!validLink}><Icon name="check" size={16} /></button>
        <button type="button" aria-label="Cancel link" onClick={() => setLinkURL(null)}><Icon name="close" size={14} /></button>
      </form> : editPrompt !== null ? <form className="space-selection-prompt" onSubmit={event => { event.preventDefault(); if (editPrompt.trim() && selection) { onAsk?.(`${editPrompt}\n\nSelected text: ${selection.text}`); setEditPrompt(null); setSelection(null); } }}>
        <SecretInput aria-label="Describe the edit" placeholder="Describe the edit…" value={editPrompt} onChange={event => setEditPrompt(event.target.value)} onMouseDown={event => event.stopPropagation()} autoFocus />
        <button aria-label="Send edit request" disabled={!editPrompt.trim()}><Icon name="arrow-up" size={16} /></button>
        <button type="button" aria-label="Cancel edit request" onClick={() => setEditPrompt(null)}><Icon name="close" size={14} /></button>
      </form> : <>
        {onAsk && <button className="space-selection-action" disabled={!selection} onClick={() => setEditPrompt("")}><Icon name="comment" size={13} />Ask for change</button>}
        <button aria-label="Bold" disabled={!editing && (!selection || selection.start < 0)} onClick={() => format("**")}><strong>B</strong></button>
        <button aria-label="Italic" disabled={!editing && (!selection || selection.start < 0)} onClick={() => format("*")}><em>I</em></button>
        <button aria-label="Strikethrough" disabled={!editing && (!selection || selection.start < 0)} onClick={() => format("~~")}><s>S</s></button>
        <button aria-label="Inline code" disabled={!editing && (!selection || selection.start < 0)} onClick={() => format("`")}>‹/›</button>
        <button aria-label="Add link" disabled={!selection || selection.start < 0} onClick={() => setLinkURL("")}><Icon name="link" size={14} /></button>
        <select className="space-block-type" aria-label="Block type" value={blockType} disabled={!selectedBlock || /^(?:\s{4}|\t|```|~~~|\||<)/m.test(selectedBlock.source)} onMouseDown={event => event.stopPropagation()} onChange={event => changeBlockType(event.target.value)}>
          <option value="text">Text</option><option value="#">Heading 1</option><option value="##">Heading 2</option><option value="###">Heading 3</option><option value="bullet">Bulleted list</option><option value="number">Numbered list</option><option value="check">Checklist</option><option value="quote">Quote</option>
        </select>
        {onComment && <button className="space-selection-action" disabled={!selection} onClick={() => { if (selection) onComment(selection.text); setSelection(null); }}><Icon name="comment" size={13} />Comment</button>}
      </>}
    </div>}
    {blocks.map((block, index) => {
      const slash = editing === block.id && /^\/[^\n]*$/.test(block.source);
      const commands = slash ? BLOCK_COMMANDS.filter(c => `${c.name} ${c.hint}`.toLowerCase().includes(block.source.slice(1).toLowerCase())) : [];
      const activeChoice = Math.min(choice, Math.max(0, commands.length - 1));
      return <Fragment key={block.id}><div className={`space-block${editing === block.id ? " editing" : ""}`} key={block.id} data-testid="space-block" data-block-id={block.id}>
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
      </div>{generation && generationAnchor.current === block.id && generation}</Fragment>;
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
  return <SecretTextarea ref={el => { ref.current = el; inputRef(el); }} className={`space-block-input${heading ? ` heading-${heading}` : ""}${value.startsWith("```") ? " code" : ""}`} rows={1} aria-label={label} placeholder="Type / for blocks, or just start writing…" value={value} onChange={e => events.onChange(e.target.value)} onKeyDown={events.onKeyDown} onBlur={events.onBlur} spellCheck={!value.startsWith("```")} />;
}

function BlockPreview({ source, label, onEdit, onChange }: { source: string; label: string; onEdit: () => void; onChange: (value: string) => void }) {
  const blocks = useMemo(() => safeBlocks(source), [source]);
  const change = useRef(onChange);
  change.current = onChange;
  // The Markdown renderer treats custom renderers as component types. Keep their
  // identities stable across toolbar state changes so selected DOM is not replaced.
  const renderers = useMemo(() => {
    const checklists: Block[] = [];
    const collect = (items: Block[]) => { for (const item of items) { if (item.type === "checkList") checklists.push(item); collect(item.children); } };
    collect(blocks);
    const list = (block: Block) => {
      const Tag = block.type === "numberedList" ? "ol" : "ul";
      return <Tag>{block.children.map(item => <li key={item.id}><InlineContent spans={item.content} /><BlockRenderer blocks={item.children} customRenderers={custom} /></li>)}</Tag>;
    };
    const custom: NonNullable<React.ComponentProps<typeof BlockRenderer>["customRenderers"]> = {
      bulletList: ({ block }) => list(block),
      numberedList: ({ block }) => list(block),
      checkList: ({ block }) => <><label className="space-check"><SecretInput type="checkbox" checked={block.props.checked} onChange={e => change.current(toggleChecklist(source, checklists.indexOf(block), e.target.checked))} /><span><InlineContent spans={block.content} /></span></label><BlockRenderer blocks={block.children} customRenderers={custom} /></>,
      callout: ({ block }) => <aside className="space-callout"><InlineContent spans={block.content} /></aside>,
    };
    return custom;
  }, [blocks, source]);
  const ref = useRef<HTMLDivElement>(null);
  // The package renderer does not expose link attributes. Apply the app's external-link contract.
  useLayoutEffect(() => { ref.current?.querySelectorAll("a").forEach(link => { link.target = "_blank"; link.rel = "noopener noreferrer"; }); }, [blocks]);
  return <div ref={ref} className="space-block-preview" tabIndex={0} aria-label={label}
    onClick={event => { if (!(event.target as HTMLElement).closest("a, input, button") && !window.getSelection()?.toString()) onEdit(); }}
    onKeyDown={event => { if (event.target === event.currentTarget && ["Enter", " "].includes(event.key)) { event.preventDefault(); onEdit(); } }}>
    {blocks.length ? <BlockRenderer blocks={blocks} customRenderers={renderers} /> : <p className="space-placeholder">Type / for blocks, or just start writing…</p>}
  </div>;
}
