import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { tmpdir } from "./helpers.js";
import { CodeReviewService } from "../src/main/engine/code-review/read-service.js";
import { ghTransport } from "../src/main/engine/code-review/gh.js";
import type { CodeReviewReply, PrKey } from "../src/shared/code-review.js";

/**
 * #321 AC1: the inbox → overview → files workflow through main's real `code-review:read` handler, the
 * real service and the real gh transport, with a fake `gh` executable answering for a synthetic
 * GitHub. Nothing touches the local filesystem but the fake's own log.
 */
const FAKE = String.raw`#!/usr/bin/env node
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
let body;
if (endpoint.startsWith("search/issues?")) {
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

/** The handler exactly as compiled into main, with `handle` recording how it was registered. */
function mainHandler(service: CodeReviewService) {
  const code = fs.readFileSync(path.resolve(import.meta.dirname, "../src/main/index.js"), "utf8");
  const start = code.indexOf('handle("code-review:read",');
  assert.ok(start >= 0, "main registers code-review:read");
  const end = code.indexOf("\n", start);
  const registered: { channel: string; handler: Function; options: { localOnly?: boolean } }[] = [];
  vm.runInNewContext(code.slice(start, end), {
    pathReady: Promise.resolve(), codeReview: service,
    handle: (channel: string, handler: Function, options: { localOnly?: boolean } = {}) => registered.push({ channel, handler, options }),
  });
  assert.equal(registered.length, 1);
  return registered[0]!;
}

test("AC1: main's code-review:read handler is local-only and serves inbox, overview and files through gh", async () => {
  const dir = tmpdir("modex-cr-ipc-");
  const bin = path.join(dir, "gh"), log = path.join(dir, "calls.log");
  fs.writeFileSync(bin, FAKE, { mode: 0o755 });
  process.env.FAKE_GH_LOG = log;
  try {
    const { channel, handler, options } = mainHandler(new CodeReviewService({ transport: ghTransport(bin) }));
    assert.equal(channel, "code-review:read");
    // The options object comes from the vm's realm; compare its one field.
    assert.deepEqual([Object.keys(options), options.localOnly], [["localOnly"], true], "paired desktops cannot reach it");
    const invoke = async (request: unknown) => await handler(request, {}) as CodeReviewReply;

    await assert.rejects(invoke({ op: "overview", requestId: "x", key: { account: "1001", host: "github.example.invalid", repoId: "7301", number: 73 } }), /Invalid Code Review request/);
    const connection = await invoke({ op: "connection", requestId: "c1" });
    assert.deepEqual(connection.scope, { account: "1001", key: null, revision: null });

    const inbox = await invoke({ op: "inbox", requestId: "i1", query: "" });
    assert.equal(inbox.result.state, "ready");
    const groups = inbox.result.state === "ready" ? (inbox.result.value as { groups: Record<string, { state: string; value: { key: PrKey; title: string }[] }> }).groups : {};
    const lending = groups.authored!.value[0]!, field = groups["review-requested"]!.value[0]!;
    assert.deepEqual([lending.key.repoId, lending.key.number, field.key.repoId, field.key.number], ["7301", 73, "7302", 73]);

    const overview = await invoke({ op: "overview", requestId: "o1", key: lending.key });
    assert.deepEqual(overview.scope, { account: "1001", key: lending.key, revision: null });
    const revision = overview.result.state === "ready" ? (overview.result.value as { revision: { baseRef: string; baseSha: string; headSha: string } }).revision : null;
    assert.deepEqual(revision, { baseRef: "main", baseSha: "b".repeat(40), headSha: "c".repeat(40) });
    const other = await invoke({ op: "overview", requestId: "o2", key: field.key });
    assert.equal(other.result.state === "ready" && (other.result.value as { title: string }).title, "Move the field notes index");

    const files = await invoke({ op: "files", requestId: "f1", key: lending.key, revision, cursor: null });
    assert.deepEqual(files.scope, { account: "1001", key: lending.key, revision });
    assert.equal(files.result.state, "ready");
    const listed = files.result.state === "ready" ? (files.result.value as { files: { path: string; patch: { kind: string } }[] }).files : [];
    assert.deepEqual(listed.map((f) => [f.path, f.patch.kind]), [["src/holds/move.ts", "text"], ["assets/shelf.png", "omitted"]]);

    const endpoints = fs.readFileSync(log, "utf8").trim().split("\n");
    assert.ok(endpoints.every((e) => /^(user|search\/issues\?.+|repos\/example-org\/(lending|field-guide)(\/pulls\/73(\/files\?per_page=100&page=1)?)?)$/.test(e)), endpoints.join("\n"));
    assert.deepEqual(fs.readdirSync(dir).sort(), ["calls.log", "gh"], "nothing written but the fake's log");
  } finally {
    delete process.env.FAKE_GH_LOG;
  }
});

test("AC6: the read path has no local write, checkout, shell, model or write-endpoint reach", () => {
  const dir = path.resolve(import.meta.dirname, "../../src/main/engine/code-review");
  const sources = fs.readdirSync(dir).filter((name) => name.endsWith(".ts")).map((name) => [name, fs.readFileSync(path.join(dir, name), "utf8")] as const);
  assert.deepEqual(sources.map(([name]) => name).sort(), ["gh.ts", "github.ts", "read-service.ts"]);
  for (const [name, source] of sources) {
    const imports = [...source.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
    for (const spec of imports) {
      assert.ok(["node:child_process", "node:os", "node:path", "../../../shared/code-review.js", "./gh.js", "./github.js"].includes(spec!), `${name} imports ${spec}`);
    }
    assert.doesNotMatch(source, /(?<![.\w])(spawn|exec|execSync|writeFile|appendFile|mkdir|rm|unlink|rename)\s*\(/, name);
    assert.doesNotMatch(source, /--method", "(POST|PATCH|PUT|DELETE)"|"-X"|"graphql"|changes:revert|onRevert/, name);
  }
  const gh = sources.find(([name]) => name === "gh.ts")![1];
  assert.equal([...gh.matchAll(/execFile\(/g)].length, 1, "one call, to gh, with no shell");
  assert.match(gh, /"--method", "GET"/);
});
