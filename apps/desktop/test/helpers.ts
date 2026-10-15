import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { MockStep } from "@modex/core";

/** A 1×1 PNG, base64: the smallest real image for attachment tests. */
export const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/** Folders this test process created; removed when it exits (node --test runs each file in its own process). */
const created = new Set<string>();
process.on("exit", () => {
  // Leaked test homes and repos filled the disk (about 170,000 folders, 24 GB, by 2026-10-15).
  if (process.env.MODEX_KEEP_TEST_TMP === "1") return;
  for (const dir of created) {
    try { fs.chmodSync(dir, 0o700); fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Best effort: a read-only fixture can stay. */ }
  }
});

/** A fresh temporary folder, removed when the test process exits. Set MODEX_KEEP_TEST_TMP=1 to keep it for debugging. */
export function tmpdir(prefix = "modex-desktop-"): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  created.add(dir);
  return dir;
}

/** A tiny git repo with one commit so worktrees and HEAD diffs work. */
export function gitRepo(): string {
  const dir = tmpdir("modex-repo-");
  const g = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  g("init", "-q", "-b", "main");
  fs.writeFileSync(path.join(dir, "README.md"), "# demo\n\nline\n");
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "demo" }, null, 2) + "\n");
  g("add", ".");
  g("-c", "commit.gpgsign=false", "commit", "-q", "-m", "init");
  return dir;
}

/** Writes a mock script to a temp file and returns its path. */
export function writeScript(steps: MockStep[]): string {
  const file = path.join(tmpdir("modex-script-"), "script.json");
  fs.writeFileSync(file, JSON.stringify({ steps }));
  return file;
}
