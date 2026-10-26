import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { tmpdir } from "./helpers.js";
import { CodeReviewWrites } from "../src/main/engine/code-review-actions/write-service.js";
import { ghWriteTransport } from "../src/main/engine/code-review-actions/write-gh.js";
import { baseWorld, WORLD_GH } from "./fixtures/code-review-gh-world.js";
import { intentMarker, type WriteReply } from "../src/shared/code-review-write.js";
import type { PrKey, PrRevision } from "../src/shared/code-review.js";

/**
 * CR-7 (#326), handler level: main's real `code-review:write` registration, the real write service and the
 * real gh write transport, with a synthetic `gh` (WORLD_GH) standing in for GitHub. The session a preview
 * belongs to comes from the IPC sender and the document epoch, never from the payload.
 */
const nativeTest = process.platform === "win32" ? test.skip : test;
const KEY: PrKey = { account: "1001", host: "github.com", repoId: "7301", number: 73 };
const REV: PrRevision = { baseRef: "main", baseSha: "b".repeat(40), headSha: "c".repeat(40) };

function mainHandler(service: CodeReviewWrites, epoch: { value: number }) {
  const code = fs.readFileSync(path.resolve(import.meta.dirname, "../src/main/index.js"), "utf8");
  const start = code.indexOf('handle("code-review:write",');
  assert.ok(start >= 0, "main registers code-review:write");
  const end = code.indexOf("}, { localOnly: true });", start) + "}, { localOnly: true });".length;
  const registered: { channel: string; handler: Function; options: { localOnly?: boolean } }[] = [];
  const sandbox = { shuttingDown: false, win: {}, isTrustedTerminalSender: () => true, pathReady: Promise.resolve(), codeReviewWrites: service, documentEpoch: epoch.value,
    handle: (channel: string, handler: Function, options: { localOnly?: boolean } = {}) => registered.push({ channel, handler, options }) };
  vm.runInNewContext(code.slice(start, end), sandbox);
  assert.equal(registered.length, 1);
  return { ...registered[0]!, reload: () => { sandbox.documentEpoch = ++epoch.value; } };
}

nativeTest("main's code-review:write handler is local-only, scopes previews to the sending document and posts through gh once", async () => {
  const dir = tmpdir("modex-cr-write-ipc-");
  const bin = path.join(dir, "gh"), log = path.join(dir, "calls.log"), world = path.join(dir, "world.json"), posts = path.join(dir, "posts.jsonl");
  fs.writeFileSync(bin, WORLD_GH, { mode: 0o755 });
  fs.writeFileSync(world, JSON.stringify(baseWorld()));
  fs.writeFileSync(log, "");
  Object.assign(process.env, { FAKE_GH_LOG: log, FAKE_GH_WORLD: world, FAKE_GH_POSTS: posts, FAKE_GH_HOLDS: dir });
  try {
    const service = new CodeReviewWrites({ home: path.join(dir, "home"), transport: ghWriteTransport(bin), identityStamp: () => "hosts-1" });
    const { channel, handler, options, reload } = mainHandler(service, { value: 1 });
    assert.equal(channel, "code-review:write");
    assert.deepEqual([Object.keys(options), options.localOnly], [["localOnly"], true], "paired desktops cannot reach it");
    const window = { sender: { id: 7 } };
    let n = 0;
    const invoke = async (request: Record<string, unknown>, event: unknown = window) => await handler({ ...request, requestId: `r${++n}` }, event) as WriteReply;
    const value = (reply: WriteReply) => { assert.equal(reply.result.state, "ok", JSON.stringify(reply.result)); return (reply.result as { value: any }).value; };

    await assert.rejects(invoke({ op: "status", key: KEY, revision: REV }, null), /only in this window/);
    await assert.rejects(invoke({ op: "status", key: KEY, revision: REV, session: "w7-1" }), /Invalid Code Review write request/);

    const saved = value(await invoke({ op: "save", key: KEY, revision: REV, kind: "comment", expectedVersion: 0, body: "Handler-level comment", comments: [] }));
    const preview = value(await invoke({ op: "prepare", key: KEY, revision: REV, operation: { kind: "comment" }, draftVersion: saved.version }));
    // Another window, or this one after a reload, holds no proof of that preview.
    const other = await invoke({ op: "submit", key: KEY, intentId: preview.intentId }, { sender: { id: 8 } });
    assert.equal(other.result.state === "refused" && other.result.reason, "no-preview");
    reload();
    const reloaded = await invoke({ op: "submit", key: KEY, intentId: preview.intentId });
    assert.equal(reloaded.result.state === "refused" && reloaded.result.reason, "no-preview");
    assert.equal(fs.existsSync(posts), false, "nothing was posted");

    const fresh = value(await invoke({ op: "prepare", key: KEY, revision: REV, operation: { kind: "comment" }, draftVersion: saved.version }));
    const receipt = value(await invoke({ op: "submit", key: KEY, intentId: fresh.intentId }));
    assert.equal(receipt.state, "confirmed");
    const sent = fs.readFileSync(posts, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(sent.map((p) => [p.endpoint, p.body]), [["repos/example-org/lending/issues/73/comments", { body: `Handler-level comment\n\n${intentMarker(fresh.intentId)}` }]]);
    const calls = fs.readFileSync(log, "utf8").trim().split("\n");
    assert.ok(calls.every((c) => /^(user|repositories\/7301|repos\/example-org\/lending\/pulls\/73|POST repos\/example-org\/lending\/issues\/73\/comments)$/.test(c)), calls.join("\n"));
    assert.equal(calls.filter((c) => c.startsWith("POST ")).length, 1);
  } finally {
    for (const name of ["FAKE_GH_LOG", "FAKE_GH_WORLD", "FAKE_GH_POSTS", "FAKE_GH_HOLDS"]) delete process.env[name];
  }
});

nativeTest("a document reload during submit preflight fences the durable dispatch", async () => {
  const dir = tmpdir("modex-cr-write-reload-");
  const bin = path.join(dir, "gh"), log = path.join(dir, "calls.log"), world = path.join(dir, "world.json"), posts = path.join(dir, "posts.jsonl");
  fs.writeFileSync(bin, WORLD_GH, { mode: 0o755 });
  fs.writeFileSync(world, JSON.stringify(baseWorld()));
  fs.writeFileSync(log, "");
  Object.assign(process.env, { FAKE_GH_LOG: log, FAKE_GH_WORLD: world, FAKE_GH_POSTS: posts, FAKE_GH_HOLDS: dir });
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const held = new Promise<void>((resolve) => { entered = resolve; });
  let hold = false;
  const transport = ghWriteTransport(bin);
  try {
    const service = new CodeReviewWrites({ home: path.join(dir, "home"), identityStamp: () => "hosts-1", transport: async (call) => {
      if (hold && call.method === "GET") { entered(); await gate; }
      return transport(call);
    } });
    const { handler, reload } = mainHandler(service, { value: 1 });
    let n = 0;
    const invoke = async (request: Record<string, unknown>) => await handler({ ...request, requestId: `reload${++n}` }, { sender: { id: 7 } }) as WriteReply;
    const value = (reply: WriteReply) => { assert.equal(reply.result.state, "ok"); return (reply.result as { value: any }).value; };
    const saved = value(await invoke({ op: "save", key: KEY, revision: REV, kind: "comment", expectedVersion: 0, body: "Do not send after reload", comments: [] }));
    const preview = value(await invoke({ op: "prepare", key: KEY, revision: REV, operation: { kind: "comment" }, draftVersion: saved.version }));
    hold = true;
    const pending = invoke({ op: "submit", key: KEY, intentId: preview.intentId });
    await held;
    const queued = invoke({ op: "submit", key: KEY, intentId: preview.intentId });
    reload();
    release();
    const reply = await pending;
    assert.equal(reply.result.state, "refused");
    assert.equal((await queued).result.state, "refused", "queued requests must recheck document authority too");
    assert.equal(fs.existsSync(posts), false, "stale document must never reach a remote mutation");
  } finally {
    release();
    for (const name of ["FAKE_GH_LOG", "FAKE_GH_WORLD", "FAKE_GH_POSTS", "FAKE_GH_HOLDS"]) delete process.env[name];
  }
});

nativeTest("main merges through gh with the reviewed head, once, and only with a method GitHub's settings allow", async () => {
  const dir = tmpdir("modex-cr-merge-ipc-");
  const bin = path.join(dir, "gh"), log = path.join(dir, "calls.log"), world = path.join(dir, "world.json"), posts = path.join(dir, "posts.jsonl");
  const w = baseWorld();
  w.permissions!["7301"] = { admin: false, maintain: false, push: true, triage: true, pull: true };
  fs.writeFileSync(bin, WORLD_GH, { mode: 0o755 });
  fs.writeFileSync(world, JSON.stringify(w));
  fs.writeFileSync(log, "");
  Object.assign(process.env, { FAKE_GH_LOG: log, FAKE_GH_WORLD: world, FAKE_GH_POSTS: posts, FAKE_GH_HOLDS: dir });
  try {
    const service = new CodeReviewWrites({ home: path.join(dir, "home"), transport: ghWriteTransport(bin), identityStamp: () => "hosts-1" });
    const { handler } = mainHandler(service, { value: 1 });
    let n = 0;
    const invoke = async (request: Record<string, unknown>) => await handler({ ...request, requestId: `m${++n}` }, { sender: { id: 7 } }) as WriteReply;
    const value = (reply: WriteReply) => { assert.equal(reply.result.state, "ok", JSON.stringify(reply.result)); return (reply.result as { value: any }).value; };
    const check = value(await invoke({ op: "merge-check", key: KEY, revision: REV }));
    assert.deepEqual([check.kind, check.methods, check.unstable], ["offer", ["squash", "rebase"], false]);
    const refused = await invoke({ op: "prepare-merge", key: KEY, revision: REV, method: "merge" });
    assert.equal(refused.result.state === "refused" && refused.result.reason, "merge-unavailable");
    const preview = value(await invoke({ op: "prepare-merge", key: KEY, revision: REV, method: "squash" }));
    assert.equal(fs.existsSync(posts), false, "a check and a preview change nothing");
    const receipt = value(await invoke({ op: "submit", key: KEY, intentId: preview.intentId }));
    assert.deepEqual([receipt.state, receipt.remoteUrl], ["confirmed", "https://github.com/example-org/lending/pull/73"]);
    const sent = fs.readFileSync(posts, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(sent.map((p) => [p.endpoint, p.body]), [["repos/example-org/lending/pulls/73/merge", { sha: REV.headSha, merge_method: "squash" }]]);
    const after = value(await invoke({ op: "merge-check", key: KEY, revision: REV }));
    assert.deepEqual([after.kind, after.reason], ["unavailable", "not-open"]);
    const calls = fs.readFileSync(log, "utf8").trim().split("\n");
    assert.ok(calls.every((c) => /^(user|repositories\/7301|repos\/example-org\/lending\/pulls\/73|repos\/example-org\/lending\/rules\/branches\/main\?per_page=100&page=1|PUT repos\/example-org\/lending\/pulls\/73\/merge)$/.test(c)), calls.join("\n"));
    assert.equal(calls.filter((c) => !/^(user|repositories|repos\/[^ ]+$)/.test(c)).length, 1, "one mutation");
  } finally {
    for (const name of ["FAKE_GH_LOG", "FAKE_GH_WORLD", "FAKE_GH_POSTS", "FAKE_GH_HOLDS"]) delete process.env[name];
  }
});

test("the write path reaches only its fixed GitHub mutations and the local review-actions store", () => {
  const dir = path.resolve(import.meta.dirname, "../../src/main/engine/code-review-actions");
  const sources = Object.fromEntries(["write-gh.ts", "write-service.ts", "merge-preflight.ts"].map((name) => [name, fs.readFileSync(path.join(dir, name), "utf8")]));
  for (const [name, source] of Object.entries(sources)) {
    for (const spec of [...source.matchAll(/from "([^"]+)"/g)].map((m) => m[1])) {
      assert.ok(["node:child_process", "node:os", "../../../shared/code-review.js", "../../../shared/code-review-patch.js", "../../../shared/code-review-write.js", "./intents.js", "./write-gh.js", "../code-review/gh.js", "../code-review/github.js", "./merge-preflight.js"].includes(spec!), `${name} imports ${spec}`);
    }
    assert.doesNotMatch(source, /(?<![.\w])(spawn|exec|execSync|writeFile|appendFile|mkdir|rm|unlink|rename)\s*\(/, name);
    // No deletion, no raw method flag, no labels or assignees, and no GraphQL text but the two draft mutations.
    assert.doesNotMatch(source, /"DELETE"|"-X"|\/labels|\/assignees|team_reviewers|deleteRef|mergePullRequest/, name);
    if (name !== "write-gh.ts") assert.doesNotMatch(source, /mutation\s*[({]/, name);
  }
  const gh = sources["write-gh.ts"]!;
  assert.equal([...gh.matchAll(/execFile\(/g)].length, 1, "one call, to gh, with no shell");
  // The mutation allowlist: a comment, a review, a reviewer request and the draft mutations by POST, the merge by
  // PUT, and the PR itself by PATCH; nothing else.
  assert.match(gh, /const WRITES = \[`\$\{REPO\}\/issues\/\$\{NUMBER\}\/comments`, `\$\{REPO\}\/pulls\/\$\{NUMBER\}\/reviews`, `\$\{REPO\}\/pulls\/\$\{NUMBER\}\/requested_reviewers`, "graphql"\]/);
  assert.match(gh, /const MERGES = \[`\$\{REPO\}\/pulls\/\$\{NUMBER\}\/merge`\]/);
  assert.match(gh, /const EDITS = \[`\$\{REPO\}\/pulls\/\$\{NUMBER\}`\]/);
  assert.equal([...gh.matchAll(/mutation\(\$id: ID!\)/g)].length, 2, "two GraphQL mutations, both fixed text");
  // A PATCH may carry only state, title and body.
  assert.match(gh, /k === "state" \|\| k === "title" \|\| k === "body"/);
  const service = sources["write-service.ts"]!;
  assert.equal([...service.matchAll(/method: "POST"/g)].length, 4);
  assert.equal([...service.matchAll(/method: "PUT"/g)].length, 1);
  assert.equal([...service.matchAll(/method: "PATCH"/g)].length, 2);
  assert.match(service, /query: DRAFT_MUTATIONS\[action\.to\]/);
  // The merge carries the reviewed head, from the durable intent, as GitHub's guard.
  assert.match(service, /method: "PUT", endpoint: `\$\{base\}\/pulls\/\$\{intent\.key\.number\}\/merge`, input: \{ sha: intent\.revision\.headSha, merge_method: method \}/);
  assert.doesNotMatch(service, /process\.env|token|GH_TOKEN/i);
});
