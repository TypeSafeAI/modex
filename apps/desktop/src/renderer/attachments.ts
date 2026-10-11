import { LIMITS } from "../shared/attachments";
import { bridge } from "./bridge";
import { stageFileBatch } from "./stage-files";

/** True for a drag that carries files (not text or a link). */
export function hasFiles(dt: DataTransfer | null | undefined): boolean {
  return Boolean(dt && Array.from(dt.types).includes("Files"));
}

export const stageFiles = (files: Iterable<File>, room = LIMITS.perTurn) => stageFileBatch(files, room, bridge);

/** Only browser development supplies a file input; desktop and Store retain their native command. */
export async function pickFiles(remaining: number) {
  return bridge.pickFiles ? stageFiles(await bridge.pickFiles(), remaining) : bridge.invoke("attachments:pick", { remaining });
}
