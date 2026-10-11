import type { ModexBridge } from "../shared/types.js";
import type { Attachment, StagedFile } from "../shared/attachments.js";
import { LIMITS, kindFor, mimeFor, rejectReason } from "../shared/attachments.js";

// File objects can wait in the queue, but only one file's bytes/base64 are materialized at a time,
// even when drops or pastes overlap across composers. App keeps the original batch reservation.
let uploading: Promise<unknown> = Promise.resolve();
export async function stageFileBatch(files: Iterable<File>, room: number, bridge: Pick<ModexBridge, "invoke" | "pathForFile">): Promise<{ staged: Attachment[]; errors: string[] }> {
  const all = Array.from(files);
  const take = all.slice(0, Math.max(0, Math.min(room, LIMITS.perTurn)));
  const errors = all.length > take.length ? [`Up to ${LIMITS.perTurn} attachments per message; ${all.length - take.length} left out.`] : [];
  const staged: Attachment[] = [];
  for (const file of take) {
    const work = uploading.then(async () => {
      const base = { name: file.name || "pasted", mime: file.type, size: file.size };
      const reason = rejectReason(base.name, base.size, kindFor(mimeFor(base.name, base.mime)));
      if (reason) throw new Error(reason);
      let path = "";
      try { path = bridge.pathForFile?.(file) ?? ""; } catch { /* synthetic/pasted file */ }
      const source: StagedFile = path ? { ...base, path } : { ...base, data: await toBase64(file) };
      const result = await bridge.invoke("attachments:stage", { files: [source] });
      staged.push(...result.staged);
      errors.push(...result.errors);
    });
    uploading = work.catch(() => {});
    try { await work; }
    catch (error) { errors.push(`${file.name || "pasted"}: ${error instanceof Error ? error.message : "Could not attach file."}`); }
  }
  return { staged, errors };
}

async function toBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
