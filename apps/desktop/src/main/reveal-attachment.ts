import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

/** File managers receive only a store-resolved path. Linux opens the parent directory. */
export function attachmentRevealCommand(file: string, platform: NodeJS.Platform = process.platform): [string, string[]] {
  if (platform === "darwin") return ["open", ["-R", file]];
  if (platform === "win32") return ["explorer.exe", [`/select,${file}`]];
  return ["xdg-open", [path.dirname(file)]];
}
export async function revealAttachment(file: string): Promise<void> {
  const [command, args] = attachmentRevealCommand(file);
  await promisify(execFile)(command, args);
}
