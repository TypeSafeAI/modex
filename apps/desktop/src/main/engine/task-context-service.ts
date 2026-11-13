import { randomUUID } from "node:crypto";
import { listWorkspaceFiles } from "./workspace-files.js";
import type { TaskContextCandidates } from "../../shared/task-context-evidence.js";
import { TaskContextRecovery, type ContextTransfer, type ContextReservation } from "./task-context-recovery.js";
import type { Store } from "./store.js";
import type { TaskContextCapture, CapturedNoteInput } from "./task-context-capture.js";
import { sameContextDraftOwner, contextRefId, copyTaskContextEvidence, isContextDraftBinding, taskContextBelongsTo, type ContextCapture, type ContextDraftOwner, type ContextDraftBinding, type ContextTarget, type TaskContextEvidence, type PendingTaskContext } from "../../shared/task-context-evidence.js";

interface Scope { projectId: string; cwd: string; identity: string }
interface Draft { binding: ContextDraftBinding; scope: Scope; context: TaskContextEvidence; abort: AbortController; generation: number; created?: { id: string; at: string }; requested?: ContextReservation; pending?: ContextTransfer }
const fail = () => new Error("Task context draft is stale or no longer belongs to this composer/project.");
const key = (owner: ContextDraftOwner) => owner.kind === "thread" ? `thread:${owner.threadId}` : owner.key;
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const empty = (): TaskContextEvidence => ({ revision: 0, refs: [], captures: [], checks: [] });
const SELECTION_BYTES = 2 * 1024 * 1024;
const tooLarge = () => new Error("Selected context is too large to save; the previous draft was preserved.");

/** Main owns draft identities and receipt bodies; renderer requests contain targets only. */
export class TaskContextService {
  private readonly drafts = new Map<string, Draft>();
  private readonly owners = new Map<string, string>();
  private readonly spent = new Map<string, { binding: ContextDraftBinding; threadId: string; turnId: string; context?: TaskContextEvidence; projectId: string }>();
  private readonly recovery: TaskContextRecovery;
  constructor(private readonly options: { store: Store; capture: Pick<TaskContextCapture, "captureSelection">; listFiles?: typeof listWorkspaceFiles }) { this.recovery = new TaskContextRecovery(options.store); }
  private scope(owner: ContextDraftOwner): Scope {
    if (!owner || typeof owner !== "object") throw fail();
    if (owner.kind === "thread") {
      if (Object.keys(owner).sort().join() !== "kind,threadId") throw fail();
      const t = this.options.store.thread(owner.threadId), p = t && this.options.store.project(t.projectId);
      if (!t || t.retired || !p) throw fail();
      return { projectId: p.id, cwd: t.cwd, identity: JSON.stringify([p.id, p.path, p.addedAt, t.id, t.createdAt, t.cwd]) };
    }
    if (owner.kind !== "project" || Object.keys(owner).sort().join() !== "key,kind,projectId" || typeof owner.key !== "string") throw fail();
    const p = this.options.store.project(owner.projectId), match = owner.key.match(/^draft:(0|[1-9]\d*):/);
    if (!p || !match || !Number.isSafeInteger(Number(match[1])) || owner.key !== `draft:${match[1]}:${p.id}`) throw fail();
    return { projectId: p.id, cwd: p.path, identity: JSON.stringify([p.id, p.path, p.addedAt]) };
  }
  private current(binding: ContextDraftBinding, revision = true): Draft {
    if (!isContextDraftBinding(binding)) throw fail();
    const draft = this.drafts.get(binding.nonce);
    if (!draft || !sameContextDraftOwner(draft.binding.owner, binding.owner) || (revision && draft.binding.revision !== binding.revision) || this.scope(binding.owner).identity !== draft.scope.identity) throw fail();
    return draft;
  }
  openContextDraft(owner: ContextDraftOwner): ContextDraftBinding {
    const scope = this.scope(owner), old = this.owners.get(key(owner));
    if (old) this.closeContextDraft(this.drafts.get(old)!.binding);
    const recovered = this.recovery.open(owner, scope);
    const binding = { owner: structuredClone(owner), nonce: randomUUID(), revision: recovered.context.revision };
    this.drafts.set(binding.nonce, { binding, scope, context: recovered.context, ...(recovered.created ? { created: recovered.created } : {}), ...(recovered.requested ? { requested: recovered.requested } : {}), abort: new AbortController(), generation: 0 });
    this.owners.set(key(owner), binding.nonce);
    return structuredClone(binding);
  }
  draftTaskContext(binding: ContextDraftBinding): TaskContextEvidence { return copyTaskContextEvidence(this.current(binding).context); }
  assertReferenceScope(projectId: string, targets: ContextTarget[]): void {
    for (const target of targets) if (target.kind !== "file" && !this.noteInScope(projectId, target)) throw new Error("This note is outside this project's notes.");
  }
  async candidates(binding: ContextDraftBinding): Promise<TaskContextCandidates> {
    const draft = this.current(binding), generation = draft.generation;
    const listed = await (this.options.listFiles ?? listWorkspaceFiles)(draft.scope.cwd);
    if (this.current(binding) !== draft || draft.generation !== generation) throw fail();
    const files: TaskContextCandidates["files"] = { paths: [], truncated: listed.truncated };
    let fileBytes = 2; // Include the array delimiters; one byte per row reserves its comma.
    for (const relative of listed.paths) {
      const target: ContextTarget = { kind: "file", path: relative };
      try { copyTaskContextEvidence({ revision: 0, refs: [{ id: "candidate", target, relations: [], captureIds: [] }], captures: [], checks: [] }); }
      catch { files.truncated = true; continue; }
      const bytes = Buffer.byteLength(JSON.stringify(relative)) + 1;
      if (files.paths.length === 5000 || fileBytes + bytes > 2 * 1024 * 1024) { files.truncated = true; break; }
      files.paths.push(relative); fileBytes += bytes;
    }
    const space = this.options.store.space, own = space.projectFor(draft.scope.projectId);
    const notes: TaskContextCandidates["notes"] = { items: [], truncated: false };
    if (own) {
      const within = (rel: string | undefined) => rel !== undefined && (rel === own.rel || rel.startsWith(`${own.rel}/`));
      const rels = space.pageRels(), tree = space.tree();
      notes.truncated = tree.truncated;
      let bytes = 2;
      const append = (row: TaskContextCandidates["notes"]["items"][number]) => {
        const size = Buffer.byteLength(JSON.stringify(row)) + 1;
        if (notes.items.length === 5000 || bytes + size > 2 * 1024 * 1024) { notes.truncated = true; return false; }
        notes.items.push(row); bytes += size; return true;
      };
      for (const page of space.list()) {
        if (!page.trashedAt && within(rels.get(page.id)) && !append({ target: { kind: "note", pageId: page.id }, title: page.title })) break;
      }
      for (const node of tree.nodes) {
        if (node.kind === "file" && within(node.rel) && !append({ target: { kind: "notes-file", id: node.id }, title: node.name })) break;
      }
    }
    if (this.current(binding) !== draft || draft.generation !== generation) throw fail();
    return { files, notes };
  }
  private noteInScope(projectId: string, target: Exclude<ContextTarget, { kind: "file" }>): boolean {
    const notes = this.options.store.space, own = notes.projectFor(projectId);
    if (!own) return false;
    const within = (rel: string | undefined) => rel !== undefined && (rel === own.rel || rel.startsWith(`${own.rel}/`));
    if (target.kind === "note") {
      if (!within(notes.pageRels().get(target.pageId))) return false;
      return notes.list().some(p => p.id === target.pageId && !p.trashedAt);
    }
    return notes.tree().nodes.some(n => n.kind === "file" && n.id === target.id && within(n.rel));
  }
  async selectTaskContext(binding: ContextDraftBinding, targets: ContextTarget[]): Promise<{ binding: ContextDraftBinding; context: TaskContextEvidence }> {
    const draft = this.current(binding), generation = draft.generation;
    if (!Array.isArray(targets)) throw fail();
    const unique = new Map<string, ContextTarget>();
    let minimumReferenceBytes = 0;
    for (const target of targets) {
      // Reuse the strict persisted-target validator before any filesystem/Notes read.
      const candidate: TaskContextEvidence = { revision: 0, refs: [{ id: "candidate", target, relations: [], captureIds: [] }], captures: [], checks: [] };
      copyTaskContextEvidence(candidate);
      const id = contextRefId(target);
      if (unique.has(id)) continue;
      // These ref fields alone cannot fit, regardless of capture results. Bound
      // the logical selection rather than rejecting large duplicate inputs.
      minimumReferenceBytes += Buffer.byteLength(JSON.stringify({ id, target, relations: [], captureIds: [] })) + 1;
      if (minimumReferenceBytes > SELECTION_BYTES) throw tooLarge();
      if (target.kind !== "file" && !this.noteInScope(draft.scope.projectId, target)) throw new Error("This note is outside this project's notes.");
      unique.set(id, structuredClone(target));
    }
    const requested = [...unique.values()];
    const source = { kind: "human" as const, actionId: randomUUID(), at: new Date().toISOString() };
    const retained = draft.context.captures.filter(c => unique.has(contextRefId(c.target)));
    const previousRefs = new Map(draft.context.refs.map(ref => [ref.id, ref]));
    const workspace = (target: ContextTarget): NonNullable<ContextCapture["workspace"]> => target.kind === "file" && binding.owner.kind === "thread"
      ? { kind: "thread", projectId: draft.scope.projectId, threadId: binding.owner.threadId } : { kind: "project", projectId: draft.scope.projectId };
    const compose = (captures: ContextCapture[]): TaskContextEvidence => {
      const capturedIds = new Map<string, string[]>();
      for (const capture of captures) { const id = contextRefId(capture.target); capturedIds.set(id, [...(capturedIds.get(id) ?? []), capture.id]); }
      return { revision: draft.context.revision + 1, refs: [...unique].map(([id, target]) => {
        const previous = previousRefs.get(id);
        return { id, target, relations: [...(previous?.relations ?? []), { kind: "relevant", provenance: "user-confirmed", source }], captureIds: [...(previous?.captureIds ?? []), ...(capturedIds.get(id) ?? [])] };
      }), captures: [...retained, ...captures], checks: [] };
    };
    // Size prediction only: unavailable/budget is the shortest capture shape,
    // IDs and ISO timestamps have their actual widths, and optional Note/hash
    // metadata is omitted. Never publish or persist these predicted receipts.
    const minimum = compose(requested.map((target, i): ContextCapture => ({ id: String(i).padStart(36, "0"), target, source, phase: "selected", startedAt: source.at, finishedAt: source.at,
      repository: { state: "unavailable", reason: "budget" }, revision: { state: "unavailable", reason: "budget" }, workspace: workspace(target) })));
    if (Buffer.byteLength(JSON.stringify(minimum)) > SELECTION_BYTES) throw tooLarge();
    const notes: CapturedNoteInput[] = [];
    for (const target of requested) {
      if (target.kind === "note") {
        const page = this.options.store.space.list().find(p => p.id === target.pageId && !p.trashedAt);
        if (!page || !this.noteInScope(draft.scope.projectId, target)) throw fail();
        notes.push({ target, source, text: page.markdown, version: { via: "read", updatedAt: page.updatedAt, revision: page.revision } });
      } else if (target.kind === "notes-file") {
        if (!this.noteInScope(draft.scope.projectId, target)) throw fail();
        notes.push({ target, source, text: this.options.store.space.readFile(target.id) });
      }
    }
    const captured = await this.options.capture.captureSelection(draft.scope.cwd, requested, source, notes, "selected", draft.abort.signal);
    const captures: ContextCapture[] = captured.map(capture => ({ ...capture, workspace: workspace(capture.target) }));
    if (this.current(binding) !== draft || draft.generation !== generation) throw fail();
    for (const target of requested) if (target.kind !== "file" && !this.noteInScope(draft.scope.projectId, target)) throw fail();
    for (const note of notes) if (note.target.kind === "note") {
      const pageId = note.target.pageId;
      const current = this.options.store.space.list().find(p => p.id === pageId && !p.trashedAt);
      if (!current || current.revision !== note.version!.revision || current.updatedAt !== note.version!.updatedAt) throw new Error("The selected Note changed; the previous context draft was preserved.");
    }
    const context = compose(captures);
    if (Buffer.byteLength(JSON.stringify(context)) > SELECTION_BYTES) throw tooLarge();
    this.recovery.save(binding.owner, draft.scope, draft.context, context, draft.created);
    draft.context = copyTaskContextEvidence(context);
    draft.binding = { ...draft.binding, revision: draft.binding.revision + 1 };
    return { binding: structuredClone(draft.binding), context: copyTaskContextEvidence(draft.context) };
  }
  closeContextDraft(binding: ContextDraftBinding): void {
    const draft = this.drafts.get(binding.nonce);
    if (!draft || !sameContextDraftOwner(draft.binding.owner, binding.owner)) return;
    draft.abort.abort(); this.drafts.delete(binding.nonce);
    if (this.owners.get(key(binding.owner)) === binding.nonce) this.owners.delete(key(binding.owner));
  }
  bindCreatedThread(binding: ContextDraftBinding, threadId: string): void {
    const draft = this.current(binding), thread = this.options.store.thread(threadId);
    if (binding.owner.kind !== "project" || !thread || thread.retired || thread.projectId !== draft.scope.projectId || (draft.created && (draft.created.id !== thread.id || draft.created.at !== thread.createdAt)) || (draft.requested && (draft.requested.id !== thread.id || draft.requested.at !== thread.createdAt))) throw new Error("The created thread is not bound to this project draft.");
    const created = { id: thread.id, at: thread.createdAt };
    this.recovery.save(binding.owner, draft.scope, draft.context, draft.context, created);
    draft.created = created;
  }
  snapshotForPending(binding: ContextDraftBinding, owner: ContextDraftOwner): PendingTaskContext {
    const draft = this.current(binding);
    if (!sameContextDraftOwner(draft.binding.owner, owner)) throw fail();
    return { owner: structuredClone(draft.binding.owner), projectId: draft.scope.projectId, evidence: copyTaskContextEvidence(draft.context) };
  }
  preparePending(binding: ContextDraftBinding, transfer: ContextTransfer): void {
    const draft = this.current(binding);
    if (transfer.kind !== "pending") throw fail();
    this.recovery.prepare(binding.owner, draft.scope, draft.context, transfer); draft.pending = structuredClone(transfer);
  }
  pendingPersisted(binding: ContextDraftBinding, turnId: string): void {
    const draft = this.current(binding);
    if (!draft.pending || draft.pending.turnId !== turnId) throw fail();
    this.recovery.complete(binding.owner, draft.scope, draft.pending); this.closeContextDraft(binding);
  }
  /** A recovered project intent cannot attest to the newly bound thread's input bytes. */
  pendingForThread(context: PendingTaskContext, threadId: string): PendingTaskContext {
    const thread = this.options.store.thread(threadId);
    if (!thread || thread.retired || thread.projectId !== context.projectId) throw fail();
    const result = structuredClone(context);
    if (result.owner.kind === "thread") {
      if (result.owner.threadId !== threadId) throw fail();
      return result;
    }
    const at = new Date().toISOString(), source = { kind: "human" as const, actionId: randomUUID(), at };
    for (const ref of result.evidence.refs) if (ref.target.kind === "file") {
      const capture: ContextCapture = { id: randomUUID(), target: { ...ref.target }, source, phase: "selected", startedAt: at, finishedAt: at,
        repository: { state: "unavailable", reason: "not-captured" }, revision: { state: "unavailable", reason: "not-captured" },
        workspace: { kind: "thread", projectId: thread.projectId, threadId } };
      result.evidence.captures.push(capture); ref.captureIds.push(capture.id);
    }
    result.evidence.revision++;
    return result;
  }
  creationFor(binding: ContextDraftBinding, projectId: string): string | undefined {
    const draft = this.current(binding);
    if (binding.owner.kind !== "project" || draft.scope.projectId !== projectId) throw new Error("Context draft belongs to another project.");
    if (!draft.created && draft.requested && this.options.store.thread(draft.requested.id)) this.bindCreatedThread(binding, draft.requested.id);
    if (draft.created) {
      const thread = this.options.store.thread(draft.created.id);
      if (!thread || thread.retired || thread.projectId !== projectId || thread.createdAt !== draft.created.at) throw fail();
      return thread.id;
    }
    return undefined;
  }
  reserveCreation(binding: ContextDraftBinding, worktree: boolean): { threadId: string; createdAt: string } {
    const draft = this.current(binding), requested = this.recovery.reserve(binding.owner, draft.scope, draft.context, worktree);
    draft.requested = requested; return { threadId: requested.id, createdAt: requested.at };
  }
  /** Main-only admission: committing is separate so a failed user write leaves the draft editable. */
  prepareContextDraft(binding: ContextDraftBinding, threadId: string, turnId: string): { context: TaskContextEvidence; commit(): void } {
    if (!isContextDraftBinding(binding)) throw fail();
    const spent = this.spent.get(binding.nonce);
    if (spent) {
      if (!equal(spent.binding, binding) || spent.threadId !== threadId || spent.turnId !== turnId || !this.options.store.project(spent.projectId)) throw new Error("Context draft was already consumed by another request.");
      const users = this.options.store.items(threadId).filter(item => item.id === turnId && item.kind === "user");
      if (users.length > 1) throw fail();
      const user = users[0], recorded = user?.kind === "user" ? user.contextEvidence : undefined;
      const context = recorded ?? spent.context;
      if (!context || !taskContextBelongsTo(copyTaskContextEvidence(context), threadId, turnId, spent.projectId)) throw new Error("The recorded task context is unavailable; the original turn was preserved.");
      if (recorded) delete spent.context;
      return { context: copyTaskContextEvidence(context), commit: () => {} };
    }
    const draft = this.current(binding), thread = this.options.store.thread(threadId);
    if (!thread || thread.retired || thread.projectId !== draft.scope.projectId || !/^[A-Za-z0-9_-]{1,128}$/.test(turnId)) throw fail();
    if (binding.owner.kind === "thread" ? binding.owner.threadId !== threadId : draft.created?.id !== threadId || draft.created?.at !== thread.createdAt) throw new Error("Context can transfer only to its main-bound created thread.");
    const transfer: ContextTransfer = { kind: "user", threadId, threadCreatedAt: thread.createdAt, turnId };
    this.recovery.prepare(binding.owner, draft.scope, draft.context, transfer);
    const context = copyTaskContextEvidence(draft.context);
    if (binding.owner.kind === "project" && thread.cwd !== draft.scope.cwd) {
      const at = new Date().toISOString(), source = { kind: "human" as const, actionId: randomUUID(), at };
      for (const ref of context.refs) if (ref.target.kind === "file") {
        const capture: ContextCapture = { id: randomUUID(), target: { ...ref.target }, source, phase: "selected", startedAt: at, finishedAt: at,
          repository: { state: "unavailable", reason: "not-captured" }, revision: { state: "unavailable", reason: "not-captured" },
          workspace: { kind: "thread", projectId: thread.projectId, threadId: thread.id } };
        context.captures.push(capture); ref.captureIds.push(capture.id);
      }
      context.revision++;
    }
    let committed = false;
    const generation = draft.generation;
    return { context: copyTaskContextEvidence(context), commit: () => {
      if (committed) return;
      if (this.current(binding) !== draft || draft.generation !== generation) throw fail();
      this.recovery.complete(binding.owner, draft.scope, transfer);
      this.spent.set(binding.nonce, { binding: structuredClone(binding), threadId, turnId, context, projectId: draft.scope.projectId });
      this.closeContextDraft(binding); committed = true;
    } };
  }
  consumeContextDraft(binding: ContextDraftBinding, threadId: string, turnId: string): TaskContextEvidence {
    const admission = this.prepareContextDraft(binding, threadId, turnId); admission.commit(); return admission.context;
  }
  /** Called only from main's post-durable user callback; retain replay identity, not duplicate snapshots. */
  contextPersisted(binding: ContextDraftBinding, threadId: string, turnId: string): void {
    const spent = this.spent.get(binding.nonce);
    if (!spent || !equal(spent.binding, binding) || spent.threadId !== threadId || spent.turnId !== turnId) throw fail();
    delete spent.context;
  }
  readDraft(binding: ContextDraftBinding): TaskContextEvidence { return copyTaskContextEvidence(this.current(binding).context); }
  invalidateDocument(): void { this.dispose(); }
  private cancelCapture(draft: Draft): void {
    draft.abort.abort(); draft.abort = new AbortController(); draft.generation++;
  }
  /** Cancel work at removal start while keeping accepted selections if removal later refuses. */
  cancelProjectCaptures(projectId: string): void {
    for (const draft of this.drafts.values()) if (draft.scope.projectId === projectId) this.cancelCapture(draft);
  }
  cancelThreadCaptures(threadId: string): void {
    for (const draft of this.drafts.values()) if ((draft.binding.owner.kind === "thread" && draft.binding.owner.threadId === threadId) || draft.created?.id === threadId) this.cancelCapture(draft);
  }
  invalidateProject(projectId: string): void {
    for (const draft of this.drafts.values()) if (draft.scope.projectId === projectId) this.closeContextDraft(draft.binding);
    for (const [nonce, row] of this.spent) if (row.projectId === projectId) this.spent.delete(nonce);
  }
  invalidateThread(threadId: string): void {
    for (const draft of this.drafts.values()) if ((draft.binding.owner.kind === "thread" && draft.binding.owner.threadId === threadId) || draft.created?.id === threadId) this.closeContextDraft(draft.binding);
    for (const [nonce, row] of this.spent) if (row.threadId === threadId) this.spent.delete(nonce);
  }
  dispose(): void { for (const draft of this.drafts.values()) this.closeContextDraft(draft.binding); this.spent.clear(); }
}
