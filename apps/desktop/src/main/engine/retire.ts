import type { PullRequestSummary, Thread, ThreadContext } from "../../shared/types.js";

export type RetireDecision =
  | { retire: true; pr: { number: number; url: string; headSha: string } }
  | { retire: false; reason: "not-a-task" | "retired" | "busy" | "no-pr" | "pr-open" | "pr-closed" | "unverified" | "uncommitted" | "unpushed" };

/**
 * A task is finished when its pull request merged. Retiring removes the worktree and branch, so it
 * only happens when nothing there would be lost: the thread is idle, the worktree has no uncommitted
 * files, and HEAD is exactly the commit the merged PR carried (a squash merge leaves the branch's own
 * commits out of main, so ancestry cannot prove this). Anything unclear leaves the task alone.
 */
export function retireDecision(input: { thread: Thread; busy: boolean; pullRequest: PullRequestSummary | undefined; clean: boolean; head: string | null }): RetireDecision {
  const { thread, pullRequest: pr } = input;
  if (!thread.worktree) return { retire: false, reason: "not-a-task" };
  if (thread.retired) return { retire: false, reason: "retired" };
  if (input.busy || thread.status !== "idle") return { retire: false, reason: "busy" };
  if (!pr || !("number" in pr)) return { retire: false, reason: "no-pr" };
  if (pr.state === "closed") return { retire: false, reason: "pr-closed" };
  if (pr.state !== "merged") return { retire: false, reason: "pr-open" };
  if (!pr.headSha || !input.head) return { retire: false, reason: "unverified" };
  if (!input.clean) return { retire: false, reason: "uncommitted" };
  if (input.head !== pr.headSha) return { retire: false, reason: "unpushed" };
  return { retire: true, pr: { number: pr.number, url: pr.url, headSha: pr.headSha } };
}

export interface RetirerDeps {
  enabled(): boolean;
  threads(): Thread[];
  busy(threadId: string): boolean;
  context(cwd: string): Promise<ThreadContext>;
  inspect(cwd: string): Promise<{ clean: boolean; head: string | null }>;
  retire(threadId: string, pr: { number: number; url: string; headSha: string }): Promise<void>;
}

/** Looks at every live worktree task on a timer and retires the ones that finished. Remembers the last PR it saw for each. */
export class TaskRetirer {
  private readonly seen = new Map<string, PullRequestSummary>();
  private sweeping: Promise<string[]> | null = null;
  private timer?: ReturnType<typeof setInterval>;

  constructor(private readonly deps: RetirerDeps) {}

  /** The pull request last observed for a task, or undefined before the first sweep reached it. */
  pullRequest(threadId: string): PullRequestSummary | undefined {
    return this.seen.get(threadId);
  }

  start(intervalMs = 180_000): void {
    this.timer ??= setInterval(() => { void this.sweep().catch(() => {}); }, intervalMs).unref();
    void this.sweep().catch(() => {});
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Returns the ids it retired. One sweep at a time; a second call joins the running one. */
  sweep(): Promise<string[]> {
    if (this.sweeping) return this.sweeping;
    const run = this.run().finally(() => { if (this.sweeping === run) this.sweeping = null; });
    this.sweeping = run;
    return run;
  }

  private async run(): Promise<string[]> {
    const retired: string[] = [];
    const live = this.deps.threads().filter((t) => t.worktree && !t.retired);
    for (const id of [...this.seen.keys()]) if (!live.some((t) => t.id === id)) this.seen.delete(id);
    for (const thread of live) {
      try {
        const pullRequest = (await this.deps.context(thread.cwd)).pullRequest;
        this.seen.set(thread.id, pullRequest);
        if (!this.deps.enabled() || pullRequest.state !== "merged") continue;
        const { clean, head } = await this.deps.inspect(thread.cwd);
        // Re-read after the awaits: the user may have sent a message meanwhile.
        const current = this.deps.threads().find((t) => t.id === thread.id);
        if (!current || !this.deps.enabled()) continue;
        const decision = retireDecision({ thread: current, busy: this.deps.busy(thread.id), pullRequest, clean, head });
        if (!decision.retire) continue;
        await this.deps.retire(thread.id, decision.pr);
        retired.push(thread.id);
      } catch {
        // A checkout that cannot be read this round is simply left for the next one.
      }
    }
    return retired;
  }
}
