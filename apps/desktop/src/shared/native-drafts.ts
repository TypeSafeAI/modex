import type { Attachment, AttachmentDraftOwner, StagedFile } from "./attachments.js";
import type { ComposerRecovery, DraftSaveReceipt, UpdateStartupRecovery } from "./update-recovery.js";
import type { Thread } from "./types.js";
export interface PendingTarget { threadId: string; projectId: string; createdAt: string }
export interface PendingCreation { threadId: string; createdAt: string }
export type DraftRemovalScope = { kind: "thread" | "project"; id: string };
export interface PendingSendRecord {
  schema: 1;
  id: string;
  createdAt: string;
  source: AttachmentDraftOwner;
  owner: AttachmentDraftOwner;
  rawText: string;
  configuration: Pick<NonNullable<ComposerRecovery["draft"]>, "worktree" | "settings">;
  files: Attachment[];
  /** Main generates and persists this correlation before any async creation.
   * It is a plan, never proof that the target exists or transfer is authorized. */
  creation: PendingCreation | null;
  target: PendingTarget | null;
}
export interface PendingSendInput { source: AttachmentDraftOwner; rawText: string; configuration: Pick<NonNullable<ComposerRecovery["draft"]>, "worktree" | "settings">; files: Attachment[] }

export interface NativeTransferRequest { id: string; sequence: number; snapshot: ComposerRecovery; intentId: string; files: Attachment[] }
export type NativeTransferReply = { status: "committed"; revision: number; files: Attachment[] } | { status: "unchanged" | "stale"; revision: number };
export interface NativeDraftEditableOpen { readOnly?: false; drafts: ComposerRecovery | null; pendingIds: string[]; recovery?: null }
export interface NativeDraftReadOnlyOpen { readOnly: true; drafts: ComposerRecovery | null; pendingIds: []; pending: PendingSendView[]; recovery: UpdateStartupRecovery }
export type NativeDraftOpen = NativeDraftEditableOpen | NativeDraftReadOnlyOpen;
/** Renderer recovery data excludes the main-only planned creation identity. */
export type PendingSendView = Omit<PendingSendRecord, "creation">;
export interface NativeDraftBridge {
  open(): Promise<NativeDraftOpen | null>;
  save(snapshot: ComposerRecovery): Promise<DraftSaveReceipt>;
  saveBeforeClose(snapshot: ComposerRecovery): number | null;
  stage(owner: AttachmentDraftOwner, files: StagedFile[]): Promise<{ staged: Attachment[]; errors: string[] }>;
  pick(owner: AttachmentDraftOwner, remaining: number): Promise<{ staged: Attachment[]; errors: string[] }>;
  discard(owner: AttachmentDraftOwner, ids: string[]): Promise<void>;
  retire(owner: AttachmentDraftOwner): Promise<void>;
  begin(input: PendingSendInput): Promise<{ id: string }>;
  create(intentId: string): Promise<Thread>;
  transfer(input: Omit<NativeTransferRequest, "sequence">): Promise<NativeTransferReply>;
  send(intentId: string): Promise<{ ok: boolean; error?: string }>;
  readPending(intentId: string): Promise<PendingSendView | null>;
}
export interface NativeDraftCommands {
  "drafts:open": { req: undefined; res: (NativeDraftEditableOpen & { session: string }) | NativeDraftReadOnlyOpen | null };
  "drafts:save": { req: { session: string; sequence: number; snapshot: ComposerRecovery }; res: DraftSaveReceipt };
  "drafts:stage": { req: { session: string; owner: AttachmentDraftOwner; files: StagedFile[] }; res: { staged: Attachment[]; errors: string[] } };
  "drafts:pick": { req: { session: string; owner: AttachmentDraftOwner; remaining: number }; res: { staged: Attachment[]; errors: string[] } };
  "drafts:discard": { req: { session: string; owner: AttachmentDraftOwner; ids: string[] }; res: void };
  "drafts:retire": { req: { session: string; owner: AttachmentDraftOwner }; res: void };
  "drafts:begin": { req: { session: string; input: PendingSendInput }; res: { id: string } };
  "drafts:create": { req: { session: string; intentId: string }; res: Thread };
  "drafts:transfer": { req: NativeTransferRequest & { session: string }; res: NativeTransferReply };
  "drafts:send": { req: { session: string; intentId: string }; res: { ok: boolean; error?: string } };
  "drafts:pending": { req: { session: string; intentId: string }; res: PendingSendView | null };
}
