import { Children, createContext, useContext, useLayoutEffect, useState, type ComponentPropsWithRef, type ClipboardEvent } from "react";
import type { Terminal } from "@xterm/xterm";
import { redactSecrets, secretRanges } from "../shared/streamer-secrets";

export const StreamerMode = createContext(false);
export const useStreamerMode = () => useContext(StreamerMode);
export function useRedact() { return useStreamerMode() ? redactSecrets : (text: string) => text; }

/** Native select menus do not paint Custom Highlights; label is display-only. */
export function SecretOption(props: ComponentPropsWithRef<"option">) {
  const redact = useRedact();
  const label = props.label ?? Children.toArray(props.children).join("");
  return <option {...props} label={redact(label)} />;
}

function copyOriginal(event: ClipboardEvent<HTMLInputElement | HTMLTextAreaElement>, cut = false) {
  if (event.defaultPrevented) return;
  const field = event.currentTarget;
  const start = field.selectionStart, end = field.selectionEnd;
  if (start === null || end === null || start === end) return;
  event.clipboardData.setData("text/plain", field.value.slice(start, end));
  event.preventDefault();
  // Native deletion retains the undo transaction and emits the normal input event.
  if (cut && !field.readOnly && !field.disabled) document.execCommand("delete");
}

// Keep the actual native control value. CSS masking preserves selection, IME, undo,
// copy/cut, formatting helpers and onChange payloads without reconstructing edits.
export function SecretInput(props: ComponentPropsWithRef<"input">) {
  const enabled = useStreamerMode();
  const [uncontrolled, setUncontrolled] = useState(props.defaultValue ?? "");
  const secret = enabled && secretRanges(String(props.value ?? uncontrolled)).length > 0;
  return <input {...props} data-streamer-secret={secret || undefined}
    onCopy={event => { props.onCopy?.(event); if (secret) copyOriginal(event); }}
    onCut={event => { props.onCut?.(event); if (secret) copyOriginal(event, true); }}
    onInput={event => { setUncontrolled(event.currentTarget.value); props.onInput?.(event); }} />;
}
export function SecretTextarea(props: ComponentPropsWithRef<"textarea">) {
  const enabled = useStreamerMode();
  const [uncontrolled, setUncontrolled] = useState(props.defaultValue ?? "");
  const secret = enabled && secretRanges(String(props.value ?? uncontrolled)).length > 0;
  return <textarea {...props} data-streamer-secret={secret || undefined}
    onCopy={event => { props.onCopy?.(event); if (secret) copyOriginal(event); }}
    onCut={event => { props.onCut?.(event); if (secret) copyOriginal(event, true); }}
    onInput={event => { setUncontrolled(event.currentTarget.value); props.onInput?.(event); }} />;
}

type Segment = { node: Text; start: number; end: number; nodeOffset?: number };
function domRanges(segments: Segment[], ranges: Array<[number, number]>): Range[] {
  const result: Range[] = [];
  let first = 0;
  for (const [start, end] of ranges) {
    while (first < segments.length && segments[first]!.end <= start) first++;
    for (let i = first; i < segments.length; i++) {
      const part = segments[i]!;
      if (part.start >= end) break;
      if (part.end <= start) continue;
      const range = document.createRange();
      range.setStart(part.node, (part.nodeOffset ?? 0) + Math.max(start, part.start) - part.start);
      range.setEnd(part.node, (part.nodeOffset ?? 0) + Math.min(end, part.end) - part.start);
      result.push(range);
    }
  }
  return result;
}

const terminals = new Map<HTMLElement, Terminal>();
/** The visible terminal stays the original parser, buffer, selection and input owner. */
export function registerStreamerTerminal(host: HTMLElement, terminal: Terminal): () => void {
  terminals.set(host, terminal);
  const refresh = () => window.dispatchEvent(new Event("modex:streamer-refresh"));
  const parsed = terminal.onWriteParsed(refresh);
  const rendered = terminal.onRender(refresh);
  return () => { parsed.dispose(); rendered.dispose(); terminals.delete(host); refresh(); };
}

function terminalRanges(host: HTMLElement, terminal: Terminal): Range[] {
  const buffer = terminal.buffer.active;
  const rows = host.querySelectorAll<HTMLElement>(".xterm-rows > div");
  let text = "";
  const segments: Segment[] = [];
  const reusable = buffer.getNullCell();
  // Include scrollback context for multiline keys/YAML and offscreen wrapped prefixes.
  // Match hard line breaks as newlines; a soft wrap is part of the same source line.
  for (let y = 0; y < buffer.length; y++) {
    const line = buffer.getLine(y)!;
    if (y && !line.isWrapped) text += "\n";
    const row = rows[y - buffer.viewportY];
    const walker = row ? document.createTreeWalker(row, NodeFilter.SHOW_TEXT) : null;
    let node = walker?.nextNode() as Text | null;
    let offset = 0;
    const columns = Math.min(line.length, terminal.cols);
    const next = buffer.getLine(y + 1);
    for (let x = 0; x < columns; x++) {
      const cell = line.getCell(x, reusable)!;
      if (!cell.getWidth()) continue;
      const chars = cell.getChars();
      // A wide glyph wraps before the last empty column. That filler is not a
      // space in the source token, although the DOM may paint a blank there.
      const filler = !chars && x === columns - 1 && next?.isWrapped && next.getCell(0)?.getWidth() === 2;
      const source = filler ? "" : chars || " ";
      const start = text.length;
      text += source;
      // Concealed emoji/combined cells paint one blank, not their UTF-16 length.
      let remaining = cell.isInvisible() ? 1 : (chars || " ").length;
      let consumed = 0;
      while (node && remaining > 0) {
        const length = Math.min(remaining, node.length - offset);
        if (!cell.isInvisible() && !filler && length) segments.push({ node, nodeOffset: offset, start: start + consumed, end: start + consumed + length });
        remaining -= length; consumed += length; offset += length;
        if (offset === node.length) { node = walker!.nextNode() as Text | null; offset = 0; }
      }
    }
  }
  return domRanges(segments, secretRanges(text));
}

/** Mask only painting; DOM strings and operational references remain original. */
export function useStreamerRedaction(enabled: boolean): void {
  useLayoutEffect(() => {
    if (!enabled) return;
    const attributes = new Map<Element, Map<string, { original: string; painted: string }>>();
    const displayAttributes = ["title", "aria-label", "placeholder", "alt"];
    const restoreAttributes = (element: Element, saved: Map<string, { original: string; painted: string }>) => {
      for (const [name, value] of saved) {
        if (element.getAttribute(name) === value.painted) element.setAttribute(name, value.original);
      }
    };
    const forgetExternalWrites = (records: MutationRecord[]) => {
      for (const record of records) if (record.type === "attributes" && record.attributeName) attributes.get(record.target as Element)?.delete(record.attributeName);
    };
    const root = document.body;
    const observe = () => observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: displayAttributes });
    const update = (records: MutationRecord[] | Event = []) => {
      const pending = [...(Array.isArray(records) ? records : []), ...observer.takeRecords()];
      observer.disconnect();
      // All our writes happen while disconnected. Even an external write equal
      // to the painted label is a new original and must not restore an old value.
      forgetExternalWrites(pending);
      const segments: Segment[] = [];
      let text = "";
      const visit = (node: Node) => {
        if (node.nodeType === Node.TEXT_NODE) {
          const value = node.textContent ?? "";
          segments.push({ node: node as Text, start: text.length, end: text.length + value.length });
          text += value;
        } else if (node instanceof Element) {
          if (node.matches("script, style, input, textarea, .xterm, .line-number")) return;
          const block = /^(DIV|P|PRE|LI|UL|OL|H[1-6]|BR|BUTTON|LABEL|TD|TR|SECTION|ARTICLE)$/.test(node.tagName);
          if (block) text += "\n";
          node.childNodes.forEach(visit);
          if (block) text += "\n";
        }
      };
      visit(root);
      const ranges = domRanges(segments, secretRanges(text));
      for (const [host, terminal] of terminals) if (host.isConnected) ranges.push(...terminalRanges(host, terminal));
      CSS.highlights.set("modex-streamer", new Highlight(...ranges));
      for (const element of root.querySelectorAll(displayAttributes.map(name => `[${name}]`).join(","))) {
        for (const name of displayAttributes) {
          const current = element.getAttribute(name);
          const saved = attributes.get(element)?.get(name);
          if (current === null) { attributes.get(element)?.delete(name); continue; }
          const original = saved && current === saved.painted ? saved.original : current;
          const painted = redactSecrets(original);
          if (!attributes.has(element)) attributes.set(element, new Map());
          attributes.get(element)!.set(name, { original, painted });
          if (current !== painted) element.setAttribute(name, painted);
        }
      }
      // Avoid retaining removed dialogs, tooltips and transcript nodes.
      for (const [element, saved] of attributes) if (!element.isConnected) {
        restoreAttributes(element, saved);
        attributes.delete(element);
      }
      root.dataset.streamerMode = "true";
      document.querySelector(".app")?.setAttribute("data-streamer-ready", "true");
      observe();
    };
    const observer = new MutationObserver(update);
    update();
    window.addEventListener("modex:streamer-refresh", update);
    return () => {
      forgetExternalWrites(observer.takeRecords());
      observer.disconnect();
      window.removeEventListener("modex:streamer-refresh", update);
      CSS.highlights.delete("modex-streamer");
      for (const [element, saved] of attributes) restoreAttributes(element, saved);
      delete root.dataset.streamerMode;
      document.querySelector(".app")?.removeAttribute("data-streamer-ready");
    };
  }, [enabled]);
}
