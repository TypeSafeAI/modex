import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Thread } from "../../shared/types";
import { canvasFile, type CanvasSnapshot } from "../../shared/canvas";
import { bridge } from "../bridge";
import { IconButton } from "./ui/IconButton";

export function CanvasPanel({ id, thread, visible, suspended, full }: { id: string; thread: Thread; visible: boolean; suspended: boolean; full: boolean }) {
  const [paths, setPaths] = useState<string[]>([]);
  const [selected, setSelected] = useState("");
  const [snapshot, setSnapshot] = useState<CanvasSnapshot | null>(null);
  const [error, setError] = useState("");
  const [listingError, setListingError] = useState("");
  const [revision, setRevision] = useState(0);
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!visible) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const result = await bridge.invoke("files:list", { threadId: thread.id });
        if (live) { setPaths(result.paths.filter(canvasFile)); setListingError(""); }
      } catch (e) { if (live) setListingError((e as Error).message); }
      if (live) timer = setTimeout(refresh, 2000);
    };
    void refresh();
    return () => { live = false; clearTimeout(timer); };
  }, [thread.id, visible]);
  useEffect(() => {
    if (!visible) return;
    setSnapshot(null); setError("");
    if (!selected) return;
    let live = true;
    let opened = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const state = opened
          ? await bridge.invoke("canvas:state", { id })
          : await bridge.invoke("canvas:open", { id, threadId: thread.id, path: selected });
        if (live) { opened = true; setSnapshot(state); setError(""); }
      } catch (e) { if (live) setError((e as Error).message); }
      if (live) timer = setTimeout(poll, 750);
    };
    void poll();
    return () => { live = false; clearTimeout(timer); };
  }, [id, thread.id, selected, revision, visible]);
  const openedPath = snapshot?.path;
  useEffect(() => () => { void bridge.invoke("canvas:close", { id }).catch(() => {}); }, [id]);
  useLayoutEffect(() => {
    const element = host.current;
    const update = () => {
      const overlay = document.querySelector('[role="dialog"], [role="menu"], [role="listbox"], .streamer-shield, [data-panel-resizing="true"]');
      const rect = element?.getBoundingClientRect();
      const show = visible && !suspended && !overlay && !error && !snapshot?.error && openedPath === selected && rect;
      void bridge.invoke("canvas:show", { id: show ? id : null, fullView: full, ...(show ? { bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } } : {}) }).catch(() => {});
    };
    update();
    const resize = new ResizeObserver(update);
    if (element) resize.observe(element);
    const mutations = new MutationObserver(update);
    mutations.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-panel-resizing"] });
    window.addEventListener("resize", update);
    return () => { resize.disconnect(); mutations.disconnect(); window.removeEventListener("resize", update); void bridge.invoke("canvas:show", { id: null }).catch(() => {}); };
  }, [id, visible, suspended, full, error, snapshot?.error, openedPath, selected]);
  return <section className="workspace-canvas" hidden={!visible} aria-label="Canvas">
    <header className="review-toolbar canvas-toolbar">
      <label htmlFor={`canvas-file-${id}`}>Canvas</label>
      <select id={`canvas-file-${id}`} aria-label="Canvas file" value={selected} onChange={e => setSelected(e.target.value)}>
        <option value="">Choose a preview…</option>
        {selected && !paths.includes(selected) && <option value={selected}>{selected}</option>}
        {paths.map(p => <option key={p} value={p}>{p}</option>)}
      </select>
      <IconButton icon="restart" label="Reload Canvas" disabled={!selected} onClick={() => {
        if (error) setRevision(r => r + 1);
        else void bridge.invoke("canvas:state", { id, reload: true }).then(setSnapshot, (e: Error) => setError(e.message));
      }} />
    </header>
    {(error || snapshot?.error || listingError) && <p className="workspace-error" role="alert" data-testid="canvas-error">{error || snapshot?.error || listingError}</p>}
    {!selected && <p className="hint pad">Preview an HTML, SVG or Markdown file. Canvas refreshes when the file or its local assets change.</p>}
    {snapshot?.loading && <span className="hint canvas-loading" role="status">Loading preview…</span>}
    <div className="workspace-guest" ref={host} data-testid="canvas-preview" />
  </section>;
}
