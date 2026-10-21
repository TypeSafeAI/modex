import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { tmpdir } from "./helpers.js";
import { CodeReviewService } from "../src/main/engine/code-review/read-service.js";
import { ghTransport } from "../src/main/engine/code-review/gh.js";
import { FAKE_GH } from "./fixtures/code-review-gh.js";
import type { CodeReviewReply, PrKey } from "../src/shared/code-review.js";

/**
 * Handler-level coverage: the inbox → overview → files workflow through main's real `code-review:read` handler, the
 * real service and the real gh transport, with a fake `gh` executable answering for a synthetic
 * GitHub. Nothing touches the local filesystem but the fake's own log.
 */


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

test("main's code-review:read handler is local-only and serves inbox, overview and files through gh", async () => {
  const dir = tmpdir("modex-cr-ipc-");
  const bin = path.join(dir, "gh"), log = path.join(dir, "calls.log");
  fs.writeFileSync(bin, FAKE_GH, { mode: 0o755 });
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
      assert.ok(["node:child_process", "node:fs", "node:os", "node:path", "../../../shared/code-review.js", "./gh.js", "./github.js"].includes(spec!), `${name} imports ${spec}`);
    }
    assert.doesNotMatch(source, /(?<![.\w])(spawn|exec|execSync|writeFile|appendFile|mkdir|rm|unlink|rename)\s*\(/, name);
    assert.doesNotMatch(source, /--method", "(POST|PATCH|PUT|DELETE)"|"-X"|"graphql"|changes:revert|onRevert/, name);
  }
  const gh = sources.find(([name]) => name === "gh.ts")![1];
  // The filesystem is touched once: a stat of gh's hosts.yml, to notice a switch of account.
  assert.deepEqual([...new Set([...gh.matchAll(/\bfs\.(\w+)/g)].map((m) => m[1]))], ["statSync"]);
  for (const [name, source] of sources) if (name !== "gh.ts") assert.doesNotMatch(source, /node:fs/, name);
  assert.equal([...gh.matchAll(/execFile\(/g)].length, 1, "one call, to gh, with no shell");
  assert.match(gh, /"--method", "GET"/);
});
