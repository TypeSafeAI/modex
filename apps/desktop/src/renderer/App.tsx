import { QuestionDraftContext, type QuestionDraftCache } from "./components/transcript/QuestionCard";
import type { NativeDraftBridge, NativeDraftReadOnlyOpen, PendingSendView } from "../shared/native-drafts";
import type { ComposerRecovery } from "../shared/update-recovery";
import type { Attachment, AttachmentDraftOwner } from "../shared/attachments";
import { useComposerRecovery } from "./useComposerRecovery";
import { ComposerRestartPreparation } from "../shared/composer-restart-preparation";
import { ComposerOwnerRemoval } from "../shared/composer-owner-removal";
import { restartDrafts } from "./restart-drafts";
import { StreamerMode, useStreamerRedaction } from "./streamer";
import { redactSecrets } from "../shared/streamer-secrets";
import { RepositoryOverview } from "./components/RepositoryOverview";
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { UpdateBanner } from "./components/UpdateBanner";
import { UpdateRecoveryView } from "./components/UpdateRecoveryView";
import { UpdateRestartView } from "./components/UpdateRestartView";
import { useUpdateState } from "./useUpdateState";
import type { AppState, BackendId, BridgeCommands, ChangesSnapshot, ModelInfo, Settings, Thread, ThreadEvent, ThreadItem, ThreadPatch, TurnFix } from "../shared/types";
import { LIMITS } from "../shared/attachments";
import { ComposerAttachments, type AttachmentActions } from "./composer-attachments";
import { stageFiles, pickFiles } from "./attachments";
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
import { AnalyticsView } from "./components/AnalyticsView";
import { Icon } from "./components/ui/Icon";
import { IconButton } from "./components/ui/IconButton";
import { useSelectionHistory } from "./history";
import { PanelResizeHandle } from "./components/PanelResizeHandle";
import { PANEL_WIDTHS, usePanelSizing } from "./panel-sizing";
import { useLayout } from "./layout";
import { applyTheme, restoreTheme } from "./theme";
import { applyItemEvent, type ItemEvent } from "./transcript";
import { codeReviewEnabled } from "./code-review/feature.js";
import type { ReviewNavigation } from "./code-review/CodeReviewView";

/** ⌃` shows or hides the thread's terminal. xterm maps no byte to it, so it reaches this handler even from inside the shell. */
const isTerminalToggle = (e: KeyboardEvent) => e.ctrlKey && !e.metaKey && !e.altKey && e.code === "Backquote";

// xterm is only loaded once a terminal is first opened.
const TerminalPanel = lazy(() => import("./components/TerminalPanel").then((m) => ({ default: m.TerminalPanel })));
const ImagesView = lazy(() => import("./images/ImagesView").then(m => ({ default: m.ImagesView })));
const RoutinesView = lazy(() => import("./routines/RoutinesView").then(m => ({ default: m.RoutinesView })));
const PluginSurface = lazy(() => import("./plugins/PluginSurface").then(m => ({ default: m.PluginSurface })));
const SpaceView = lazy(() => import("./space/SpaceView").then(m => ({ default: m.SpaceView })));
const CodeReviewView = lazy(() => import("./code-review/CodeReviewView"));

export function App({ persistPreferences = true, spaceEnabled = true, analyticsEnabled = true, suspended = false }: { persistPreferences?: boolean; spaceEnabled?: boolean; analyticsEnabled?: boolean; suspended?: boolean } = {}) {
  const updater = useUpdateState();
  const updateBlocked = ["preparing", "staged", "uncertain", "recovery"].includes(updater.installation?.phase ?? "");
  const updateBlockedRef = useRef(updateBlocked); updateBlockedRef.current = updateBlocked;
  const [native, setNative] = useState<NativeDraftBridge | null>(null);
  const nativeRef = useRef(native); nativeRef.current = native;
  const [nativeLoading, setNativeLoading] = useState(Boolean(bridge.nativeDrafts));
  const [nativeHold, setNativeHold] = useState(false);
  const nativeHoldRef = useRef(false);
  const ownerRemovalHeld = useRef(false);
  const ownerRemovalEvents = useRef<Extract<ThreadEvent, { type: "thread" }>[]>([]);
  const [nativeRecoveryError, setNativeRecoveryError] = useState<string | null>(null);
  const [readOnlyRecovery, setReadOnlyRecovery] = useState<NativeDraftReadOnlyOpen | null>(null);
  const [pendingSends, setPendingSends] = useState<PendingSendView[]>([]);
  const pendingRef = useRef(pendingSends); pendingRef.current = pendingSends;
  const pendingRuns = useRef(new Set<string>());
  const holdNative = (held: boolean) => { nativeHoldRef.current = held; setNativeHold(held); };
  const rememberPending = (record: PendingSendView) => {
    pendingRef.current = [...pendingRef.current.filter(value => value.id !== record.id), record];
    setPendingSends(pendingRef.current);
  };
  const forgetPending = (id: string) => {
    pendingRef.current = pendingRef.current.filter(value => value.id !== id);
    setPendingSends(pendingRef.current);
  };
  const ownerFor = (key: string): AttachmentDraftOwner => {
    const match = key.match(/^draft:(0|[1-9]\d*):([A-Za-z0-9_-]+)$/);
    return match ? { kind: "project", key, projectId: match[2]! } : { kind: "thread", threadId: key };
  };
  const ownerKey = (owner: AttachmentDraftOwner) => owner.kind === "thread" ? owner.threadId : owner.key;
  const [openPage, setOpenPage] = useState<{ id: string }>();
  useEffect(() => {
    const open = (event: Event) => { if (nativeHoldRef.current || updateBlockedRef.current) return; setOpenPage({ id: (event as CustomEvent<string>).detail }); setSpaceOpened(true); setSurface("space"); };
    window.addEventListener("modex:open-page", open);
    return () => window.removeEventListener("modex:open-page", open);
  }, []);
  const [surface, setSurface] = useState<"chat" | "space" | "analytics" | "images" | "plugins" | "routines" | "code-review">("chat");
  // Code Review (#319) stays hidden in built apps until Gate A is done; see code-review/feature.ts.
  const [reviewEnabled] = useState(() => codeReviewEnabled(localStorage, import.meta.env.DEV));
  const [reviewOpened, setReviewOpened] = useState(false);
  const [reviewNav, setReviewNav] = useState<ReviewNavigation | null>(null);
  const [mediaFeatures, setMediaFeatures] = useState({ images: false, plugins: false });
  const [imagesOpened, setImagesOpened] = useState(false);
  useEffect(() => { let live = true; void bridge.invoke("features:media", undefined).then(features => { if (live) setMediaFeatures(features); }).catch(() => {}); return () => { live = false; }; }, []);
  const openImages = () => { setImagesOpened(true); setSurface("images"); };
  const [spaceOpened, setSpaceOpened] = useState(false);
  /** A project whose notes Space should show, from the sidebar's "Open notes". */
  const [openProject, setOpenProject] = useState<{ projectId: string; nonce: number }>();
  const [workspaces, setWorkspaces] = useState<BridgeCommands["notes:workspaces"]["res"]>();
  const [spaceChatOpen, setSpaceChatOpen] = useState(false);
  const [state, setState] = useState<AppState | null>(null);
  useLayoutEffect(() => { if (state) applyTheme(state.settings.theme, persistPreferences); }, [state?.settings.theme, persistPreferences]);
  useLayoutEffect(() => () => { if (!persistPreferences) restoreTheme(); }, [persistPreferences]);
  const [connectionRevision, setConnectionRevision] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [draftRevision, setDraftRevision] = useState(0);
  const [items, setItems] = useState<Record<string, ThreadItem[]>>({});
  const questionDrafts = useRef(new Map<string, QuestionDraftCache>());
  useEffect(() => {
    for (const [threadId, drafts] of questionDrafts.current) {
      if (state && !state.threads.some(t => t.id === threadId && !t.retired)) {
        questionDrafts.current.delete(threadId);
        continue;
      }
      const snapshot = items[threadId];
      if (!snapshot) continue;
      const open = new Set(snapshot.filter(item => item.kind === "question" && !item.answers && !item.withdrawn && !item.delivery).map(item => item.id));
      for (const id of drafts.keys()) if (!open.has(id)) drafts.delete(id);
    }
  }, [items, state]);
  const draftsForQuestions = (threadId: string) => {
    let drafts = questionDrafts.current.get(threadId);
    if (!drafts) { drafts = new Map(); questionDrafts.current.set(threadId, drafts); }
    return drafts;
  };
  // Unsent text by thread id (or `draft:<revision>:<projectId>` for a new chat). Switching threads keeps it;
  // Native recovery saves the exact raw values; remote clients keep their existing local drafts.
  const [unsent, setUnsent] = useState<Record<string, string>>({});
  const unsentRevision = useRef(new Map<string, number>());
  const unsentRef = useRef<Record<string, string>>({});
  const setUnsentFor = useCallback((key: string, text: string) => {
    unsentRef.current[key] = text;
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
  // App owns asynchronous attachment work so switching/unmounting cannot reset its reservations.
  const [, redrawAttachments] = useState(0);
  const [attachmentDrafts] = useState(() => new ComposerAttachments(
    () => redrawAttachments(n => n + 1),
    async (files, key) => {
      if (nativeRef.current) await nativeRef.current.discard(ownerFor(key), files.map(file => file.id));
      else await bridge.invoke("attachments:discard", { ids: files.map(f => f.id) });
    },
    async key => { await nativeRef.current?.retire(ownerFor(key)); },
  ));
  const stateRef = useRef(state);
  stateRef.current = state;
  const attachmentActions = (key: string): AttachmentActions => {
    const unavailable = () => {
      const t = stateRef.current?.threads.find(t => t.id === key);
      if (nativeHoldRef.current || updateBlockedRef.current || nativeLoading || nativeRecoveryError) return true;
      if (!nativeRef.current && key.startsWith("draft:") && attachmentDrafts.get(key).sending) return true;
      return Boolean(t && (t.retired || t.status === "running" || t.status === "waiting"));
    };
    return {
      ...attachmentDrafts.get(key),
      onFiles: async (files) => {
        if (unavailable()) return;
        const list = Array.from(files);
        await attachmentDrafts.stage(key, list.length, room => stageFiles(list, room, nativeRef.current ? files => nativeRef.current!.stage(ownerFor(key), files) : undefined));
      },
      onPick: async () => {
        if (unavailable()) return;
        await attachmentDrafts.stage(key, LIMITS.perTurn, remaining => nativeRef.current ? nativeRef.current.pick(ownerFor(key), remaining) : pickFiles(remaining));
      },
      onRemove: id => { if (!unavailable()) attachmentDrafts.remove(key, id); },
      onDismissWarning: () => attachmentDrafts.dismissWarning(key),
    };
  };
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
  const [knowledgeReady, setKnowledgeReady] = useState(false);
  const [knowledgeSidebarOpen, setKnowledgeSidebarOpen] = useState(false);
  const onKnowledgeReadyChange = useCallback((ready: boolean) => {
    setKnowledgeReady(ready);
    if (ready) setKnowledgeSidebarOpen(false);
  }, []);
  const knowledgeFocused = surface === "space" && knowledgeReady;
  const sidebarOpen = knowledgeFocused ? knowledgeSidebarOpen : layout.sidebar;
  const streamerMode = layout.streamerMode;
  const showAnalytics = analyticsEnabled && layout.analytics;
  // Hiding Analytics in Settings while it is open returns to Chat rather than leaving an unreachable surface.
  useEffect(() => { if (!showAnalytics && surface === "analytics") setSurface("chat"); }, [showAnalytics, surface]);
  useStreamerRedaction(streamerMode);
  const privateLabel = streamerMode ? redactSecrets : (text: string) => text;
  const setShowChanges = (f: (v: boolean) => boolean) => setLayout((l) => ({ changes: f(l.changes) }));
  const setSidebarOpen = (f: (v: boolean) => boolean) => {
    if (knowledgeFocused) setKnowledgeSidebarOpen(f);
    else setLayout((l) => ({ sidebar: f(l.sidebar) }));
  };
  // The toast: what failed and, when the action can simply be run again, how.
  const [error, setError] = useState<{ message: string; retry?: () => void } | null>(null);
  const [models, setModels] = useState<Partial<Record<BackendId, { models: ModelInfo[]; error?: string }>>>({});
  const [modelPickerRequest, setModelPickerRequest] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  // A new chat is a draft (renderer-only) until its first send creates the thread.
  const [draft, setDraft] = useState<Draft | null>(null);
  const draftKey = `draft:${draftRevision}:${draft?.projectId ?? ""}`;
  const creating = !native && Boolean(draft) && attachmentDrafts.get(draftKey).sending;
  const activeDraftKey = draft ? draftKey : null;
  const activeDraftKeyRef = useRef(activeDraftKey);
  activeDraftKeyRef.current = activeDraftKey;
  // The project picker navigates drafts within one New chat revision. Keep their input and
  // in-flight operations until that whole revision is closed or replaced by another New chat.
  const previousDraft = useRef<{ revision: number; keys: Set<string> } | null>(null);
  useEffect(() => {
    const currentRevision = native ? draftRevision : activeDraftKey ? draftRevision : null;
    if (previousDraft.current && previousDraft.current.revision !== currentRevision) {
      for (const key of previousDraft.current.keys) attachmentDrafts.retire(key);
      previousDraft.current = null;
    }
    if (activeDraftKey) {
      previousDraft.current ??= { revision: draftRevision, keys: new Set() };
      previousDraft.current.keys.add(activeDraftKey);
    }
  }, [activeDraftKey, draftRevision, attachmentDrafts, native]);
  useEffect(() => {
    // State arrives before native draft restoration. Retirement must not touch
    // the one-shot attachment restore or run while recovery remains unresolved.
    if (nativeLoading || nativeRecoveryError) return;
    for (const t of state?.threads ?? []) if (t.retired) attachmentDrafts.retire(t.id);
  }, [state?.threads, attachmentDrafts, nativeLoading, nativeRecoveryError]);
  const draftRef = useRef(draft); draftRef.current = draft;
  const draftConfig = useRef<ComposerRecovery["draft"]>(null);
  if (draft) draftConfig.current = { ...draft, revision: draftRevision };
  const captureDrafts = (): ComposerRecovery => {
    const current = stateRef.current;
    const editable = new Map(attachmentDrafts.editableSnapshot().map(entry => [entry.key, entry.attachments.map(file => ({ ...file }))]));
    const selectedId = selectedRef.current && current?.threads.some(row => row.id === selectedRef.current && !row.retired) ? selectedRef.current : null;
    const threads = (current?.threads ?? []).filter(row => !row.retired && (row.id === selectedId || unsentRef.current[row.id] || editable.get(row.id)?.length))
      .map(row => ({ threadId: row.id, text: unsentRef.current[row.id] ?? "", attachments: editable.get(row.id) ?? [] }));
    const config = draftConfig.current && current?.projects.some(row => row.id === draftConfig.current!.projectId) ? draftConfig.current : null;
    const projects = config ? (current?.projects ?? []).map(row => {
      const key = `draft:${config.revision}:${row.id}`;
      return { key, projectId: row.id, text: unsentRef.current[key] ?? "", attachments: editable.get(key) ?? [] };
    }).filter(row => row.projectId === config.projectId || row.text || row.attachments.length) : [];
    const savedConfig = config ? structuredClone(config) : null;
    // Transfers pass this snapshot directly to strict native persistence, unlike
    // the autosave queue's JSON copy. Represent an unset effort as absent there too.
    if (savedConfig?.settings.effort === undefined && savedConfig) delete savedConfig.settings.effort;
    return { threads, projects, selectedThreadId: selectedId, draft: savedConfig };
  };
  const composerRecovery = useComposerRecovery(native, captureDrafts(), failure => setError({ message: `Could not save your draft: ${failure.message}`, retry: () => { void composerRecovery.flush().catch(() => {}); } }), () => restartPreparation.canClose);
  const restartContext = useRef({ captureDrafts, nativeLoading, nativeRecoveryError, showSettings, showCompanion, spaceOpened });
  restartContext.current = { captureDrafts, nativeLoading, nativeRecoveryError, showSettings, showCompanion, spaceOpened };
  const [restartPreparation] = useState(() => new ComposerRestartPreparation({
    queue: composerRecovery.queue,
    guards: restartDrafts,
    validate: () => {
      const current = restartContext.current;
      if (!nativeRef.current || current.nativeLoading || current.nativeRecoveryError || nativeHoldRef.current) throw new Error("Wait for draft recovery to finish before restarting.");
      if (current.showSettings || current.showCompanion) throw new Error("Save or close the open dialog before restarting.");
      if (pendingRef.current.length || pendingRuns.current.size) throw new Error("Retry saved messages before restarting.");
    },
    snapshot: () => restartContext.current.captureDrafts(),
    requiredEditors: () => restartContext.current.spaceOpened ? ["pages", "page-comments", "space-actions"] : [],
    freezeAttachments: () => attachmentDrafts.freezeForRecovery() !== null,
    releaseAttachments: () => attachmentDrafts.resumeAfterRecovery(),
    held: holdNative,
  }));
  useEffect(() => {
    if (!native || !bridge.onRestartPreparation) return;
    let unsubscribeRestart: (() => void) | undefined;
    try {
      unsubscribeRestart = bridge.onRestartPreparation(invalidated => restartPreparation.prepare(invalidated), () => {
        void restartPreparation.release().catch(error => setNativeRecoveryError(error.message));
      });
      const unsubscribeQuit = bridge.onRecoveryQuitPreparation?.(invalidated => restartPreparation.prepareQuit(invalidated), () => restartPreparation.releaseQuit());
      return () => {
        try { restartPreparation.invalidate(); }
        finally { try { unsubscribeQuit?.(); } finally { unsubscribeRestart?.(); } }
      };
    } catch (error) { unsubscribeRestart?.(); setNativeRecoveryError((error as Error).message); }
  }, [native, restartPreparation]);
  const [ownerRemovalPreparation] = useState(() => new ComposerOwnerRemoval<AppState>({
    queue: composerRecovery.queue,
    validate: () => {
      const current = restartContext.current;
      if (!nativeRef.current || current.nativeLoading || current.nativeRecoveryError || nativeHoldRef.current || updateBlockedRef.current || pendingRuns.current.size) {
        throw new Error("Wait for current draft operations to finish before removing this project or thread.");
      }
      if (current.showSettings || current.showCompanion) throw new Error("Save or close the open dialog before removing this project or thread.");
    },
    snapshot: () => restartContext.current.captureDrafts(),
    prepareEditors: invalidated => restartDrafts.prepare(restartContext.current.spaceOpened ? ["pages", "page-comments", "space-actions"] : [], invalidated),
    releaseEditors: () => restartDrafts.release(),
    freezeAttachments: () => attachmentDrafts.freezeForOwnerRemoval() !== null,
    releaseAttachments: () => attachmentDrafts.resumeAfterRecovery(),
    held: value => {
      ownerRemovalHeld.current = value;
      if (!value) {
        const pending = ownerRemovalEvents.current.splice(0).reverse();
        setState(current => current ? { ...current, threads: current.threads.map(thread => {
          const update = pending.find(event => event.threadId === thread.id);
          return update ? { ...thread, ...update.thread, status: thread.status } : thread;
        }) } : current);
      }
      holdNative(value);
    },
    apply: (saved, current) => {
      // Main sends events and adoption over the same ordered channel. Earlier
      // events are in this snapshot; later events must survive until release.
      ownerRemovalEvents.current = [];
      const restored = Object.fromEntries([...saved.threads.map(row => [row.threadId, row.text]), ...saved.projects.map(row => [row.key, row.text])]);
      // Synchronous refs must describe the canonical snapshot before the queue
      // adopts it. React state alone leaves a stale autosave/selection window.
      stateRef.current = current; setState(current);
      unsentRef.current = restored; setUnsent(restored);
      selectedRef.current = saved.selectedThreadId; setSelected(saved.selectedThreadId);
      draftConfig.current = saved.draft;
      const nextDraft = saved.draft && !saved.selectedThreadId ? { projectId: saved.draft.projectId, worktree: saved.draft.worktree, settings: saved.draft.settings } : null;
      draftRef.current = nextDraft; setDraft(nextDraft);
      if (saved.draft) setDraftRevision(saved.draft.revision);
    },
  }));
  useEffect(() => {
    if (!native || !bridge.onOwnerRemovalPreparation || !bridge.onOwnerRemovalAdoption || !bridge.onOwnerRemovalRecovery) return;
    const preparation = bridge.onOwnerRemovalPreparation(invalidated => ownerRemovalPreparation.prepare(invalidated), () => {
      void ownerRemovalPreparation.release().catch(error => setNativeRecoveryError(error.message));
    });
    const adoption = bridge.onOwnerRemovalAdoption((_invalidated, result) => ownerRemovalPreparation.adopt(result), () => {});
    const recovery = bridge.onOwnerRemovalRecovery(message => {
      setNativeRecoveryError(message);
      // Main's recovery notification revoked the preload's cached editable open.
      // A fresh read-only result preserves originals and permits ordinary Quit.
      void native.open().then(opened => {
        if (!opened?.readOnly) throw new Error("Owner removal requires read-only recovery.");
        nativeRef.current = null; setNative(null); setReadOnlyRecovery(opened);
      }).catch(error => setNativeRecoveryError(error.message));
    });
    return () => { recovery(); adoption(); preparation(); };
  }, [native, ownerRemovalPreparation]);
  // A thread just created from a draft has no history to load, and reloading it could overwrite
  // the first streamed items; the selection effect skips its one load.
  const justCreated = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    const s = await bridge.invoke("state:get", undefined);
    stateRef.current = s; setState(s);
    return s;
  }, []);

  useEffect(() => {
    let live = true;
    void refresh().then(async s => {
      const capability = bridge.nativeDrafts;
      const opened = capability ? await capability.open() : null;
      if (!live) return;
      if (opened && capability) {
        if (opened.readOnly) {
          setReadOnlyRecovery(opened); setNativeRecoveryError(opened.recovery.message); setNativeLoading(false);
          return;
        }
        const records = (await Promise.all(opened.pendingIds.map(id => capability.readPending(id)))).filter((record): record is PendingSendView => record !== null);
        if (!live) return;
        const saved = opened.drafts;
        if (saved) {
          const restored = Object.fromEntries([...saved.threads.map(row => [row.threadId, row.text]), ...saved.projects.map(row => [row.key, row.text])]);
          if (!attachmentDrafts.restore([...saved.threads.map(row => ({ key: row.threadId, attachments: row.attachments })), ...saved.projects.map(row => ({ key: row.key, attachments: row.attachments }))])) throw new Error("The saved attachment drafts could not be restored.");
          unsentRef.current = restored; setUnsent(restored);
          selectedRef.current = saved.selectedThreadId; setSelected(saved.selectedThreadId);
          draftConfig.current = saved.draft;
          if (saved.draft) { setDraftRevision(saved.draft.revision); if (!saved.selectedThreadId) setDraft({ projectId: saved.draft.projectId, worktree: saved.draft.worktree, settings: saved.draft.settings }); }
        } else {
          attachmentDrafts.restore([]);
          if (s.threads[0]) { selectedRef.current = s.threads[0].id; setSelected(s.threads[0].id); }
        }
        for (const record of records) if (!attachmentDrafts.restorePending(ownerKey(record.owner), record.files)) throw new Error("The original pending message could not be restored.");
        pendingRef.current = records; setPendingSends(records);
        nativeRef.current = capability; setNative(capability);
      } else if (s.threads[0]) setSelected(s.threads[0].id);
      setNativeLoading(false);
    }).catch((err: Error) => {
      if (!live) return;
      setError({ message: err.message }); setNativeRecoveryError(err.message); setNativeLoading(false);
    });
    return () => { live = false; };
  }, [refresh]);

  useEffect(() => bridge.onReconnect?.((info) => {
    // A resumed host stream replays every missed event, so loaded transcripts stay; only reload them
    // when the host could not resume. The thread list always refreshes: creation and deletion are
    // not thread events.
    if (!info?.resumed) setConnectionRevision((revision) => revision + 1);
    else if (selectedRef.current) void loadChanges(selectedRef.current);
    void refresh().then((snapshot) => {
      const current = selectedRef.current;
      if (current && !snapshot.threads.some((thread) => thread.id === current)) setSelected(null);
    }).catch((err: Error) => setError({ message: err.message }));
  }), [refresh]);

  // Live events from every thread; the selected thread re-renders, others just update status.
  useEffect(() => {
    return bridge.onEvent((e: ThreadEvent) => {
      // Retirement publishes its Store event inside the held operation. Its
      // canonical Store snapshot is adopted with drafts by the second handshake.
      if (ownerRemovalHeld.current && e.type === "thread") { ownerRemovalEvents.current.push(e); return; }
      if (e.type === "item" || e.type === "item_update") {
        loadingItems.current.get(e.threadId)?.push(e);
        setItems((m) => ({ ...m, [e.threadId]: applyItemEvent(m[e.threadId] ?? [], e) }));
      }
      else if (e.type === "status") {
        setState((s) => (s ? { ...s, threads: s.threads.map((t) => (t.id === e.threadId ? { ...t, status: e.status } : t)) } : s));
        if ((e.status === "idle" || e.status === "error") && selectedRef.current === e.threadId) void loadChanges(e.threadId);
      } else if (e.type === "thread") setState((s) => {
        if (!s) return s;
        // A thread made in main (a routine run) is news to this window; others update in place.
        if (!s.threads.some((t) => t.id === e.thread.id)) return { ...s, threads: [e.thread, ...s.threads] };
        return { ...s, threads: s.threads.map((t) => (t.id === e.thread.id ? { ...t, ...e.thread, status: t.status } : t)) };
      });
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
    if (nativeHoldRef.current) return;
    setSurface("chat");
    setDraft(null);
    setSelected(id);
  }, []);
  /** Shows a thread in chat, refreshing first when this window has not heard of it yet. */
  const openThread = (id: string) => { void (state?.threads.some(t => t.id === id) ? Promise.resolve() : refresh()).then(() => { selectThread(id); setSurface("chat"); }).catch((err: Error) => setError({ message: err.message })); };
  const history = useSelectionHistory(selected, selectThread, (id) => Boolean(state?.threads.some((t) => t.id === id)));
  const draftDefaults = (s: AppState): Draft["settings"] => ({
    backend: s.settings.default_backend,
    mode: s.settings.default_mode,
    plan: false,
    auto: s.settings.routing.auto_by_default,
    model: s.settings.default_model[s.settings.default_backend] ?? "",
  });
  const openDraft = (projectId: string, worktree = false) => {
    if (!state || nativeHoldRef.current || nativeLoading || nativeRecoveryError) return;
    setSelected(null);
    setDraftRevision((revision) => revision + 1);
    setDraft({ projectId, worktree, settings: draftDefaults(state) });
  };
  // Nothing selected and no draft, but there are projects (first launch, last thread deleted): open a draft.
  useEffect(() => {
    if (!state || selected || creating || nativeLoading || nativeHold || nativeRecoveryError) return;
    if (draft && !state.projects.some((p) => p.id === draft.projectId)) setDraft(null);
    else if (!draft && state.projects[0]) { setDraftRevision(revision => revision + 1); setDraft({ projectId: state.projects[0].id, worktree: false, settings: draftDefaults(state) }); }
  }, [state, selected, draft, creating, nativeLoading, nativeHold, nativeRecoveryError]);

  // Model catalogue per backend, fetched lazily from the CLIs (Codex: live `model/list`).
  useEffect(() => {
    const b = thread?.backend ?? draft?.settings.backend;
    if (!b || models[b]) return;
    void bridge.invoke("models:list", { backend: b }).then((r) => setModels((m) => ({ ...m, [b]: r }))).catch((err) => setModels((m) => ({ ...m, [b]: { models: [], error: (err as Error).message } })));
  }, [thread?.backend, draft?.settings.backend, models]);

  // A draft, like a thread, always shows a model the CLI knows: the settings default or the CLI's own.
  useEffect(() => {
    if (!draft || !state || nativeHoldRef.current) return;
    const list = models[draft.settings.backend]?.models;
    if (!list?.length || list.some((m) => m.id === draft.settings.model)) return;
    const preferred = state.settings.default_model[draft.settings.backend];
    const pick = list.find((m) => m.id === preferred) ?? list.find((m) => m.isDefault) ?? list[0]!;
    setDraft({ ...draft, settings: { ...draft.settings, model: pick.id, effort: pick.defaultEffort } });
  }, [draft?.settings.backend, draft?.settings.model, models, nativeHold]);

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

  // Workspaces group the sidebar's projects; they change with projects and in Space, so read them then.
  const projectKey = state?.projects.map(p => p.id).join(",") ?? "";
  useEffect(() => {
    if (!spaceEnabled || !projectKey) return;
    let alive = true;
    void bridge.invoke("notes:workspaces", undefined).then(value => { if (alive) setWorkspaces(value); }, () => { if (alive) setWorkspaces(undefined); });
    return () => { alive = false; };
  }, [projectKey, surface, spaceEnabled]);
  const openNotes = (projectId: string) => { setOpenProject({ projectId, nonce: Date.now() }); setSpaceOpened(true); setSurface("space"); };
  const moveToWorkspace = (projectId: string, workspaceId: string) => void act(async () => { setWorkspaces(await bridge.invoke("project:workspace", { projectId, workspaceId })); });
  const moveToNewWorkspace = (projectId: string, name: string) => void act(async () => { setWorkspaces(await bridge.invoke("project:new-workspace", { projectId, name })); });
  const act = async <T,>(fn: () => Promise<T>, { retry = true }: { retry?: boolean } = {}): Promise<T | undefined> => {
    try {
      if (nativeHoldRef.current || nativeLoading || nativeRecoveryError) throw new Error("Wait for draft recovery to finish.");
      setError(null);
      return await fn();
    } catch (err) {
      setError({ message: (err as Error).message, ...(retry ? { retry: () => void act(fn) } : {}) });
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
  const resumeNativeSend = async (initial: PendingSendView): Promise<void> => {
    const capability = nativeRef.current;
    if (!capability || pendingRuns.current.has(initial.id) || nativeHoldRef.current || nativeRecoveryError) return;
    pendingRuns.current.add(initial.id); redrawAttachments(value => value + 1);
    let sourceKey = ownerKey(initial.owner);
    let sealed = false;
    try {
      const target = await capability.create(initial.id);
      await refresh();
      const record = await capability.readPending(initial.id);
      if (!record) { forgetPending(initial.id); return; }
      rememberPending(record); sourceKey = ownerKey(record.owner);
      // Failed originals stay reserved independently; a retired renderer draft
      // can be revived only with this main-proven pending batch.
      attachmentDrafts.restorePending(sourceKey, record.files);
      holdNative(true);
      composerRecovery.queue.update(captureDrafts());
      await composerRecovery.flush();
      const hold = composerRecovery.queue.holdForTransfer();
      await hold.drained;
      const transfer = attachmentDrafts.beginTransfer(sourceKey, target.id);
      if (!transfer) { composerRecovery.queue.refuseTransfer(hold.token); holdNative(false); throw new Error("Let attachment requests finish, then retry the saved message."); }
      sealed = true;
      const batch = transfer.snapshot.find(entry => entry.key === sourceKey)!.attachments.map(file => ({ ...file }));
      const claimed = batch.map(file => ({ ...file, rel: file.rel.startsWith("staging/") ? `${target.id}/${file.rel.slice(8)}` : file.rel }));
      const originals = new Set(record.files.map(file => file.id));
      const snapshot = captureDrafts();
      const newerText = unsentRef.current[sourceKey] ?? "";
      snapshot.threads = snapshot.threads.filter(entry => entry.threadId !== target.id);
      snapshot.threads.push({ threadId: target.id, text: newerText, attachments: claimed.filter(file => !originals.has(file.id)) });
      if (record.owner.kind === "project") snapshot.projects = snapshot.projects.map(entry => entry.key === sourceKey ? { ...entry, text: "", attachments: [] } : entry);
      const selectTarget = selectedRef.current === sourceKey || activeDraftKeyRef.current === sourceKey;
      if (selectTarget) snapshot.selectedThreadId = target.id;
      const receipt = await capability.transfer({ id: crypto.randomUUID(), intentId: record.id, snapshot, files: batch });
      if (receipt.status === "unchanged") {
        attachmentDrafts.refuseTransfer(transfer.token); composerRecovery.queue.refuseTransfer(hold.token); sealed = false; holdNative(false);
        throw new Error("The draft changed before transfer. Retry the saved message.");
      }
      if (receipt.status !== "committed" || !attachmentDrafts.adoptTransfer(transfer.token, receipt.files)) throw new Error("Attachment recovery is required. Quit and reopen Modex; the original and newer drafts were preserved.");
      if (sourceKey !== target.id) setUnsentFor(sourceKey, "");
      setUnsentFor(target.id, newerText);
      if (selectTarget) { selectedRef.current = target.id; setSelected(target.id); draftRef.current = null; setDraft(null); justCreated.current = target.id; }
      composerRecovery.queue.completeTransfer(hold.token, snapshot, receipt.revision);
      sealed = false; holdNative(false); sourceKey = target.id;
      const sent = await capability.send(record.id);
      if (!sent.ok) throw new Error(sent.error ?? "The saved message could not be sent.");
      attachmentDrafts.finishSend(sourceKey, true); forgetPending(record.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (sealed || composerRecovery.queue.held) setNativeRecoveryError(message);
      else { holdNative(false); setError({ message }); }
      try { const record = await capability.readPending(initial.id); if (record) rememberPending(record); else { attachmentDrafts.finishSend(sourceKey, true); forgetPending(initial.id); } } catch { /* Keep the durable original visible until recovery. */ }
    } finally { pendingRuns.current.delete(initial.id); redrawAttachments(value => value + 1); }
  };
  const beginNativeSend = async (key: string, rawText: string, configuration: PendingSendView["configuration"]): Promise<void> => {
    const capability = nativeRef.current;
    if (!capability || nativeHoldRef.current || nativeRecoveryError || attachmentDrafts.get(key).copying || attachmentDrafts.get(key).sending) return;
    holdNative(true);
    try {
      // Save the exact original before any IPC admission ambiguity or UI clear.
      composerRecovery.queue.update(captureDrafts()); await composerRecovery.flush();
      const hold = composerRecovery.queue.holdForTransfer(); await hold.drained;
      const files = attachmentDrafts.get(key).attachments;
      const intent = await capability.begin({ source: ownerFor(key), rawText, configuration, files });
      const record = await capability.readPending(intent.id);
      if (!record || attachmentDrafts.beginSend(key) === null) throw new Error("The original message is preserved. Quit and reopen Modex to recover it.");
      rememberPending(record); setUnsentFor(key, "");
      // begin writes only I. R stayed unchanged, so ordinary autosaving resumes
      // immediately while the asynchronous thread/worktree creation runs.
      composerRecovery.queue.refuseTransfer(hold.token);
      composerRecovery.queue.update(captureDrafts()); holdNative(false);
      await resumeNativeSend(record);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (composerRecovery.queue.held) setNativeRecoveryError(message);
      else { holdNative(false); setError({ message }); }
    }
  };
  // Send/create retries belong to the restored composer: replaying only an inner act() closure
  // would bypass its capacity and duplicate-send reservations.
  /** First send from a draft: create the thread with the draft's settings, then send. */
  const sendDraft = async (text: string): Promise<void> => {
    if (!draft) return;
    const d = draft;
    if (native) {
      // Model/backend changes may explicitly clear effort. Omit that optional
      // field at the durable-message boundary; keep every supplied value intact.
      const { effort, ...settings } = d.settings;
      return beginNativeSend(draftKey, text, { worktree: d.worktree, settings: { ...settings, ...(effort === undefined ? {} : { effort }) } });
    }
    const attachments = attachmentDrafts.beginSend(draftKey);
    if (attachments === null) return;
    setUnsentFor(draftKey, "");
    let restoreKey = draftKey;
    let restoreRevision = unsentRevision.current.get(draftKey)!;
    const sent = await act(async () => {
      const s = d.settings;
      const t = await bridge.invoke("thread:create", { projectId: d.projectId, worktree: d.worktree, backend: s.backend, mode: s.mode, model: s.model || undefined, auto: s.auto });
      if (s.plan || s.effort) await bridge.invoke("thread:update", { threadId: t.id, patch: { ...(s.plan ? { plan: true } : {}), ...(s.effort ? { effort: s.effort } : {}) } });
      await refresh();
      // Transfer ownership with selection, including edits made while thread creation was pending.
      attachmentDrafts.move(draftKey, t.id);
      restoreKey = t.id;
      const draftWasEdited = unsentRevision.current.get(draftKey) !== restoreRevision;
      restoreRevision = unsentRevision.current.get(t.id) ?? 0;
      if (draftWasEdited) setUnsentFor(t.id, unsentRef.current[draftKey] ?? "");
      setUnsentFor(draftKey, "");
      if (activeDraftKeyRef.current === draftKey) {
        justCreated.current = t.id;
        setDraft(null);
        setSelected(t.id);
      }
      const r = await bridge.invoke("thread:send", { threadId: t.id, text: text.trim(), ...(attachments.length ? { attachments } : {}) });
      if (!r.ok) setError({ message: r.error ?? "send failed" });
      return r.ok;
    }, { retry: false });
    attachmentDrafts.finishSend(restoreKey, sent === true);
    if (sent !== true) restoreUnsentIfCurrent(restoreKey, restoreRevision, text);
  };
  const send = async (text: string): Promise<void> => {
    if (!thread || thread.retired || thread.status === "running" || thread.status === "waiting") return;
    const threadId = thread.id;
    if (native) return beginNativeSend(threadId, text, { worktree: Boolean(thread.worktree), settings: { backend: thread.backend, mode: thread.mode, plan: thread.plan, auto: Boolean(thread.auto), model: thread.model, ...(thread.effort ? { effort: thread.effort } : {}) } });
    const attachments = attachmentDrafts.beginSend(threadId);
    if (attachments === null) return;
    setUnsentFor(threadId, "");
    const revision = unsentRevision.current.get(threadId)!;
    const sent = await act(async () => {
      const r = await bridge.invoke("thread:send", { threadId, text: text.trim(), ...(attachments.length ? { attachments } : {}) });
      if (!r.ok) setError({ message: r.error ?? "send failed" });
      return r.ok;
    }, { retry: false });
    attachmentDrafts.finishSend(threadId, sent === true);
    if (sent !== true) restoreUnsentIfCurrent(threadId, revision, text);
  };
  /** The failure card's Retry: main runs the thread's last message again without adding a second bubble. */
  const retry = () => thread && act(async () => {
    const r = await bridge.invoke("thread:retry", { threadId: thread.id });
    if (!r.ok) setError({ message: r.error ?? "retry failed", retry: () => void retry() });
  });
  /** The failure card's fix: type the sign-in command into the thread's shell (opening it), open Settings, or start over in a new thread. */
  const applyFix = (fix: TurnFix) => {
    if (fix.kind === "settings") { setShowSettings(true); return; }
    if (fix.kind === "new-thread") { if (thread) openDraft(thread.projectId, Boolean(thread.worktree)); return; }
    if (fix.kind === "models") {
      if (thread && (!models[thread.backend]?.models.length || models[thread.backend]?.error)) retryModels(thread.backend);
      setModelPickerRequest((request) => request + 1);
      return;
    }
    if (fix.kind === "retry") { void retry(); return; }
    if (!thread) return;
    const id = thread.id;
    setSurface("chat");
    setLayout({ changes: true });
    setTerminalCommands((m) => ({ ...m, [id]: { text: fix.command, nonce: ++commandNonce.current } }));
    setTerminals((m) => ({ ...m, [id]: true }));
  };
  const stop = () => thread && act(() => bridge.invoke("thread:stop", { threadId: thread.id }));
  const answer = (itemId: string, a: "yes" | "no" | "always") => thread && act(() => bridge.invoke("thread:answer", { threadId: thread.id, itemId, answer: a }));
  const answerQuestion = async (itemId: string, answers: Record<string, string[]>) => thread ? bridge.invoke("thread:answer-question", { threadId: thread.id, itemId, answers }) : undefined;
  const updateThread = (patch: ThreadPatch) => thread && act(async () => {
    await bridge.invoke("thread:update", { threadId: thread.id, patch });
    await refresh();
  });
  /** Archived threads leave the working list on every device; the selection stays so the row remains visible under Archived. */
  const archiveThread = (t: Thread, archived: boolean) => act(async () => {
    await bridge.invoke("thread:archive", { threadId: t.id, archived });
    await refresh();
  });
  const closeTerminal = (threadId: string) => {
    setTerminals((m) => ({ ...m, [threadId]: false }));
    inputRef.current?.focus();
  };
  const toggleTerminal = (threadId: string) => {
    if (surface === "chat" && terminals[threadId] && showChanges) closeTerminal(threadId);
    else { setSurface("chat"); setLayout({ changes: true }); setTerminals((m) => ({ ...m, [threadId]: true })); }
  };
  const deleteThread = (t: Thread) => act(async () => {
    const removeWorktree = t.worktree ? window.confirm(privateLabel(`Delete this thread and remove its worktree?\n\n${t.worktree.path}\n\nUncommitted changes there will be lost; the branch ${t.worktree.branch} is kept.`)) : true;
    if (t.worktree && !removeWorktree) return;
    const s = await bridge.invoke("thread:delete", { threadId: t.id, removeWorktree });
    if (nativeRef.current) return; // The main-owned handshake already adopted selection and drafts.
    setState(s);
    loadingItems.current.delete(t.id);
    setItems((m) => { const next = { ...m }; delete next[t.id]; return next; });
    setUnsentFor(t.id, "");
    attachmentDrafts.retire(t.id);
    setTerminals((m) => {
      if (!(t.id in m)) return m;
      const { [t.id]: _gone, ...rest } = m;
      return rest;
    });
    setChangeResult((c) => (c?.threadId === t.id ? null : c));
    if (selected === t.id) setSelected(s.threads.find((x) => x.projectId === t.projectId)?.id ?? s.threads[0]?.id ?? null);
  });
  const removeProject = (projectId: string) => act(async () => {
    if (!window.confirm(spaceEnabled ? "Remove this project from Modex? Files on disk are not touched, and its notes stay in Space." : "Remove this project from Modex? Files on disk are not touched.")) return;
    const removedThreads = state?.threads.filter((t) => t.projectId === projectId) ?? [];
    const s = await bridge.invoke("project:remove", { projectId });
    if (nativeRef.current) return; // Do not overwrite canonical adoption with the pre-await draft closure.
    setState(s);
    for (const t of removedThreads) {
      loadingItems.current.delete(t.id);
      setUnsentFor(t.id, "");
      attachmentDrafts.retire(t.id);
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
    const removedDraftKey = `draft:${draftRevision}:${projectId}`;
    setUnsentFor(removedDraftKey, "");
    attachmentDrafts.retire(removedDraftKey);
    if (draft?.projectId === projectId) setDraft(null);
    if (thread?.projectId === projectId || (selected && removedIds.has(selected))) {
      setSelected(s.threads[0]?.id ?? null);
    }
  });
  const revert = (path: string) => thread && act(async () => {
    if (!window.confirm(privateLabel(`Discard changes to ${path}? This cannot be undone.`))) return;
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
      if (nativeHoldRef.current || updateBlockedRef.current || nativeLoading || nativeRecoveryError || suspended || showSettings || showCompanion || (surface !== "chat" && !(surface === "space" && eventTargetInSpaceChat(e)))) return;
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
        if (surface === "space") { setSurface("chat"); setLayout({ changes: true }); }
        else setShowChanges((v) => !v);
      } else if (e.key === "Enter" && (thread || draft) && document.activeElement !== inputRef.current) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [thread, state, draft, showSettings, showCompanion, streamerMode, showChanges, terminals, surface, suspended]);

  // Focus after React commits the selected thread or newly mounted draft.
  useEffect(() => {
    inputRef.current?.focus();
  }, [selected, draftRevision, draft?.projectId]);

  const newChat = () => {
    const pid = thread?.projectId ?? draft?.projectId ?? state?.projects[0]?.id;
    if (pid) openDraft(pid);
  };
  const activeThreads = state?.threads.filter((candidate) => candidate.status === "running" || candidate.status === "waiting") ?? [];
  const activeAgents = activeThreads.flatMap(t => (items[t.id] ?? []).flatMap(item =>
    item.kind === "tool" && item.agent && (item.agent.state === "running" || item.agent.state === "waiting")
      ? [{ threadId: t.id, threadTitle: t.title, agent: item.agent }] : []));
  const activeWork = { count: activeThreads.length, agents: activeAgents.length, waiting: activeThreads.filter((candidate) => candidate.status === "waiting").length };
  const openActiveWork = () => {
    const next = activeThreads[0];
    if (next) { setLayout({ sidebar: true }); selectThread(next.id); }
  };

  const panels = usePanelSizing({ ...layout, sidebar: sidebarOpen }, surface === "chat" && showChanges && Boolean(thread), state?.settings.theme === "graphite");
  const openSpaceChat = (prompt?: string) => {
    if (nativeHoldRef.current) return;
    setSpaceChatOpen(true);
    if (prompt) {
      const key = thread?.id ?? draftKey;
      setUnsentFor(key, [unsent[key], prompt].filter(Boolean).join("\n\n"));
    }
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const workspace = state ? (
    <>
      <TitleBar
        thread={surface === "chat" ? thread : null}
        onRename={(title) => void updateThread({ title })}
        canBack={surface === "chat" ? history.canBack : surface === "code-review" && Boolean(reviewNav?.canBack)}
        canForward={surface === "chat" ? history.canForward : surface === "code-review" && Boolean(reviewNav?.canForward)}
        onBack={surface === "code-review" ? () => reviewNav?.back() : history.back}
        onForward={surface === "code-review" ? () => reviewNav?.forward() : history.forward}
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
        onArchive={archiveThread}
        platform={bridge.platform}
      />
      <Rail surface={surface} onOpenRoutines={() => setSurface("routines")} onOpenAnalytics={showAnalytics ? () => setSurface("analytics") : undefined} onOpenImages={mediaFeatures.images ? openImages : undefined} onOpenPlugins={mediaFeatures.plugins ? () => setSurface("plugins") : undefined} onOpenCodeReview={reviewEnabled ? () => { setReviewOpened(true); setSurface("code-review"); } : undefined} onOpenChat={() => setSurface("chat")} onOpenSpace={spaceEnabled ? () => { setSpaceOpened(true); setSurface("space"); } : undefined} activeWork={activeWork} onOpenActiveWork={openActiveWork} onOpenSettings={() => setShowSettings(true)} onOpenCompanion={() => setShowCompanion(true)} streamerMode={streamerMode} onEnableStreamerMode={() => setLayout({ streamerMode: !streamerMode })} />
      <div ref={panels.setSheet} className="sheet" data-testid="sheet" data-surface={surface}>
        {(surface === "chat" || surface === "space" || surface === "code-review") && sidebarOpen && <PanelResizeHandle side="sidebar" width={panels.sidebarWidth} min={PANEL_WIDTHS.sidebar.min} max={panels.sidebarMax}
          onResize={sidebarWidth => setLayout({ sidebarWidth })} onReset={() => setLayout({ sidebarWidth: panels.sidebarDefault })} />}
        {surface === "chat" && thread && showChanges && <PanelResizeHandle side="workspace" width={panels.workspaceWidth} min={PANEL_WIDTHS.workspace.min} max={panels.workspaceMax}
          onResize={workspaceWidth => setLayout({ workspaceWidth })} onReset={() => setLayout({ workspaceWidth: PANEL_WIDTHS.workspace.default })} />}
        {surface === "analytics" && <AnalyticsView active={!showSettings && !showCompanion} />}
        {reviewOpened && <Suspense fallback={surface === "code-review" ? <div role="status">Opening Code Review…</div> : null}><CodeReviewView active={surface === "code-review"} inboxOpen={sidebarOpen} layout={layout} setLayout={setLayout} onNavigation={setReviewNav} /></Suspense>}
        {imagesOpened && <Suspense fallback={<div role="status">Opening Images…</div>}><ImagesView active={surface === "images"} projects={state.projects} onPlugins={() => setSurface("plugins")} onOpenPage={id => { setOpenPage({ id }); setSpaceOpened(true); setSurface("space"); }} onUseInChat={async id => {
          const key = thread?.id ?? draftKey;
          if (!thread && !draft) throw new Error("Choose a project and open a chat before attaching an image.");
          const staged = await bridge.invoke("images:stage", { id });
          if (!staged.data) throw new Error("Image is unavailable.");
          const bytes = Uint8Array.from(atob(staged.data), c => c.charCodeAt(0));
          await attachmentActions(key).onFiles([new File([bytes], staged.name, { type: staged.mime })]);
          setSurface("chat");
        }} /></Suspense>}
        {surface === "plugins" && <Suspense fallback={<div role="status">Opening Plugins…</div>}><PluginSurface projects={state.projects} onImages={openImages} /></Suspense>}
        {surface === "routines" && <Suspense fallback={<div role="status">Opening Routines…</div>}><RoutinesView active={!showSettings && !showCompanion} projects={state.projects}
          onOpenThread={openThread}
          onOpenPage={spaceEnabled ? id => { setOpenPage({ id }); setSpaceOpened(true); setSurface("space"); } : undefined} /></Suspense>}
        {spaceOpened && <Suspense fallback={surface === "space" ? <div role="status">Opening Space…</div> : null}><SpaceView onOpenThread={openThread} onOpenImages={mediaFeatures.images ? openImages : undefined} onKnowledgeReadyChange={onKnowledgeReadyChange} openPage={openPage} openProject={openProject} active={surface === "space" && !showSettings && !showCompanion} sidebarOpen={sidebarOpen} onOpenChat={openSpaceChat} chatOpen={spaceChatOpen} /></Suspense>}
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
            onArchiveThread={archiveThread}
            onRemoveProject={removeProject}
            unsent={unsent}
            agents={activeAgents}
            {...(spaceEnabled ? { workspaces, onOpenNotes: openNotes, onMoveToWorkspace: moveToWorkspace, onMoveToNewWorkspace: moveToNewWorkspace } : {})}
          />
        )}
        <main className={`main${surface === "space" && spaceChatOpen ? " space-chat" : ""}`} data-testid={surface === "space" && spaceChatOpen ? "space-chat" : "main"}>
          {surface === "space" && spaceChatOpen && <header className="space-chat-header"><IconButton icon="minus" label="Minimize chat" size="md" onClick={() => { setSpaceChatOpen(false); requestAnimationFrame(() => document.querySelector<HTMLInputElement>(".space-chat-launcher input")?.focus()); }} /><span>{thread?.title ?? "New chat"}</span><IconButton icon="expand" label="Open chat in Home" size="md" onClick={() => setSurface("chat")} /></header>}
          {surface === "chat" && <UpdateBanner {...updater} />}
          {pendingSends.map(record => <section key={record.id} className="notice" data-testid="pending-message" aria-label="Saved message awaiting send">
            <p>Your original message is saved separately from newer typing.</p>
            <pre style={{ whiteSpace: "pre-wrap" }}>{privateLabel(record.rawText)}</pre>
            {record.files.length > 0 && <p>{record.files.map(file => privateLabel(file.name)).join(", ")}</p>}
            <button className="btn small" data-testid="pending-message-retry" disabled={pendingRuns.current.has(record.id) || nativeHold || Boolean(nativeRecoveryError)} onClick={() => void resumeNativeSend(record)}>Retry saved message</button>
          </section>)}
          {surface === "chat" && thread && project && !showChanges && <RepositoryOverview project={project} changes={changes} onOpenChanges={() => setLayout({ changes: true })} onOpenFolder={() => openPath(thread.cwd)} />}
          {thread && project ? (
            <QuestionDraftContext.Provider value={draftsForQuestions(thread.id)}>
            <ThreadView
              key={thread.id}
              thread={thread}
              project={project}
              items={items[thread.id] ?? []}
              text={unsent[thread.id] ?? ""}
              onText={(text) => { if (!nativeHoldRef.current && !nativeRecoveryError) setUnsentFor(thread.id, text); }}
              attachments={attachmentDrafts.get(thread.id).attachments}
              attachmentActions={attachmentActions(thread.id)}
              onSend={send}
              onStop={stop}
              onAnswer={answer}
              onAnswerQuestion={answerQuestion}
              onUpdate={updateThread}
              onRetry={() => void retry()}
              onFix={applyFix}
              onUnarchive={() => void archiveThread(thread, false)}
              models={models[thread.backend]?.models ?? []}
              modelsError={models[thread.backend]?.error}
              onRetryModels={() => retryModels(thread.backend)}
              openModelPickerRequest={modelPickerRequest}
              inputRef={inputRef}
              branch={changes?.branch ?? undefined}
            />
            </QuestionDraftContext.Provider>
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
              onChange={value => { if (!nativeHoldRef.current && !nativeRecoveryError) setDraft(value); }}
              onSend={sendDraft}
              inputRef={inputRef}
              text={unsent[draftKey] ?? ""}
              onText={(text) => { if (!nativeHoldRef.current && !nativeRecoveryError) setUnsentFor(draftKey, text); }}
              attachments={attachmentDrafts.get(draftKey).attachments}
              attachmentActions={attachmentActions(draftKey)}
            />
          ) : state.projects.length === 0 ? (
            <EmptyState onAddProject={addProject} />
          ) : null}
        </main>
        {thread && <Workspace key={thread.id} thread={thread} changes={changes} onRefresh={() => loadChanges(thread.id)} onRevert={revert}
          visible={surface === "chat" && showChanges} onShow={() => setLayout({ changes: true })} onHide={() => setLayout({ changes: false })}
          suspended={suspended || surface !== "chat" || showSettings || showCompanion}
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
      {showSettings && <SettingsDialog settings={state.settings} projects={state.projects} currentProjectId={thread?.projectId ?? draft?.projectId} onSave={saveSettings} onClose={() => setShowSettings(false)} {...(analyticsEnabled ? { analyticsInRail: layout.analytics, onAnalyticsInRail: (shown: boolean) => setLayout({ analytics: shown }) } : {})} />}
      {showCompanion && <CompanionDialog onClose={() => setShowCompanion(false)} />}
    </>
  ) : <span>{error?.message ?? "Loading…"}</span>;

  return (
    <StreamerMode.Provider value={streamerMode}>
      <div className={`app${sidebarOpen ? "" : " sidebar-closed"}${state ? "" : " loading"}`} style={panels.style} data-streamer-mode={streamerMode ? "true" : "false"}>
        {readOnlyRecovery ? <UpdateRecoveryView recovery={readOnlyRecovery} /> : <>
          <div style={{ display: "contents" }} inert={nativeHold || nativeLoading || Boolean(nativeRecoveryError) || updateBlocked}>{workspace}</div>
          {updateBlocked && <UpdateRestartView {...updater} />}
          {!updateBlocked && (nativeLoading || nativeRecoveryError) && <div className="toast" role="alert" data-testid="draft-recovery-status">{nativeRecoveryError ?? "Restoring saved drafts…"}</div>}
        </>}
        {!state && streamerMode && <button className="btn" data-testid="streamer-mode-disable" onClick={() => setLayout({ streamerMode: false })}>Turn off Streamer Mode</button>}
      </div>
    </StreamerMode.Provider>
  );
}

function eventTargetInSpaceChat(event: KeyboardEvent): boolean {
  return event.target instanceof Element && Boolean(event.target.closest(".space-chat"));
}
