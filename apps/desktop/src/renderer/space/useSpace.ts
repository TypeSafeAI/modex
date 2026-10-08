import { useCallback, useEffect, useRef, useState } from "react";
import type { CreateSpacePage, SpacePage } from "../../shared/space";
import { bridge } from "../bridge";

/** Per-page save queue: edits stay local immediately; acknowledgements never replace newer text. */
export function useSpace() {
  const [pages, setPages] = useState<SpacePage[]>([]);
  const current = useRef(pages);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const mutating = useRef(false);
  const pending = useRef(new Map<string, SpacePage>());
  const inFlight = useRef<Promise<void> | null>(null);
  const publish = (next: SpacePage[]) => { current.current = next; setPages(next); };
  const load = useCallback(async () => {
    try { const result = await bridge.invoke("space:list", undefined); publish(result); setLoaded(true); setError(null); }
    catch (err) { setError((err as Error).message); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const flush = useCallback((): Promise<void> => {
    if (inFlight.current) return inFlight.current;
    setSaving(true);
    const work = async () => {
      while (pending.current.size) {
        const [id, snapshot] = pending.current.entries().next().value!;
        const saved = await bridge.invoke("space:save", snapshot);
        if (pending.current.get(id) === snapshot) pending.current.delete(id);
        else {
          const newer = pending.current.get(id)!;
          pending.current.set(id, { ...newer, revision: saved.revision });
        }
        publish(current.current.map(page => page.id === id ? { ...page, revision: saved.revision, updatedAt: saved.updatedAt } : page));
      }
      setError(null);
    };
    inFlight.current = work().catch(err => { setError((err as Error).message); throw err; }).finally(() => { inFlight.current = null; setSaving(false); });
    return inFlight.current;
  }, []);

  const edit = (id: string, patch: Partial<Pick<SpacePage, "title" | "markdown" | "favorite" | "parentId">>) => {
    if (mutating.current) return;
    const page = current.current.find(p => p.id === id);
    if (!page) return;
    const next = { ...page, ...patch };
    publish(current.current.map(p => p.id === id ? next : p));
    pending.current.set(id, next);
    void flush().catch(() => {});
  };
  // Keep failed/in-flight text in the renderer until it is acknowledged; never silently close over it.
  useEffect(() => {
    const preventLoss = (event: BeforeUnloadEvent) => {
      if (pending.current.size) { event.preventDefault(); event.returnValue = ""; }
    };
    window.addEventListener("beforeunload", preventLoss);
    return () => window.removeEventListener("beforeunload", preventLoss);
  }, []);

  const create = async (input: CreateSpacePage = {}) => {
    if (mutating.current) throw new Error("Wait for the current page action to finish.");
    const page = await bridge.invoke("space:create", input);
    publish([...current.current, page]);
    return page;
  };
  const trash = async (id: string, value: boolean) => {
    if (mutating.current) return;
    mutating.current = true; setBusy(true);
    try {
      await flush();
      const saved = await bridge.invoke("space:trash", { id, trash: value });
      publish(saved.map(remote => {
        const local = current.current.find(p => p.id === remote.id);
        return local && local.revision > remote.revision ? local : remote;
      }));
    } finally { mutating.current = false; setBusy(false); }
  };
  return { pages, loaded, error, saving, busy, edit, create, trash, flush, retry: () => loaded ? flush() : load() };
}
