// Synthetic GitHub responses shared by handler and real Electron IPC tests.
export const FAKE_GH = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const endpoint = process.argv[3] || "";
fs.appendFileSync(process.env.FAKE_GH_LOG, endpoint + "\n");
const sha = (c) => c.repeat(40);
const repo = (id, name) => ({ id, full_name: "example-org/" + name, name, owner: { login: "example-org" }, default_branch: "main" });
const LENDING = repo(7301, "lending"), FIELD = repo(7302, "field-guide");
const pull = (r, title) => ({ id: r.id * 1000 + 73, number: 73, title, body: "", state: "open", draft: false, merged_at: null,
  user: { id: 1001, login: "ada-fixture", type: "User" }, created_at: "2026-10-18T10:00:00Z", updated_at: "2026-10-19T09:00:00Z",
  base: { ref: "main", sha: sha("b"), repo: r }, head: { ref: "topic", sha: sha("c"), repo: r },
  changed_files: 2, additions: 3, deletions: 1, commits: 1, comments: 0, review_comments: 0, requested_reviewers: [] });
const row = (r, title) => ({ id: r.id, number: 73, title, state: "open", draft: false, user: { id: 1001, login: "ada-fixture", type: "User" },
  updated_at: "2026-10-19T09:00:00Z", repository_url: "https://api.github.com/repos/" + r.full_name, pull_request: { merged_at: null } });
const routes = {
  "user": { id: 1001, login: "ada-fixture", type: "User" },
  "repos/example-org/lending": LENDING,
  "repos/example-org/field-guide": FIELD,
  "repos/example-org/lending/pulls/73": pull(LENDING, "Lend a hold to another branch"),
  "repos/example-org/field-guide/pulls/73": pull(FIELD, "Move the field notes index"),
  "repos/example-org/lending/pulls/73/files": [
    { filename: "src/holds/move.ts", status: "modified", additions: 3, deletions: 1, changes: 4, patch: "@@ -1 +1,3 @@\n-a\n+b\n+c\n+d" },
    { filename: "assets/shelf.png", status: "added", additions: 0, deletions: 0, changes: 0 },
  ],
};
if (endpoint === "repos/example-org/lending/contents/src/holds/move.ts?ref=" + sha("c")) {
  process.stdout.write("HTTP/2.0 200 OK\nContent-Type: application/vnd.github.raw\r\n\r\nb\nc\nd\nremote unchanged four\nremote unchanged five\n");
  process.exit(0);
}
let body;
if (/^repos\/example-org\/(lending|field-guide)\/compare\/[a-f0-9]{40}\.\.\.[a-f0-9]{40}\?per_page=1&page=1$/.test(endpoint)) {
  body = { base_commit: { sha: endpoint.split("/compare/")[1].split("...")[0] }, merge_base_commit: { sha: sha("b") } };
} else if (endpoint.startsWith("search/issues?")) {
  const q = new URLSearchParams(endpoint.split("?")[1]).get("q");
  const items = q.includes("review-requested:@me") ? [row(FIELD, "Move the field notes index")] : [row(LENDING, "Lend a hold to another branch")];
  body = { total_count: items.length, incomplete_results: false, items };
} else {
  body = routes[endpoint.split("?")[0]];
}
if (body === undefined) {
  process.stdout.write("HTTP/2.0 404 Not Found\nContent-Type: application/json\r\n\r\n{}");
  process.exitCode = 1;
} else {
  process.stdout.write("HTTP/2.0 200 OK\nContent-Type: application/json; charset=utf-8\r\nX-Ratelimit-Remaining: 4999\r\n\r\n" + JSON.stringify(body));
}
`;
