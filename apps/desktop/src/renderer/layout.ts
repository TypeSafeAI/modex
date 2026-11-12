import { useCallback, useState } from "react";
import { DEFAULT_LAYOUT, loadLayout, saveLayout, type Layout } from "../shared/layout";

/** The pane layout, loaded once from localStorage and written back on every change. */
export function useLayout(persist = true): [Layout, (patch: Partial<Layout> | ((l: Layout) => Partial<Layout>)) => void] {
  const [layout, setLayout] = useState<Layout>(() => persist ? loadLayout(localStorage) : { ...DEFAULT_LAYOUT });
  const update = useCallback((patch: Partial<Layout> | ((l: Layout) => Partial<Layout>)) => {
    setLayout((l) => {
      const next = { ...l, ...(typeof patch === "function" ? patch(l) : patch) };
      if (persist) saveLayout(localStorage, next);
      return next;
    });
  }, [persist]);
  return [layout, update];
}
