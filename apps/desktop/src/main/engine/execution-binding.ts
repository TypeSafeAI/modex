import type { Thread } from "../../shared/types.js";
import type { PendingExecutionBinding } from "../../shared/native-drafts.js";
import { threadTarget } from "../../shared/local-models.js";

/** Canonical main-owned destination snapshot; no credentials or resume handles. */
export function executionBinding(thread: Pick<Thread, "backend" | "model" | "localTarget" | "localContextTokens" | "codexAccount" | "sessionHandle">, defaultAccount: string | null): PendingExecutionBinding {
  const local = thread.localTarget !== undefined ? threadTarget(thread) : null;
  return { schema: 1, backend: thread.backend, model: thread.model,
    account: local || thread.backend !== "codex" ? null : thread.codexAccount ?? (thread.sessionHandle ? "cli" : defaultAccount),
    localTarget: local?.kind === "local" ? local.target : null, localContextTokens: local ? thread.localContextTokens ?? null : null };
}
