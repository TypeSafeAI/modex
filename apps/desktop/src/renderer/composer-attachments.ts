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
  attachments: Attachment[];
  reserved: number;
  operations: number;
  sent: Attachment[] | null;
  warning: string | null;
  retired: boolean;
  generation: number;
}
type StageResult = { staged: Attachment[]; errors: string[] };
const limitWarning = `Up to ${LIMITS.perTurn} attachments per message; extra files were left out.`;

/** App owns this for the entire session. Operations capture a draft, never the selected composer. */
export class ComposerAttachments {
  private drafts = new Map<string, Draft>();
  constructor(private changed: () => void, private discard: (files: Attachment[]) => Promise<void>) {}
  private draft(key: string): Draft {
    let draft = this.drafts.get(key);
    if (!draft) { draft = { attachments: [], reserved: 0, operations: 0, sent: null, warning: null, retired: false, generation: 0 }; this.drafts.set(key, draft); }
    return draft;
  }
  get(key: string) {
    const d = this.draft(key);
    return { attachments: d.attachments, copying: d.operations > 0, sending: d.sent !== null, warning: d.warning };
  }
  private warn(d: Draft, message: string) { d.warning = [d.warning, message].filter(Boolean).join(" "); }
  private async discardFiles(d: Draft, files: Attachment[]) {
    if (!files.length) return;
    try { await this.discard(files); }
    catch { if (!d.retired) this.warn(d, "Could not remove a staged attachment. Please try again."); }
  }
  dismissWarning(key: string) { this.draft(key).warning = null; this.changed(); }
  async stage(key: string, count: number, run: (room: number) => Promise<StageResult>) {
    const d = this.draft(key);
    if (d.retired || count <= 0) return;
    const room = Math.min(count, LIMITS.perTurn - d.attachments.length - d.reserved - (d.sent?.length ?? 0));
    if (room <= 0) { this.warn(d, limitWarning); this.changed(); return; }
    // Reserve before even file.arrayBuffer() or the native dialog gets a chance to yield.
    const generation = d.generation;
    d.reserved += room;
    d.operations++;
    this.changed();
    try {
      const { staged, errors } = await run(room);
      if (d.retired || generation !== d.generation) { await this.discardFiles(d, staged); return; }
      // Main enforces its own limits too; never retain unexpected overflow from a transport.
      d.attachments = [...d.attachments, ...staged.slice(0, room)];
      if (errors.length) this.warn(d, errors.join(" "));
      if (staged.length > room) { this.warn(d, limitWarning); await this.discardFiles(d, staged.slice(room)); }
    } catch (error) {
      if (!d.retired && generation === d.generation) this.warn(d, `Could not attach files: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      d.reserved -= room;
      d.operations--;
      this.changed();
    }
  }
  remove(key: string, id: string) {
    const d = this.draft(key);
    const removed = d.attachments.filter(f => f.id === id);
    d.attachments = d.attachments.filter(f => f.id !== id);
    this.changed();
    void this.discardFiles(d, removed).then(this.changed);
  }
  /** Keep the sent batch charged against capacity until main accepts or rejects the send. */
  beginSend(key: string): Attachment[] | null {
    const d = this.draft(key);
    if (d.retired || d.operations || d.sent !== null) return null;
    d.sent = d.attachments;
    d.attachments = [];
    this.changed();
    return d.sent;
  }
  finishSend(key: string, ok: boolean) {
    const d = this.draft(key);
    if (d.sent === null) return;
    if (!ok) {
      if (d.retired) void this.discardFiles(d, d.sent);
      else d.attachments = [...d.sent, ...d.attachments];
    }
    d.sent = null;
    this.changed();
  }
  /** A newly created thread inherits the draft's reservation, warning and intervening edits. */
  move(from: string, to: string) {
    const d = this.draft(from);
    this.drafts.delete(from);
    this.drafts.set(to, d);
    d.retired = false;
    this.changed();
  }
  retire(key: string) {
    const d = this.draft(key);
    if (d.retired) return;
    d.retired = true;
    d.generation++;
    const removed = d.attachments;
    d.attachments = [];
    d.warning = null;
    void this.discardFiles(d, removed);
    this.changed();
  }
}
