import { execFile } from "node:child_process";
import path from "node:path";
import type { PullRequestSummary, ThreadContext } from "../../shared/types.js";

const unavailable = (): PullRequestSummary => ({ state: "unavailable", detail: "PR status unavailable. Check GitHub CLI sign-in and network access." });
const disabled = (): PullRequestSummary => ({ state: "disabled", detail: "GitHub status is disabled in demos, tests and browser development." });
const none = (): PullRequestSummary => ({ state: "none", detail: "No pull request found for this branch." });

/** No shell, interactive prompts, relative PATH entries, or unbounded command output. */
function run(bin: string, args: string[], cwd: string): Promise<string> {
  const searchPath = [...new Set([...(process.env.PATH ?? "").split(path.delimiter).filter(path.isAbsolute), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"])].join(path.delimiter);
  return new Promise((resolve, reject) => {
    execFile(bin, args, { cwd, timeout: 8_000, maxBuffer: 512 * 1024, env: { ...process.env, PATH: searchPath, GIT_OPTIONAL_LOCKS: "0", GH_PROMPT_DISABLED: "1", GH_PAGER: "cat" } },
      (err, stdout) => err ? reject(err) : resolve(stdout.trim()));
  });
}

/** Only github.com remotes; never forward CLI credentials to a host supplied by a repository. */
function githubRepo(remote: string): string | null {
  const match = /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https:\/\/github\.com\/)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(remote);
  return match?.[1] ?? null;
}

interface Options {
  enabled?: boolean;
  query?: (args: string[], cwd: string) => Promise<string>;
  now?: () => number;
}

/** Coalesce visible rows sharing a checkout and cache GitHub reads for one minute per head/base. */
export class ThreadContextReader {
  private readonly pending = new Map<string, Promise<ThreadContext>>();
  private readonly pulls = new Map<string, { expires: number; promise: Promise<PullRequestSummary> }>();
  constructor(private readonly options: Options = {}) {}

  read(cwd: string): Promise<ThreadContext> {
    const previous = this.pending.get(cwd);
    if (previous) return previous;
    const promise = this.readCheckout(cwd).finally(() => this.pending.delete(cwd));
    this.pending.set(cwd, promise);
    return promise;
  }

  private async readCheckout(cwd: string): Promise<ThreadContext> {
    const git = (args: string[]) => run("git", args, cwd);
    if (await git(["rev-parse", "--is-inside-work-tree"]).catch(() => "false") !== "true") {
      return { isRepo: false, branch: null, pullRequest: { state: "no-remote", detail: "Not a Git repository." } };
    }
    const branch = await git(["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => null);
    if (!branch) return { isRepo: true, branch: null, pullRequest: { state: "detached", detail: "Detached HEAD has no branch pull request." } };
    const context = { isRepo: true, branch };
    const [trackedRemote, pushRemote, pushDefault] = await Promise.all([
      git(["config", "--get", `branch.${branch}.remote`]).catch(() => ""),
      git(["config", "--get", `branch.${branch}.pushRemote`]).catch(() => ""),
      git(["config", "--get", "remote.pushDefault"]).catch(() => ""),
    ]);
    const remoteUrl = (remote: string) => remote && remote !== "." ? git(["remote", "get-url", "--", remote]).catch(() => "") : Promise.resolve("");
    const [originUrl, trackedUrl, upstreamUrl] = await Promise.all([
      remoteUrl("origin"), remoteUrl(trackedRemote),
      git(["remote", "get-url", "upstream"]).catch(() => ""),
    ]);
    const headRemote = pushRemote || pushDefault || (trackedRemote !== "." && trackedRemote ? trackedRemote : "origin");
    const headUrl = headRemote && headRemote !== "." ? await git(["remote", "get-url", "--push", "--", headRemote]).catch(() => "") : "";
    const headRepo = githubRepo(headUrl);
    if (!headRepo) return { ...context, pullRequest: { state: "no-remote", detail: "No supported github.com remote for this checkout." } };
    if (this.options.enabled === false) return { ...context, pullRequest: disabled() };
    const fetchRepos = [githubRepo(trackedUrl), githubRepo(originUrl)].filter((repo): repo is string => repo !== null);
    const baseRepo = githubRepo(upstreamUrl) ?? fetchRepos.find((repo) => repo.toLowerCase() !== headRepo.toLowerCase()) ?? fetchRepos[0] ?? headRepo;
    // New worktrees commonly track origin/main. That is their base, never their PR head.
    const headBranch = branch;
    const query = new URLSearchParams({ state: "all", head: `${headRepo.split("/")[0]}:${headBranch}`, sort: "updated", direction: "desc", per_page: "100" });
    const endpoint = `repos/${baseRepo}/pulls?${query}`;
    const key = `${headRepo}:${endpoint}`;
    const now = (this.options.now ?? Date.now)();
    let cached = this.pulls.get(key);
    if (!cached || cached.expires <= now) {
      const request = this.options.query ?? ((args: string[], dir: string) => run("gh", args, dir));
      const promise = request(["api", endpoint, "--hostname", "github.com", "--method", "GET"], cwd)
        .then((json) => summarizePulls(JSON.parse(json), baseRepo, headRepo, headBranch)).catch(() => unavailable());
      cached = { expires: now + 60_000, promise };
      this.pulls.delete(key);
      this.pulls.set(key, cached);
      if (this.pulls.size > 256) this.pulls.delete(this.pulls.keys().next().value!);
    }
    return { ...context, pullRequest: await cached.promise };
  }
}

function summarizePulls(value: unknown, baseRepo: string, headRepo: string, branch: string): PullRequestSummary {
  if (!Array.isArray(value)) return unavailable();
  const matches = [];
  for (const pr of value) {
    if (!pr || !Number.isSafeInteger(pr.number) || pr.number <= 0 || typeof pr.title !== "string" || !["open", "closed"].includes(pr.state)
      || typeof pr.draft !== "boolean" || !(pr.merged_at === null || typeof pr.merged_at === "string")
      || typeof pr.head?.ref !== "string" || typeof pr.base?.repo?.full_name !== "string") return unavailable();
    // Deleted forks and same-named branches in another repository are not this checkout.
    if (pr.head.ref !== branch || pr.head.repo?.full_name?.toLowerCase() !== headRepo.toLowerCase() || pr.base.repo.full_name.toLowerCase() !== baseRepo.toLowerCase()) continue;
    matches.push(pr);
  }
  // Prefer the active PR if a branch has been reused; the API sorts each lifecycle by recency.
  const pr = matches.find((item) => item.state === "open") ?? matches[0];
  return pr ? { state: pr.merged_at ? "merged" : pr.state === "closed" ? "closed" : pr.draft ? "draft" : "open", number: pr.number,
    title: pr.title.slice(0, 512), url: `https://github.com/${baseRepo}/pull/${pr.number}`,
    ...(typeof pr.head.sha === "string" && /^[0-9a-f]{40}$/.test(pr.head.sha) ? { headSha: pr.head.sha } : {}) } : none();
}
