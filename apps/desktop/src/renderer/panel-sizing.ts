import { useLayoutEffect, useState, type CSSProperties } from "react";
import type { Layout } from "../shared/layout";

export const PANEL_WIDTHS = { sidebar: { min: 180, max: 400, default: 240 }, workspace: { min: 280, max: 800, default: 360 } };
const CHAT_MIN = 350;

/** Fit saved preferences to the current window without overwriting their larger-window values. */
export function usePanelSizing(layout: Layout, workspaceVisible: boolean) {
  const [sheet, setSheet] = useState<HTMLDivElement | null>(null);
  const [available, setAvailable] = useState(window.innerWidth - 54);
  useLayoutEffect(() => {
    if (!sheet) return;
    const measure = () => setAvailable(sheet.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(sheet);
    return () => observer.disconnect();
  }, [sheet]);
  const left = PANEL_WIDTHS.sidebar;
  const right = PANEL_WIDTHS.workspace;
  const sidebarMax = Math.max(left.min, Math.min(left.max, available - CHAT_MIN - (workspaceVisible ? right.min : 0)));
  const sidebarWidth = Math.max(left.min, Math.min(sidebarMax, layout.sidebarWidth ?? left.default));
  const workspaceMax = Math.max(right.min, Math.min(right.max, available - CHAT_MIN - (layout.sidebar ? sidebarWidth : 0)));
  const workspaceWidth = Math.max(right.min, Math.min(workspaceMax, layout.workspaceWidth ?? right.default));
  // A left drag stops at the current right edge, rather than shrinking the opposite panel.
  const leftDragMax = Math.max(left.min, Math.min(left.max, available - CHAT_MIN - (workspaceVisible ? workspaceWidth : 0)));
  const style = { "--sidebar-w": `${sidebarWidth}px`, "--changes-panel-w": `${workspaceWidth}px` } as CSSProperties;
  return { setSheet, style, sidebarWidth, workspaceWidth, sidebarMax: leftDragMax, workspaceMax };
}
