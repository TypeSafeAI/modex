// A synthetic `gh` for CR-8's (#327) Electron journeys through main's production read service. Unlike
// FAKE_GH, it answers from a JSON world file it reads on every call, so a test can move a head, switch
// the account or hold one endpoint mid-read. It never reaches the network and knows nothing of tokens.
//
//   FAKE_GH_WORLD  the world file (see GhWorld)
//   FAKE_GH_LOG    one line per call: the endpoint main asked for
//   FAKE_GH_HOLDS  a directory: a held endpoint answers once a file of its hold's name appears there
//   FAKE_GH_POSTS  CR-7 (#326): one JSON line per POST GitHub "received" ({ endpoint, body, id }). A posted
//                  comment or review is then listed by the matching GET, as GitHub would list it.
export interface GhWorld {
  /** `gh api user`; null answers as gh does when nobody is signed in (exit 4). */
  user: { id: number; login: string } | null;
  /** Search rows per group, before the person's text and paging narrow them. */
  search: { authored: unknown[]; "review-requested": unknown[] };
  /** `incomplete_results` per group, as GitHub sets it when its search timed out. */
  incomplete?: Partial<Record<"authored" | "review-requested", boolean>>;
  /** Endpoint path (no query) to a JSON body, or an explicit answer. Arrays are paged by `page`/`per_page`. */
  routes: Record<string, unknown>;
  /** Endpoint path to a hold name: the call waits until FAKE_GH_HOLDS/<name> exists. */
  holds?: Record<string, string>;
  /** `GET /repositories/{id}`'s `permissions` per repository id; absent answers without the field. */
  permissions?: Record<string, Record<string, boolean>>;
  /** POST endpoint to a hold name: GitHub records the write, then the answer waits, as when it is lost in flight. */
  postHolds?: Record<string, string>;
  /** POST endpoint to a forced answer. `recorded`: GitHub carried the write out before answering it. */
  postAnswers?: Record<string, GhAnswerSpec & { recorded?: boolean }>;
}

/** An explicit answer. `stderr` is printed as gh would print a diagnostic: main must never pass it on. */
export interface GhAnswerSpec { status: number; body?: unknown; raw?: string; headers?: Record<string, string>; stderr?: string }

export const WORLD_GH = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const endpoint = process.argv[3] || "";
const method = process.argv[process.argv.indexOf("--method") + 1] || "GET";
fs.appendFileSync(process.env.FAKE_GH_LOG, (method === "GET" ? "" : method + " ") + endpoint + "\n");
const [route, query = ""] = endpoint.split("?");
const params = new URLSearchParams(query);
const read = () => JSON.parse(fs.readFileSync(process.env.FAKE_GH_WORLD, "utf8"));
const wait = (hold) => { const released = hold && require("node:path").join(process.env.FAKE_GH_HOLDS, hold); if (released) { const flag = new Int32Array(new SharedArrayBuffer(4)); while (!fs.existsSync(released)) Atomics.wait(flag, 0, 0, 25); } };
wait((read().holds || {})[route]);
const world = read();
const postsFile = process.env.FAKE_GH_POSTS;
const posts = () => postsFile && fs.existsSync(postsFile) ? fs.readFileSync(postsFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const reason = { 200: "OK", 403: "Forbidden", 404: "Not Found", 410: "Gone" };
function send(status, body, headers) {
  const all = { "Content-Type": "application/json; charset=utf-8", "X-Ratelimit-Remaining": "4999", ...(headers || {}) };
  process.stdout.write("HTTP/2.0 " + status + " " + (reason[status] || "Error") + "\n" + Object.entries(all).map(([k, v]) => k + ": " + v).join("\r\n") + "\r\n\r\n"
    + (typeof body === "string" ? body : JSON.stringify(body)));
  if (status >= 300) process.exitCode = 1;
}
function paged(list) {
  const per = Number(params.get("per_page") || 30), page = Number(params.get("page") || 1);
  return list.slice((page - 1) * per, page * per);
}
if (method === "POST") {
  const input = JSON.parse(fs.readFileSync(0, "utf8") || "null");
  const forced = (world.postAnswers || {})[route];
  const review = /\/pulls\/\d+\/reviews$/.test(route);
  let created = null;
  if (!forced || forced.recorded) {
    const id = 900001 + posts().length;
    created = review ? { id, user: { ...world.user, type: "User" }, body: input.body, commit_id: input.commit_id,
      state: input.event === "APPROVE" ? "APPROVED" : input.event === "REQUEST_CHANGES" ? "CHANGES_REQUESTED" : "COMMENTED", submitted_at: "2026-10-18T20:40:00Z" }
      : { id, user: { ...world.user, type: "User" }, body: input.body, created_at: "2026-10-18T20:40:00Z", updated_at: "2026-10-18T20:40:00Z" };
    fs.appendFileSync(postsFile, JSON.stringify({ endpoint: route, body: input, id, created }) + "\n");
  }
  wait((world.postHolds || {})[route]);
  if (forced) send(forced.status, forced.body === undefined ? {} : forced.body, forced.headers);
  else send(review ? 200 : 201, created);
} else if (/^repositories\/\d+$/.test(route)) {
  const id = Number(route.split("/")[1]);
  const repo = Object.values(world.routes).find((value) => value && value.full_name && value.id === id);
  const permissions = (world.permissions || {})[String(id)];
  if (!repo) send(404, { message: "Not Found" });
  else send(200, { ...repo, ...(permissions ? { permissions } : {}) });
} else if (/\/(issues\/\d+\/comments|pulls\/\d+\/reviews)$/.test(route)) {
  const listed = [...(Array.isArray(world.routes[route]) ? world.routes[route] : []), ...posts().filter((p) => p.endpoint === route).map((p) => p.created)];
  send(200, paged(listed));
} else if (route === "user") {
  if (!world.user) { process.stderr.write("You are not logged into any GitHub hosts.\n"); process.exitCode = 4; }
  else send(200, { ...world.user, type: "User" });
} else if (route === "search/issues") {
  const q = params.get("q") || "";
  const group = q.includes("review-requested:@me") ? "review-requested" : "authored";
  const text = q.split(" ").filter((t) => !/^(is|archived|author|review-requested):/.test(t)).join(" ").toLowerCase();
  const rows = (world.search[group] || []).filter((row) => !text || String(row.title).toLowerCase().includes(text));
  send(200, { total_count: rows.length, incomplete_results: Boolean((world.incomplete || {})[group]), items: paged(rows) });
} else {
  let found = world.routes[route];
  // These synthetic PRs fork directly from their named base. Only a declared PR pair
  // supplies comparison provenance; explicit routes can model divergent or failed comparisons.
  const comparison = /^(repos\/[^/]+\/[^/]+)\/compare\/([a-f0-9]{40})\.\.\.([a-f0-9]{40})$/.exec(route);
  if (found === undefined && comparison) {
    const declared = Object.entries(world.routes).some(([endpoint, value]) =>
      endpoint.startsWith(comparison[1] + "/pulls/") && /\/pulls\/\d+$/.test(endpoint)
      && value && value.base && value.head && value.base.sha === comparison[2] && value.head.sha === comparison[3]);
    if (declared) found = { base_commit: { sha: comparison[2] }, merge_base_commit: { sha: comparison[2] } };
  }
  if (found === undefined) send(404, { message: "Not Found" });
  else if (found && typeof found === "object" && !Array.isArray(found) && typeof found.status === "number") {
    if (found.stderr) process.stderr.write(found.stderr);
    if (typeof found.raw === "string") send(found.status, found.raw, { "Content-Type": "application/vnd.github.raw", ...(found.headers || {}) });
    else send(found.status, found.body === undefined ? {} : found.body, found.headers);
  } else send(200, Array.isArray(found) ? paged(found) : found);
}
`;

// GitHub REST shapes, as github.ts reads them. Everything named here is made up.
export const sha = (c: string) => c.repeat(40);
export const ghRepo = (id: number, owner: string, name: string) => ({ id, full_name: `${owner}/${name}`, name, owner: { login: owner }, default_branch: "main" });
type Repo = ReturnType<typeof ghRepo>;
const person = (id: number, login: string) => ({ id, login, type: "User" });

export function ghPull(repo: Repo, number: number, title: string, opts: { head?: string; body?: string; files?: number; additions?: number; deletions?: number; author?: [number, string] } = {}) {
  return { id: repo.id * 1000 + number, number, title, body: opts.body ?? "", state: "open", draft: false, merged_at: null,
    user: person(...(opts.author ?? [1001, "ada-fixture"])), created_at: "2026-10-18T10:00:00Z", updated_at: "2026-10-18T20:30:00Z",
    base: { ref: "main", sha: sha("b"), repo }, head: { ref: `topic-${number}`, sha: opts.head ?? sha("c"), repo },
    changed_files: opts.files ?? 2, additions: opts.additions ?? 3, deletions: opts.deletions ?? 1, commits: 1, comments: 0, review_comments: 0, requested_reviewers: [], locked: false };
}

export function ghRow(repo: Repo, number: number, title: string, author: [number, string] = [1001, "ada-fixture"], updated = "2026-10-18T20:30:00Z") {
  return { id: repo.id * 1000 + number, number, title, state: "open", draft: false, user: person(...author), updated_at: updated,
    repository_url: `https://api.github.com/repos/${repo.full_name}`, pull_request: { merged_at: null } };
}

export const ghFile = (filename: string, patch: string | null, additions: number, deletions: number, status = "modified") =>
  ({ filename, status, additions, deletions, changes: additions + deletions, ...(patch === null ? {} : { patch }) });

export const LENDING = ghRepo(7301, "example-org", "lending");
export const FIELD_GUIDE = ghRepo(7302, "example-org", "field-guide");
export const LENDING_73 = "Move holds between branches without losing the queue position";
export const FIELD_GUIDE_73 = "Fix the broken anchors on the opening-hours page";
export const FIELD_GUIDE_91 = "Group the branch pages by region";

/**
 * The journeys' default world: R1's density (a long title, +8,912 −47 over 11 files) and R4's (4 files,
 * +11 −4), in made-up repositories that share PR #73, as the CR-1 fixtures do. No real PR content.
 */
export function baseWorld(): GhWorld {
  const lendingRows = [ghRow(LENDING, 73, LENDING_73, [1001, "ada-fixture"], "2026-10-18T20:30:00Z"), ghRow(LENDING, 70, "Show each branch's opening hours on the hold slip", [1001, "ada-fixture"], "2026-10-18T19:10:00Z"),
    ghRow(FIELD_GUIDE, 91, FIELD_GUIDE_91, [1001, "ada-fixture"], "2026-10-18T18:45:00Z")];
  return {
    user: { id: 1001, login: "ada-fixture" },
    permissions: { "7301": { admin: false, maintain: false, push: false, triage: false, pull: true }, "7302": { admin: false, maintain: false, push: false, triage: false, pull: true } },
    search: { authored: lendingRows, "review-requested": [ghRow(FIELD_GUIDE, 73, FIELD_GUIDE_73, [1002, "grace-fixture"], "2026-10-18T17:00:00Z")] },
    routes: {
      "repos/example-org/lending": LENDING,
      "repos/example-org/field-guide": FIELD_GUIDE,
      "repos/example-org/lending/pulls/73": ghPull(LENDING, 73, LENDING_73, { files: 11, additions: 8912, deletions: 47 }),
      "repos/example-org/lending/pulls/70": ghPull(LENDING, 70, "Show each branch's opening hours on the hold slip"),
      "repos/example-org/field-guide/pulls/91": ghPull(FIELD_GUIDE, 91, FIELD_GUIDE_91, { files: 4, additions: 11, deletions: 4 }),
      "repos/example-org/field-guide/pulls/73": ghPull(FIELD_GUIDE, 73, FIELD_GUIDE_73, { files: 1, additions: 5, deletions: 2, author: [1002, "grace-fixture"] }),
      "repos/example-org/lending/pulls/73/files": [ghFile("src/holds/move.ts", "@@ -1 +1,3 @@\n-a\n+b\n+c\n+d", 3, 1), ghFile("assets/shelf.png", null, 0, 0, "added")],
    },
  };
}
