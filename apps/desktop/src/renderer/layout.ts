import { useCallback, useState } from "react";
import { loadLayout, saveLayout, type Layout } from "../shared/layout";

/** The pane layout, loaded once from localStorage and written back on every change. */
export function useLayout(): [Layout, (patch: Partial<Layout> | ((l: Layout) => Partial<Layout>)) => void] {
  const [layout, setLayout] = useState<Layout>(() => loadLayout(localStorage));
  const update = useCallback((patch: Partial<Layout> | ((l: Layout) => Partial<Layout>)) => {
    setLayout((l) => {
      const next = { ...l, ...(typeof patch === "function" ? patch(l) : patch) };
      saveLayout(localStorage, next);
      return next;
    });
  }, []);
  return [layout, update];
}
