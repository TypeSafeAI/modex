import { useEffect, useRef, useState, type PointerEvent } from "react";

interface Props {
  side: "sidebar" | "workspace";
  width: number;
  min: number;
  max: number;
  onResize: (width: number) => void;
  onReset: () => void;
}

/** A quiet divider with a larger hit target; arrows follow the divider's screen direction. */
export function PanelResizeHandle({ side, width, min, max, onResize, onReset }: Props) {
  const drag = useRef<{ x: number; width: number; pointer: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const direction = side === "sidebar" ? 1 : -1;
  const resize = (value: number) => onResize(Math.round(Math.max(min, Math.min(max, value))));
  const finish = () => {
    drag.current = null;
    setDragging(false);
    delete document.body.dataset.panelResizing;
  };
  useEffect(() => () => {
    if (drag.current) delete document.body.dataset.panelResizing;
  }, []);
  const start = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !event.isPrimary) return;
    event.preventDefault();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, width, pointer: event.pointerId };
    document.body.dataset.panelResizing = "true";
    setDragging(true);
  };
  return <div className={`panel-resizer panel-resizer-${side}`} role="separator" tabIndex={0}
    aria-label={`Resize ${side}`} aria-orientation="vertical" aria-valuemin={min} aria-valuemax={max}
    aria-valuenow={width} aria-valuetext={`${width} pixels`} data-dragging={dragging || undefined}
    title="Drag to resize · Double-click to reset · Arrow keys to adjust"
    onPointerDown={start}
    onPointerMove={event => {
      if (drag.current?.pointer === event.pointerId) resize(drag.current.width + direction * (event.clientX - drag.current.x));
    }}
    onPointerUp={event => {
      if (drag.current?.pointer !== event.pointerId) return;
      finish();
      event.currentTarget.releasePointerCapture(event.pointerId);
    }}
    onPointerCancel={finish} onLostPointerCapture={finish}
    onDoubleClick={onReset}
    onKeyDown={event => {
      const step = event.shiftKey ? 32 : 8;
      if (event.key === "ArrowLeft") resize(width - direction * step);
      else if (event.key === "ArrowRight") resize(width + direction * step);
      else if (event.key === "Home") resize(min);
      else if (event.key === "End") resize(max);
      else if (event.key === "Enter") onReset();
      else return;
      event.preventDefault();
    }} />;
}
