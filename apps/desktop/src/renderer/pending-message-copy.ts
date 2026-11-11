import type { PendingSendView } from "../shared/native-drafts.js";
import type { BridgeCommands, Thread } from "../shared/types.js";

/** Explicit text-only recovery. The old intent and its file reservations stay
 * with main; this creates an empty chat, never a turn or an implicit retry. */
export async function copyPendingTextToNewThread(
  original: Pick<PendingSendView, "rawText">,
  destination: Pick<BridgeCommands["thread:create"]["req"], "projectId" | "backend" | "model" | "mode">,
  create: (request: BridgeCommands["thread:create"]["req"]) => Promise<Thread>,
): Promise<{ thread: Thread; text: string }> {
  const text = original.rawText;
  const thread = await create({ ...destination, auto: false, worktree: false });
  return { thread, text };
}
