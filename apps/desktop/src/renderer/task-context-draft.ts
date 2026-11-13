import { useLayoutEffect, useMemo, useReducer, useRef } from "react";
import { bridge } from "./bridge";
import { contextRefId, type ContextDraftBinding, type ContextDraftOwner, type ContextTarget, type TaskContextCandidates, type TaskContextEvidence } from "../shared/task-context-evidence";

type Entry = { key: string; owner: ContextDraftOwner | null; active: boolean; generation: number; held: boolean; open: boolean; busy: boolean; error: string; binding?: ContextDraftBinding; context?: TaskContextEvidence; candidates?: TaskContextCandidates; selected: ContextTarget[] };
export type ContextSend = { entry: Entry; binding?: ContextDraftBinding };
export interface ContextDraftUi {
  state: Entry;
  toggle(): void;
  close(): void;
  load(): Promise<void>;
  reload(): Promise<void>;
  choose(target: ContextTarget, selected: boolean): void;
  apply(): Promise<void>;
  include(target: ContextTarget): Promise<void>;
  hold(key: string): ContextSend | null;
  release(send: ContextSend, consumed: boolean): void;
}
const ownerKey = (owner: ContextDraftOwner | null) => owner?.kind === "thread" ? owner.threadId : owner?.key ?? "";
const disposeBinding = (binding?: ContextDraftBinding) => { if (binding) void bridge.invoke("task:context-draft-close", { binding }).catch(() => {}); };

/** A main-minted draft binding stays held across create/send, even if selection changes meanwhile. */
export function useTaskContextDraft(owner: ContextDraftOwner | null): ContextDraftUi {
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const entries = useRef(new Map<string, Entry>());
  const key = ownerKey(owner);
  const entry = useMemo<Entry>(() => {
    const held = entries.current.get(key); if (held?.held) return held;
    const created = { key, owner, active: true, generation: 0, held: false, open: false, busy: false, error: "", selected: [] };
    return created;
  }, [key]);
  useLayoutEffect(() => {
    entries.current.set(key, entry);
    entry.active = true;
    return () => { entry.active = false; if (!entry.held) { entry.generation++; disposeBinding(entry.binding); entry.binding = undefined; if (entries.current.get(key) === entry) entries.current.delete(key); } };
  }, [entry]);
  const notify = () => { if (entry.active) redraw(); };
  const load = async () => {
    if (!entry.owner || entry.busy || entry.held || (entry.binding && entry.context && entry.candidates)) return;
    const generation = entry.generation; entry.busy = true; entry.error = ""; notify();
    let opened: ContextDraftBinding | undefined;
    try {
      opened = await bridge.invoke("task:context-draft-open", { owner: entry.owner });
      if (!entry.active || entry.generation !== generation) { disposeBinding(opened); return; }
      const context = await bridge.invoke("task:context-draft", { binding: opened });
      const candidates = await bridge.invoke("task:context-candidates", { binding: opened });
      if (!entry.active || entry.generation !== generation) { disposeBinding(opened); return; }
      entry.binding = opened; entry.context = context; entry.candidates = candidates; entry.selected = context.refs.map(ref => ref.target);
    } catch (error) {
      disposeBinding(opened);
      if (entry.active && entry.generation === generation) { entry.binding = undefined; entry.error = error instanceof Error ? error.message : String(error); }
    } finally { if (entry.generation === generation) { entry.busy = false; notify(); } }
  };
  const apply = async () => {
    if (!entry.binding || entry.busy || entry.held) return;
    const binding = entry.binding, generation = entry.generation, targets = structuredClone(entry.selected);
    entry.busy = true; entry.error = ""; notify();
    try {
      const selected = await bridge.invoke("task:context-draft-select", { binding, targets });
      if (!entry.active || entry.generation !== generation) return;
      entry.binding = selected.binding; entry.context = selected.context;
    } catch (error) { if (entry.active && entry.generation === generation) entry.error = error instanceof Error ? error.message : String(error); }
    finally { if (entry.generation === generation) { entry.busy = false; notify(); } }
  };
  return {
    state: entry, load, apply,
    reload: async () => {
      if (entry.busy || entry.held || !entry.active) return;
      entry.generation++; disposeBinding(entry.binding); entry.binding = undefined; entry.candidates = undefined;
      await load();
    },
    toggle: () => { entry.open = !entry.open; notify(); if (entry.open) void load(); },
    close: () => { entry.open = false; notify(); },
    choose: (target, selected) => {
      if (entry.busy || entry.held) return;
      entry.selected = entry.selected.filter(value => contextRefId(value) !== contextRefId(target));
      if (selected) entry.selected.push(target); notify();
    },
    include: async target => {
      entry.open = true; notify(); await load(); if (!entry.binding || entry.busy || entry.held) return;
      if (!entry.selected.some(value => contextRefId(value) === contextRefId(target))) entry.selected.push(target);
      await apply();
    },
    hold: source => {
      if (source !== key || entry.busy || entry.held || (entry.context?.refs.length && !entry.binding)) return null;
      entry.held = true; notify(); return { entry, ...(entry.binding ? { binding: structuredClone(entry.binding) } : {}) };
    },
    release: (send, consumed) => {
      const previous = send.entry; previous.held = false;
      if (consumed || !previous.active) {
        previous.generation++; disposeBinding(previous.binding); previous.binding = undefined;
        if (consumed) { previous.context = undefined; previous.candidates = undefined; previous.selected = []; previous.open = false; }
        if (!previous.active && entries.current.get(previous.key) === previous) entries.current.delete(previous.key);
      }
      if (previous.active) redraw();
    },
  };
}
