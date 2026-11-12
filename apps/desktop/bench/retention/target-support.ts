// Only the target-module import is rebound in the generated driver copy.
import fs from "node:fs";
import path from "node:path";
import { appDir, launch, seedHome as seedTargetHome, tid, items } from "../../e2e/support";
export { appDir, launch, tid, items };

/** Keep fixture inputs private without changing the app/runtime temporary directory. */
export function seedHome(settings: Record<string, unknown> = {}) {
  const root = process.env.MODEX_RETENTION_FIXTURE_ROOT;
  if (!root || !path.isAbsolute(root) || !fs.lstatSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink()) throw new Error("A private retained fixture root is required.");
  const previous = process.env.TMPDIR;
  try { process.env.TMPDIR = root; return seedTargetHome(settings); }
  finally { if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous; }
}
