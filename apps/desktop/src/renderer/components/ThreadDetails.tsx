import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./ui/Icon";

/** A hover card lives outside the scrolling list so inspection never moves another chat. */
export function useThreadDetails(enabled: boolean) {
  const anchor = useRef<HTMLLIElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  const focusOnOpen = useRef(false);
  const restoringFocus = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const close = () => {
    clearTimeout(timer.current);
    if (panel.current?.contains(document.activeElement)) {
      restoringFocus.current = true;
      anchor.current?.querySelector<HTMLButtonElement>(".thread-main")?.focus();
      restoringFocus.current = false;
    }
    setPosition(null);
  };
  const leave = () => { clearTimeout(timer.current); timer.current = setTimeout(() => { if (!panel.current?.contains(document.activeElement)) close(); }, 140); };
  const keep = () => clearTimeout(timer.current);
  const show = (immediate = false, focus = false) => {
    if (restoringFocus.current) return;
    if (!enabled) return;
    clearTimeout(timer.current);
    const open = () => {
      const bounds = anchor.current?.getBoundingClientRect();
      if (bounds) { focusOnOpen.current = focus; setPosition({ left: Math.max(8, Math.min(bounds.right + 3, innerWidth - 328)), top: Math.max(8, Math.min(bounds.top, innerHeight - 180)) }); }
    };
    if (immediate) open(); else timer.current = setTimeout(open, 400);
  };
  useLayoutEffect(() => { if (position && focusOnOpen.current) { focusOnOpen.current = false; panel.current?.querySelector("summary")?.focus(); } }, [position]);
  useEffect(() => {
    if (!position) return;
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    // Transcript/composer scrolling does not move this anchor. Only its ancestors can invalidate the placement.
    const scroll = (event: Event) => { if (event.target instanceof Node && event.target.contains(anchor.current)) close(); };
    window.addEventListener("resize", close);
    window.addEventListener("scroll", scroll, true);
    document.addEventListener("keydown", key);
    return () => { clearTimeout(timer.current); window.removeEventListener("resize", close); window.removeEventListener("scroll", scroll, true); document.removeEventListener("keydown", key); };
  }, [Boolean(position)]);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => { if (!enabled) close(); }, [enabled]);
  return { anchor, panel, id, position, show, close, leave, keep };
}

export function ThreadDetails({ card, title, project, updatedAt, children }: { card: ReturnType<typeof useThreadDetails>; title: string; project: string; updatedAt: string; children: ReactNode }) {
  if (!card.position) return null;
  const days = Math.max(0, Math.floor((Date.now() - Date.parse(updatedAt)) / 86_400_000));
  const age = days >= 7 ? `${Math.floor(days / 7)}w` : days ? `${days}d` : "Today";
  return createPortal(<div ref={card.panel} id={card.id} className="thread-details" role="dialog" aria-label="Chat details" style={card.position} onPointerDown={event => event.stopPropagation()} onPointerEnter={card.keep} onPointerLeave={card.leave} onFocus={event => { event.stopPropagation(); card.keep(); }} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) card.leave(); }}>
    <div className="thread-details-title"><span>{title}</span><Icon name="laptop" size={13} /><time dateTime={updatedAt}>{age}</time></div>
    <details><summary><Icon name="folder" size={14} /><span>{project}</span></summary><div className="thread-details-meta">{children}</div></details>
  </div>, document.body);
}
