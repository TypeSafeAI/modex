import type { Attachment, AttachmentDraftOwner } from "../../shared/attachments.js";
import { LIMITS } from "../../shared/attachments.js";
import type { ComposerRecovery } from "../../shared/update-recovery.js";
import type { AttachmentDraft, AttachmentStore } from "./attachments.js";
import { parseRecoveryJSON, recoveryJSON } from "./attachment-recovery-file.js";

declare const documentBrand: unique symbol;
declare const draftBrand: unique symbol;
declare const transferBrand: unique symbol;
/** Main-only handles. Neither handle, nor the underlying store capability, crosses IPC. */
export type AttachmentDocument = { readonly [documentBrand]: true };
export type DocumentAttachmentDraft = { readonly [draftBrand]: true };
export type DocumentAttachmentTransfer = { readonly [transferBrand]: true };
interface Draft {
  document: Document;
  owner: AttachmentDraftOwner;
  capability: AttachmentDraft;
  handle: DocumentAttachmentDraft;
  files: Map<string, Attachment>;
  active: boolean;
  generation: number;
}
interface Transfer {
  source: Draft;
  generation: number;
  targetOwner: AttachmentDraftOwner & { kind: "thread" };
  target: Draft | undefined;
  files: Attachment[];
}
interface Document { active: boolean; drafts: Map<string, Draft> }
interface Options {
  attachments: AttachmentStore;
  /** Trusted main reader: use UpdateRecovery.read().drafts, never renderer input. */
  readSavedDrafts(): ComposerRecovery | null;
  /** Strict main pending-intent reader; references protect bytes, never confer
   * editable-document authority. Omit only when durable sends are unavailable. */
  readPendingAttachments?(): readonly Attachment[];
  /** Main Store lookup. Existence alone never authorizes an unknown file ID. */
  ownerExists(owner: AttachmentDraftOwner): boolean;
}
const stale = () => new Error("The attachment document or draft is no longer available.");
const key = (owner: AttachmentDraftOwner) => owner.kind === "thread" ? `thread:${owner.threadId}` : owner.key;
const copy = (files: readonly Readonly<Attachment>[]): Attachment[] => files.map(file => ({ ...file }));
function ownerCopy(input: AttachmentDraftOwner): AttachmentDraftOwner {
  if (!input || typeof input !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw stale();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const keys = Reflect.ownKeys(input);
  if (keys.some(k => typeof k !== "string" || !descriptors[k]?.enumerable || !Object.hasOwn(descriptors[k]!, "value"))) throw stale();
  const id = (value: unknown): value is string => typeof value === "string" && value.length <= 128 && /^[\w-]+$/.test(value) && value !== "staging";
  if (keys.length === 2 && input.kind === "thread" && id(input.threadId)) return Object.freeze({ kind: "thread", threadId: input.threadId });
  if (keys.length === 3 && input.kind === "project" && id(input.projectId) && typeof input.key === "string") {
    const revision = input.key.match(/^draft:(0|[1-9]\d*):/);
    if (revision && Number.isSafeInteger(Number(revision[1])) && input.key === `draft:${revision[1]}:${input.projectId}`) {
      return Object.freeze({ kind: "project", key: input.key, projectId: input.projectId });
    }
  }
  throw stale();
}
const references = (snapshot: ComposerRecovery | null): Attachment[] => snapshot
  ? [...snapshot.threads, ...snapshot.projects].flatMap(entry => copy(entry.attachments)) : [];

/** Document lifetime and exact-file admission for local native attachment commands.
 * The journal owns disk transfers. This registry adopts only its main-proven
 * committed result; durable deletion remains a separate sequenced boundary.
 */
export class AttachmentDocuments {
  private readonly options: Readonly<Options>;
  private readonly documents = new WeakMap<AttachmentDocument, Document>();
  private readonly handles = new WeakMap<DocumentAttachmentDraft, Draft>();
  private readonly transfers = new WeakMap<DocumentAttachmentTransfer, Transfer>();
  private readonly preserved = new Map<string, Attachment>();
  private current?: Document;
  private pending = 0;
  private hold?: symbol;
  private adopting = false;
  private adoptionReentered = false;
  private uncertain = false;

  constructor(options: Options) {
    this.options = Object.freeze({ ...options });
    // This must precede startup or incidental staging cleanup, including a failed read.
    options.attachments.setRecoveryRetention(null);
  }

  get busy(): boolean { return this.pending > 0; }

  open(): { document: AttachmentDocument; drafts: ComposerRecovery | null } {
    this.assertOpen();
    this.invalidate();
    this.options.attachments.setRecoveryRetention(null);
    const saved = this.options.readSavedDrafts();
    const drafts: ComposerRecovery | null = saved === null ? null : JSON.parse(JSON.stringify(saved));
    const state: Document = { active: true, drafts: new Map() };
    const document = Object.freeze({}) as AttachmentDocument;
    this.documents.set(document, state);
    this.current = state;
    try {
      for (const entry of drafts?.threads ?? []) this.restore(document, { kind: "thread", threadId: entry.threadId }, entry.attachments);
      for (const entry of drafts?.projects ?? []) this.restore(document, { kind: "project", key: entry.key, projectId: entry.projectId }, entry.attachments);
      if (!this.refreshRetention()) throw new Error("Saved attachment references require recovery; all files were preserved.");
      return { document, drafts };
    } catch (error) {
      this.invalidate();
      this.options.attachments.setRecoveryRetention(null);
      throw error;
    }
  }

  private restore(document: AttachmentDocument, owner: AttachmentDraftOwner, files: Attachment[]): void {
    const handle = this.register(document, owner);
    const draft = this.requireDraft(handle);
    for (const file of files) {
      if (!this.options.attachments.validateRecovery(file, draft.owner)) throw new Error("A saved attachment is missing or changed; all files were preserved.");
      draft.files.set(file.id, { ...file });
    }
  }

  /** Main controller only: restore a strictly read durable pending batch.
   * Retention references alone never call this or grant document authority. */
  restorePending(document: AttachmentDocument, owner: AttachmentDraftOwner, files: readonly Readonly<Attachment>[]): void {
    this.assertOpen();
    const handle = this.register(document, owner), draft = this.requireDraft(handle);
    for (const file of files) {
      const known = draft.files.get(file.id);
      if ((known && recoveryJSON(known, 4096) !== recoveryJSON(file, 4096))
        || !this.options.attachments.validateRecovery(file, draft.owner)) throw stale();
    }
    for (const file of files) draft.files.set(file.id, { ...file });
    draft.generation++;
  }

  register(document: AttachmentDocument, input: AttachmentDraftOwner): DocumentAttachmentDraft {
    this.assertOpen();
    const state = this.requireDocument(document);
    const owner = ownerCopy(input);
    const existing = state.drafts.get(key(owner));
    if (existing) return existing.handle;
    if (this.options.ownerExists(owner) !== true) throw stale();
    const capability = this.options.attachments.mintDraft(owner);
    this.requireDocument(document);
    const handle = Object.freeze({}) as DocumentAttachmentDraft;
    const draft: Draft = { document: state, owner, capability, handle, files: new Map(), active: true, generation: 0 };
    state.drafts.set(key(owner), draft);
    this.handles.set(handle, draft);
    return handle;
  }

  capture(document: AttachmentDocument, owner: AttachmentDraftOwner): DocumentAttachmentDraft {
    const draft = this.requireDocument(document).drafts.get(key(ownerCopy(owner)));
    if (!draft) throw stale();
    this.requireDraft(draft.handle);
    return draft.handle;
  }

  retire(handle: DocumentAttachmentDraft): void {
    this.assertOpen();
    const draft = this.requireDraft(handle);
    this.preserve([...draft.files.values()]);
    draft.active = false;
    draft.document.drafts.delete(key(draft.owner));
    this.options.attachments.revokeDraft(draft.capability);
    // Lifetime revocation never discards evidence on the renderer's behalf.
  }

  invalidate(): void {
    const state = this.current;
    this.current = undefined;
    if (!state) return;
    state.active = false;
    for (const draft of state.drafts.values()) {
      this.preserve([...draft.files.values()]);
      draft.active = false;
      try { this.options.attachments.revokeDraft(draft.capability); }
      catch { this.options.attachments.setRecoveryRetention(null); }
    }
  }

  stage(handle: DocumentAttachmentDraft, files: unknown, bytesOnly = false) {
    this.assertOpen();
    const draft = this.requireDraft(handle);
    this.assertFileWritesOpen();
    const result = this.options.attachments.stage(files, { draft: draft.capability, bytesOnly });
    this.requireDraft(handle);
    draft.generation++;
    for (const file of result.staged) draft.files.set(file.id, { ...file });
    if (!this.refreshRetention()) throw new Error("Attachment recovery is required; all files were preserved.");
    return { staged: copy(result.staged), errors: [...result.errors] };
  }

  async pick(handle: DocumentAttachmentDraft, remaining: number, choose: () => Promise<unknown>) {
    this.assertOpen();
    const draft = this.requireDraft(handle); // Capture before the native dialog yields.
    this.assertFileWritesOpen();
    if (!Number.isInteger(remaining) || remaining < 0 || remaining > LIMITS.perTurn) throw new Error("Invalid attachment capacity.");
    this.pending++;
    draft.generation++;
    try {
      const paths = await choose();
      this.assertOpen();
      this.requireDraft(handle);
      this.assertFileWritesOpen();
      const result = this.options.attachments.stagePaths(paths, remaining, { draft: draft.capability });
      this.requireDraft(handle);
      for (const file of result.staged) draft.files.set(file.id, { ...file });
      if (!this.refreshRetention()) throw new Error("Attachment recovery is required; all files were preserved.");
      return { staged: copy(result.staged), errors: [...result.errors] };
    } finally { this.pending--; }
  }

  discard(handle: DocumentAttachmentDraft, ids: readonly string[]): void {
    this.assertOpen();
    const draft = this.requireDraft(handle);
    this.assertFileWritesOpen();
    if (!Array.isArray(ids) || ids.length > LIMITS.perTurn || new Set(ids).size !== ids.length
      || ids.some(id => typeof id !== "string" || !draft.files.has(id))) throw new Error("Unknown attachment in this draft.");
    // The old durable snapshot may still reference these files. Retiring its
    // manifest entries now would break fresh-process recovery even if retention
    // kept the bytes. Only the future durable-save adapter may finalize deletion.
    this.preserve(ids.map(id => draft.files.get(id)!));
    draft.generation++;
    for (const id of ids) draft.files.delete(id);
  }

  validate(document: AttachmentDocument, owner: AttachmentDraftOwner, file: Readonly<Attachment>): boolean {
    try {
      const handle = this.capture(document, owner);
      const draft = this.requireDraft(handle);
      const known = draft.files.get(file.id);
      if (!known || Reflect.ownKeys(file).length !== Object.keys(known).length
        || Object.keys(known).some(k => known[k as keyof Attachment] !== file[k as keyof Attachment])) return false;
      const valid = this.options.attachments.validateRecovery(file, draft.owner);
      return valid && this.requireDraft(handle) === draft;
    } catch { return false; }
  }

  /** Adapter-only: target comes from a bound main pending intent/Store proof. */
  beginTransfer(source: DocumentAttachmentDraft, targetThreadId: string, input: readonly Attachment[]): DocumentAttachmentTransfer {
    this.assertOpen();
    if (this.busy) throw stale();
    const draft = this.requireDraft(source);
    const targetOwner = ownerCopy({ kind: "thread", threadId: targetThreadId }) as AttachmentDraftOwner & { kind: "thread" };
    if (draft.owner.kind === "thread" && draft.owner.threadId !== targetThreadId) throw stale();
    const files = parseRecoveryJSON(recoveryJSON(input, 64 * 1024), 64 * 1024) as Attachment[];
    if (!Array.isArray(files) || files.length > LIMITS.perTurn || files.length !== draft.files.size
      || new Set(files.map(file => file.id)).size !== files.length
      || files.some(file => !draft.files.has(file.id) || recoveryJSON(file, 4096) !== recoveryJSON(draft.files.get(file.id), 4096)
        || !this.options.attachments.validateRecovery(file, draft.owner))) throw stale();
    if (this.options.ownerExists(targetOwner) !== true) throw stale();
    const target = draft.document.drafts.get(key(targetOwner));
    if (target && target !== draft && (target.generation !== 0 || target.files.size)) throw stale();
    const token = Object.freeze({}) as DocumentAttachmentTransfer;
    const state: Transfer = { source: draft, generation: draft.generation, targetOwner, target, files: copy(files) };
    this.transfers.set(token, state);
    if (this.currentTransfer(token) !== state) throw stale();
    return token;
  }

  private currentTransfer(token: DocumentAttachmentTransfer): Transfer | undefined {
    try {
      if (this.uncertain || this.hold || this.busy) return undefined;
      const state = this.transfers.get(token); if (!state) return undefined;
      const source = this.requireDraft(state.source.handle);
      const target = source.document.drafts.get(key(state.targetOwner));
      if (source !== state.source || source.generation !== state.generation || source.files.size !== state.files.length
        || state.files.some(file => recoveryJSON(source.files.get(file.id), 4096) !== recoveryJSON(file, 4096))
        || target !== state.target || (target && target !== source && (target.generation !== 0 || target.files.size))
        || this.options.ownerExists(state.targetOwner) !== true) return undefined;
      // Recheck after authority callbacks, which may revoke a document or touch
      // a draft even when they ultimately return true.
      if (!source.active || source.generation !== state.generation || source.document !== this.current || !source.document.active
        || source.document.drafts.get(key(source.owner)) !== source || source.document.drafts.get(key(state.targetOwner)) !== target
        || (target && target !== source && (target.generation !== 0 || target.files.size))) return undefined;
      return state;
    } catch { return undefined; }
  }

  validateTransfer(token: DocumentAttachmentTransfer): boolean {
    const state = this.currentTransfer(token);
    return !!state && state.files.every(file => this.options.attachments.validateRecovery(file, state.source.owner))
      && this.currentTransfer(token) === state;
  }

  /** Only main's adapter supplies committed(), after the durable journal result.
   * Renderer input cannot supply this callback or obtain the opaque token. */
  adoptTransfer(token: DocumentAttachmentTransfer, input: unknown, committed: () => boolean): DocumentAttachmentDraft {
    this.assertOpen();
    const state = this.currentTransfer(token); if (!state) throw stale();
    this.adopting = true; this.adoptionReentered = false;
    let capability: AttachmentDraft | undefined, adopted = false, confirmed = false;
    try {
      confirmed = committed() === true;
      if (!confirmed || this.adoptionReentered || this.currentTransfer(token) !== state) throw stale();
      const files = parseRecoveryJSON(recoveryJSON(input, 64 * 1024), 64 * 1024) as Attachment[];
      if (!Array.isArray(files) || files.length !== state.files.length || new Set(files.map(file => file.id)).size !== files.length) throw stale();
      const claimed = new Map(files.map(file => [file.id, file]));
      for (const before of state.files) {
        const expected = { ...before, rel: before.rel.startsWith("staging/") ? `${state.targetOwner.threadId}/${before.rel.slice(8)}` : before.rel };
        const file = claimed.get(before.id);
        if (!file || recoveryJSON(file, 4096) !== recoveryJSON(expected, 4096)
          || !this.options.attachments.validateRecovery(file, state.targetOwner)) throw stale();
      }
      capability = this.options.attachments.mintDraft(state.targetOwner);
      if (this.adoptionReentered || this.currentTransfer(token) !== state) throw stale();
      this.options.attachments.revokeDraft(state.source.capability);
      if (state.target && state.target !== state.source) this.options.attachments.revokeDraft(state.target.capability);
      const handle = Object.freeze({}) as DocumentAttachmentDraft;
      const draft: Draft = { document: state.source.document, owner: state.targetOwner, capability, handle,
        files: new Map(files.map(file => [file.id, { ...file }])), active: true, generation: 1 };
      this.preserve(state.files);
      state.source.active = false;
      if (state.target) state.target.active = false;
      draft.document.drafts.delete(key(state.source.owner));
      draft.document.drafts.set(key(draft.owner), draft);
      this.handles.set(handle, draft); this.transfers.delete(token); adopted = true;
      if (!this.refreshRetention()) throw new Error("Attachment recovery is required; all files were preserved.");
      return handle;
    } catch (error) {
      if (confirmed || this.adoptionReentered) { this.uncertain = true; this.options.attachments.setRecoveryRetention(null); }
      throw error;
    } finally {
      if (capability && !adopted) {
        try { this.options.attachments.revokeDraft(capability); } catch { this.options.attachments.setRecoveryRetention(null); }
      }
      this.adopting = false;
    }
  }

  /** Call after a durable save, before cleanup. A failed/ambiguous read preserves all. */
  refreshRetention(): boolean {
    this.options.attachments.setRecoveryRetention(null);
    if (this.uncertain) return false;
    try {
      const files = references(this.options.readSavedDrafts());
      if (this.options.readPendingAttachments) files.push(...copy(this.options.readPendingAttachments()));
      files.push(...copy([...this.preserved.values()]));
      for (const draft of this.current?.drafts.values() ?? []) files.push(...copy([...draft.files.values()]));
      return this.options.attachments.setRecoveryRetention(files);
    } catch { return false; }
  }

  holdForRestart(): () => void {
    this.assertOpen();
    if (this.busy) throw new Error("Let attachment requests finish before restarting.");
    const token = this.hold = Symbol();
    return () => { if (this.hold === token) this.hold = undefined; };
  }

  private assertOpen(): void {
    if (this.adopting) { this.adoptionReentered = true; throw stale(); }
    if (this.uncertain) throw new Error("Attachment recovery is required; all files were preserved.");
    if (this.hold) throw new Error("Modex is preparing to restart.");
  }
  private preserve(files: readonly Attachment[]): void {
    for (const file of files) this.preserved.set(JSON.stringify([file.id, file.rel]), { ...file });
  }
  private assertFileWritesOpen(): void {
    this.assertOpen();
    if (!this.refreshRetention()) throw new Error("Attachment recovery is required; all files were preserved.");
  }
  private requireDocument(handle: AttachmentDocument): Document {
    const state = this.documents.get(handle);
    if (!state?.active || state !== this.current) throw stale();
    return state;
  }
  private requireDraft(handle: DocumentAttachmentDraft): Draft {
    if (this.uncertain) throw stale();
    const draft = this.handles.get(handle);
    if (!draft?.active || draft.document !== this.current || !draft.document.active
      || draft.document.drafts.get(key(draft.owner)) !== draft || this.options.ownerExists(draft.owner) !== true) throw stale();
    return draft;
  }
}
