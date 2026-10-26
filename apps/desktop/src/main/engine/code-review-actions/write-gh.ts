import { execFile } from "node:child_process";
import os from "node:os";
import { environment, parseIncluded, type GhAnswer } from "../code-review/gh.js";

/**
 * CR-7's transport (#326, approved by Val on 2026-10-25): fixed `gh api` calls through the person's own
 * `gh` login, separate from the read transport. Every endpoint is one of the shapes below, built by main
 * from its own reads; a body goes to gh on stdin as JSON. Modex never sees or stores the token.
 */
export interface GhWriteCall {
  method: "GET" | "POST" | "PUT" | "PATCH";
  endpoint: string;
  /** The JSON body of a POST, PUT or PATCH; null for a GET. */
  input: Record<string, unknown> | null;
  maxBytes: number;
  timeoutMs: number;
}

export type GhWriteTransport = (call: GhWriteCall) => Promise<GhAnswer>;

const OWNER = "[A-Za-z0-9-]{1,39}";
const NAME = "[A-Za-z0-9_.%-]{1,300}";
const REPO = `repos/${OWNER}/${NAME}`;
const NUMBER = "[1-9][0-9]{0,9}";
const SHA = "[0-9a-f]{40}";
const PAGE = "page=[1-9][0-9]{0,2}";
/** A branch name, percent-encoded into one path segment (slashes as %2F). */
const BRANCH = "[A-Za-z0-9_.%-]{1,1024}";
const READS = [
  "user",
  `repositories/${NUMBER}`,
  `${REPO}/pulls/${NUMBER}`,
  `${REPO}/pulls/${NUMBER}/files\\?per_page=100&${PAGE}`,
  `${REPO}/compare/${SHA}\\.\\.\\.${SHA}\\?per_page=1&page=1`,
  `${REPO}/issues/${NUMBER}/comments\\?per_page=100&${PAGE}`,
  `${REPO}/pulls/${NUMBER}/reviews\\?per_page=100&${PAGE}`,
  `${REPO}/rules/branches/${BRANCH}\\?per_page=100&page=1`,
].map((pattern) => new RegExp(`^${pattern}$`));
/**
 * The only mutations: a top-level comment, a submitted review, a reviewer request and GitHub's two draft
 * mutations by POST; a merge guarded by the reviewed head by PUT; and a PR's state, title or body by PATCH.
 */
const WRITES = [`${REPO}/issues/${NUMBER}/comments`, `${REPO}/pulls/${NUMBER}/reviews`, `${REPO}/pulls/${NUMBER}/requested_reviewers`, "graphql"].map((pattern) => new RegExp(`^${pattern}$`));
const MERGES = [`${REPO}/pulls/${NUMBER}/merge`].map((pattern) => new RegExp(`^${pattern}$`));
const EDITS = [`${REPO}/pulls/${NUMBER}`].map((pattern) => new RegExp(`^${pattern}$`));

/**
 * REST can't move a PR to or from draft, so these two GraphQL mutations are the only GraphQL Modex sends,
 * text for text, with the PR's node id as their one variable.
 */
export const DRAFT_MUTATIONS = {
  draft: "mutation($id: ID!) { convertPullRequestToDraft(input: { pullRequestId: $id }) { pullRequest { isDraft updatedAt } } }",
  ready: "mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { isDraft updatedAt } } }",
} as const;
const NODE_ID = /^[A-Za-z0-9_=+/-]{1,200}$/;

/** What each mutation's body may hold. Anything else is refused before gh runs. */
function bodyAllowed(call: GhWriteCall): boolean {
  const input = call.input!;
  const keys = Object.keys(input);
  if (call.method === "PATCH") return keys.length > 0 && keys.every((k) => k === "state" || k === "title" || k === "body");
  if (call.endpoint === "graphql") {
    const variables = input.variables as Record<string, unknown> | undefined;
    return keys.length === 2 && Object.values(DRAFT_MUTATIONS).includes(input.query as never)
      && !!variables && typeof variables === "object" && Object.keys(variables).join() === "id" && typeof variables.id === "string" && NODE_ID.test(variables.id);
  }
  if (call.endpoint.endsWith("/requested_reviewers")) return keys.join() === "reviewers" && Array.isArray(input.reviewers);
  return true;
}

export function ghWriteArgs(call: GhWriteCall): string[] {
  const allowed = call.method === "GET" ? READS : call.method === "POST" ? WRITES : call.method === "PUT" ? MERGES : call.method === "PATCH" ? EDITS : [];
  const segments = call.endpoint.split("?")[0]!.split("/");
  // No segment may climb out of the path GitHub is asked for, encoded or not.
  if (!allowed.some((pattern) => pattern.test(call.endpoint)) || segments.some((s) => s === "." || s === ".." || /%2e%2e|^%2e$|^\.%2e$|^%2e\.$/i.test(s))) throw new Error("Code Review endpoint is not allowed.");
  if ((call.method !== "GET") !== (call.input !== null) || (call.input && !bodyAllowed(call))) throw new Error("Code Review request body is not allowed.");
  return ["api", call.endpoint, "--hostname", "github.com", "--method", call.method, "--include", "-H", "Accept: application/vnd.github+json",
    "-H", "X-GitHub-Api-Version: 2022-11-28", ...(call.input ? ["--input", "-"] : [])];
}

const NETWORK = /dial tcp|no such host|connection (?:refused|reset)|network is unreachable|i\/o timeout|TLS handshake|proxyconnect|EOF/i;

export function ghWriteTransport(bin = "gh"): GhWriteTransport {
  return (call) => {
    const args = ghWriteArgs(call);
    return new Promise((resolve) => {
      const child = execFile(bin, args, { cwd: os.homedir(), env: environment(), encoding: "buffer", timeout: call.timeoutMs, maxBuffer: call.maxBytes, windowsHide: true },
        (error, stdout, stderr) => {
          const failure = error as (Omit<NodeJS.ErrnoException, "code"> & { killed?: boolean; code?: string | number }) | null;
          if (failure?.code === "ENOENT") return resolve({ kind: "no-cli" });
          if (failure?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return resolve({ kind: "too-large" });
          if (failure?.killed) return resolve({ kind: "timeout" });
          const answer = parseIncluded(stdout);
          if (answer && failure && answer.status >= 200 && answer.status < 300) return resolve({ kind: "failed" });
          if (answer) return resolve({ kind: "http", ...answer });
          if (failure?.code === 4) return resolve({ kind: "signed-out" });
          resolve({ kind: failure && NETWORK.test(stderr.toString("utf8")) ? "offline" : "failed" });
        });
      // gh reads the body from stdin; a GET gets an empty stdin so it never waits on the terminal.
      child.stdin?.on("error", () => {});
      child.stdin?.end(call.input ? JSON.stringify(call.input) : "");
    });
  };
}
