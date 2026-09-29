import fs from "node:fs";
import path from "node:path";
import type { ApprovalAnswer, BackendId, Mode, ModelInfo, Thread, ThreadEvent, ThreadItem, ThreadPatch, ThreadStatus } from "../../shared/types.js";
import { Store, newId } from "./store.js";
import * as gitx from "./git.js";
import type { Backend, TurnSink } from "./backends/types.js";
import { ClaudeBackend } from "./backends/claude.js";
import { CodexBackend } from "./backends/codex.js";
import { MockBackend } from "./backends/mock.js";
import { Router } from "./routing/router.js";
import type { SecretStore } from "./secrets.js";

interface Live {
  abort: AbortController | null;
  run: Promise<void> | null;
  /** Backend executing the current turn, so a force-stop reaches the right one. */
  backend: BackendId | null;
  flushTimer?: ReturnType<typeof setTimeout>;
  pending: Map<string, (a: ApprovalAnswer) => void>;
  items: ThreadItem[];
  status: ThreadStatus;
  /** Assistant item currently receiving streamed text, if any. */
  streaming: { id: string; text: string } | null;
}

export interface RunnerOptions {
  home: string;
  store: Store;
  emit: (event: ThreadEvent) => void;
  /** Override backends (tests inject fakes). */
  backends?: Partial<Record<BackendId, Backend>>;
  /** Override the Auto router (tests inject an offline one or a fake Jev transport). */
  router?: Router;
  /** Where a hand-entered TypeSafe key lives (OS keychain via Electron safeStorage). */
  secrets?: SecretStore;
  /** Stop thread-owned resources before deleting its state or working directory. */
  beforeDeleteThread?: (threadId: string) => Promise<void>;
}

/**
 * Owns every thread. Threads run independently and concurrently; each turn is delegated to
 * the thread's backend (Claude CLI, Codex CLI, or the offline mock engine) whose callbacks are
 * turned into ThreadEvents for the renderer and persisted as items.
 */
export class ThreadRunner {
  private readonly live = new Map<string, Live>();
  private disposing = false;
  private readonly naming = new Map<string, AbortController>();
  private readonly titleRuns = new Set<Promise<void>>();
  private readonly deleting = new Set<string>();
  private readonly removingProjects = new Set<string>();
  private readonly creating = new Map<string, Set<Promise<Thread>>>();
  private readonly backends: Record<BackendId, Backend>;
  /** Auto routing: judges a request (Jev or the offline heuristic) and picks model/effort/fast per turn. */
  readonly router: Router;

  constructor(private readonly o: RunnerOptions) {
    const s = () => o.store.settings;
    this.backends = {
      claude: o.backends?.claude ?? new ClaudeBackend(s().claude_bin),
      codex: o.backends?.codex ?? new CodexBackend(s().codex_bin),
      mock: o.backends?.mock ?? new MockBackend(() => s().mock_script, o.home),
    };
    this.router = o.router ?? new Router({ home: o.home, policy: () => s().routing, listModels: (b) => this.listModels(b), secrets: o.secrets });
  }

  backend(id: BackendId): Backend {
    return this.backends[id];
  }

  async listModels(id: BackendId): Promise<{ models: ModelInfo[]; error?: string }> {
    if (this.disposing) return { models: [], error: "Modex is shutting down." };
    try {
      return { models: await this.backends[id].listModels() };
    } catch (err) {
      return { models: [], error: (err as Error).message };
    }
  }

  async dispose(): Promise<void> {
    this.disposing = true;
    for (const abort of this.naming.values()) abort.abort();
    this.naming.clear();
    const runs = [...this.live.values()].flatMap((l) => l.run ? [l.run] : []);
    for (const t of this.live.keys()) this.stop(t);
    await Promise.all(Object.values(this.backends).map((b) => b.dispose()));
    await Promise.allSettled([...runs, ...this.titleRuns]);
  }

  private slot(threadId: string): Live {
    let l = this.live.get(threadId);
    if (!l) {
      l = { abort: null, run: null, backend: null, pending: new Map(), items: this.o.store.items(threadId), status: "idle", streaming: null };
      this.live.set(threadId, l);
    }
    return l;
  }

  items(threadId: string): ThreadItem[] {
    return [...this.slot(threadId).items];
  }

  status(threadId: string): ThreadStatus {
    return this.live.get(threadId)?.status ?? "idle";
  }

  /** Shared by coding turns and embedded terminals; removal fences cover both. */
  assertThreadAvailable(threadId: string): void {
    if (this.disposing) throw new Error("Modex is shutting down.");
    const thread = this.o.store.thread(threadId);
    if (!thread) throw new Error(`unknown thread ${threadId}`);
    if (this.removingProjects.has(thread.projectId)) throw new Error("This project is being removed.");
    if (this.deleting.has(threadId)) throw new Error("This thread is being deleted.");
  }

  async createThread(projectId: string, opts: { worktree?: boolean; mode?: Mode; model?: string; backend?: BackendId; auto?: boolean } = {}): Promise<Thread> {
    if (this.disposing) throw new Error("Modex is shutting down.");
    if (this.removingProjects.has(projectId)) throw new Error("This project is being removed.");
    const pending = this.creating.get(projectId) ?? new Set<Promise<Thread>>();
    this.creating.set(projectId, pending);
    const creation = this.createThreadInProject(projectId, opts);
    pending.add(creation);
    try { return await creation; }
    finally {
      pending.delete(creation);
      if (!pending.size) this.creating.delete(projectId);
    }
  }

  private async createThreadInProject(projectId: string, opts: { worktree?: boolean; mode?: Mode; model?: string; backend?: BackendId; auto?: boolean }): Promise<Thread> {
    const project = this.o.store.project(projectId);
    if (!project) throw new Error(`unknown project ${projectId}`);
    const settings = this.o.store.settings;
    const backend = opts.backend ?? settings.default_backend;
    const id = newId();
    const now = new Date().toISOString();
    let cwd = project.path;
    let worktree: Thread["worktree"];
    if (opts.worktree) {
      const script = gitx.projectWorktreeScript(project.path);
      if (script) {
        // The project defines its own convention (e.g. .worktrees/<name>); follow it instead of ~/.modex.
        worktree = await gitx.projectWorktreeAdd(project.path, script, `modex-${id}`);
      } else {
        const branch = `modex/${id}`;
        const dest = path.join(this.o.home, "worktrees", project.name, id);
        worktree = { ...(await gitx.worktreeAdd(project.path, dest, branch)), manager: "modex" };
      }
      cwd = worktree.path;
    }
    const thread: Thread = {
      id, projectId, title: "New thread", createdAt: now, updatedAt: now, cwd, worktree,
      backend, mode: opts.mode ?? settings.default_mode, plan: false,
      model: opts.model ?? settings.default_model[backend] ?? "", status: "idle",
      auto: opts.auto ?? settings.routing.auto_by_default,
    };
    this.o.store.addThread(thread);
    return thread;
  }

  async removeProject(projectId: string): Promise<void> {
    if (this.removingProjects.has(projectId)) throw new Error("This project is being removed.");
    this.removingProjects.add(projectId);
    try {
      await Promise.allSettled(this.creating.get(projectId) ?? []);
      const threads = this.o.store.snapshot().threads.filter((thread) => thread.projectId === projectId);
      await Promise.all(threads.map((thread) => this.deleteThread(thread.id)));
      this.o.store.removeProject(projectId);
    } finally {
      this.removingProjects.delete(projectId);
    }
  }

  async deleteThread(threadId: string, removeWorktree = false): Promise<void> {
    if (this.deleting.has(threadId)) throw new Error("This thread is being deleted. If its CLI has not confirmed the stop, press Stop again to force it.");
    this.deleting.add(threadId);
    this.naming.get(threadId)?.abort();
    this.naming.delete(threadId);
    try {
      const thread = this.o.store.thread(threadId);
      const l = this.live.get(threadId);
      this.stop(threadId);
      await this.o.beforeDeleteThread?.(threadId);
      await l?.run;
      if (thread?.worktree && removeWorktree) {
        const project = this.o.store.project(thread.projectId);
        if (project) {
          const script = thread.worktree.manager === "project-script" ? gitx.projectWorktreeScript(project.path) : null;
          if (script) await gitx.projectWorktreeRemove(project.path, script, thread.worktree.branch);
          else await gitx.worktreeRemove(project.path, thread.worktree.path);
        }
      }
      clearTimeout(l?.flushTimer);
      this.o.store.deleteThread(threadId);
      this.live.delete(threadId);
    } finally {
      this.deleting.delete(threadId);
    }
  }

  /** Runs one user turn. Resolves when the thread is idle again (or errored). */
  async send(threadId: string, text: string): Promise<void> {
    this.assertThreadAvailable(threadId);
    const l = this.slot(threadId);
    if (l.run) throw new Error("This thread is still working. Stop it or wait for it to finish.");
    const run = this.runTurn(threadId, text);
    l.run = run;
    try { await run; }
    finally { if (l.run === run) l.run = null; }
  }

  private async runTurn(threadId: string, text: string): Promise<void> {
    let thread = this.o.store.thread(threadId);
    if (!thread) throw new Error(`unknown thread ${threadId}`);
    const l = this.slot(threadId);
    if (l.status === "running" || l.status === "waiting") throw new Error("This thread is still working. Stop it or wait for it to finish.");
    if (!fs.existsSync(thread.cwd)) throw new Error(`working directory is missing: ${thread.cwd}`);

    const shouldName = thread.title === "New thread" && !l.items.some((item) => item.kind === "user");
    this.addItem(threadId, { id: newId(), kind: "user", text, at: new Date().toISOString() });
    if (thread.title === "New thread") this.updateThread(threadId, { title: text.replace(/\s+/g, " ").trim().slice(0, 60) || "New thread" });

    const fallbackTitle = thread.title;
    const abort = new AbortController();
    l.abort = abort;
    l.streaming = null;
    const sink = this.sinkFor(threadId, l);
    this.setStatus(threadId, "running");
    let fast = false;
    const auto = Boolean(thread.auto);
    if (auto) {
      // Auto: judge the request, then re-read the thread — the pick is applied as a thread update
      // so the composer, header, and persisted state all show what this turn runs on.
      try {
        const project = this.o.store.project(thread.projectId);
        const receipt = await this.router.route({ thread, text, items: l.items.slice(0, -1), project: { name: project?.name ?? "", branch: thread.worktree?.branch ?? null } }, abort.signal);
        this.addItem(threadId, receipt.item);
        const d = receipt.decision;
        if (d.backend !== thread.backend) this.updateThread(threadId, { backend: d.backend, model: d.model, effort: d.effort }, { fromRouter: true });
        else if (d.model !== thread.model || d.effort !== thread.effort) this.updateThread(threadId, { model: d.model, effort: d.effort }, { fromRouter: true });
        fast = d.fast;
        thread = this.o.store.thread(threadId) ?? thread;
      } catch (err) {
        this.addItem(threadId, { id: newId(), kind: "notice", level: "warn", text: `Auto routing failed (${(err as Error).message}); using the thread's current model.`, at: new Date().toISOString() });
      }
    }
    if (abort.signal.aborted) {
      this.addItem(threadId, { id: newId(), kind: "notice", level: "info", text: "Stopped.", at: new Date().toISOString() });
      this.setStatus(threadId, "idle");
      l.abort = null;
      return;
    }
    const backend = this.backends[thread.backend];
    l.backend = thread.backend;
    try {
      const result = await backend.runTurn(
        text,
        { cwd: thread.cwd, mode: thread.mode, plan: thread.plan, model: thread.model, effort: thread.effort, fast, resume: thread.sessionHandle, addDirs: thread.worktree ? [] : [] },
        sink,
        abort.signal,
      );
      if (result.status === "completed" && shouldName && !abort.signal.aborted) this.nameThread(threadId, text, fallbackTitle, backend, thread.model);
      if (auto) this.router.noteOutcome(threadId, result.status);
      if (result.status === "failed") {
        this.addItem(threadId, { id: newId(), kind: "notice", level: "error", text: result.error ?? "The turn failed.", at: new Date().toISOString() });
        this.setStatus(threadId, "error");
      } else {
        if (result.status === "interrupted") this.addItem(threadId, { id: newId(), kind: "notice", level: "info", text: "Stopped.", at: new Date().toISOString() });
        this.setStatus(threadId, "idle");
      }
    } catch (err) {
      if (auto) this.router.noteOutcome(threadId, "failed");
      this.addItem(threadId, { id: newId(), kind: "notice", level: "error", text: (err as Error).message, at: new Date().toISOString() });
      this.setStatus(threadId, "error");
    } finally {
      // A CLI can exit without closing its last streamed items. Save their tail and stop spinners.
      for (const item of l.items) {
        if ((item.kind === "thinking" || item.kind === "tool") && item.status === "running") {
          this.patchItem(threadId, item.id, { status: "done", durationMs: Date.now() - Date.parse(item.at), ...(item.kind === "tool" ? { ok: false } : {}) }, { persist: false });
        }
      }
      for (const [id, resolve] of l.pending) {
        this.patchItem(threadId, id, { answer: "no" }, { persist: false });
        resolve("no");
      }
      l.pending.clear();
      this.persistItems(threadId, l);
      l.abort = null;
      l.backend = null;
      l.streaming = null;
    }
  }

  private nameThread(threadId: string, text: string, fallback: string, backend: Backend, model: string): void {
    if (!backend.generateTitle || this.disposing || this.deleting.has(threadId) || this.o.store.thread(threadId)?.title !== fallback) return;
    const abort = new AbortController();
    this.naming.set(threadId, abort);
    const timer = setTimeout(() => abort.abort(), 30_000);
    const run = Promise.resolve().then(() => backend.generateTitle!(text, { model }, abort.signal)).then((title) => {
      if (title && !abort.signal.aborted && !this.disposing && this.o.store.thread(threadId)?.title === fallback) {
        this.updateThread(threadId, { title });
      }
    }).catch(() => { /* Naming is best-effort; keep the opening-message title. */ }).finally(() => {
      clearTimeout(timer);
      this.titleRuns.delete(run);
      if (this.naming.get(threadId) === abort) this.naming.delete(threadId);
    });
    this.titleRuns.add(run);
  }

  stop(threadId: string): void {
    const l = this.live.get(threadId);
    if (!l) return;
    for (const [itemId, resolve] of l.pending) {
      this.patchItem(threadId, itemId, { answer: "no" });
      resolve("no");
    }
    l.pending.clear();
    const abort = l.abort;
    if (!abort) return;
    if (!abort.signal.aborted) abort.abort();
    // A second Stop means the CLI has not confirmed the first one.
    else if (l.run) this.forceStop(threadId, l);
  }

  private forceStop(threadId: string, l: Live): void {
    const id = l.backend;
    const backend = id ? this.backends[id] : undefined;
    if (!id || !backend?.forceStop) return;
    const others = [...this.live].filter(([other, o]) => other !== threadId && o.backend === id && o.run).length;
    const name = id === "codex" ? "Codex" : id;
    const text = others ? `Force-stopping ${name}. ${others} other ${name} ${others === 1 ? "thread" : "threads"} will stop too.` : `Force-stopping ${name}.`;
    this.addItem(threadId, { id: newId(), kind: "notice", level: "warn", text, at: new Date().toISOString() });
    backend.forceStop().catch((err: Error) => {
      if (this.live.get(threadId) === l) this.addItem(threadId, { id: newId(), kind: "notice", level: "error", text: `Force-stop failed: ${err.message}`, at: new Date().toISOString() });
    });
  }

  answer(threadId: string, itemId: string, answer: ApprovalAnswer): void {
    const l = this.slot(threadId);
    const resolve = l.pending.get(itemId);
    if (!resolve) return;
    l.pending.delete(itemId);
    this.patchItem(threadId, itemId, { answer });
    if (l.pending.size === 0 && l.status === "waiting") this.setStatus(threadId, "running");
    resolve(answer);
  }

  updateThread(threadId: string, patch: ThreadPatch, opts: { fromRouter?: boolean } = {}): Thread {
    if (patch.title !== undefined) {
      this.naming.get(threadId)?.abort();
      this.naming.delete(threadId);
    }
    // The store hands back its live object, so snapshot it before the write below mutates it.
    const live = this.o.store.thread(threadId);
    const current = live ? { ...live } : undefined;
    // Switching backend starts a fresh backend conversation; the transcript stays.
    const extra: Partial<Thread> = current && patch.backend && patch.backend !== current.backend ? { sessionHandle: undefined, model: this.o.store.settings.default_model[patch.backend] ?? "", effort: undefined } : {};
    const t = this.o.store.updateThread(threadId, { ...extra, ...patch });
    this.o.emit({ threadId, type: "thread", thread: t });
    // A hand-picked model on an Auto thread is the strongest signal the fit gets: the user
    // disagreed with the last pick. Only model changes count; effort tweaks stay within a tier.
    if (!opts.fromRouter && current?.auto && patch.model && patch.model !== current.model && !patch.backend && this.slot(threadId).items.some((i) => i.kind === "route")) {
      void this.router.noteOverride(current, patch.model).then((learned) => {
        if (learned) this.addItem(threadId, { id: newId(), kind: "notice", level: "info", text: `Noted — for ${learned.task.replace(/_/g, " ")} you chose tier ${learned.to} over Auto's tier ${learned.from}. Auto will lean that way next time.`, at: new Date().toISOString() });
      }).catch(() => {});
    }
    return t;
  }

  private sinkFor(threadId: string, l: Live): TurnSink {
    const at = () => new Date().toISOString();
    const abort = l.abort;
    const active = () => this.live.get(threadId) === l && l.abort === abort && abort !== null;
    // Backend ids are only guaranteed unique inside a turn (Claude and mock restart at think-1).
    const prefix = newId();
    const scoped = (id: string) => `${prefix}:${id}`;
    return {
      delta: (text) => {
        if (!active()) return;
        if (!l.streaming) {
          l.streaming = { id: newId(), text: "" };
          this.addItem(threadId, { id: l.streaming.id, kind: "assistant", text: "", at: at() });
        }
        l.streaming.text += text;
        this.patchItem(threadId, l.streaming.id, { text: l.streaming.text }, { persist: false });
      },
      assistant: (text) => {
        if (!active()) return;
        if (l.streaming) this.patchItem(threadId, l.streaming.id, { text });
        else if (text.trim()) this.addItem(threadId, { id: newId(), kind: "assistant", text, at: at() });
        l.streaming = null;
      },
      toolStart: (t) => {
        if (!active()) return;
        l.streaming = null;
        this.addItem(threadId, { id: scoped(t.id), kind: "tool", name: t.name, title: t.title, args: redact(t.args), status: "running", at: at() });
      },
      toolUpdate: (id, patch) => {
        if (active()) this.patchItem(threadId, scoped(id), patch, { persist: patch.status === "done" || patch.ok !== undefined });
      },
      approval: (req) =>
        new Promise<ApprovalAnswer>((resolve) => {
          if (!active() || l.abort?.signal.aborted) return resolve("no");
          const id = newId();
          l.pending.set(id, resolve);
          this.addItem(threadId, { id, kind: "approval", question: req.question, detail: req.detail, canAlways: req.canAlways, at: at() });
          this.setStatus(threadId, "waiting");
        }),
      notice: (level, text) => { if (active()) this.addItem(threadId, { id: newId(), kind: "notice", level, text, at: at() }); },
      thinkingDelta: (id, delta) => {
        if (!active()) return;
        id = scoped(id);
        const existing = l.items.find((i) => i.id === id && i.kind === "thinking") as Extract<ThreadItem, { kind: "thinking" }> | undefined;
        // Backends announce a reasoning block before any text exists. The row appears immediately
        // ("Thinking…") so the user sees the model reasoning; if the CLI never shares the text the
        // finished row stays as a compact "Thought for Ns" line and says so when expanded.
        if (!existing) {
          l.streaming = null;
          this.addItem(threadId, { id, kind: "thinking", text: delta, status: "running", at: at() });
        } else this.patchItem(threadId, id, { text: existing.text + delta }, { persist: false });
      },
      thinkingDone: (id, text) => {
        if (!active()) return;
        id = scoped(id);
        const existing = l.items.find((i) => i.id === id && i.kind === "thinking") as Extract<ThreadItem, { kind: "thinking" }> | undefined;
        if (!existing) {
          // A reasoning block that only produced text at completion (no deltas) still gets an item.
          if (text?.trim()) this.addItem(threadId, { id, kind: "thinking", text, status: "done", durationMs: 0, at: at() });
          return;
        }
        this.patchItem(threadId, id, { text: text ?? existing.text, status: "done", durationMs: Date.now() - new Date(existing.at).getTime() });
      },
      session: (handle) => {
        if (!active()) return;
        const t = this.o.store.thread(threadId);
        if (t && t.sessionHandle !== handle) this.o.store.updateThread(threadId, { sessionHandle: handle });
      },
    };
  }

  private addItem(threadId: string, item: ThreadItem): void {
    const l = this.slot(threadId);
    l.items.push(item);
    this.persistItems(threadId, l);
    this.o.emit({ threadId, type: "item", item });
  }

  private patchItem(threadId: string, id: string, patch: Partial<ThreadItem>, opts: { persist?: boolean } = {}): void {
    const l = this.slot(threadId);
    const idx = l.items.findIndex((i) => i.id === id);
    if (idx >= 0) l.items[idx] = { ...l.items[idx], ...patch } as ThreadItem;
    // Bound synchronous transcript writes during streaming, and always flush at turn completion.
    if (opts.persist !== false) this.persistItems(threadId, l);
    else if (!l.flushTimer) l.flushTimer = setTimeout(() => this.persistItems(threadId, l), 250);
    this.o.emit({ threadId, type: "item_update", id, patch });
  }

  private persistItems(threadId: string, l: Live): void {
    clearTimeout(l.flushTimer);
    l.flushTimer = undefined;
    if (this.o.store.thread(threadId)) this.o.store.saveItems(threadId, l.items);
  }

  private setStatus(threadId: string, status: ThreadStatus): void {
    const l = this.slot(threadId);
    l.status = status;
    if (this.o.store.thread(threadId)) this.o.store.updateThread(threadId, { status });
    this.o.emit({ threadId, type: "status", status });
  }
}

/** Keeps tool args small enough for the UI: long strings are truncated. */
function redact(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) out[k] = typeof v === "string" && v.length > 4000 ? v.slice(0, 4000) + "…" : v;
  return out;
}
