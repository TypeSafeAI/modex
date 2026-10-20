import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "./helpers.js";
import { ghArgs, ghTransport, parseIncluded, type GhCall } from "../src/main/engine/code-review/gh.js";

/**
 * The transport for #321: `gh api <fixed path> --method GET --include`, read back from the bytes `gh`
 * prints. A fake `gh` answers by the repository name in the endpoint, the way the real one answered
 * these cases on 2026-10-20 (gh 2.98.0): the status line ends in LF, headers in CRLF; a 304 or a 4xx
 * still prints the status line but exits 1; a missing sign-in exits 4; no network prints no status.
 */
const FAKE = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const endpoint = args[1] || "";
if (process.env.FAKE_GH_LOG) fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify({ args, cwd: process.cwd(),
  env: { GH_PROMPT_DISABLED: process.env.GH_PROMPT_DISABLED, GH_PAGER: process.env.GH_PAGER, GH_DEBUG: process.env.GH_DEBUG ?? null,
    NO_COLOR: process.env.NO_COLOR, GH_NO_UPDATE_NOTIFIER: process.env.GH_NO_UPDATE_NOTIFIER } }) + "\n");
const answer = (status, reason, headers, body, code) => {
  process.stdout.write("HTTP/2.0 " + status + " " + reason + "\n" + headers.map((h) => h + "\r\n").join("") + "\r\n" + body);
  process.stderr.write("gh: " + reason + " (HTTP " + status + ") ghp_fakeSecretThatMustNotEscape\n");
  process.exitCode = code;
};
switch (endpoint.split("/")[2]) {
  case "ok": answer(200, "OK", ["Content-Type: application/json; charset=utf-8", 'Etag: W/"abc123"', "X-Ratelimit-Remaining: 4719", "Link: <https://api.github.com/x?page=2>; rel=\"next\""], '{"id":7301}', 0); break;
  case "unchanged": answer(304, "Not Modified", ["X-Ratelimit-Remaining: 4719"], "", 1); break;
  case "missing": answer(404, "Not Found", ["Content-Type: application/json"], '{"message":"Not Found"}', 1); break;
  case "signedout": process.stderr.write("To get started with GitHub CLI, please run:  gh auth login\n"); process.exitCode = 4; break;
  case "offline": process.stderr.write('Get "https://api.github.com/x": dial tcp: lookup api.github.com: no such host\n'); process.exitCode = 1; break;
  case "broken": process.stderr.write("unknown flag: --frobnicate ghp_fakeSecretThatMustNotEscape\n"); process.exitCode = 1; break;
  case "slow": setTimeout(() => answer(200, "OK", [], "{}", 0), 5000); break;
  case "huge": process.stdout.write("HTTP/2.0 200 OK\n\r\n" + "x".repeat(300000)); break;
  case "binary": process.stdout.write(Buffer.concat([Buffer.from("HTTP/2.0 200 OK\nContent-Type: application/octet-stream\r\n\r\n"), Buffer.from([0, 255, 10, 13, 10])])); break;
  default: answer(500, "Internal Server Error", [], "{}", 1);
}
`;

function fakeGh(): { bin: string; log: string } {
  const dir = tmpdir("modex-fake-gh-");
  const bin = path.join(dir, "gh");
  fs.writeFileSync(bin, FAKE, { mode: 0o755 });
  return { bin, log: path.join(dir, "calls.jsonl") };
}

function call(endpoint: string, patch: Partial<GhCall> = {}): GhCall {
  return { endpoint, accept: "application/vnd.github+json", etag: null, maxBytes: 64 * 1024, timeoutMs: 3000, signal: new AbortController().signal, ...patch };
}

test("asks gh for one GET on github.com with the API version, and a known ETag when it has one", () => {
  assert.deepEqual(ghArgs(call("repos/example-org/lending/pulls/73")), ["api", "repos/example-org/lending/pulls/73", "--hostname", "github.com",
    "--method", "GET", "--include", "-H", "Accept: application/vnd.github+json", "-H", "X-GitHub-Api-Version: 2022-11-28"]);
  assert.deepEqual(ghArgs(call("user", { etag: 'W/"abc123"' })).slice(-2), ["-H", 'If-None-Match: W/"abc123"']);
  assert.deepEqual(ghArgs(call("repos/example-org/lending/contents/docs/holds.md?ref=" + "a".repeat(40), { accept: "application/vnd.github.raw" })).slice(7, 9),
    ["-H", "Accept: application/vnd.github.raw"]);
  // Only paths main builds itself: nothing a flag parser, gh's {owner} placeholders or a header could misread.
  for (const endpoint of ["-X", "--method=POST", "graphql", "https://example.invalid/x", "/repos/a/b", "repos/a/b pulls", "repos/{owner}/{repo}/pulls",
    "repos/a/b\n-X", "user/../graphql", "search/code?q=x", "", "repos/a/b/pulls/1\u0000"]) {
    assert.throws(() => ghArgs(call(endpoint)), /endpoint/, endpoint);
  }
  for (const etag of ['"x"\r\nAuthorization: token', "abc", 'W/"' + "a".repeat(300) + '"']) assert.throws(() => ghArgs(call("user", { etag })), /ETag/, etag);
  assert.throws(() => ghArgs(call("user", { accept: "text/html\r\nX: y" as GhCall["accept"] })), /media type/);
});

test("reads the status line, headers and body from gh's own bytes", () => {
  const parsed = parseIncluded(Buffer.from('HTTP/2.0 200 OK\nEtag: W/"abc"\r\nX-Ratelimit-Remaining: 7\r\n\r\n{"a":1}'));
  assert.deepEqual(parsed && { ...parsed, body: parsed.body.toString() }, { status: 200, headers: { etag: 'W/"abc"', "x-ratelimit-remaining": "7" }, body: '{"a":1}' });
  assert.equal(parseIncluded(Buffer.from("HTTP/2.0 304 Not Modified\nX-Ratelimit-Remaining: 7\r\n\r\n"))?.status, 304);
  assert.equal(parseIncluded(Buffer.from("HTTP/1.1 404 Not Found\r\n\r\n{}"))?.status, 404);
  for (const text of ["", "{\"a\":1}", "HTTP/2.0 2000 OK\n\r\n", "HTTP/2.0 200 OK\nno blank line", "Get \"https://api.github.com\": dial tcp"]) {
    assert.equal(parseIncluded(Buffer.from(text)), null, text);
  }
});

test("maps each way gh can end to a result that holds no stderr text", async () => {
  const { bin, log } = fakeGh();
  process.env.FAKE_GH_LOG = log;
  try {
    const gh = ghTransport(bin);
    const ok = await gh(call("repos/example-org/ok/pulls/73"));
    assert.equal(ok.kind, "http");
    if (ok.kind === "http") {
      assert.equal(ok.status, 200);
      assert.equal(ok.headers.etag, 'W/"abc123"');
      assert.match(ok.headers.link!, /rel="next"/);
      assert.equal(ok.body.toString(), '{"id":7301}');
    }
    const unchanged = await gh(call("repos/example-org/unchanged/pulls/73", { etag: 'W/"abc123"' }));
    assert.equal(unchanged.kind === "http" && unchanged.status, 304);
    const missing = await gh(call("repos/example-org/missing/pulls/73"));
    assert.equal(missing.kind === "http" && missing.status, 404);
    assert.equal((await gh(call("repos/example-org/signedout/pulls/73"))).kind, "signed-out");
    assert.equal((await gh(call("repos/example-org/offline/pulls/73"))).kind, "offline");
    assert.equal((await gh(call("repos/example-org/broken/pulls/73"))).kind, "failed");
    assert.equal((await gh(call("repos/example-org/slow/pulls/73", { timeoutMs: 300 }))).kind, "timeout");
    const stop = new AbortController();
    const cancelled = gh(call("repos/example-org/slow/pulls/73", { signal: stop.signal }));
    setTimeout(() => stop.abort(), 100);
    assert.equal((await cancelled).kind, "cancelled");
    assert.equal((await gh(call("repos/example-org/huge/pulls/73", { maxBytes: 1024 }))).kind, "too-large");
    const binary = await gh(call("repos/example-org/binary/contents/x?ref=" + "a".repeat(40), { accept: "application/vnd.github.raw" }));
    assert.deepEqual(binary.kind === "http" && [...binary.body], [0, 255, 10, 13, 10]);
    assert.equal((await ghTransport(path.join(path.dirname(bin), "no-such-gh"))(call("user"))).kind, "no-cli");
    assert.doesNotMatch(JSON.stringify([ok, unchanged, missing].map((r) => r.kind === "http" ? { ...r, body: r.body.toString() } : r)), /ghp_/);

    const calls = fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    for (const recorded of calls) {
      assert.equal(recorded.args[0], "api");
      assert.equal(recorded.args[recorded.args.indexOf("--method") + 1], "GET");
      assert.equal(recorded.args[recorded.args.indexOf("--hostname") + 1], "github.com");
      assert.deepEqual(recorded.env, { GH_PROMPT_DISABLED: "1", GH_PAGER: "cat", GH_DEBUG: null, NO_COLOR: "1", GH_NO_UPDATE_NOTIFIER: "1" });
      assert.ok(!recorded.args.some((arg: string) => /^(-X|--method=|-f|-F|--field|--raw-field|--input|--paginate)$/.test(arg)), recorded.args.join(" "));
    }
  } finally {
    delete process.env.FAKE_GH_LOG;
  }
});

test("never forwards gh debugging, which could print request headers", async () => {
  const { bin, log } = fakeGh();
  process.env.FAKE_GH_LOG = log;
  process.env.GH_DEBUG = "api";
  try {
    await ghTransport(bin)(call("repos/example-org/ok/pulls/73"));
    assert.equal(JSON.parse(fs.readFileSync(log, "utf8").trim()).env.GH_DEBUG, null);
  } finally {
    delete process.env.GH_DEBUG;
    delete process.env.FAKE_GH_LOG;
  }
});
