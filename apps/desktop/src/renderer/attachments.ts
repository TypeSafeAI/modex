import type { Attachment, StagedFile } from "../shared/attachments";
import { LIMITS } from "../shared/attachments";
import { bridge } from "./bridge";

/** True for a drag that carries files (not text or a link). */
export function hasFiles(dt: DataTransfer | null | undefined): boolean {
  return Boolean(dt && Array.from(dt.types).includes("Files"));
}

/**
 * Hands files to main to stage: by OS path when there is one (drop, picker), by bytes otherwise
 * (paste). `room` is how many more the message can take.
 */
export async function stageFiles(files: Iterable<File>, room = LIMITS.perTurn): Promise<{ staged: Attachment[]; errors: string[] }> {
  const all = Array.from(files);
  const take = all.slice(0, Math.max(0, room));
  const errors = all.length > take.length ? [`Up to ${LIMITS.perTurn} attachments per message; ${all.length - take.length} left out.`] : [];
  const list: StagedFile[] = [];
  for (const f of take) {
    const base = { name: f.name || "pasted", mime: f.type, size: f.size };
    let path = "";
    try { path = bridge.pathForFile?.(f) ?? ""; } catch { path = ""; }
    if (path) list.push({ ...base, path });
    else if (f.size > LIMITS.fileBytes) errors.push(`${base.name} is too large to attach.`);
    else list.push({ ...base, data: await toBase64(f) });
  }
  if (!list.length) return { staged: [], errors };
  const r = await bridge.invoke("attachments:stage", { files: list });
  return { staged: r.staged, errors: [...errors, ...r.errors] };
}

async function toBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
