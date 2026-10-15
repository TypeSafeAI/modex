import { useLayoutEffect, useRef, useState } from "react";
import { useStreamerMode } from "../streamer";
import { bridge } from "../bridge";

/**
 * The Analytics surface. The dashboard is its own document in a native view over this canvas, so its
 * styles and the app's never meet; main serves it and the recorded usage (see workspace-analytics.ts).
 * Like the knowledge base, it is hidden under dialogs and menus and while Streamer Mode is on.
 */
export function AnalyticsView({ active }: { active: boolean }) {
  const streamerMode = useStreamerMode();
  const canvas = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useLayoutEffect(() => {
    let alive = true;
    const update = async () => {
      const rect = canvas.current?.getBoundingClientRect();
      const overlay = document.querySelector('[role="dialog"], [role="menu"], [role="listbox"], [data-panel-resizing="true"]');
      const bounds = active && !streamerMode && !overlay && rect && rect.width > 0 && rect.height > 0
        ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : undefined;
      try {
        const result = await bridge.invoke("analytics:show", { bounds });
        if (alive) setError(result?.error ?? null);
      } catch (err) { if (alive) setError((err as Error).message); }
    };
    void update();
    const resize = new ResizeObserver(() => void update());
    if (canvas.current) resize.observe(canvas.current);
    const mutations = new MutationObserver(() => void update());
    mutations.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-panel-resizing"] });
    window.addEventListener("resize", update);
    return () => { alive = false; resize.disconnect(); mutations.disconnect(); window.removeEventListener("resize", update); void bridge.invoke("analytics:show", {}).catch(() => {}); };
  }, [active, streamerMode]);

  return <section className="analytics-surface" data-testid="analytics" aria-label="Analytics" hidden={!active}>
    {streamerMode && <p className="analytics-note" role="status">Analytics is hidden while Streamer Mode is on.</p>}
    {error && <p className="analytics-note" role="alert">{error}</p>}
    <div ref={canvas} className="analytics-canvas" data-testid="analytics-canvas" />
  </section>;
}
