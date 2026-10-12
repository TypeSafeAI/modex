import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type { ComposerRecovery } from "../shared/update-recovery";
import type { NativeDraftBridge } from "../shared/native-drafts";
import { ComposerRecoveryQueue } from "../shared/composer-recovery-queue";

/** Coalesced local saves, shared with the short attachment-transfer barrier. */
export function useComposerRecovery(native: NativeDraftBridge | null, snapshot: ComposerRecovery, failed: (error: Error) => void, canClose: () => boolean = () => false) {
  const snapshotBody = JSON.stringify(snapshot);
  const active = useRef(native), onFailure = useRef(failed);
  const mayClose = useRef(canClose);
  const queue = useRef<ComposerRecoveryQueue | null>(null);
  if (!queue.current) queue.current = new ComposerRecoveryQueue(snapshot, value => {
    if (!active.current) return Promise.reject(new Error("Native draft recovery is unavailable."));
    return active.current.save(value);
  });
  useLayoutEffect(() => {
    active.current = native; onFailure.current = failed;
    mayClose.current = canClose;
    if (!queue.current!.held) queue.current!.update(snapshot);
  });
  const flush = useCallback(() => active.current ? queue.current!.flush() : Promise.resolve(0), []);
  useEffect(() => {
    if (!native || queue.current!.held) return;
    const timer = setTimeout(() => { if (!queue.current!.held) void flush().catch(error => onFailure.current(error)); }, 250);
    return () => clearTimeout(timer);
  }, [native, snapshotBody, flush]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!active.current) return;
      if (mayClose.current()) return;
      try { if (queue.current!.saveBeforeClose(value => active.current!.saveBeforeClose(value))) return; }
      catch { /* Keep unsaved or ambiguously transferred work open. */ }
      event.preventDefault(); event.returnValue = "";
      if (!queue.current!.held) void flush().catch(error => onFailure.current(error));
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [flush]);
  return { queue: queue.current, flush };
}
