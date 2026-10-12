import fs from "node:fs";
import path from "node:path";
import { requireAbsent } from "./native-update-acceptance.mjs";

/** The private source fixture never replaces the release candidate's output or
 * version. Preserve failed build artifacts for diagnosis rather than deleting them. */
export async function withSourceFixture({ packageFile, releaseDirectory, work, build }, accept) {
  const original = fs.readFileSync(packageFile);
  const source = path.join(work, "source");
  const candidate = path.join(work, "candidate");
  const failed = path.join(work, "failed-source");
  requireAbsent([source, candidate, failed]);
  fs.renameSync(releaseDirectory, candidate);
  try {
    const metadata = JSON.parse(original.toString("utf8"));
    fs.writeFileSync(packageFile, JSON.stringify({ ...metadata, version: "0.0.0" }, null, 2) + "\n");
    await build();
    fs.renameSync(releaseDirectory, source);
  } finally {
    try { fs.writeFileSync(packageFile, original); }
    finally {
      if (fs.existsSync(releaseDirectory)) fs.renameSync(releaseDirectory, failed);
      fs.renameSync(candidate, releaseDirectory);
    }
  }
  return accept(source);
}
