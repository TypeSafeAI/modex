import path from "node:path";
import { execFileSync } from "node:child_process";
import { verifyManifest } from "../../../../scripts/lib/cf8-retention.mjs";

const manifestFile = process.env.MODEX_RETENTION_MANIFEST;
const output = process.env.MODEX_RETENTION_OUTPUT;
const expectedManifest = process.env.MODEX_RETENTION_MANIFEST_SHA256;
if (!manifestFile || !output || !path.isAbsolute(output) || !expectedManifest || !/^[0-9a-f]{64}$/.test(expectedManifest)) throw new Error("Run the explicit retention CLI with new private output; no workload is enabled by default.");
export const manifest = verifyManifest(manifestFile, expectedManifest);
export const root = output;
export const sourceHead: string = manifest.source.sha;
export const driverHead: string = manifest.driver.head;
export const driverRoot: string = manifest.dependencies.root;
export const legacy = manifest.role === "baseline";

export function verifySource() {
  const checked = verifyManifest(manifestFile!, expectedManifest!);
  const actualHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: driverRoot, encoding: "utf8" }).trim();
  if (actualHead !== driverHead) throw new Error("Diagnostic driver checkout changed; retained source/build inputs do not authorize a new driver.");
  return { role: checked.role, source: checked.source.sha, tree: checked.source.tree, sourceFilesVerified: checked.source.files.length, builtFilesVerified: checked.build.files.length, commonCoreFilesVerified: checked.dependencies.coreFiles.length, kind: checked.kind, driverHeadMeaning: "Separate diagnostic checkout identity; measured source is an explicitly verified export, not this HEAD" };
}
