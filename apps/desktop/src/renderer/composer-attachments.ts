import type { Attachment } from "../shared/attachments.js";
import { LIMITS } from "../shared/attachments.js";

export interface AttachmentActions {
  copying: boolean;
  sending: boolean;
  warning: string | null;
  onFiles: (files: Iterable<File>) => Promise<void>;
  onPick: () => Promise<void>;
  onRemove: (id: string) => void;
  onDismissWarning: () => void;
}
interface Draft {
  key: string;
  attachments: Attachment[];
  reserved: number;
  operations: number;
  discarding: number;
  sent: Attachment[] | null;
  warning: string | null;
  retired: boolean;
  generation: number;
  touched: boolean;
  transfer?: AttachmentTransfer;
}
declare const transferBrand: unique symbol;
export type AttachmentTransfer = Readonly<{ [transferBrand]: true }>;
interface TransferState {
  from: string;
  to: string;
  draft: Draft;
  generation: number;
  sent: Attachment[];
  attachments: Attachment[];
}
export type AttachmentDraftSnapshot = readonly {
  readonly key: string;
  readonly attachments: readonly Readonly<Attachment>[];
}[];
type StageResult = { staged: Attachment[]; errors: string[] };
const limitWarning = `Up to ${LIMITS.perTurn} attachments per message; extra files were left out.`;
const copyFiles = (files: readonly Readonly<Attachment>[]): Attachment[] => files.map(file => ({ ...file }));

/** A renderer restore is data only. Main still verifies ownership and file identity. */
function restoreEntries(input: unknown): { key: string; attachments: Attachment[] }[] | null {
  const object = (value: unknown, keys: string[]): value is Record<string, unknown> => {
    if (!value || typeof value !== "object" || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return false;
    return Reflect.ownKeys(value).length === keys.length && keys.every(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor?.enumerable && Object.hasOwn(descriptor, "value");
    });
  };
  const array = (value: unknown, max: number): value is unknown[] => Array.isArray(value) && value.length <= max
    && Reflect.ownKeys(value).length === value.length + 1
    && Array.from({ length: value.length }, (_, i) => Object.getOwnPropertyDescriptor(value, i))
      .every(descriptor => descriptor?.enumerable && Object.hasOwn(descriptor, "value"));
  const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max && !value.includes("\0");
  try {
    if (!array(input, 1000)) return null;
    const keys = new Set<string>(), ids = new Set<string>(), paths = new Set<string>();
    const entries: { key: string; attachments: Attachment[] }[] = [];
    for (const entry of input) {
      if (!object(entry, ["key", "attachments"]) || !text(entry.key, 512) || keys.has(entry.key) || !array(entry.attachments, LIMITS.perTurn)) return null;
      keys.add(entry.key);
      const attachments: Attachment[] = [];
      for (const file of entry.attachments) {
        if (!object(file, ["id", "name", "mime", "size", "kind", "rel"]) || !text(file.id, 128) || !text(file.name, 120)
          || typeof file.mime !== "string" || !file.mime || file.mime.length > 256
          || !text(file.rel, 512) || (file.kind !== "file" && file.kind !== "image")
          || typeof file.size !== "number" || !Number.isSafeInteger(file.size) || file.size < 0
          || file.size > (file.kind === "image" ? LIMITS.imageBytes : LIMITS.fileBytes)
          || ids.has(file.id) || paths.has(file.rel) || ids.size >= 2000) return null;
        ids.add(file.id); paths.add(file.rel);
        attachments.push({ id: file.id, name: file.name, mime: file.mime, size: file.size, kind: file.kind, rel: file.rel });
      }
      entries.push({ key: entry.key, attachments });
    }
    return entries;
  } catch { return null; }
}

/** App owns this for the entire session. Operations capture a draft, never the selected composer. */
export class ComposerAttachments {
  private drafts = new Map<string, Draft>();
  private pending = 0;
  private sent = new Set<Draft>();
  private touched = false;
  private frozen = false;
  private disposed = false;
  private transfers = new WeakMap<AttachmentTransfer, TransferState>();
  constructor(private changed: () => void, private discard: (files: Attachment[], key: string) => Promise<void>, private retireDraft?: (key: string) => Promise<void>) {}
  private notify() { if (!this.disposed) this.changed(); }
  private get writable() { return !this.frozen && !this.disposed; }
  private touch(d: Draft) { this.touched = true; d.touched = true; }
  private draft(key: string): Draft {
    let draft = this.drafts.get(key);
    if (!draft) { draft = { key, attachments: [], reserved: 0, operations: 0, discarding: 0, sent: null, warning: null, retired: false, generation: 0, touched: false }; this.drafts.set(key, draft); }
    return draft;
  }
  get(key: string) {
    if (!this.writable && !this.drafts.has(key)) return { attachments: [], copying: false, sending: false, warning: null };
    const d = this.draft(key);
    return { attachments: copyFiles(d.attachments), copying: d.operations > 0 || d.discarding > 0 || !!d.transfer, sending: d.sent !== null, warning: d.warning };
  }
  isBusy(): boolean { return this.pending > 0 || this.sent.size > 0; }
  snapshot(): AttachmentDraftSnapshot | null {
    if (this.disposed || this.isBusy()) return null;
    return this.editableSnapshot();
  }
  /** Ordinary autosaves may run while an original send or picker is pending.
   * Only the newer editable attachments belong in that independent snapshot. */
  editableSnapshot(): AttachmentDraftSnapshot {
    return Object.freeze([...this.drafts].filter(([, draft]) => !draft.retired).map(([key, draft]) => Object.freeze({
      key, attachments: Object.freeze(copyFiles(draft.attachments).map(file => Object.freeze(file))),
    })));
  }
  freezeForRecovery(): AttachmentDraftSnapshot | null {
    if (this.frozen) return null;
    const snapshot = this.snapshot();
    if (snapshot !== null) this.frozen = true;
    return snapshot;
  }
  /** Pending originals may belong to unrelated owners. Preserve reservations;
   * main checks their exact source/target before allowing owner deletion. */
  freezeForOwnerRemoval(): AttachmentDraftSnapshot | null {
    if (!this.writable || this.pending || [...this.drafts.values()].some(draft => draft.transfer)) return null;
    const snapshot = this.editableSnapshot(); this.frozen = true; return snapshot;
  }
  resumeAfterRecovery(): void { if (!this.disposed) this.frozen = false; }
  restore(input: unknown): boolean {
    if (!this.writable || this.touched || this.isBusy()) return false;
    const entries = restoreEntries(input);
    if (!entries || !this.writable || this.touched || this.isBusy()) return false;
    for (const { key, attachments } of entries) {
      const draft = this.draft(key);
      draft.attachments = attachments;
      this.touch(draft);
    }
    this.touched = true; // Even an empty successful startup restore is one-shot.
    this.notify();
    return true;
  }
  /** Restore a main-proven original as a reservation, never concatenate it with
   * newer editable attachments. Main still validates every file on transfer. */
  restorePending(key: string, input: readonly Attachment[]): boolean {
    if (!this.writable || this.pending) return false;
    const files = restoreEntries([{ key, attachments: input }])?.[0]?.attachments;
    if (!files) return false;
    const d = this.draft(key);
    if (d.operations || d.discarding || d.transfer) return false;
    if (d.sent) {
      if (!d.retired || JSON.stringify(d.sent) !== JSON.stringify(files)) return false;
      d.retired = false; this.touch(d); this.notify(); return true;
    }
    const originals = new Map(files.map(file => [file.id, file]));
    if (d.attachments.some(file => originals.has(file.id) && JSON.stringify(file) !== JSON.stringify(originals.get(file.id)))) return false;
    const newer = d.attachments.filter(file => !originals.has(file.id));
    if (newer.length + files.length > LIMITS.perTurn) return false;
    d.attachments = newer; d.sent = files; d.retired = false;
    this.sent.add(d); this.touch(d); this.notify(); return true;
  }
  /** Disposal never deletes owned evidence or publishes a late asynchronous result. */
  dispose(): void { this.disposed = true; }
  private warn(d: Draft, message: string) { d.warning = [d.warning, message].filter(Boolean).join(" "); }
  private async discardFiles(d: Draft, files: Attachment[]) {
    if (this.disposed || !files.length) return;
    this.pending++;
    d.discarding++;
    try { await this.discard(copyFiles(files), d.key); }
    catch { if (!this.disposed && !d.retired) this.warn(d, "Could not remove a staged attachment. Please try again."); }
    finally { this.pending--; d.discarding--; this.notify(); }
  }
  dismissWarning(key: string) {
    if (!this.writable) return;
    const d = this.draft(key); if (d.transfer) return;
    this.touch(d); d.warning = null; this.notify();
  }
  async stage(key: string, count: number, run: (room: number) => Promise<StageResult>) {
    if (!this.writable || !Number.isSafeInteger(count) || count <= 0) return;
    const d = this.draft(key);
    if (d.retired || d.transfer) return;
    this.touch(d);
    const room = Math.min(count, LIMITS.perTurn - d.attachments.length - d.reserved - (d.sent?.length ?? 0));
    if (room <= 0) { this.warn(d, limitWarning); this.notify(); return; }
    // Reserve before even file.arrayBuffer() or the native dialog gets a chance to yield.
    const generation = d.generation;
    d.reserved += room;
    d.operations++;
    this.pending++;
    try {
      this.notify();
      if (this.disposed || d.retired || generation !== d.generation) return;
      const { staged, errors } = await run(room);
      if (this.disposed) return;
      if (d.retired || generation !== d.generation) { await this.discardFiles(d, staged); return; }
      // Main enforces its own limits too; never retain unexpected overflow from a transport.
      d.attachments = [...d.attachments, ...copyFiles(staged.slice(0, room))];
      if (errors.length) this.warn(d, errors.join(" "));
      if (staged.length > room) { this.warn(d, limitWarning); await this.discardFiles(d, staged.slice(room)); }
    } catch (error) {
      if (!this.disposed && !d.retired && generation === d.generation) this.warn(d, `Could not attach files: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      d.reserved -= room;
      d.operations--;
      this.pending--;
      this.notify();
    }
  }
  remove(key: string, id: string) {
    if (!this.writable) return;
    const d = this.draft(key);
    if (d.transfer) return;
    this.touch(d);
    const removed = d.attachments.filter(f => f.id === id);
    d.attachments = d.attachments.filter(f => f.id !== id);
    void this.discardFiles(d, removed);
    this.notify();
  }
  /** Keep the sent batch charged against capacity until main accepts or rejects the send. */
  beginSend(key: string): Attachment[] | null {
    if (!this.writable) return null;
    const d = this.draft(key);
    if (d.retired || d.operations || d.discarding || d.transfer || d.sent !== null) return null;
    this.touch(d);
    d.sent = d.attachments;
    d.attachments = [];
    this.sent.add(d);
    this.notify();
    return copyFiles(d.sent);
  }
  finishSend(key: string, ok: boolean) {
    if (!this.writable) return;
    const d = this.draft(key);
    if (d.transfer) return;
    if (d.sent === null) return;
    if (!ok) {
      if (d.retired) void this.discardFiles(d, d.sent);
      else d.attachments = [...d.sent, ...d.attachments];
    }
    d.sent = null;
    this.sent.delete(d);
    this.notify();
  }
  /** A newly created thread inherits the draft's reservation, warning and intervening edits. */
  move(from: string, to: string) {
    if (!this.writable || from === to) return;
    const target = this.drafts.get(to);
    if (target?.transfer || this.drafts.get(from)?.transfer) throw new Error("Attachment transfer is still pending.");
    if (target?.touched) throw new Error("Cannot overwrite an existing attachment draft target.");
    const d = this.draft(from);
    this.touch(d);
    this.drafts.delete(from);
    this.drafts.set(to, d);
    d.key = to;
    d.retired = false;
    this.notify();
  }
  /** Short seal after asynchronous creation/picking settles. Text remains owned
   * by App; this token holds only attachment mutations for the source draft. */
  beginTransfer(from: string, to: string): { token: AttachmentTransfer; snapshot: AttachmentDraftSnapshot } | null {
    if (!this.writable || this.pending || !/^[A-Za-z0-9_-]{1,128}$/.test(to)) return null;
    if (from !== to && !/^draft:\d+:[A-Za-z0-9_-]+$/.test(from)) return null;
    const d = this.drafts.get(from);
    if (!d || d.retired || d.transfer || d.operations || d.discarding || d.sent === null
      || (from !== to && this.drafts.get(to)?.touched)) return null;
    const token = Object.freeze({}) as AttachmentTransfer;
    this.transfers.set(token, { from, to, draft: d, generation: d.generation, sent: copyFiles(d.sent), attachments: copyFiles(d.attachments) });
    d.transfer = token;
    // Preserve every reserved send, including independent threads. Ordinary
    // restart snapshots still refuse busy work; this is transaction input only.
    const snapshot = Object.freeze([...this.drafts].filter(([, draft]) => !draft.retired).map(([key, draft]) => Object.freeze({
      key, attachments: Object.freeze(copyFiles([...(draft.sent ?? []), ...draft.attachments]).map(file => Object.freeze(file))),
    })));
    this.notify();
    return Object.freeze({ token, snapshot });
  }
  private liveTransfer(token: AttachmentTransfer): TransferState | undefined {
    const state = this.transfers.get(token);
    if (!this.writable || !state || state.draft.retired || state.draft.generation !== state.generation
      || state.draft.transfer !== token || this.drafts.get(state.from) !== state.draft
      || JSON.stringify(state.draft.sent) !== JSON.stringify(state.sent)
      || JSON.stringify(state.draft.attachments) !== JSON.stringify(state.attachments)) return undefined;
    return state;
  }
  /** Only a proven pre-mutation refusal from main may release this seal. An
   * uncertain result, navigation or failed adoption preserves its evidence. */
  refuseTransfer(token: AttachmentTransfer): boolean {
    const state = this.liveTransfer(token);
    if (!state) return false;
    state.draft.transfer = undefined; this.transfers.delete(token); this.notify();
    return true;
  }
  /** Adopt the complete authoritative batch before moving any key. A failed
   * validation leaves both drafts unchanged and the source sealed. */
  adoptTransfer(token: AttachmentTransfer, input: unknown): boolean {
    const state = this.liveTransfer(token);
    if (!state || (state.from !== state.to && this.drafts.get(state.to)?.touched)) return false;
    const entries = restoreEntries([{ key: state.to, attachments: input }]);
    const files = entries?.[0]?.attachments;
    const original = [...state.sent, ...state.attachments];
    if (!files || files.length !== original.length || new Set(original.map(file => file.id)).size !== original.length) return false;
    const returned = new Map(files.map(file => [file.id, file]));
    for (const old of original) {
      const file = returned.get(old.id);
      const rel = old.rel.startsWith("staging/") ? `${state.to}/${old.rel.slice("staging/".length)}` : old.rel;
      if (!file || !rel.startsWith(`${state.to}/`) || file.rel !== rel
        || file.name !== old.name || file.mime !== old.mime || file.kind !== old.kind || file.size !== old.size) return false;
    }
    if (this.liveTransfer(token) !== state || (state.from !== state.to && this.drafts.get(state.to)?.touched)) return false;
    // No callbacks or mutation occurred during validation. Preserve reservation
    // membership/order while replacing both sent and newly typed attachments.
    const d = state.draft;
    d.sent = state.sent.map(file => ({ ...returned.get(file.id)! }));
    d.attachments = state.attachments.map(file => ({ ...returned.get(file.id)! }));
    if (state.from !== state.to) { this.drafts.delete(state.from); this.drafts.set(state.to, d); d.key = state.to; }
    d.transfer = undefined; this.transfers.delete(token); this.touch(d); this.notify();
    return true;
  }
  retire(key: string) {
    if (!this.writable) return;
    const d = this.draft(key);
    if (d.retired) return;
    this.touch(d);
    d.retired = true;
    d.generation++;
    if (this.retireDraft) {
      this.pending++;
      void this.retireDraft(key).catch(() => { /* Main preserves the revoked draft's evidence. */ }).finally(() => { this.pending--; this.notify(); });
    }
    if (d.transfer) { this.notify(); return; }
    const removed = d.attachments;
    d.attachments = [];
    d.warning = null;
    void this.discardFiles(d, removed);
    this.notify();
  }
}
