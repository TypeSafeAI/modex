import { resolveCli } from "./cli-path.js";
import { RestartAdmission } from "./restart-admission.js";
import fs from "node:fs";
import path from "node:path";
import type { AnswerResult, ApprovalAnswer, ApprovalReceipt, BackendId, FollowUp, LastTurn, Mode, ModelInfo, Settings, Thread, ThreadEvent, ThreadItem, ThreadPatch, ThreadStatus } from "../../shared/types.js";
import { APPROVAL_POLICIES, BACKENDS } from "../../shared/types.js";
import { Store, newId } from "./store.js";
import * as gitx from "./git.js";
import type { ApprovalRequest, Backend, NativeRequest, QuestionReply, TurnResult, TurnSink } from "./backends/types.js";
import { ClaudeBackend } from "./backends/claude.js";
import { CodexBackend } from "./backends/codex.js";
import { MockBackend } from "./backends/mock.js";
import { Router } from "./routing/router.js";
import { answerFor, decide as decideApproval, gateApplies, receiptFor } from "./approvals/gate.js";
import { policyAnswer, policyReceipt } from "./approvals/policy.js";
import type { SecretStore } from "./secrets.js";
import { creditFallbackModel, describeFailure, isModelOutOfCredits, modelFamilyName } from "../../shared/failures.js";

/** After a model is refused for usage credits, how long Modex starts its turns on the fallback instead. */
export const CREDIT_SKIP_MS = 60 * 60_000;
import type { PagesAgents, PagesLease } from "./pages-agents.js";
import type { UsageLedger } from "./usage-ledger.js";
import type { KnowledgeAgents, KnowledgeLease } from "./knowledge-agents.js";
import { AttachmentStore, type AttachmentDraft } from "./attachments.js";
import { ToolLogStore, type ToolLogPage } from "./tool-logs.js";
import { describeAttachments, type Attachment } from "../../shared/attachments.js";
import type { TurnAttachment } from "./backends/types.js";
import type { PendingCreation, PendingSendRecord } from "./pending-sends.js";
import { copyComposerRecovery } from "./update-recovery.js";
import { parseRecoveryJSON, recoveryJSON } from "./attachment-recovery-file.js";
import type { DraftRemovalScope } from "../../shared/native-drafts.js";
import { boundOutput } from "../../shared/evidence.js";
import { taskMarkdown, taskRecord } from "../../shared/task-context.js";
import { actionDigest, emptyRequests, publicAnswers, register as registerRequest, resolve as resolveRequest, settle as settleRequest, validateAnswers, withdraw as withdrawRequests, type Question, type RequestBinding, type RequestsState, type Resolution } from "../../shared/human-requests.js";
import { CONVERSATION_SCHEMA, applyConversationEvent, initialConversation, okFor, toolItemId, type AttemptMark, type ConversationEvent, type ConversationState, type Observation, type SettledOutcome, type TurnRef } from "../../shared/conversation-events.js";

/** Refused approvals in a routine run: the routine is read-only, and nobody is there to answer. */
const UNATTENDED_RECEIPT: ApprovalReceipt = { source: "policy", ruleId: "policy:routine", when: "Routine run: approvals are refused while it runs unattended", decision: "never", via: "policy", ms: 0 };

type ThreadCreationOptions = { worktree?: boolean; mode?: Mode; model?: string; backend?: BackendId; auto?: boolean; plan?: boolean; effort?: string };

type UserItem = Extract<ThreadItem, { kind: "user" }>;
export interface DurableSendAdmission {
  readonly id: string;
  readonly at: string;
  /** Main-only synchronous callback; never IPC data. Called after the raw user
   * item is durable and before routing/backend work. No automatic replay. */
  readonly committed: (item: Readonly<Omit<UserItem, "attachments">> & { readonly attachments?: readonly Readonly<Attachment>[] }) => void;
}
interface PreparedAdmission extends DurableSendAdmission { readonly rawText: string }

type PendingRequest =
  | { kind: "approval"; settle: (answer: ApprovalAnswer) => void }
  | { kind: "question"; questions: Question[]; settle: (reply: QuestionReply) => void };

interface Live {
  abort: AbortController | null;
  run: Promise<void> | null;
  /** Backend executing the current turn, so a force-stop reaches the right one. */
  backend: BackendId | null;
  flushTimer?: ReturnType<typeof setTimeout>;
  /** Requests waiting on a person, by card id: an approval settles with an answer, a question with answers or a withdrawal. */
  pending: Map<string, PendingRequest>;
  /**
   * The running turn's requests (shared/human-requests.ts): open, resolved or withdrawn, and the refusal for
   * any other answer. Kept only while the turn runs, so a secret answer is gone when it ends; afterwards a
   * card's own fields say how it closed.
   */
  requests: RequestsState;
  items: ThreadItem[];
  status: ThreadStatus;
  /** The running turn's projected conversation (shared/conversation-events.ts); reset per turn. */
  conversation: ConversationState;
  /** The attempt whose sink may still write; an older attempt's sink is inert. */
  attempt: string | null;
  /** The last turn ended completed: not failed, stopped or silent. */
  completed?: boolean;
  /** The follow-up suggestion for the transcript as it stands; `key` says which transcript and settings it answers. */
  followUp?: { key: string; abort: AbortController; result: Promise<FollowUp | null> };
  /** Processes a Stop asked to end that never confirmed their exit; their thread's files stay while one lives. */
  unconfirmed?: Set<number>;
}

export interface RunnerOptions {
  beforeSend?(thread: Thread): void;
  imageBackend?: Backend;
  imageOutcome?(jobId: string, status: string): void;
  images?: { prepare(thread: Thread, signal: AbortSignal): Promise<import("./images/agent.js").ImagesLease | undefined> };
  pages?: Pick<PagesAgents, "prepare">;
  /** Analytics' per-turn usage record. Optional: tests and demos run without one. */
  usage?: Pick<UsageLedger, "record">;
  knowledge?: Pick<KnowledgeAgents, "prepare">;
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
  /** Main-owned live draft fence, retained through all asynchronous removal. */
  withOwnerRemoval?: (scope: DraftRemovalScope, operation: () => Promise<void>) => Promise<void>;
  /** Where attached files live; defaults to `<home>/attachments`. */
  attachments?: AttachmentStore;
  /** Whether a process still exists; tests replace the signal-0 probe. */
  isProcessAlive?: (pid: number) => boolean;
}

/**
 * Owns every thread. Threads run independently and concurrently; each turn is delegated to
 * the thread's backend (Claude CLI, Codex CLI, or the offline mock engine) whose callbacks are
 * turned into ThreadEvents for the renderer and persisted as items.
 */
export class ThreadRunner {
  private readonly live = new Map<string, Live>();
  private disposing = false;
  private restartHold?: { kind: "restart" | "owner-removal" };
  private readonly background = new RestartAdmission();
  private readonly naming = new Map<string, AbortController>();
  /** `backend:model` → when the CLI last refused it for usage credits. */
  private readonly outOfCredits = new Map<string, number>();
  private readonly titleRuns = new Set<Promise<void>>();
  private readonly deleting = new Set<string>();
  private readonly removingProjects = new Set<string>();
  /** Threads running an unattended routine turn: no person is there to answer, so approvals are refused. */
  private readonly unattended = new Set<string>();
  private readonly creating = new Map<string, Set<Promise<Thread>>>();
  private readonly pendingCreations = new Map<string, { signature: string; promise: Promise<Thread> }>();
  private readonly backends: Record<BackendId, Backend>;
  /** Auto routing: judges a request (Jev or the offline heuristic) and picks model/effort/fast per turn. */
  readonly router: Router;
  readonly attachments: AttachmentStore;
  /** Raw output of tools that outgrew the transcript's preview (main/engine/tool-logs.ts). */
  readonly toolLogs: ToolLogStore;

  constructor(private readonly o: RunnerOptions) {
    this.attachments = o.attachments ?? new AttachmentStore(path.join(o.home, "attachments"));
    this.toolLogs = new ToolLogStore(path.join(o.home, "app", "tool-logs"));
    const s = () => o.store.settings;
    const cliSettings = s(); // Explicit override changes take effect after restart; auto paths resolve per launch.
    this.backends = {
      claude: o.backends?.claude ?? new ClaudeBackend(() => resolveCli("claude", cliSettings.claude_bin)),
      codex: o.backends?.codex ?? new CodexBackend(() => resolveCli("codex", cliSettings.codex_bin)),
      mock: o.backends?.mock ?? new MockBackend(() => s().mock_script, o.home),
    };
    this.router = o.router ?? new Router({ home: o.home, policy: () => s().routing, listModels: (b) => this.listModels(b), secrets: o.secrets });
  }

  backend(id: BackendId): Backend {
    return this.backends[id];
  }

  async listModels(id: BackendId): Promise<{ models: ModelInfo[]; error?: string }> {
    if (this.disposing) return { models: [], error: "Modex is shutting down." };
    if (this.restartHold) return { models: [], error: "Modex is preparing to restart." };
    try {
      return { models: await this.background.run(() => this.backends[id].listModels()) };
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

  /** Reversible admission fence, acquired synchronously before restart preflight awaits.
   * Direct Companion calls share it with local IPC. The caller must also fence other
   * services and persist renderer drafts before committing to a native update.
   */
  holdForRestart(): () => void {
    this.assertNotRestarting();
    if (this.disposing) throw new Error("Modex is shutting down.");
    if (this.creating.size || this.deleting.size || this.removingProjects.size || this.titleRuns.size
      || [...this.live.values()].some(l => l.run || l.pending.size || l.status === "running" || l.status === "waiting")) {
      throw new Error("Let current turns and worktree operations finish before restarting.");
    }
    const releaseBackground = this.background.holdForRestart();
    const token = this.restartHold = { kind: "restart" as const };
    return () => { if (this.restartHold === token) { this.restartHold = undefined; releaseBackground(); } };
  }

  /** Freeze new admissions for draft-owner removal without requiring idle turns.
   * Deletion stops and drains its own turn; unrelated turns may keep running.
   * Structural work must settle before the renderer's owner snapshot is frozen.
   */
  holdForOwnerRemoval(): () => void {
    this.assertNotRestarting();
    if (this.disposing) throw new Error("Modex is shutting down.");
    if (this.creating.size || this.deleting.size || this.removingProjects.size) {
      throw new Error("Let current worktree operations finish before removing a thread or project.");
    }
    const token = this.restartHold = { kind: "owner-removal" as const };
    return () => { if (this.restartHold === token) this.restartHold = undefined; };
  }

  private assertNotRestarting(): void {
    if (this.restartHold) throw new Error("Modex is preparing to restart.");
  }

  private slot(threadId: string): Live {
    let l = this.live.get(threadId);
    if (!l) {
      // Disk history has no live CLI stream after a process restart. Keep the last
      // result truthful, and never revive these agents when the parent runs again.
      const stored = this.o.store.items(threadId);
      const items = stored.map((item): ThreadItem => {
        // Work a previous process saw start but never saw end: its outcome is unknown, not running.
        if ((item.kind === "tool" || item.kind === "thinking" || item.kind === "assistant") && item.origin && item.outcome === "running") {
          item = item.kind === "assistant" ? { ...item, outcome: "unknown" } : item.kind === "tool" ? { ...item, status: "done", outcome: "unknown", ok: okFor("unknown") } : { ...item, status: "done", outcome: "unknown" };
        }
        // A card nobody answered: the process that could take the answer is gone, so it closes as ended.
        if (item.kind === "approval" && !item.answer) return { ...item, answer: "no", withdrawn: "ended" };
        if (item.kind === "question" && !item.answers && !item.withdrawn) return { ...item, withdrawn: "ended" };
        if (item.kind !== "tool" || !item.agent || !["running", "waiting"].includes(item.agent.state)) return item;
        return { ...item, status: "done", ok: undefined, agent: { ...item.agent, state: "unknown", detail: "Modex restarted without a final agent status" } };
      });
      l = { abort: null, run: null, backend: null, pending: new Map(), requests: emptyRequests(), items, status: "idle", conversation: initialConversation(), attempt: null };
      this.live.set(threadId, l);
      // Settle it everywhere once, not only in this window: save it for the next process, and send the
      // change through the event stream so the journal and paired clients that resume from it see it too.
      // An item that needed no settling is the very object read above, so it is neither sent nor saved.
      const settled = items.flatMap((item, i) => {
        const before = stored[i];
        if (!before || item === before) return [];
        const patch = Object.fromEntries(Object.entries(item).filter(([key, value]) => (before as Record<string, unknown>)[key] !== value));
        return [{ id: item.id, patch: patch as Partial<ThreadItem> }];
      });
      if (settled.length) {
        try { this.persistItems(threadId, l); }
        catch (error) { console.error("[modex] could not save settled items:", error); }
        for (const { id, patch } of settled) this.o.emit({ threadId, type: "item_update", id, patch });
      }
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
    this.assertNotRestarting();
    if (this.disposing) throw new Error("Modex is shutting down.");
    const thread = this.o.store.thread(threadId);
    if (!thread) throw new Error(`unknown thread ${threadId}`);
    if (this.removingProjects.has(thread.projectId)) throw new Error("This project is being removed.");
    if (this.deleting.has(threadId)) throw new Error("This thread is being deleted.");
    if (thread.retired) throw new Error(`This task finished: pull request #${thread.retired.pr} merged and its worktree was removed. Start a new thread to continue.`);
  }

  /**
   * A suggested next message for an idle thread, or null. Cached per transcript state: the renderer asks
   * again on every render of an idle thread, and Jev must not be asked twice for the same turn.
   */
  async followUp(threadId: string): Promise<FollowUp | null> {
    this.assertNotRestarting();
    const thread = this.o.store.thread(threadId);
    if (!thread) throw new Error(`unknown thread ${threadId}`);
    const l = this.slot(threadId);
    if (l.status !== "idle") return null;
    const user = [...l.items].reverse().find((item) => item.kind === "user");
    if (!user || user.kind !== "user") return null;
    const key = JSON.stringify([l.items.at(-1)?.id, thread.plan, thread.mode, thread.auto]);
    if (l.followUp?.key === key) return l.followUp.result;
    l.followUp?.abort.abort();
    const abort = new AbortController();
    const project = this.o.store.project(thread.projectId);
    const result = this.background.run(() => this.router.followUp({ thread, text: user.text, items: [...l.items], project: { name: project?.name ?? "" } }, abort.signal));
    l.followUp = { key, abort, result };
    return result;
  }

  /** Main-owned image execution: a fresh thread in a dedicated job directory, with normal approvals. */
  async createImageThread(directory: string, jobId: string, backend: BackendId, account?: string): Promise<Thread> {
    this.assertNotRestarting();
    const project = this.o.store.addProject(path.dirname(directory));
    const thread = await this.createThread(project.id, { backend, mode: "agent", auto: false });
    this.o.store.updateThread(thread.id, { cwd: directory, imageJobId: jobId, title: "Image generation", titleSource: "manual", approvals: "ask", ...(account ? { codexAccount: account } : {}) });
    return this.o.store.thread(thread.id)!;
  }

  async createThread(projectId: string, opts: { worktree?: boolean; mode?: Mode; model?: string; backend?: BackendId; auto?: boolean } = {}): Promise<Thread> {
    return this.trackCreation(projectId, opts);
  }

  /**
   * A routine run's thread: always Chat (read-only), with Plan when the routine asks for it, in the
   * project checkout, named after the routine and marked with the run that made it.
   */
  async createRoutineThread(projectId: string, routine: { id: string; name: string; runId: string; plan: boolean; backend?: BackendId; model?: string }): Promise<Thread> {
    // Auto off: the routine's own provider and model run, whatever Auto's default is.
    const thread = await this.trackCreation(projectId, { mode: "chat", plan: routine.plan, auto: false, ...(routine.backend ? { backend: routine.backend } : {}), ...(routine.model ? { model: routine.model } : {}) });
    const marked = this.o.store.updateThread(thread.id, { title: routine.name.slice(0, 200), titleSource: "manual", routine: { id: routine.id, name: routine.name, runId: routine.runId } });
    // No window asked for this thread: tell any open one it exists.
    this.o.emit({ threadId: marked.id, type: "thread", thread: marked });
    return marked;
  }

  /**
   * Runs one turn with nobody watching. The thread must still be read-only when the turn starts:
   * a saved routine grants nothing. Every approval the CLI asks for is refused, with a receipt.
   */
  async sendUnattended(threadId: string, text: string): Promise<{ completed: boolean }> {
    const thread = this.o.store.thread(threadId);
    if (!thread || thread.mode !== "chat") throw new Error("An unattended turn must run in Chat, which is read-only.");
    this.unattended.add(threadId);
    try {
      await this.send(threadId, text);
      // A stopped, failed or silent turn is not a result, however much it streamed first.
      return { completed: this.slot(threadId).completed === true };
    } finally { this.unattended.delete(threadId); }
  }

  /**
   * Saves a turn's task record (shared/task-context.ts) to the thread's project notes, at a person's
   * request. Saving again updates the same note, unless it was edited since: then the edit stays and
   * this version becomes a note of its own. Writes only through the notes store; reads only the
   * transcript.
   */
  saveTaskNote(threadId: string, turnId: string): { pageId: string; title: string; revision: number; created: boolean; preserved: boolean } {
    this.assertNotRestarting();
    const thread = this.o.store.thread(threadId);
    if (!thread) throw new Error(`unknown thread ${threadId}`);
    const items = this.items(threadId);
    const start = items.findIndex((item) => item.kind === "user" && item.id === turnId);
    if (start < 0) throw new Error("That message is no longer in this thread.");
    const next = items.findIndex((item, i) => i > start && item.kind === "user");
    const turn = items.slice(start, next < 0 ? undefined : next);
    const record = taskRecord(turn, { threadId, title: `Task: ${thread.title}`, cwd: thread.cwd });
    const markdown = taskMarkdown(record);
    const notes = this.o.store.space;
    const project = notes.tree().nodes.find((node) => node.kind === "project" && node.modexProjectId === thread.projectId);
    if (!project) throw new Error("This project has no notes yet. Open Notes for it, then save again.");
    const saved = thread.taskNotes?.[turnId];
    const existing = saved ? notes.list().find((page) => page.id === saved.pageId && !page.trashedAt) : undefined;
    const change = { actor: "human", summary: "Saved a task record" };
    const untouched = existing && existing.revision === saved!.revision;
    const page = untouched
      ? notes.save({ ...existing, title: record.title, markdown }, change)
      : notes.create({ title: existing ? `${record.title} (saved again)` : record.title, markdown, containerId: project.id }, change);
    const updated = this.o.store.updateThread(threadId, { taskNotes: { ...thread.taskNotes, [turnId]: { pageId: page.id, revision: page.revision } } });
    this.o.emit({ threadId, type: "thread", thread: updated });
    return { pageId: page.id, title: page.title, revision: page.revision, created: !untouched, preserved: Boolean(existing && !untouched) };
  }

  /** A tool's kept raw output from `offset`, a page at a time; null when its output fit in the preview. */
  toolLog(threadId: string, itemId: string, offset: number): ToolLogPage | null {
    const item = this.items(threadId).find((i) => i.id === itemId);
    if (!item) throw new Error("That output is no longer in this thread.");
    if (item.kind !== "tool") throw new Error("That item is not a tool.");
    return this.toolLogs.read(threadId, itemId, offset);
  }

  /** A receipt in the transcript for something Modex did on the thread's behalf. */
  addNotice(threadId: string, level: "info" | "warn" | "error", text: string): void {
    this.addItem(threadId, { id: newId(), kind: "notice", level, text, at: new Date().toISOString() });
  }

  /** Main-only pending intent path. Public thread:create never accepts the
   * reserved identity. Startup only binds existing matches; it never calls this. */
  async createThreadForPending(projectId: string, creation: PendingCreation, configuration: PendingSendRecord["configuration"]): Promise<Thread> {
    this.assertNotRestarting();
    if (!this.o.store.supportsDurableAdmission || this.disposing || this.removingProjects.has(projectId)) throw new Error("Pending thread creation is unavailable.");
    const copied = parseRecoveryJSON(recoveryJSON({ projectId, creation, configuration }, 8192), 8192) as { projectId: string; creation: PendingCreation; configuration: PendingSendRecord["configuration"] };
    const reserved = copied.creation;
    if (!reserved || Object.keys(reserved).length !== 2 || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(reserved.threadId)
      || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(reserved.createdAt)
      || !Number.isFinite(Date.parse(reserved.createdAt)) || new Date(reserved.createdAt).toISOString() !== reserved.createdAt) throw new Error("Invalid pending creation identity.");
    const validated = copyComposerRecovery({ threads: [], selectedThreadId: null,
      projects: [{ key: `draft:0:${copied.projectId}`, projectId: copied.projectId, text: "", attachments: [] }],
      draft: { revision: 0, projectId: copied.projectId, ...copied.configuration } });
    if (!this.o.store.project(copied.projectId)) throw new Error("Pending creation project is unavailable.");
    const config = validated.draft!, signature = recoveryJSON(copied, 8192);
    const pending = this.pendingCreations.get(reserved.threadId);
    if (pending) {
      if (pending.signature !== signature) throw new Error("Pending creation identity was reused.");
      return pending.promise;
    }
    const existing = this.o.store.thread(reserved.threadId);
    if (existing) {
      if (existing.projectId !== copied.projectId || existing.createdAt !== reserved.createdAt) throw new Error("Pending creation identity conflicts with an existing thread.");
      this.assertThreadAvailable(existing.id);
      this.o.store.checkpointThread(existing.id);
      return existing;
    }
    if (this.pendingCreations.size >= 1000) throw new Error("Pending thread creations require recovery.");
    const promise = this.trackCreation(copied.projectId, { worktree: config.worktree, ...config.settings }, reserved).then(thread => {
      this.o.store.checkpointThread(thread.id); return thread;
    });
    this.pendingCreations.set(reserved.threadId, { signature, promise });
    // Successful future requests can bind the Store record. Keep a failed
    // in-process creation: a worktree script may already have created evidence.
    void promise.then(() => this.pendingCreations.delete(reserved.threadId), () => {
      // No script/git work was attempted and Store publishes only after a
      // durable write. Its usable/absent state proves this retry is harmless.
      if (!config.worktree && this.o.store.supportsDurableAdmission && !this.o.store.thread(reserved.threadId)) {
        this.pendingCreations.delete(reserved.threadId);
      }
    });
    return promise;
  }

  private async trackCreation(projectId: string, opts: ThreadCreationOptions, reserved?: PendingCreation): Promise<Thread> {
    this.assertNotRestarting();
    if (this.disposing) throw new Error("Modex is shutting down.");
    if (this.removingProjects.has(projectId)) throw new Error("This project is being removed.");
    const pending = this.creating.get(projectId) ?? new Set<Promise<Thread>>();
    this.creating.set(projectId, pending);
    const creation = this.createThreadInProject(projectId, opts, reserved);
    pending.add(creation);
    try { return await creation; }
    finally {
      pending.delete(creation);
      if (!pending.size) this.creating.delete(projectId);
    }
  }

  private async createThreadInProject(projectId: string, opts: ThreadCreationOptions, reserved?: PendingCreation): Promise<Thread> {
    const project = this.o.store.project(projectId);
    if (!project) throw new Error(`unknown project ${projectId}`);
    const settings = this.o.store.settings;
    const backend = opts.backend ?? settings.default_backend;
    const id = reserved?.threadId ?? newId();
    const now = reserved?.createdAt ?? new Date().toISOString();
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
      backend, mode: opts.mode ?? settings.default_mode, plan: opts.plan ?? false,
      ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
      model: opts.model ?? settings.default_model[backend] ?? "", status: "idle",
      auto: opts.auto ?? settings.routing.auto_by_default,
    };
    this.o.store.addThread(thread);
    return thread;
  }

  async removeProject(projectId: string): Promise<void> {
    this.assertNotRestarting();
    const operation = () => this.removeProjectHeld(projectId);
    return this.o.withOwnerRemoval ? this.o.withOwnerRemoval({ kind: "project", id: projectId }, operation) : operation();
  }
  private async removeProjectHeld(projectId: string): Promise<void> {
    if (this.removingProjects.has(projectId)) throw new Error("This project is being removed.");
    this.removingProjects.add(projectId);
    try {
      await Promise.allSettled(this.creating.get(projectId) ?? []);
      const threads = this.o.store.snapshot().threads.filter((thread) => thread.projectId === projectId);
      const removals = await Promise.allSettled(threads.map((thread) => this.deleteThreadHeld(thread.id)));
      const failure = removals.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failure) throw failure.reason;
      this.o.store.removeProject(projectId);
    } finally {
      this.removingProjects.delete(projectId);
    }
  }

  async deleteThread(threadId: string, removeWorktree = false): Promise<void> {
    this.assertNotRestarting();
    const operation = () => this.deleteThreadHeld(threadId, removeWorktree);
    return this.o.withOwnerRemoval ? this.o.withOwnerRemoval({ kind: "thread", id: threadId }, operation) : operation();
  }
  private async deleteThreadHeld(threadId: string, removeWorktree = false): Promise<void> {
    if (this.deleting.has(threadId)) throw new Error("This thread is being deleted. If its CLI has not confirmed the stop, press Stop again to force it.");
    this.deleting.add(threadId);
    this.naming.get(threadId)?.abort();
    this.naming.delete(threadId);
    try {
      const thread = this.o.store.thread(threadId);
      const l = this.live.get(threadId);
      // A process an earlier Stop could not confirm ended may still use the thread's files: keep them all.
      const refuseWhileAlive = () => {
        const alive = l ? this.unconfirmedAlive(l) : [];
        if (!alive.length) return;
        const name = BACKENDS.find((b) => b.id === thread?.backend)?.label ?? "The CLI";
        throw new Error(`${name} (pid ${alive.join(", ")}) has not confirmed that it stopped, so Modex keeps this thread and its worktree. Delete it again once that process has exited.`);
      };
      refuseWhileAlive();
      this.stop(threadId);
      await this.o.beforeDeleteThread?.(threadId);
      await l?.run;
      refuseWhileAlive();
      if (thread?.worktree && !thread.retired && removeWorktree) {
        const project = this.o.store.project(thread.projectId);
        if (project) {
          const script = thread.worktree.manager === "project-script" ? gitx.projectWorktreeScript(project.path) : null;
          if (thread.worktree.manager === "project-script" && !script) throw new Error("Project worktree script is missing; restore it before removing this task.");
          if (script) await gitx.projectWorktreeRemove(project.path, script, thread.worktree.branch);
          else await gitx.worktreeRemove(project.path, thread.worktree.path);
        }
      }
      clearTimeout(l?.flushTimer);
      this.o.store.deleteThread(threadId);
      this.attachments.removeThread(threadId);
      this.toolLogs.removeThread(threadId);
      this.live.delete(threadId);
    } finally {
      this.deleting.delete(threadId);
    }
  }

  /**
   * Finishes a task whose pull request merged: removes its worktree and branch and marks the thread
   * retired. The transcript stays, read-only. Callers have already checked that nothing would be lost.
   */
  async retireThread(threadId: string, pr: { number: number; url: string; headSha: string }): Promise<void> {
    if (this.restartHold) return;
    const thread = this.o.store.thread(threadId);
    if (!thread?.worktree || thread.retired || this.deleting.has(threadId) || this.live.get(threadId)?.run) return;
    const operation = () => this.retireThreadHeld(threadId, pr);
    return this.o.withOwnerRemoval ? this.o.withOwnerRemoval({ kind: "thread", id: threadId }, operation) : operation();
  }
  private async retireThreadHeld(threadId: string, pr: { number: number; url: string; headSha: string }): Promise<void> {
    const thread = this.o.store.thread(threadId);
    const wt = thread?.worktree;
    if (!thread || !wt || thread.retired) return;
    if (this.deleting.has(threadId) || this.live.get(threadId)?.run) return;
    const slot = this.live.get(threadId);
    if (slot && this.unconfirmedAlive(slot).length) return;
    const project = this.o.store.project(thread.projectId);
    if (!project) return;
    this.deleting.add(threadId);
    try {
      await this.o.beforeDeleteThread?.(threadId);
      const state = await gitx.worktreeState(wt.path);
      const branch = await gitx.currentBranch(wt.path);
      if (!state.clean || state.head !== pr.headSha || branch !== wt.branch) return;
      const script = wt.manager === "project-script" ? gitx.projectWorktreeScript(project.path) : null;
      if (wt.manager === "project-script" && !script) throw new Error("Project worktree script is missing; restore it before retiring this task.");
      if (script) await gitx.projectWorktreeRemove(project.path, script, wt.branch);
      else {
        await gitx.worktreeRemove(project.path, wt.path, false);
        // A project script owns branch retention; never override its decision.
        await gitx.branchDelete(project.path, wt.branch).catch(() => {});
      }
      const retired = { at: new Date().toISOString(), reason: "merged" as const, pr: pr.number, url: pr.url };
      this.addItem(threadId, { id: newId(), kind: "notice", level: "info", text: `Pull request #${pr.number} merged. Modex retired this task; this thread is now a read-only record.`, at: retired.at });
      const t = this.o.store.updateThread(threadId, { retired });
      this.o.emit({ threadId, type: "thread", thread: t });
    } finally {
      this.deleting.delete(threadId);
    }
  }

  /** Runs one user turn. Resolves when the thread is idle again (or errored). */
  async send(threadId: string, text: string, attachments: Attachment[] = []): Promise<void> {
    return this.start(threadId, text, undefined, attachments);
  }

  /** Native durable adapter only. Files have already crossed its journaled
   * ownership transaction. Existing generic send and explicit Retry stay separate. */
  async sendDurably(threadId: string, rawText: string, attachments: readonly Readonly<Attachment>[], admission: DurableSendAdmission): Promise<void> {
    const id = admission.id, at = admission.at, committed = admission.committed;
    if (!this.o.store.supportsDurableAdmission) throw new Error("Durable native message admission is unavailable.");
    if (typeof rawText !== "string" || rawText.length > 1024 * 1024 || !/^[A-Za-z0-9_-]{1,128}$/.test(id)
      || typeof at !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(at)
      || !Number.isFinite(Date.parse(at)) || typeof committed !== "function") throw new Error("Invalid durable message admission.");
    const files = attachments.map(file => ({ ...file }));
    await this.start(threadId, rawText.trim(), undefined, files, Object.freeze({ id, at, committed, rawText }));
  }

  /**
   * Runs the thread's last message again, in place: the transcript keeps its one user bubble and the
   * new attempt follows the failure card. Auto routing is not re-asked; the pick already applied.
   */
  async retry(threadId: string): Promise<void> {
    this.assertThreadAvailable(threadId);
    const user = [...this.slot(threadId).items].reverse().find((item) => item.kind === "user");
    if (!user || user.kind !== "user") throw new Error("Nothing to retry: this thread has no message yet.");
    return this.start(threadId, user.text, user.id, user.attachments);
  }

  private async start(threadId: string, text: string, reuse?: string, attachments: Attachment[] = [], prepared?: PreparedAdmission): Promise<void> {
    this.assertThreadAvailable(threadId);
    this.o.beforeSend?.(this.o.store.thread(threadId)!);
    const l = this.slot(threadId);
    if (l.run) throw new Error("This thread is still working. Stop it or wait for it to finish.");
    // Publish admission before runTurn's synchronous prefix can emit or invoke
    // a main callback. Reentrant sends and restart/disposal see this reservation.
    let release!: () => void;
    const reservation = new Promise<void>(resolve => { release = resolve; });
    l.run = reservation;
    // A new message on an archived thread brings it back: an archived thread is never one that is working.
    try {
      this.unarchive(threadId);
      await this.runTurn(threadId, text, reuse, attachments, prepared);
    }
    finally { if (l.run === reservation) l.run = null; release(); }
  }

  /** `reuse` names an existing user item to run again instead of adding one (Retry). */
  private async runTurn(threadId: string, text: string, reuse?: string, attachments: Attachment[] = [], prepared?: PreparedAdmission): Promise<void> {
    const savedThread = this.o.store.thread(threadId);
    if (!savedThread) throw new Error(`unknown thread ${threadId}`);
    let thread = savedThread;
    const l = this.slot(threadId);
    if (l.status === "running" || l.status === "waiting") throw new Error("This thread is still working. Stop it or wait for it to finish.");
    if (!fs.existsSync(thread.cwd)) throw new Error(`working directory is missing: ${thread.cwd}`);
    l.completed = false;

    if (prepared) {
      if (reuse !== undefined || l.items.some(item => item.id === prepared.id)) throw new Error("This message was already admitted. Use Retry explicitly.");
      const checkpoint = this.o.store.checkpointThread(threadId);
      if (checkpoint.projectId !== savedThread.projectId || checkpoint.createdAt !== savedThread.createdAt) throw new Error("Prepared message target changed.");
      if (attachments.some(file => !file.rel.startsWith(`${threadId}/`)
        || !this.attachments.validateRecovery(file, { kind: "thread", threadId }))) throw new Error("Prepared message attachments changed.");
    }

    // Keep the initial permission ceiling while observing any live reduction during setup/turns.
    const initialPlan = thread.plan;
    const initialMode = thread.mode;
    const connectionTurn = {
      id: thread.id,
      projectId: thread.projectId,
      get plan() { return initialPlan || thread.plan; },
      get mode() { return initialMode === "chat" ? "chat" as const : thread.mode; },
    };

    const retry = reuse !== undefined;
    // Staged files move into the thread's folder now, so a Retry (or a restart) still finds them.
    let draft: AttachmentDraft | undefined;
    if ((prepared || retry) && Array.isArray(attachments) && attachments.length) {
      try { draft = this.attachments.mintDraft({ kind: "thread", threadId }); }
      catch (error) {
        // Legacy transcript Retry may contain unbound files. Its existing claim
        // path still refuses every bound file without the matching capability.
        if (prepared) throw error;
      }
    }
    let files: Attachment[];
    try { files = this.attachments.claim(threadId, attachments, draft ? { draft } : {}); }
    finally { if (draft) this.attachments.revokeDraft(draft); }
    const derivedTitle = (text.replace(/\s+/g, " ").trim() || files.map((f) => f.name).join(", ")).slice(0, 60) || "New thread";
    // Name the thread after its first completed turn, including a retried first turn that still carries the opening-message title.
    const firstTurn = !l.items.some((item) => item.kind === "user" && item.id !== reuse);
    const shouldName = firstTurn && thread.titleSource !== "manual" && (thread.title === "New thread" || (retry && thread.title === derivedTitle));
    l.followUp?.abort.abort();
    l.followUp = undefined;
    // The Modex turn is the user message it answers: Retry runs the same turn again as a new attempt.
    const turnId = reuse ?? prepared?.id ?? newId();
    if (!retry) {
      const item: UserItem = { id: turnId, kind: "user", text: prepared?.rawText ?? text,
        at: prepared?.at ?? new Date().toISOString(), ...(files.length ? { attachments: files } : {}) };
      this.addItem(threadId, item, prepared ? () => {
        const receipt = Object.freeze({ ...item, ...(item.attachments ? { attachments: Object.freeze(item.attachments.map(file => Object.freeze({ ...file }))) } : {}) });
        if (prepared.committed(receipt) !== undefined) throw new Error("Durable admission callback must complete synchronously.");
      } : undefined);
      this.assertThreadAvailable(threadId);
      if (thread.title === "New thread" && thread.titleSource !== "manual") this.updateThread(threadId, { title: derivedTitle }, { automaticTitle: true });
    }

    const fallbackTitle = thread.title;
    const abort = new AbortController();
    l.abort = abort;
    l.conversation = initialConversation();
    l.requests = emptyRequests();
    l.attempt = null;
    const sink = this.sinkFor(threadId, l);
    this.setStatus(threadId, "running");
    let fast = false;
    let routeId: string | undefined;
    let routingBlocked: string | undefined;
    const auto = Boolean(thread.auto);
    if (auto && !retry) {
      // Auto: judge the request, then re-read the thread — the pick is applied as a thread update
      // so the composer, header, and persisted state all show what this turn runs on.
      try {
        const project = this.o.store.project(thread.projectId);
        const receipt = await this.router.route({ thread, text, items: l.items.slice(0, -1), project: { name: project?.name ?? "", branch: thread.worktree?.branch ?? null } }, abort.signal);
        this.addItem(threadId, receipt.item);
        routeId = receipt.item.id;
        const d = receipt.decision;
        if (d.blocked) routingBlocked = d.reasons.at(-1) ?? "The reasoning-effort ceiling cannot be guaranteed.";
        // A blocked route is diagnostic evidence only. Never let it mutate the thread or
        // discard its current backend session, even if a router implementation returns a
        // partially populated decision alongside `blocked`.
        if (!d.blocked && d.backend !== thread.backend) this.updateThread(threadId, { backend: d.backend, model: d.model, effort: d.effort }, { fromRouter: true });
        else if (!d.blocked && (d.model !== thread.model || d.effort !== thread.effort)) this.updateThread(threadId, { model: d.model, effort: d.effort }, { fromRouter: true });
        fast = d.fast;
        thread = this.o.store.thread(threadId) ?? thread;
      } catch (err) {
        if (thread.backend === "mock") {
          this.addItem(threadId, { id: newId(), kind: "notice", level: "warn", text: `Auto routing failed (${(err as Error).message}); using the thread's current model.`, at: new Date().toISOString() });
        } else {
          routingBlocked = `Auto could not establish a safe route (${(err as Error).message}). Retry routing or explicitly turn Auto off to use the current model.`;
        }
      }
    }
    if (abort.signal.aborted) {
      this.addItem(threadId, { id: newId(), kind: "notice", level: "info", text: "Stopped.", at: new Date().toISOString() });
      this.setStatus(threadId, "idle");
      l.abort = null;
      return;
    }
    if (routingBlocked) {
      this.addItem(threadId, { id: newId(), kind: "notice", level: "error", text: `Auto routing stopped: ${routingBlocked}`, at: new Date().toISOString() });
      this.setStatus(threadId, "error");
      l.abort = null;
      return;
    }
    const backend = thread.imageJobId && this.o.imageBackend ? this.o.imageBackend : this.backends[thread.backend];
    l.backend = thread.backend;
    const turnStart = l.items.length;
    let knowledge: KnowledgeLease | undefined;
    let pages: PagesLease | undefined;
    let images: import("./images/agent.js").ImagesLease | undefined;
    const revokeConnections = () => {
      void pages?.close().catch(() => {});
      void images?.close().catch(() => {});
      void knowledge?.close().catch(() => {});
    };
    abort.signal.addEventListener("abort", revokeConnections, { once: true });
    try {
      this.o.beforeSend?.(thread);
      if (thread.imageJobId && this.o.images) images = await this.o.images.prepare(thread, abort.signal);
      // Prepare Pages first: snapshot the turn's read-only ceiling before knowledge setup awaits.
      // Always attach its stable route, including when the project's setting currently disables it.
      if (thread.backend !== "mock" && this.o.pages) {
        pages = await this.o.pages.prepare(connectionTurn, change => this.addItem(threadId, {
          id: newId(), kind: "notice", level: "info", text: `Note updated: ${change.summary}`, pages: change, at: new Date().toISOString(),
        }), abort.signal);
        if (abort.signal.aborted) { this.setStatus(threadId, "idle"); return; }
      }
      if (thread.backend !== "mock" && this.o.knowledge) {
        knowledge = await this.o.knowledge.prepare(connectionTurn, change => this.addItem(threadId, {
          id: newId(), kind: "notice", level: "info", text: `Knowledge updated: ${change.summary}`, knowledge: change, at: new Date().toISOString(),
        }), abort.signal);
        if (knowledge.warning) sink.notice("warn", knowledge.warning);
        if (abort.signal.aborted) { this.setStatus(threadId, "idle"); return; }
      }
      const account = thread.backend === "codex" && backend.identity
        ? thread.codexAccount ?? (thread.sessionHandle ? "cli" : backend.identity()) : undefined;
      if (account && !thread.codexAccount) this.o.store.updateThread(threadId, { codexAccount: account });
      const turnFiles: TurnAttachment[] = files.map((f) => {
        const file = this.attachments.resolve(f.rel);
        if (!file) throw new Error(`Attachment ${f.name} is missing or changed. Attach it again before retrying.`);
        return { name: f.name, mime: f.mime, kind: f.kind, path: file };
      });
      // Each run of the backend is one attempt with its own sink; ending it settles whatever it left open.
      const runOn = async (ran: Thread): Promise<TurnResult> => {
        const attempt = this.beginAttempt(threadId, l, { thread: threadId, turn: turnId, attempt: newId(), backend: backend.id, ...(account ? { account } : {}) });
        try {
          const result = await backend.runTurn(
            describeAttachments(text, turnFiles),
            {
              cwd: ran.cwd, mode: ran.mode, plan: ran.plan, model: ran.model, effort: ran.effort, fast, resume: ran.sessionHandle, account,
              // Files the CLI reads by path sit outside cwd; --add-dir keeps that from prompting.
              addDirs: turnFiles.some((f) => f.kind === "file") ? [path.join(this.attachments.root, threadId)] : [],
              ...(turnFiles.length ? { attachments: turnFiles } : {}), ...(knowledge ? { knowledge: knowledge.connection } : {}), ...(pages ? { pages: pages.connection } : {}), ...(images ? { images: images.connection } : {}),
            },
            attempt.sink,
            abort.signal,
          );
          attempt.end(abort.signal.aborted ? "interrupted" : ATTEMPT_OUTCOME[result.status]);
          return result;
        } catch (err) {
          attempt.end(abort.signal.aborted ? "interrupted" : "failed");
          throw err;
        }
      };
      // A model refused for usage credits recently is refused again: start on its fallback instead.
      const skip = this.recentCreditFallback(thread);
      if (skip) thread = this.fallBack(threadId, thread, skip, routeId, false);
      let replyStart = l.items.length;
      let result = await runOn(thread);
      const fallback = result.status === "failed" && !abort.signal.aborted ? this.creditFallback(thread, result.error, l.items.slice(turnStart)) : undefined;
      if (fallback) {
        const from = thread.model;
        this.outOfCredits.set(`${thread.backend}:${from}`, Date.now());
        thread = this.fallBack(threadId, thread, fallback, routeId, true);
        replyStart = l.items.length;
        result = await runOn(thread);
        if (result.status === "failed") result = { ...result, recovery: [`${modelFamilyName(from)} was out of usage credits; retried on ${modelFamilyName(fallback)}.`, ...(result.recovery ?? [])] };
      }
      if (thread.imageJobId) this.o.imageOutcome?.(thread.imageJobId, result.status);
      // Record what ran, not what was asked for: the CLI can refuse fast mode (no usage credits, for one).
      const ranFast = result.fastMode ? result.fastMode.on : fast;
      if (fast && !ranFast && routeId) this.noteFastOff(threadId, routeId, result.fastMode?.why);
      this.noteLastTurn(threadId, thread, ranFast, result);
      if (result.status === "completed" && shouldName && !abort.signal.aborted) {
        const reply = l.items.slice(turnStart).reverse().find((item) => item.kind === "assistant" && item.text.trim());
        this.nameThread(threadId, text, fallbackTitle, backend, thread.model, reply?.kind === "assistant" ? reply.text : undefined);
      }
      if (auto) this.router.noteOutcome(threadId, result.status, result.usage);
      this.recordUsage(thread, account, result);
      // A failure can precede Stop; its outcome does not establish process exit.
      if (result.stop?.outcome === "unconfirmed" && result.stop.pid) (l.unconfirmed ??= new Set()).add(result.stop.pid);
      if (result.status === "failed") {
        this.failTurn(threadId, thread, result.error ?? "The turn failed.", { detail: result.detail, recovery: result.recovery, fast, retry });
      } else if (result.status === "completed" && l.items.length === replyStart && !abort.signal.aborted) {
        // The CLI ended the turn without a word: no reply, no tool, no notice. A card with Retry beats an idle thread
        // that looks as if nothing was asked (2026-10-09: a resumed session's stale result ended a turn this way).
        this.failTurn(threadId, thread, `${BACKENDS.find((b) => b.id === thread.backend)?.label ?? thread.backend} ended the turn without replying.`, { fast, retry });
      } else {
        if (result.status === "interrupted") {
          const { level, text } = stopNotice(BACKENDS.find((b) => b.id === thread.backend)?.label ?? thread.backend, result.stop);
          this.addItem(threadId, { id: newId(), kind: "notice", level, text, at: new Date().toISOString() });
        } else if (!abort.signal.aborted) l.completed = true;
        this.setStatus(threadId, "idle");
      }
    } catch (err) {
      if (abort.signal.aborted) {
        sink.notice("info", "Stopped.");
        this.setStatus(threadId, "idle");
      } else {
        if (auto) this.router.noteOutcome(threadId, "failed");
        this.failTurn(threadId, thread, (err as Error).message, { fast, retry });
      }
    } finally {
      abort.signal.removeEventListener("abort", revokeConnections);
      await Promise.all([
        images?.close().catch(err => sink.notice("warn", `Images connection could not close: ${(err as Error).message}`)),
        pages?.close().catch(err => sink.notice("warn", `Pages connection could not close: ${(err as Error).message}`)),
        knowledge?.close().catch(err => sink.notice("warn", `Knowledge connection could not close: ${(err as Error).message}`)),
      ]);
      // Attempts settle their own items. An item from before the conversation contract can still be
      // marked running on disk: save its tail and stop its spinner, as before.
      for (const item of l.items) {
        if ((item.kind === "thinking" || item.kind === "tool") && item.status === "running" && !item.origin) {
          this.patchItem(threadId, item.id, { status: "done", durationMs: Date.now() - Date.parse(item.at), ...(item.kind === "tool" ? { ok: false } : {}) }, { persist: false });
        }
      }
      // Still open when the turn ended: nobody can answer them now.
      for (const id of [...l.pending.keys()]) this.withdraw(threadId, l, id, "ended", false);
      l.requests = emptyRequests();
      this.persistItems(threadId, l);
      l.abort = null;
      l.backend = null;
      l.attempt = null;
    }
  }

  /** Ends a turn in the error state with a failure card: the CLI's message, a remedy, and everything a bug report needs. */
  private failTurn(threadId: string, thread: Thread, message: string, extra: { detail?: Record<string, unknown>; recovery?: string[]; fast: boolean; retry: boolean }): void {
    const settings = this.o.store.settings;
    const failure = describeFailure({
      backend: thread.backend,
      message,
      detail: extra.detail,
      recovery: extra.recovery,
      context: {
        at: new Date().toISOString(),
        modex: process.env.MODEX_VERSION,
        platform: `${process.platform} ${process.arch}`,
        electron: process.versions.electron,
        node: process.versions.node,
        backend: thread.backend,
        bin: thread.backend === "claude" ? settings.claude_bin : thread.backend === "codex" ? settings.codex_bin : undefined,
        model: thread.model,
        effort: thread.effort,
        mode: thread.mode,
        plan: thread.plan,
        auto: Boolean(thread.auto),
        fast: extra.fast,
        retry: extra.retry,
        threadId,
        sessionHandle: thread.sessionHandle,
        cwd: thread.cwd,
        worktree: thread.worktree?.branch,
      },
    });
    this.addItem(threadId, { id: newId(), kind: "notice", level: "error", text: failure.summary, failure, at: new Date().toISOString() });
    this.setStatus(threadId, "error");
  }

  private nameThread(threadId: string, text: string, fallback: string, backend: Backend, model: string, reply?: string): void {
    const current = this.o.store.thread(threadId);
    if (!backend.generateTitle || this.disposing || this.deleting.has(threadId) || current?.title !== fallback || current.titleSource === "manual") return;
    const abort = new AbortController();
    this.naming.set(threadId, abort);
    const timer = setTimeout(() => abort.abort(), 30_000);
    const account = this.o.store.thread(threadId)?.codexAccount;
    const run = Promise.resolve().then(() => backend.generateTitle!(text, { model, account, reply }, abort.signal)).then((title) => {
      if (title && !abort.signal.aborted && !this.disposing && this.o.store.thread(threadId)?.title === fallback) {
        this.updateThread(threadId, { title }, { automaticTitle: true });
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
    l.followUp?.abort.abort();
    l.followUp = undefined;
    for (const itemId of [...l.pending.keys()]) this.withdraw(threadId, l, itemId, "stopped");
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
    const account = id === "codex" ? this.o.store.thread(threadId)?.codexAccount ?? "cli" : undefined;
    const others = [...this.live].filter(([other, o]) => other !== threadId && o.backend === id && o.run &&
      (account === undefined || (this.o.store.thread(other)?.codexAccount ?? "cli") === account)).length;
    const name = id === "codex" ? "Codex" : id;
    const text = others ? `Force-stopping ${name}. ${others} other ${name} ${others === 1 ? "thread" : "threads"} will stop too.` : `Force-stopping ${name}.`;
    this.addItem(threadId, { id: newId(), kind: "notice", level: "warn", text, at: new Date().toISOString() });
    backend.forceStop(account).catch((err: Error) => {
      if (this.live.get(threadId) === l) this.addItem(threadId, { id: newId(), kind: "notice", level: "error", text: `Force-stop failed: ${err.message}`, at: new Date().toISOString() });
    });
  }

  /** Answers an approval card. The first answer is taken; any other is refused with the reason (docs/human-requests.md). */
  answer(threadId: string, itemId: string, answer: ApprovalAnswer, by = "desktop"): AnswerResult {
    const l = this.slot(threadId);
    const accepted = this.accept(l, itemId, { kind: "approval", answer }, by);
    const pending = l.pending.get(itemId);
    if (!accepted.ok || pending?.kind !== "approval") return accepted.ok ? { ok: false, reason: "invalid" } : accepted;
    l.pending.delete(itemId);
    this.patchItem(threadId, itemId, { answer });
    if (l.pending.size === 0 && l.status === "waiting") this.setStatus(threadId, "running");
    pending.settle(answer);
    l.requests = settleRequest(l.requests, itemId, "sent");
    return { ok: true };
  }

  /**
   * Answers a question card with one answer list per question. Answers are checked against the questions
   * before anything reaches the CLI; a secret answer goes to the CLI and is saved and shown as "(hidden)".
   */
  answerQuestion(threadId: string, itemId: string, answers: Record<string, unknown>, by = "desktop"): AnswerResult {
    const l = this.slot(threadId);
    const pending = l.pending.get(itemId);
    if (pending?.kind === "question") {
      const checked = validateAnswers(pending.questions, answers);
      if (!checked.ok) return { ok: false, reason: "invalid", error: checked.error };
    }
    const accepted = this.accept(l, itemId, { kind: "question", answers: answers as Record<string, string[]> }, by);
    if (!accepted.ok || pending?.kind !== "question") return accepted.ok ? { ok: false, reason: "invalid" } : accepted;
    const given = answers as Record<string, string[]>;
    l.pending.delete(itemId);
    this.patchItem(threadId, itemId, { answers: publicAnswers(pending.questions, given) });
    if (l.pending.size === 0 && l.status === "waiting") this.setStatus(threadId, "running");
    pending.settle({ answers: given });
    l.requests = settleRequest(l.requests, itemId, "sent");
    return { ok: true };
  }

  /** Takes one answer for a waiting request through the broker, or says why not. */
  private accept(l: Live, itemId: string, resolution: Resolution, by: string): AnswerResult {
    const record = l.requests.requests[itemId];
    if (!record) {
      // Not this turn's request: the card, if there is one, says how it closed.
      const item = l.items.find((i) => i.id === itemId);
      if (!item || (item.kind !== "approval" && item.kind !== "question")) return { ok: false, reason: "unknown" };
      if (item.kind !== resolution.kind) return { ok: false, reason: "invalid" };
      const answered = item.kind === "approval" ? Boolean(item.answer) && !item.withdrawn : Boolean(item.answers);
      return { ok: false, reason: answered ? "already-resolved" : "withdrawn" };
    }
    const result = resolveRequest(l.requests, itemId, resolution, { binding: record.request.binding, digest: record.request.digest, by });
    if (!result.ok) return { ok: false, reason: result.reason };
    l.requests = result.state;
    return { ok: true };
  }

  /**
   * Closes a card nobody answered, once: it reads as withdrawn (and "no", so older clients show it closed),
   * its request settles "no", and a late click finds nothing pending. Only a backend's own withdrawal lets the
   * thread stop waiting; Stop and the turn's end set the status themselves.
   */
  private withdraw(threadId: string, l: Live, itemId: string, why: "native" | "stopped" | "ended", persist = true): void {
    const pending = l.pending.get(itemId);
    if (!pending) return;
    l.pending.delete(itemId);
    l.requests = withdrawRequests(l.requests, { id: itemId });
    this.patchItem(threadId, itemId, pending.kind === "approval" ? { answer: "no", withdrawn: why } : { withdrawn: why }, { persist });
    if (why === "native" && l.pending.size === 0 && l.status === "waiting") this.setStatus(threadId, "running");
    if (pending.kind === "approval") pending.settle("no");
    else pending.settle({ withdrawn: why });
  }

  /** Stopped processes that never confirmed their exit and are still there. */
  private unconfirmedAlive(l: Live): number[] {
    const alive = this.o.isProcessAlive ?? processAlive;
    for (const pid of l.unconfirmed ?? []) if (!alive(pid)) l.unconfirmed!.delete(pid);
    return [...(l.unconfirmed ?? [])];
  }

  /**
   * Puts a thread away or brings it back. Archived threads leave the working lists on the Mac and the
   * phone; the transcript stays. A thread that is working cannot be archived, so nothing hidden ever
   * waits for an answer.
   */
  setArchived(threadId: string, archived: boolean): Thread {
    this.assertNotRestarting();
    if (typeof archived !== "boolean") throw new Error("Choose Archive or Unarchive.");
    const thread = this.o.store.thread(threadId);
    if (!thread) throw new Error(`unknown thread ${threadId}`);
    if (this.deleting.has(threadId)) throw new Error("This thread is being deleted.");
    const status = this.status(threadId);
    if (archived && (status === "running" || status === "waiting")) throw new Error("Wait for this thread to finish before archiving it.");
    if (Boolean(thread.archived) === archived) return { ...thread };
    const t = this.o.store.updateThread(threadId, { archived: archived ? { at: new Date().toISOString() } : undefined });
    this.o.emit({ threadId, type: "thread", thread: t });
    return t;
  }

  private unarchive(threadId: string): void {
    if (!this.o.store.thread(threadId)?.archived) return;
    const t = this.o.store.updateThread(threadId, { archived: undefined });
    this.o.emit({ threadId, type: "thread", thread: t });
  }

  updateThread(threadId: string, patch: ThreadPatch, opts: { fromRouter?: boolean; automaticTitle?: boolean } = {}): Thread {
    // Already-admitted turns can finish routing and naming during owner removal.
    // External edits remain fenced until the renderer adopts the canonical state.
    if (this.restartHold?.kind !== "owner-removal" || (!opts.fromRouter && !opts.automaticTitle)) this.assertNotRestarting();
    // Resume handles and account bindings are main-owned, even if an IPC caller sends extra keys.
    patch = Object.fromEntries(Object.entries(patch).filter(([key]) =>
      ["mode", "model", "title", "backend", "plan", "effort", "auto", "approvals"].includes(key))) as ThreadPatch;
    if (patch.approvals !== undefined && !APPROVAL_POLICIES.includes(patch.approvals)) delete patch.approvals;
    if (patch.title !== undefined) {
      this.naming.get(threadId)?.abort();
      this.naming.delete(threadId);
    }
    // The store hands back its live object, so snapshot it before the write below mutates it.
    const live = this.o.store.thread(threadId);
    const current = live ? { ...live } : undefined;
    // Switching backend starts a fresh backend conversation; the transcript stays.
    const extra: Partial<Thread> = current && patch.backend && patch.backend !== current.backend ? { sessionHandle: undefined, codexAccount: undefined, lastTurn: undefined, model: this.o.store.settings.default_model[patch.backend] ?? "", effort: undefined } : {};
    const titleSource = patch.title === undefined ? {} : { titleSource: opts.automaticTitle ? "auto" as const : "manual" as const };
    const t = this.o.store.updateThread(threadId, { ...extra, ...patch, ...titleSource });
    this.o.emit({ threadId, type: "thread", thread: t });
    // Switching to YOLO also clears what is already waiting; Always allow leaves it, since it cannot tell which of those are escalations.
    if (patch.approvals === "yolo") for (const [id, pending] of [...this.slot(threadId).pending]) if (pending.kind === "approval") this.answer(threadId, id, "yes");
    // A hand-picked model on an Auto thread is the strongest signal the fit gets: the user
    // disagreed with the last pick. Only model changes count; effort tweaks stay within a tier.
    const lastRoute = [...this.slot(threadId).items].reverse().find((i) => i.kind === "route");
    if (!opts.fromRouter && current?.auto && patch.model && patch.model !== current.model && !patch.backend && lastRoute && !lastRoute.blocked) {
      void this.background.run(async () => {
        const learned = await this.router.noteOverride(current, patch.model!);
        if (learned) this.addItem(threadId, { id: newId(), kind: "notice", level: "info", text: `Noted — for ${learned.task.replace(/_/g, " ")} you chose tier ${learned.to} over Auto's tier ${learned.from}. Auto will lean that way next time.`, at: new Date().toISOString() });
      }).catch(() => {});
    }
    return t;
  }

  /**
   * The model to retry on when a turn failed only because its model is out of usage credits, or
   * undefined. Only before anything ran: a reply, a tool or reasoning means the work has started
   * and a second run could repeat it, so that turn keeps its failure card.
   */
  private creditFallback(thread: Thread, error: string | undefined, turnItems: ThreadItem[]): string | undefined {
    if (!this.o.store.settings.model_fallback || !error || !isModelOutOfCredits(error)) return undefined;
    if (turnItems.some((item) => item.kind === "assistant" || item.kind === "tool" || item.kind === "thinking")) return undefined;
    const to = creditFallbackModel(thread.backend, thread.model);
    return to && to !== thread.model ? to : undefined;
  }

  /** The fallback for a model that was refused for usage credits within CREDIT_SKIP_MS, or undefined. */
  private recentCreditFallback(thread: Thread): string | undefined {
    if (!this.o.store.settings.model_fallback) return undefined;
    const key = `${thread.backend}:${thread.model}`;
    const at = this.outOfCredits.get(key);
    if (at === undefined) return undefined;
    if (Date.now() - at >= CREDIT_SKIP_MS) { this.outOfCredits.delete(key); return undefined; }
    return creditFallbackModel(thread.backend, thread.model);
  }

  /** Moves the thread to `to` for this turn and onward, and says so in the thread and on Auto's receipt. */
  private fallBack(threadId: string, thread: Thread, to: string, routeId: string | undefined, refusedNow: boolean): Thread {
    const from = modelFamilyName(thread.model), next = modelFamilyName(to);
    // fromRouter: Modex made this switch, so Auto must not learn it as the user's preference.
    this.updateThread(threadId, { model: to }, { fromRouter: true });
    const why = refusedNow ? `${from} is out of usage credits, so this turn moved to ${next}.` : `${from} ran out of usage credits within the last hour, so this turn runs on ${next}.`;
    this.addItem(threadId, { id: newId(), kind: "notice", level: "warn", text: `${why} Add usage credits to use ${from} again, or turn off the fallback in Settings.`, at: new Date().toISOString() });
    const route = routeId ? this.slot(threadId).items.find((i) => i.id === routeId) : undefined;
    if (route?.kind === "route") {
      const actual = this.o.store.thread(threadId) ?? { ...thread, model: to };
      this.router.noteFallback(actual, route.fast);
      this.patchItem(threadId, route.id, { model: to, held: undefined, reasons: [...route.reasons, why] });
    }
    return this.o.store.thread(threadId) ?? { ...thread, model: to };
  }

  /** Auto asked for fast mode and the CLI ran without it: the turn's receipt says so, and why. */
  private noteFastOff(threadId: string, routeId: string, why: string | undefined): void {
    const item = this.slot(threadId).items.find((i) => i.id === routeId);
    if (item?.kind !== "route") return;
    this.patchItem(threadId, routeId, { fast: false, reasons: [...item.reasons, `Fast mode did not apply: ${why ?? "the CLI ran at standard speed"}.`] });
  }

  /** Records what the backend's prompt cache was last built with, so Auto can avoid discarding it. */
  /** One Analytics row for every turn that called a model, Auto or not. A ledger failure never changes a turn's outcome. */
  private recordUsage(ran: Thread, account: string | undefined, result: TurnResult): void {
    if (!this.o.usage || !result.usage) return;
    try {
      this.o.usage.record({
        at: new Date().toISOString(), backend: ran.backend, model: ran.model, threadId: ran.id,
        project: this.o.store.project(ran.projectId)?.name ?? "", account: account ?? "", usage: result.usage,
      });
    } catch (error) { console.error("[modex] usage record failed:", error); }
  }

  private noteLastTurn(threadId: string, ran: Thread, fast: boolean, result: TurnResult): void {
    if (!result.usage && result.status !== "completed") return;
    const now = this.o.store.thread(threadId);
    // A backend switch during the turn started another conversation; this record would describe the old one.
    if (!now || now.backend !== ran.backend) return;
    const lastTurn: LastTurn = {
      at: new Date().toISOString(), model: ran.model, fast,
      ...(ran.effort ? { effort: ran.effort } : {}),
      ...(result.usage ? { contextTokens: result.usage.contextTokens } : {}),
    };
    this.o.store.updateThread(threadId, { lastTurn });
  }

  /**
   * Starts one attempt at the running turn: a sink bound to `turn`, which stamps each observation
   * with an id, its ingress order and time, and projects it into transcript items. Starting an
   * attempt makes every earlier attempt's sink inert.
   */
  private beginAttempt(threadId: string, l: Live, turn: TurnRef): { sink: TurnSink; end: (outcome: SettledOutcome) => void } {
    l.attempt = turn.attempt;
    let seq = 0;
    const seen = new Set<string>();
    const stamp = (body: Observation | AttemptMark): ConversationEvent => {
      seq++;
      const id = "source" in body && body.source ? `${body.native.runtime}:${body.source}` : `${turn.attempt}:${seq}`;
      return { ...body, schema: CONVERSATION_SCHEMA, id, seq, at: new Date().toISOString(), turn } as ConversationEvent;
    };
    const sink = this.sinkFor(threadId, l, turn, (observation) => {
      // The CLI's own event id, when it gives one, is applied once: a repeated line is the same event.
      if (observation.source) {
        if (seen.has(observation.source)) return;
        seen.add(observation.source);
      }
      this.project(threadId, l, stamp(redactObservation(observation)));
    });
    this.project(threadId, l, stamp({ type: "attempt.start" }));
    return { sink, end: (outcome) => {
      this.toolLogs.endThread(threadId);
      if (this.live.get(threadId) === l) this.project(threadId, l, stamp({ type: "attempt.end", outcome }));
    } };
  }

  /** Applies one event to the turn's conversation and emits what changed as item events. */
  private project(threadId: string, l: Live, event: ConversationEvent): void {
    const before = l.conversation;
    const after = applyConversationEvent(before, event);
    if (after === before) return;
    l.conversation = after;
    // Streaming text and output is written at most every 250 ms; everything else at once.
    const persist = event.type !== "message.delta" && event.type !== "reasoning.delta" && event.type !== "tool.update";
    after.items.forEach((item, i) => {
      const old = before.items[i];
      if (item === old) return;
      if (!old) return this.addItem(threadId, item);
      const patch = Object.fromEntries(Object.entries(item).filter(([key, value]) => (old as Record<string, unknown>)[key] !== value));
      this.patchItem(threadId, item.id, patch as Partial<ThreadItem>, { persist });
    });
  }

  /** A sink for the running turn. One bound to `attempt` goes inert, every method of it, once another attempt starts. */
  private sinkFor(threadId: string, l: Live, turn?: TurnRef, observe: (observation: Observation) => void = () => {}): TurnSink {
    const at = () => new Date().toISOString();
    const abort = l.abort;
    const attempt = turn?.attempt;
    const active = () => this.live.get(threadId) === l && l.abort === abort && abort !== null && (attempt === undefined || l.attempt === attempt);
    // Who asked: this turn and attempt, and the CLI's own request id when it gives one (else the card's id).
    const bind = (id: string, native?: NativeRequest): RequestBinding => ({
      thread: threadId, turn: turn?.turn ?? "", attempt: attempt ?? "", backend: turn?.backend ?? this.o.store.thread(threadId)?.backend ?? "mock",
      ...(turn?.account ? { account: turn.account } : {}), runtime: native?.runtime ?? "", nativeRequestId: native?.request ?? id, ...(native?.item ? { item: native.item } : {}),
    });
    // Requests a rule refused, with the rule's "when" text, for backends that pass a reason to the model.
    const refusals = new WeakMap<ApprovalRequest, string>();
    return {
      observe: (observation) => {
        if (!active()) return;
        observe(observation);
        if (observation.type === "tool.done" && turn) {
          const id = toolItemId(l.conversation, turn, observation.native);
          if (id) this.toolLogs.end(threadId, id);
        }
      },
      // Raw output stays in main: kept for the item once it outgrows the preview, never sent on.
      output: (native, chunk) => {
        if (!active() || !turn) return;
        const id = toolItemId(l.conversation, turn, native);
        if (id) this.toolLogs.append(threadId, id, chunk);
      },
      approval: (req, withdrawn) => {
        if (this.unattended.has(threadId)) {
          // A routine runs read-only with no one to ask: refuse, and say so on the card.
          if (active()) this.addItem(threadId, { id: newId(), kind: "approval", question: req.question, detail: req.detail, ...(req.action ? { title: req.action.title } : {}), answer: "no", decidedBy: UNATTENDED_RECEIPT, at: at() });
          return Promise.resolve("no" as const);
        }
        // Stopped, superseded, or withdrawn by the CLI: nothing more is shown or decided for this request.
        const gone = () => !active() || Boolean(l.abort?.signal.aborted) || Boolean(withdrawn?.aborted);
        // Today's flow: a card the user answers. Rules can only add a receipt to it.
        const askUser = (decidedBy?: ApprovalReceipt) =>
          new Promise<ApprovalAnswer>((resolve) => {
            if (gone()) return resolve("no");
            const id = newId();
            const close = () => this.withdraw(threadId, l, id, "native");
            l.pending.set(id, { kind: "approval", settle: (answer) => {
              withdrawn?.removeEventListener("abort", close);
              resolve(answer);
            } });
            l.requests = registerRequest(l.requests, { kind: "approval", id, binding: bind(id, req.native), action: req.action ?? null, digest: actionDigest(req.action ?? { question: req.question, detail: req.detail ?? null }), canAlways: req.canAlways });
            this.addItem(threadId, { id, kind: "approval", question: req.question, detail: req.detail, canAlways: req.canAlways, ...(decidedBy ? { decidedBy } : {}), at: at() });
            this.setStatus(threadId, "waiting");
            withdrawn?.addEventListener("abort", close, { once: true });
          });
        const thread = this.o.store.thread(threadId);
        const project = thread ? this.o.store.project(thread.projectId) : undefined;
        const settings = this.o.store.settings;
        // The thread's Always allow / YOLO setting answers what the rules left to a human.
        const byPolicy = (decidedBy?: ApprovalReceipt) => {
          const policy = this.o.store.thread(threadId)?.approvals;
          if (policyAnswer(policy, req.action, decidedBy) !== "yes") return askUser(decidedBy);
          if (gone()) return "no" as const;
          this.addItem(threadId, { id: newId(), kind: "approval", question: req.question, detail: req.detail, canAlways: req.canAlways, ...(req.action ? { title: req.action.title } : {}), answer: "yes", decidedBy: policyReceipt(policy!), at: at() });
          return "yes" as const;
        };
        if (!thread || !project || !gateApplies(req.action, settings.approval_rules, settings.approval_gate, project.path)) return Promise.resolve(byPolicy());
        const signal = withdrawn && abort ? AbortSignal.any([abort.signal, withdrawn]) : abort?.signal ?? withdrawn;
        return this.gateApproval(req, { thread, project, settings, active, signal }).then((r) => {
          if (r.ask) return byPolicy(r.decidedBy);
          if (gone()) return "no";
          // Answered by a rule: the card lands already answered, and the thread never waits on it.
          if (r.decidedBy) {
            this.addItem(threadId, { id: newId(), kind: "approval", question: req.question, detail: req.detail, canAlways: req.canAlways, ...(req.action ? { title: req.action.title } : {}), answer: r.answer, decidedBy: r.decidedBy, at: at() });
            if (r.answer === "no") refusals.set(req, r.decidedBy.when);
          }
          return r.answer;
        });
      },
      question: (req, withdrawn) => {
        if (this.unattended.has(threadId)) {
          if (active()) this.addItem(threadId, { id: newId(), kind: "notice", level: "warn", text: "The agent asked a question during a routine run. Nobody is there to answer, so it was declined.", at: at() });
          return Promise.resolve({ withdrawn: "ended" as const });
        }
        return new Promise<QuestionReply>((resolve) => {
          if (withdrawn?.aborted) return resolve({ withdrawn: "native" });
          if (!active() || l.abort?.signal.aborted) return resolve({ withdrawn: "stopped" });
          const id = newId();
          const close = () => this.withdraw(threadId, l, id, "native");
          l.pending.set(id, { kind: "question", questions: req.questions, settle: (reply) => {
            withdrawn?.removeEventListener("abort", close);
            resolve(reply);
          } });
          l.requests = registerRequest(l.requests, { kind: "question", id, binding: bind(id, req.native), questions: req.questions, blocking: req.blocking, digest: actionDigest(req.questions) });
          this.addItem(threadId, { id, kind: "question", questions: req.questions, blocking: req.blocking, at: at() });
          // A blocking question holds the turn until it is answered; a non-blocking one lets it run on.
          if (req.blocking) this.setStatus(threadId, "waiting");
          withdrawn?.addEventListener("abort", close, { once: true });
        });
      },
      refusedByRule: (req) => refusals.get(req),
      notice: (level, text) => { if (active()) this.addItem(threadId, { id: newId(), kind: "notice", level, text, at: at() }); },
      session: (handle) => {
        if (!active()) return;
        const t = this.o.store.thread(threadId);
        if (t && t.sessionHandle !== handle) this.o.store.updateThread(threadId, { sessionHandle: handle });
      },
    };
  }

  /**
   * Runs the approval gate for one request. Resolves to a rule's answer ("yes" or "no", never
   * "always"), or `ask` when a human must decide. Any failure is an ask; a stopped turn is a "no".
   */
  private async gateApproval(
    req: ApprovalRequest,
    c: { thread: Thread; project: { path: string; name: string }; settings: Settings; active: () => boolean; signal?: AbortSignal },
  ): Promise<{ ask: true; decidedBy?: ApprovalReceipt } | { ask: false; answer: "yes" | "no"; decidedBy?: ApprovalReceipt }> {
    if (!c.active() || c.signal?.aborted) return { ask: false, answer: "no" };
    try {
      const jev = await this.router.decisions.connect("approval", { threadId: c.thread.id }).catch(() => ({ transport: null, model: "" }));
      const d = await decideApproval(req.action, {
        rules: c.settings.approval_rules,
        config: c.settings.approval_gate,
        project: { root: c.project.path, name: c.project.name, branch: c.thread.worktree?.branch ?? null },
        mode: c.thread.mode,
        transport: jev.transport,
        model: jev.model,
      }, c.signal);
      const answer = answerFor(d);
      const decidedBy = receiptFor(d);
      if (answer === "yes" || answer === "no") return { ask: false, answer, decidedBy };
      return { ask: true, decidedBy };
    } catch {
      return c.signal?.aborted ? { ask: false, answer: "no" } : { ask: true };
    }
  }

  private addItem(threadId: string, item: ThreadItem, persisted?: () => void): void {
    const l = this.slot(threadId);
    l.items.push(item);
    try { this.persistItems(threadId, l); }
    catch (error) { l.items.pop(); throw error; }
    // A failure here is after durable persistence: keep the item in memory and
    // retain the pending intent. Do not pretend a failed callback rolled disk back.
    persisted?.();
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

/** How a backend's turn result ends its attempt. */
const ATTEMPT_OUTCOME: Record<TurnResult["status"], SettledOutcome> = { completed: "succeeded", interrupted: "interrupted", failed: "failed" };

/** Tool args and output at the size the transcript keeps: output is its last 256 KiB, with the total. */
function redactObservation(o: Observation): Observation {
  if (o.type === "tool.start") return { ...o, tool: { ...o.tool, args: redact(o.tool.args) } };
  if ((o.type === "tool.update" || o.type === "tool.done") && o.progress) {
    const progress = { ...o.progress, ...(o.progress.args ? { args: redact(o.progress.args) } : {}) };
    if (progress.output !== undefined) {
      const bounded = boundOutput(progress.output);
      progress.output = bounded.text;
      if (bounded.truncated) Object.assign(progress, { outputBytes: Math.max(progress.outputBytes ?? 0, bounded.truncated.totalBytes), outputTruncated: true });
    }
    return { ...o, progress } as Observation;
  }
  return o;
}

/** Whether a process exists (signal 0 delivers nothing; EPERM means it exists under another user). */
function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/** The notice a stopped turn ends with: plain "Stopped." when the CLI ended on its own, else how Modex ended it. */
function stopNotice(name: string, stop: TurnResult["stop"]): { level: "info" | "warn"; text: string } {
  const grace = stop?.graceMs === undefined ? "its grace window" : stop.graceMs < 1000 ? `${stop.graceMs} ms` : `${Math.round(stop.graceMs / 100) / 10} s`;
  switch (stop?.outcome) {
    case "terminated": return { level: "info", text: `Stopped. ${name} did not end the turn within ${grace} of the interrupt, so Modex terminated it.` };
    case "killed": return { level: "warn", text: `Stopped. ${name} ignored the interrupt and SIGTERM, so Modex killed it.` };
    case "unconfirmed": return { level: "warn", text: `Stop requested, but ${name}${stop.pid ? ` (pid ${stop.pid})` : ""} has not confirmed that it exited. Modex keeps this thread and its worktree until it does.` };
    default: return { level: "info", text: "Stopped." };
  }
}

/** Keeps tool args small enough for the UI: long strings are truncated. */
function redact(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) out[k] = typeof v === "string" && v.length > 4000 ? v.slice(0, 4000) + "…" : v;
  return out;
}
