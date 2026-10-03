import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ChangedFile, ChangesSnapshot } from "../../shared/types.js";

export function git(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }, (err, stdout, stderr) => {
      const code = err && typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === "number" ? ((err as { code: number }).code) : err ? 1 : 0;
      resolve({ stdout: String(stdout), stderr: String(stderr), code });
    });
  });
}

export async function isRepo(cwd: string): Promise<boolean> {
  if (!fs.existsSync(cwd)) return false;
  const r = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  return r.code === 0 && r.stdout.trim() === "true";
}

export async function currentBranch(cwd: string): Promise<string | null> {
  const r = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return r.code === 0 ? r.stdout.trim() : null;
}

async function hasCommits(cwd: string): Promise<boolean> {
  return (await git(cwd, ["rev-parse", "--verify", "HEAD"])).code === 0;
}

/** Working-tree status relative to HEAD (staged + unstaged + untracked), with line counts. */
export async function status(cwd: string): Promise<ChangesSnapshot> {
  if (!(await isRepo(cwd))) return { cwd, isRepo: false, branch: null, files: [] };
  const [branch, entries, committed] = await Promise.all([currentBranch(cwd), statusEntries(cwd), hasCommits(cwd)]);
  const files: ChangedFile[] = entries.map(({ path, code, original }) => ({
    path,
    code,
    ...(code.includes("R") && original ? { original } : {}),
    additions: 0,
    deletions: 0,
  }));
  const byPath = new Map(files.map((file) => [file.path, file]));
  const numstat = await git(cwd, ["diff", "--numstat", "-z", ...(committed ? ["HEAD"] : ["--cached"]), "--"]);
  const counts = numstat.stdout.split("\0");
  for (let i = 0; i < counts.length; i++) {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(counts[i]!);
    if (!match) continue;
    // Renames are counts + empty path, followed by old and new NUL-delimited paths.
    const name = match[3] || counts[i += 2];
    const file = name === undefined ? undefined : byPath.get(name);
    if (file) {
      file.additions = match[1] === "-" ? 0 : Number(match[1]);
      file.deletions = match[2] === "-" ? 0 : Number(match[2]);
    }
  }
  for (const f of files) {
    if (f.code === "??") {
      const abs = path.join(cwd, f.path);
      try {
        f.additions = countLines(fs.readFileSync(abs, "utf8"));
      } catch {
        /* binary or unreadable */
      }
    }
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { cwd, isRepo: true, branch, files };
}

/** Keep the rename source: a path-filtered status turns a rename into an apparent addition. */
async function statusEntries(cwd: string): Promise<{ path: string; code: string; original?: string }[]> {
  const result = await git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (result.code !== 0) throw new Error(result.stderr.trim() || "git status failed");
  const fields = result.stdout.split("\0");
  const entries: { path: string; code: string; original?: string }[] = [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]!;
    if (field.length < 4) continue;
    const code = field.slice(0, 2);
    const original = /[RC]/.test(code) ? fields[++i] : undefined;
    entries.push({ path: field.slice(3), code, original });
  }
  return entries;
}

function countLines(s: string): number {
  if (!s) return 0;
  return s.split("\n").length - (s.endsWith("\n") ? 1 : 0);
}

export function workspaceRel(cwd: string, targetPath: string): { abs: string; relative: string } {
  const abs = path.resolve(cwd, targetPath);
  if (!abs.startsWith(path.resolve(cwd) + path.sep) && abs !== path.resolve(cwd)) {
    throw new Error(`refusing to access outside the workspace: ${targetPath}`);
  }
  const relative = path.relative(cwd, abs).split(path.sep).join("/");
  return { abs, relative };
}

export async function repoContext(cwd: string): Promise<{ root: string; prefix: string }> {
  const [rootRes, prefixRes] = await Promise.all([
    git(cwd, ["rev-parse", "--show-toplevel"]),
    git(cwd, ["rev-parse", "--show-prefix"]),
  ]);
  const root = rootRes.code === 0 && rootRes.stdout.trim() ? rootRes.stdout.trim() : cwd;
  const prefix = prefixRes.code === 0 ? prefixRes.stdout.trim() : "";
  return { root, prefix };
}

function toRepoRel(prefix: string, p: string): string {
  if (prefix && p.startsWith(prefix)) return p;
  return prefix ? path.posix.join(prefix, p) : p;
}

function diffOutput(result: { stdout: string; stderr: string; code: number }, noIndex = false): string {
  // --no-index uses exit 1 for an ordinary difference; other nonzero exits are errors.
  if (result.code !== 0 && !(noIndex && result.code === 1 && result.stdout.length > 0)) {
    throw new Error(result.stderr.trim() || "git diff failed");
  }
  return result.stdout;
}

/** Unified diff for one path; untracked files are rendered as pure additions. */
export async function diff(cwd: string, rel: string, original?: string): Promise<string> {
  const { root, prefix } = await repoContext(cwd);
  const repoRel = toRepoRel(prefix, rel);
  let orig = original ? toRepoRel(prefix, original) : undefined;
  let code: string | undefined;

  if (orig === undefined) {
    const entry = (await statusEntries(root)).find((file) => file.path === repoRel);
    if (entry?.code.includes("R")) orig = entry.original;
    code = entry?.code;
  }

  if (code === "??") {
    return diffOutput(await git(root, ["--literal-pathspecs", "diff", "--no-index", "--", "/dev/null", repoRel]), true);
  }

  const committed = await hasCommits(root);
  const target = committed ? "HEAD" : "--cached";

  if (orig) {
    const renamed = diffOutput(await git(root, ["--literal-pathspecs", "diff", "-M", target, "--", orig, repoRel]));
    const headers = renamed.match(/^diff --git /gm) || [];
    if (headers.length === 1) {
      return renamed;
    }
    // If rewrite similarity dropped below git's rename threshold, compare the original
    // HEAD blob directly against the destination file. -- also protects a leading-dash name.
    if (committed) {
      const fallback = diffOutput(await git(root, ["--literal-pathspecs", "diff", `HEAD:${orig}`, "--", repoRel]));
      if (fallback) return fallback;
    }
  }

  return diffOutput(await git(root, ["--literal-pathspecs", "diff", target, "--", repoRel]));
}

/** Discards changes to one path (tracked → checkout from HEAD; untracked → delete). Destructive. */
export async function revert(cwd: string, rel: string): Promise<void> {
  const { abs, relative } = workspaceRel(cwd, rel);
  const entry = (await statusEntries(cwd)).find((file) => file.path === relative);
  if (!entry) return;
  const code = entry.code;
  if (code.includes("R") && entry.original) {
    // A new file at the source is independent work, not part of the selected rename.
    const original = fs.lstatSync(path.join(cwd, entry.original), { throwIfNoEntry: false });
    const destination = fs.lstatSync(abs, { throwIfNoEntry: false });
    const sameEntry = entry.original.toLowerCase() === relative.toLowerCase() && original && destination && original.dev === destination.dev && original.ino === destination.ino;
    if (original && !sameEntry) throw new Error(`Cannot discard rename: original path ${entry.original} already exists.`);
    // On case-insensitive volumes, remove the destination before restoring the source;
    // restoring both in one invocation can unlink the just-restored file.
    const groups = sameEntry ? [[relative], [entry.original]] : [[entry.original, relative]];
    for (const paths of groups) {
      const restored = await git(cwd, ["--literal-pathspecs", "restore", "--source=HEAD", "--staged", "--worktree", "--", ...paths]);
      if (restored.code !== 0) throw new Error(restored.stderr.trim() || "git restore failed");
    }
    return;
  }
  if (code === "??") {
    fs.rmSync(abs, { force: true, recursive: false });
    return;
  }
  // An intent-to-add entry is reported as " A" even though the path has no HEAD
  // version. Before the first commit every indexed path is likewise new.
  if (code[0] === "A" || code === " A" || !(await hasCommits(cwd))) {
    const removed = await git(cwd, ["--literal-pathspecs", "rm", "--cached", "-f", "-q", "--", relative]);
    if (removed.code !== 0) throw new Error(removed.stderr.trim() || "git rm failed");
    fs.rmSync(abs, { force: true });
    return;
  }
  const r = await git(cwd, ["--literal-pathspecs", "checkout", "HEAD", "--", relative]);
  if (r.code !== 0) throw new Error(r.stderr.trim() || `git checkout failed for ${rel}`);
}

/** Creates a linked worktree on a fresh branch so a thread can work in isolation. */
export async function worktreeAdd(repo: string, dest: string, branch: string): Promise<{ path: string; branch: string }> {
  if (!(await hasCommits(repo))) throw new Error("the repository has no commits yet; worktrees need a HEAD");
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const r = await git(repo, ["worktree", "add", "-b", branch, dest, "HEAD"]);
  if (r.code !== 0) throw new Error(r.stderr.trim() || "git worktree add failed");
  return { path: dest, branch };
}

/** Removes a linked worktree (and its uncommitted changes). The branch is kept. */
export async function worktreeRemove(repo: string, dest: string): Promise<void> {
  const r = await git(repo, ["worktree", "remove", "--force", dest]);
  if (r.code !== 0 && fs.existsSync(dest)) throw new Error(r.stderr.trim() || "git worktree remove failed");
  await git(repo, ["worktree", "prune"]);
}

/** Path of the project's own worktree tool, if it ships one (the convention in AGENTS.md). */
export function projectWorktreeScript(repo: string): string | null {
  const script = path.join(repo, "scripts", "worktree.sh");
  try {
    fs.accessSync(script, fs.constants.R_OK);
    return script;
  } catch {
    return null;
  }
}

function runScript(repo: string, script: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile("bash", [script, ...args], { cwd: repo, maxBuffer: 8 * 1024 * 1024, env: process.env, timeout: 10 * 60 * 1000 }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : err ? 1 : 0;
      resolve({ stdout: String(stdout), stderr: String(stderr), code });
    });
  });
}

/**
 * Creates a worktree through the project's `scripts/worktree.sh new <name>`, which prints the
 * worktree path on its last stdout line. The branch is the name by convention.
 */
export async function projectWorktreeAdd(repo: string, script: string, name: string): Promise<{ path: string; branch: string; manager: "project-script" }> {
  const r = await runScript(repo, script, ["new", name]);
  const dest = r.stdout.trim().split("\n").filter(Boolean).at(-1) ?? "";
  if (r.code !== 0 || !dest || !fs.existsSync(dest)) throw new Error(`${path.relative(repo, script)} new ${name} failed${r.stderr.trim() ? `: ${r.stderr.trim().split("\n").slice(-2).join(" ")}` : ""}`);
  return { path: fs.realpathSync(dest), branch: name, manager: "project-script" };
}

/** Removes a project-script worktree. The script refuses on uncommitted changes; that refusal surfaces as an error. */
export async function projectWorktreeRemove(repo: string, script: string, name: string): Promise<void> {
  const r = await runScript(repo, script, ["remove", name]);
  if (r.code !== 0) throw new Error(r.stderr.trim().split("\n").slice(-2).join(" ") || `${path.relative(repo, script)} remove ${name} failed`);
}
