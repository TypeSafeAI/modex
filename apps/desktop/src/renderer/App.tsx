import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { UpdateBanner } from "./components/UpdateBanner";
import type { AppState, BackendId, ChangesSnapshot, ModelInfo, Settings, Thread, ThreadEvent, ThreadItem, ThreadPatch, TurnFix } from "../shared/types";
import { bridge } from "./bridge";
import { Sidebar } from "./components/Sidebar";
import { ThreadView } from "./components/ThreadView";
import { Workspace } from "./components/Workspace";
import { SettingsDialog } from "./components/SettingsDialog";
import { CompanionDialog } from "./components/CompanionDialog";
import { EmptyState } from "./components/EmptyState";
import { DraftView, type Draft } from "./components/DraftView";
import { TitleBar } from "./components/TitleBar";
import { Rail } from "./components/Rail";
import { Icon } from "./components/ui/Icon";
import { useSelectionHistory } from "./history";
import { useLayout } from "./layout";
import { applyTheme, restoreTheme } from "./theme";
import { applyItemEvent, type ItemEvent } from "./transcript";

/** ⌃` shows or hides the thread's terminal. xterm maps no byte to it, so it reaches this handler even from inside the shell. */
const isTerminalToggle = (e: KeyboardEvent) => e.ctrlKey && !e.metaKey && !e.altKey && e.code === "Backquote";

// xterm is only loaded once a terminal is first opened.
const TerminalPanel = lazy(() => import("./components/TerminalPanel").then((m) => ({ default: m.TerminalPanel })));

export function App({ persistPreferences = true }: { persistPreferences?: boolean } = {}) {
  const [state, setState] = useState<AppState | null>(null);
  useLayoutEffect(() => { if (state) applyTheme(state.settings.theme, persistPreferences); }, [state?.settings.theme, persistPreferences]);
  useLayoutEffect(() => () => { if (!persistPreferences) restoreTheme(); }, [persistPreferences]);
  const [connectionRevision, setConnectionRevision] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [draftRevision, setDraftRevision] = useState(0);
  const [items, setItems] = useState<Record<string, ThreadItem[]>>({});
  // Unsent composer text by thread id (or `draft:<revision>` for a new chat). Switching threads keeps it;
  // sending, deleting the thread or starting another new chat clears it. Renderer-only: it is not saved.
  const [unsent, setUnsent] = useState<Record<string, string>>({});
  const unsentRevision = useRef(new Map<string, number>());
  const setUnsentFor = useCallback((key: string, text: string) => {
    unsentRevision.current.set(key, (unsentRevision.current.get(key) ?? 0) + 1);
    setUnsent((m) => {
      if (text) return { ...m, [key]: text };
      if (!(key in m)) return m;
      const { [key]: _gone, ...rest } = m;
      return rest;
    });
  }, []);
  const restoreUnsentIfCurrent = useCallback((key: string, revision: number, text: string) => {
    // A newer edit (including clearing a newer draft) owns this composer now.
    if ((unsentRevision.current.get(key) ?? 0) === revision) setUnsentFor(key, text);
  }, [setUnsentFor]);
  const loadingItems = useRef(new Map<string, ItemEvent[]>());
  const [changeResult, setChangeResult] = useState<{ threadId: string; snapshot: ChangesSnapshot } | null>(null);
  const changes = changeResult?.threadId === selected ? changeResult.snapshot : null;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const changesRequest = useRef(0);
  // Which threads have their terminal panel showing. Hiding a panel leaves its shell running.
  const [terminals, setTerminals] = useState<Record<string, boolean>>({});
  // A command line for a thread's shell (a failure card's sign-in fix); the panel types it once per nonce.
  const [terminalCommands, setTerminalCommands] = useState<Record<string, { text: string; nonce: number }>>({});
  const commandNonce = useRef(0);
  const [showSettings, setShowSettings] = useState(false);
  const [showCompanion, setShowCompanion] = useState(false);
  // Panel toggles survive a relaunch (localStorage, see shared/layout.ts).
  const [layout, setLayout] = useLayout(persistPreferences);
  const showChanges = layout.changes;
  const sidebarOpen = layout.sidebar;
  const streamerMode = layout.streamerMode;
  const setShowChanges = (f: (v: boolean) => boolean) => setLayout((l) => ({ changes: f(l.changes) }));
  const setSidebarOpen = (f: (v: boolean) => boolean) => setLayout((l) => ({ sidebar: f(l.sidebar) }));
  // The toast: what failed and, when the action can simply be run again, how.
  const [error, setError] = useState<{ message: string; retry?: () => void } | null>(null);
  const [models, setModels] = useState<Partial<Record<BackendId, { models: ModelInfo[]; error?: string }>>>({});
  const [modelPickerRequest, setModelPickerRequest] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  // A new chat is a draft (renderer-only) until its first send creates the thread.
  const [draft, setDraft] = useState<Draft | null>(null);
  const [creating, setCreating] = useState(false);
  // A thread just created from a draft has no history to load, and reloading it could overwrite
  // the first streamed items; the selection effect skips its one load.
  const justCreated = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    const s = await bridge.invoke("state:get", undefined);
    setState(s);
    return s;
  }, []);

  useEffect(() => {
    void refresh().then((s) => {
      if (!selected && s.threads[0]) setSelected(s.threads[0].id);
    }).catch((err: Error) => setError({ message: err.message }));
  }, [refresh]);

  useEffect(() => bridge.onReconnect?.(() => {
    setConnectionRevision((revision) => revision + 1);
    void refresh().then((snapshot) => {
      const current = selectedRef.current;
      if (current && !snapshot.threads.some((thread) => thread.id === current)) setSelected(null);
    }).catch((err: Error) => setError({ message: err.message }));
  }), [refresh]);

  // Live events from every thread; the selected thread re-renders, others just update status.
  useEffect(() => {
    return bridge.onEvent((e: ThreadEvent) => {
      if (e.type === "item" || e.type === "item_update") {
        loadingItems.current.get(e.threadId)?.push(e);
        setItems((m) => ({ ...m, [e.threadId]: applyItemEvent(m[e.threadId] ?? [], e) }));
      }
      else if (e.type === "status") {
        setState((s) => (s ? { ...s, threads: s.threads.map((t) => (t.id === e.threadId ? { ...t, status: e.status } : t)) } : s));
        if ((e.status === "idle" || e.status === "error") && selectedRef.current === e.threadId) void loadChanges(e.threadId);
      } else if (e.type === "thread") setState((s) => (s ? { ...s, threads: s.threads.map((t) => (t.id === e.thread.id ? { ...t, ...e.thread, status: t.status } : t)) } : s));
    });
  }, []);

  const loadChanges = useCallback(async (threadId: string) => {
    if (selectedRef.current !== threadId) return;
    const request = ++changesRequest.current;
    try {
      const snapshot = await bridge.invoke("changes:status", { threadId });
      if (selectedRef.current === threadId && request === changesRequest.current) setChangeResult({ threadId, snapshot });
    } catch (err) {
      if (selectedRef.current !== threadId || request !== changesRequest.current) return;
      setChangeResult(null);
      setError({ message: (err as Error).message, retry: () => void loadChanges(threadId) });
    }
  }, []);

  const loadItems = useCallback((threadId: string) => {
    if (loadingItems.current.has(threadId)) return;
    // Replay events that race the snapshot; this also hydrates active, unselected threads.
    const pending: ItemEvent[] = [];
    loadingItems.current.set(threadId, pending);
    void bridge.invoke("thread:items", { threadId }).then((list) => {
      if (loadingItems.current.get(threadId) !== pending) return;
      loadingItems.current.delete(threadId);
      setItems((m) => ({ ...m, [threadId]: pending.reduce(applyItemEvent, list) }));
    }).catch((err: Error) => {
      if (loadingItems.current.get(threadId) !== pending) return;
      loadingItems.current.delete(threadId);
      if (selectedRef.current === threadId) setError({ message: err.message });
    });
  }, []);
  useEffect(() => {
    if (!selected) return;
    if (justCreated.current === selected) {
      justCreated.current = null;
      setItems((m) => ({ ...m, [selected]: m[selected] ?? [] }));
    } else loadItems(selected);
    void loadChanges(selected);
  }, [selected, loadChanges, loadItems, connectionRevision]);
  const runningIds = state?.threads.filter(t => t.status === "running" || t.status === "waiting").map(t => t.id).join(",") ?? "";
  useEffect(() => {
    for (const id of runningIds.split(",").filter(Boolean)) loadItems(id);
  }, [runningIds, loadItems, connectionRevision]);

  // A draft has no thread to take a Changes snapshot from, so it asks for its project's branch directly.
  const [draftBranch, setDraftBranch] = useState<{ projectId: string; branch: string | null } | null>(null);
  const draftProjectId = draft?.projectId;
  useEffect(() => {
    if (!draftProjectId) return;
    let live = true;
    bridge.invoke("project:branch", { projectId: draftProjectId }).then(
      (branch) => live && setDraftBranch({ projectId: draftProjectId, branch }),
      () => live && setDraftBranch({ projectId: draftProjectId, branch: null }),
    );
    return () => { live = false; };
  }, [draftProjectId]);

  const thread = useMemo(() => state?.threads.find((t) => t.id === selected) ?? null, [state, selected]);
  /** Choosing a thread (sidebar, history) discards any draft: an unsent draft never becomes a thread. */
  const selectThread = useCallback((id: string) => {
    setDraft(null);
    setSelected(id);
  }, []);
  const history = useSelectionHistory(selected, selectThread, (id) => Boolean(state?.threads.some((t) => t.id === id)));
  const draftDefaults = (s: AppState): Draft["settings"] => ({
    backend: s.settings.default_backend,
    mode: s.settings.default_mode,
    plan: false,
    auto: s.settings.routing.auto_by_default,
    model: s.settings.default_model[s.settings.default_backend] ?? "",
  });
  const openDraft = (projectId: string, worktree = false) => {
    if (!state) return;
    setSelected(null);
    setDraftRevision((revision) => revision + 1);
    setDraft({ projectId, worktree, settings: draftDefaults(state) });
    setTimeout(() => inputRef.current?.focus(), 0);
  };
  // Nothing selected and no draft, but there are projects (first launch, last thread deleted): open a draft.
  useEffect(() => {
    if (!state || selected || creating) return;
    if (draft && !state.projects.some((p) => p.id === draft.projectId)) setDraft(null);
    else if (!draft && state.projects[0]) setDraft({ projectId: state.projects[0].id, worktree: false, settings: draftDefaults(state) });
  }, [state, selected, draft, creating]);

  // Model catalogue per backend, fetched lazily from the CLIs (Codex: live `model/list`).
  useEffect(() => {
    const b = thread?.backend ?? draft?.settings.backend;
    if (!b || models[b]) return;
    void bridge.invoke("models:list", { backend: b }).then((r) => setModels((m) => ({ ...m, [b]: r }))).catch((err) => setModels((m) => ({ ...m, [b]: { models: [], error: (err as Error).message } })));
  }, [thread?.backend, draft?.settings.backend, models]);

  // A draft, like a thread, always shows a model the CLI knows: the settings default or the CLI's own.
  useEffect(() => {
    if (!draft || !state) return;
    const list = models[draft.settings.backend]?.models;
    if (!list?.length || list.some((m) => m.id === draft.settings.model)) return;
    const preferred = state.settings.default_model[draft.settings.backend];
    const pick = list.find((m) => m.id === preferred) ?? list.find((m) => m.isDefault) ?? list[0]!;
    setDraft({ ...draft, settings: { ...draft.settings, model: pick.id, effort: pick.defaultEffort } });
  }, [draft?.settings.backend, draft?.settings.model, models]);

  // Like the Codex App, a thread always has a concrete model the CLI knows: pick the CLI's
  // default (or the settings default) when the thread has none or names one the CLI no longer lists.
  useEffect(() => {
    if (!thread) return;
    const list = models[thread.backend]?.models;
    if (!list?.length) return;
    const current = list.find((m) => m.id === thread.model);
    if (current) {
      if (current.efforts?.length && thread.effort && !current.efforts.includes(thread.effort)) void updateThread({ effort: current.defaultEffort });
      return;
    }
    const preferred = state?.settings.default_model[thread.backend];
    const pick = list.find((m) => m.id === preferred) ?? list.find((m) => m.isDefault) ?? list[0]!;
    void updateThread({ model: pick.id, effort: pick.defaultEffort });
  }, [thread?.id, thread?.backend, thread?.model, models]);
  const project = useMemo(() => (thread ? state?.projects.find((p) => p.id === thread.projectId) ?? null : null), [state, thread]);

  const act = async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      setError(null);
      return await fn();
    } catch (err) {
      setError({ message: (err as Error).message, retry: () => void act(fn) });
      return undefined;
    }
  };
  /** Ask the CLI for its models again after a failed listing (the composer's Retry). */
  const retryModels = (backend: BackendId) => setModels((m) => {
    const next = { ...m };
    delete next[backend];
    return next;
  });

  const addProject = () => act(async () => {
    const folder = bridge.platform === "web" ? window.prompt("Local project folder (absolute path)")?.trim() : undefined;
    if (bridge.platform === "web" && !folder) return;
    const p = await bridge.invoke("project:add", folder ? { path: folder } : undefined);
    if (p) await refresh();
  });
  /** First send from a draft: create the thread with the draft's settings, then send. */
  const sendDraft = async (text: string): Promise<void> => {
    if (!draft) return;
    const d = draft;
    const draftKey = `draft:${draftRevision}`;
    setUnsentFor(draftKey, "");
    let restoreKey = draftKey;
    let restoreRevision = unsentRevision.current.get(draftKey)!;
    setCreating(true);
    const sent = await act(async () => {
      const s = d.settings;
      const t = await bridge.invoke("thread:create", { projectId: d.projectId, worktree: d.worktree, backend: s.backend, mode: s.mode, model: s.model || undefined, auto: s.auto });
      if (s.plan || s.effort) await bridge.invoke("thread:update", { threadId: t.id, patch: { ...(s.plan ? { plan: true } : {}), ...(s.effort ? { effort: s.effort } : {}) } });
      await refresh();
      justCreated.current = t.id;
      setDraft(null);
      setSelected(t.id);
      restoreKey = t.id;
      restoreRevision = unsentRevision.current.get(t.id) ?? 0;
      const r = await bridge.invoke("thread:send", { threadId: t.id, text: text.trim() });
      if (!r.ok) setError({ message: r.error ?? "send failed" });
      return r.ok;
    });
    setCreating(false);
    if (sent !== true) restoreUnsentIfCurrent(restoreKey, restoreRevision, text);
  };
  const send = async (text: string): Promise<void> => {
    if (!thread) return;
    const threadId = thread.id;
    setUnsentFor(threadId, "");
    const revision = unsentRevision.current.get(threadId)!;
    const sent = await act(async () => {
      const r = await bridge.invoke("thread:send", { threadId, text: text.trim() });
      if (!r.ok) setError({ message: r.error ?? "send failed" });
      return r.ok;
    });
    if (sent !== true) restoreUnsentIfCurrent(threadId, revision, text);
  };
  /** The failure card's Retry: main runs the thread's last message again without adding a second bubble. */
  const retry = () => thread && act(async () => {
    const r = await bridge.invoke("thread:retry", { threadId: thread.id });
    if (!r.ok) setError({ message: r.error ?? "retry failed", retry: () => void retry() });
  });
  /** The failure card's fix: type the sign-in command into the thread's shell (opening it), or open Settings. */
  const applyFix = (fix: TurnFix) => {
    if (fix.kind === "settings") { setShowSettings(true); return; }
    if (fix.kind === "models") {
      if (thread && (!models[thread.backend]?.models.length || models[thread.backend]?.error)) retryModels(thread.backend);
      setModelPickerRequest((request) => request + 1);
      return;
    }
    if (fix.kind === "retry") { void retry(); return; }
    if (!thread) return;
    const id = thread.id;
    setLayout({ changes: true });
    setTerminalCommands((m) => ({ ...m, [id]: { text: fix.command, nonce: ++commandNonce.current } }));
    setTerminals((m) => ({ ...m, [id]: true }));
  };
  const stop = () => thread && act(() => bridge.invoke("thread:stop", { threadId: thread.id }));
  const answer = (itemId: string, a: "yes" | "no" | "always") => thread && act(() => bridge.invoke("thread:answer", { threadId: thread.id, itemId, answer: a }));
  const updateThread = (patch: ThreadPatch) => thread && act(async () => {
    await bridge.invoke("thread:update", { threadId: thread.id, patch });
    await refresh();
  });
  const closeTerminal = (threadId: string) => {
    setTerminals((m) => ({ ...m, [threadId]: false }));
    inputRef.current?.focus();
  };
  const toggleTerminal = (threadId: string) => {
    if (terminals[threadId] && showChanges) closeTerminal(threadId);
    else { setLayout({ changes: true }); setTerminals((m) => ({ ...m, [threadId]: true })); }
  };
  const deleteThread = (t: Thread) => act(async () => {
    const removeWorktree = t.worktree ? window.confirm(`Delete this thread and remove its worktree?\n\n${t.worktree.path}\n\nUncommitted changes there will be lost; the branch ${t.worktree.branch} is kept.`) : true;
    if (t.worktree && !removeWorktree) return;
    const s = await bridge.invoke("thread:delete", { threadId: t.id, removeWorktree });
    setState(s);
    loadingItems.current.delete(t.id);
    setItems((m) => { const next = { ...m }; delete next[t.id]; return next; });
    setUnsentFor(t.id, "");
    setTerminals((m) => {
      if (!(t.id in m)) return m;
      const { [t.id]: _gone, ...rest } = m;
      return rest;
    });
    setChangeResult((c) => (c?.threadId === t.id ? null : c));
    if (selected === t.id) setSelected(s.threads.find((x) => x.projectId === t.projectId)?.id ?? s.threads[0]?.id ?? null);
  });
  const removeProject = (projectId: string) => act(async () => {
    if (!window.confirm("Remove this project from Modex? Files on disk are not touched.")) return;
    const removedThreads = state?.threads.filter((t) => t.projectId === projectId) ?? [];
    const s = await bridge.invoke("project:remove", { projectId });
    setState(s);
    for (const t of removedThreads) {
      loadingItems.current.delete(t.id);
      setUnsentFor(t.id, "");
    }
    const removedIds = new Set(removedThreads.map((t) => t.id));
    setItems((m) => {
      const next = { ...m };
      for (const id of removedIds) delete next[id];
      return next;
    });
    setTerminals((m) => {
      const next = { ...m };
      for (const id of removedIds) delete next[id];
      return next;
    });
    setChangeResult((c) => (c && removedIds.has(c.threadId) ? null : c));
    if (draft?.projectId === projectId) {
      setUnsentFor(`draft:${draftRevision}`, "");
      setDraft(null);
    }
    if (thread?.projectId === projectId || (selected && removedIds.has(selected))) {
      setSelected(s.threads[0]?.id ?? null);
    }
  });
  const revert = (path: string) => thread && act(async () => {
    if (!window.confirm(`Discard changes to ${path}? This cannot be undone.`)) return;
    await bridge.invoke("changes:revert", { threadId: thread.id, path });
    await loadChanges(thread.id);
  });
  const openPath = (p: string) => act(() => bridge.invoke("shell:openPath", { path: p }));
  const openTerminal = (p: string) => act(() => bridge.invoke("shell:openTerminal", { path: p }));
  const saveSettings = async (patch: Partial<Settings>): Promise<void> => {
    const saved = await bridge.invoke("settings:update", patch);
    // The update response is authoritative even if the subsequent full-state refresh fails.
    if (saved) setState((current) => current ? { ...current, settings: saved } : current);
    try {
      await refresh();
    } catch (err) {
      setError({ message: `Settings were saved, but Modex could not refresh its view: ${(err as Error).message}` });
    }
  };

  // Keyboard shortcuts: ⌘N new thread, ⇧⌘N worktree thread, ⌘⏎ send (handled in Composer), ⇧⌘P plan, ⌘. stop, ⌘J changes,
  // ⌃` terminal. Inside the terminal, xterm consumes the ⌃-keys it sends to the shell, so they never get here.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (showSettings || showCompanion || streamerMode) return;
      if (isTerminalToggle(e)) {
        e.preventDefault();
        if (thread) toggleTerminal(thread.id);
        return;
      }
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      const pid = thread?.projectId ?? draft?.projectId ?? state?.projects[0]?.id;
      if (e.key.toLowerCase() === "n" && pid) {
        e.preventDefault();
        openDraft(pid, e.shiftKey);
      } else if (e.key.toLowerCase() === "p" && e.shiftKey && (thread || draft)) {
        e.preventDefault();
        if (thread) void updateThread({ plan: !thread.plan });
        else if (draft) setDraft({ ...draft, settings: { ...draft.settings, plan: !draft.settings.plan } });
      } else if (e.key === "." && thread) {
        e.preventDefault();
        void stop();
      } else if (e.key.toLowerCase() === "j") {
        e.preventDefault();
        setShowChanges((v) => !v);
      } else if (e.key === "Enter" && (thread || draft) && document.activeElement !== inputRef.current) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [thread, state, draft, showSettings, showCompanion, streamerMode, showChanges, terminals]);

  // Focus the composer whenever the selected thread changes.
  useEffect(() => {
    inputRef.current?.focus();
  }, [selected]);

  if (!state) return <div className="app loading">{error?.message ?? "Loading…"}</div>;

  const newChat = () => {
    const pid = thread?.projectId ?? draft?.projectId ?? state.projects[0]?.id;
    if (pid) openDraft(pid);
  };
  const activeThreads = state.threads.filter((candidate) => candidate.status === "running" || candidate.status === "waiting");
  const activeAgents = activeThreads.flatMap(t => (items[t.id] ?? []).flatMap(item =>
    item.kind === "tool" && item.agent && (item.agent.state === "running" || item.agent.state === "waiting")
      ? [{ threadId: t.id, threadTitle: t.title, agent: item.agent }] : []));
  const activeWork = { count: activeThreads.length, agents: activeAgents.length, waiting: activeThreads.filter((candidate) => candidate.status === "waiting").length };
  const openActiveWork = () => {
    const next = activeThreads[0];
    if (next) { setLayout({ sidebar: true }); selectThread(next.id); }
  };

  return (
    <div className={`app${sidebarOpen ? "" : " sidebar-closed"}`} data-streamer-mode={streamerMode ? "true" : "false"}>
      <TitleBar
        thread={thread}
        onRename={(title) => void updateThread({ title })}
        canBack={history.canBack}
        canForward={history.canForward}
        onBack={history.back}
        onForward={history.forward}
        sidebarOpen={sidebarOpen}
        onToggleSidebar={() => setSidebarOpen((v) => !v)}
        showChanges={showChanges}
        onToggleChanges={() => setShowChanges((v) => !v)}
        showTerminal={Boolean(thread && showChanges && terminals[thread.id])}
        onToggleTerminal={() => thread && toggleTerminal(thread.id)}
        changedCount={changes?.files.length ?? 0}
        onOpenPath={openPath}
        onOpenTerminal={openTerminal}
        onDelete={deleteThread}
        platform={bridge.platform}
      />
      <Rail activeWork={activeWork} onOpenActiveWork={openActiveWork} onOpenSettings={() => setShowSettings(true)} onOpenCompanion={() => setShowCompanion(true)} onEnableStreamerMode={() => setLayout({ streamerMode: true })} />
      <div className="sheet" data-testid="sheet">
        {sidebarOpen && (
          <Sidebar
            state={state}
            selected={selected}
            onSelect={selectThread}
            draftProjectId={draft?.projectId}
            onAddProject={addProject}
            onNewChat={newChat}
            onNewThread={openDraft}
            onDeleteThread={deleteThread}
            onRemoveProject={removeProject}
            unsent={unsent}
            agents={activeAgents}
          />
        )}
        <main className="main" data-testid="main">
          <UpdateBanner />
          {thread && project ? (
            <ThreadView
              key={thread.id}
              thread={thread}
              project={project}
              items={items[thread.id] ?? []}
              text={unsent[thread.id] ?? ""}
              onText={(text) => setUnsentFor(thread.id, text)}
              onSend={send}
              onStop={stop}
              onAnswer={answer}
              onUpdate={updateThread}
              onRetry={() => void retry()}
              onFix={applyFix}
              models={models[thread.backend]?.models ?? []}
              modelsError={models[thread.backend]?.error}
              onRetryModels={() => retryModels(thread.backend)}
              openModelPickerRequest={modelPickerRequest}
              inputRef={inputRef}
              branch={changes?.branch ?? undefined}
            />
          ) : draft ? (
            <DraftView
              key={`${draft.projectId}:${draftRevision}`}
              draft={draft}
              projects={state.projects}
              creating={creating}
              models={models[draft.settings.backend]?.models ?? []}
              modelsError={models[draft.settings.backend]?.error}
              onRetryModels={() => retryModels(draft.settings.backend)}
              branch={draftBranch?.projectId === draft.projectId ? draftBranch.branch ?? undefined : undefined}
              onChange={setDraft}
              onSend={sendDraft}
              inputRef={inputRef}
              text={unsent[`draft:${draftRevision}`] ?? ""}
              onText={(text) => setUnsentFor(`draft:${draftRevision}`, text)}
            />
          ) : state.projects.length === 0 ? (
            <EmptyState onAddProject={addProject} />
          ) : null}
        </main>
        {thread && <Workspace key={thread.id} thread={thread} changes={changes} onRefresh={() => loadChanges(thread.id)} onRevert={revert}
          visible={showChanges} onShow={() => setLayout({ changes: true })} onHide={() => setLayout({ changes: false })}
          suspended={showSettings || showCompanion || streamerMode}
          onOpenTerminal={() => { setLayout({ changes: true }); setTerminals((m) => ({ ...m, [thread.id]: true })); }}
          onHideTerminal={() => closeTerminal(thread.id)} onFocusChat={() => requestAnimationFrame(() => inputRef.current?.focus())}
          terminal={terminals[thread.id] ? (<Suspense fallback={<div className="terminal-panel loading" role="status">Loading terminal…</div>}>
              <TerminalPanel key={thread.id} theme={state.settings.theme} thread={thread} onClose={() => closeTerminal(thread.id)} command={terminalCommands[thread.id]} onCommandConsumed={(nonce) => setTerminalCommands((commands) => {
                if (commands[thread.id]?.nonce !== nonce) return commands;
                const next = { ...commands };
                delete next[thread.id];
                return next;
              })} />
            </Suspense>) : null}
        />}
        {error && (
          <div className="toast" role="alert" data-testid="toast">
            <span data-testid="toast-message">{error.message}</span>
            {error.retry && <button type="button" className="btn small" data-testid="toast-retry" onClick={() => { const again = error.retry; setError(null); again?.(); }}>Retry</button>}
            <button type="button" className="btn small" data-testid="toast-copy" title="Copy the error and where it happened" onClick={() => void bridge.invoke("clipboard:write", { text: `Modex error\n${error.message}\n\nat: ${new Date().toISOString()}\nplatform: ${bridge.platform}\nthread: ${thread?.id ?? "none"}\ncwd: ${thread?.cwd ?? "none"}` }).catch(() => {})}>Copy</button>
            <button type="button" className="toast-close" onClick={() => setError(null)} aria-label="Dismiss">×</button>
          </div>
        )}
      </div>
      {showSettings && <SettingsDialog settings={state.settings} projects={state.projects} currentProjectId={thread?.projectId ?? draft?.projectId} onSave={saveSettings} onClose={() => setShowSettings(false)} />}
      {showCompanion && <CompanionDialog onClose={() => setShowCompanion(false)} />}
      {streamerMode && (
        <section className="streamer-shield" data-testid="streamer-shield" aria-label="Streamer Mode is on">
          <Icon name="privacy" size={28} />
          <h1>Streamer Mode</h1>
          <p>Private workspace content is hidden.</p>
          <button autoFocus className="btn" data-testid="streamer-mode-disable" onClick={() => setLayout({ streamerMode: false })}>Show workspace</button>
        </section>
      )}
    </div>
  );
}
