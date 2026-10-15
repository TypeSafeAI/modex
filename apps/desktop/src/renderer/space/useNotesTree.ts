import { useCallback, useEffect, useRef, useState } from "react";
import type { NotesTree } from "../../shared/notes";
import { bridge } from "../bridge";
import { restartDrafts } from "../restart-drafts";

/** The notes folder's tree, polled like Space's pages; a version that still holds costs one small reply. */
export function useNotesTree(active: boolean) {
  const [tree, setTree] = useState<NotesTree | null>(null);
  const [error, setError] = useState<string | null>(null);
  const version = useRef<string | undefined>(undefined);
  const load = useCallback(async () => {
    if (restartDrafts.frozen) return;
    try {
      const result = await bridge.invoke("notes:tree", version.current ? { since: version.current } : undefined);
      if ("unchanged" in result) return;
      version.current = result.version;
      setTree(result);
      setError(null);
    } catch (err) { setError((err as Error).message); }
  }, []);
  useEffect(() => {
    if (!active) return;
    void load();
    const timer = setInterval(() => void load(), 1500);
    return () => clearInterval(timer);
  }, [active, load]);
  /** Runs a tree action, then reads the tree again whatever happened. */
  const act = useCallback(async <T,>(action: () => Promise<T>): Promise<T> => {
    try { return await action(); } finally { version.current = undefined; await load(); }
  }, [load]);
  const refresh = useCallback(() => { version.current = undefined; return load(); }, [load]);
  return { tree, error, act, refresh };
}
