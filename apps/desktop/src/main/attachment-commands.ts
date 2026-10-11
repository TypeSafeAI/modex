import type { RegisterCommand } from "./commands.js";
import type { AttachmentStore } from "./engine/attachments.js";

/** Common attachment semantics; only the native picker may accept trusted OS source paths. */
export function registerAttachmentCommands(handle: RegisterCommand, attachments: AttachmentStore, {
  bytesOnly, reveal,
}: { bytesOnly: boolean; reveal: (path: string) => Promise<void> | void }): void {
  handle("attachments:stage", (req) => attachments.stage(req?.files, { bytesOnly }));
  handle("attachments:discard", (req) => {
    try { attachments.discard(req?.ids); }
    catch { throw new Error("Could not remove that attachment. Please try again."); }
  });
  handle("attachments:open", async (req) => {
    const abs = attachments.resolve(req?.rel);
    if (!abs) throw new Error("That attachment is no longer on disk.");
    try { await reveal(abs); }
    catch { throw new Error("Could not reveal that attachment in the file manager."); }
  });
}
