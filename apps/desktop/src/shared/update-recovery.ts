import type { BackendId, Mode } from "./types.js";
import type { Attachment } from "./attachments.js";

/** Local unsent text and references to files owned by main; never sanitized for display. */
export interface ComposerRecovery {
  threads: { threadId: string; text: string; attachments: Attachment[] }[];
  selectedThreadId: string | null;
  projects: { key: string; projectId: string; text: string; attachments: Attachment[] }[];
  /** App has one shared new-chat configuration, with text/files keyed per project. */
  draft: {
    revision: number;
    projectId: string;
    worktree: boolean;
    settings: { backend: BackendId; mode: Mode; plan: boolean; auto: boolean; model: string; effort?: string };
  } | null;
}

export interface DraftSaveReceipt { revision: number; saved: boolean }

export interface UpdateStartupRecovery {
  outcome: "uncertain" | "staged" | "unreadable" | "recovery";
  targetVersion?: string;
  message: string;
}

export interface UpdateAttempt {
  id: string;
  from: string;
  to: string;
  sha512: string;
  startedAt: string;
  outcome: "uncertain" | "staged" | "installed";
}

export interface UpdateRecoveryRecord {
  schema: 2;
  revision: number;
  drafts: ComposerRecovery | null;
  attempt: UpdateAttempt | null;
}
