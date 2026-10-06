import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { gitRepo, tmpdir } from "./helpers.js";
import { ThreadContextReader } from "../src/main/engine/thread-context.js";

function repository(remote = "git@github.com:TypeSafeAI/modex.git") {
  const repo = gitRepo();
  execFileSync("git", ["remote", "add", "origin", remote], { cwd: repo });
  execFileSync("git", ["switch", "-qc", "release/sidebar"], { cwd: repo });
  return repo;
}
const pull = (patch: Record<string, unknown> = {}) => ({ number: 128, title: "Release details", state: "open", draft: false, merged_at: null,
  head: { ref: "release/sidebar", repo: { full_name: "TypeSafeAI/modex" } }, base: { repo: { full_name: "TypeSafeAI/modex" } }, ...patch });

test("reads real checkout metadata and handles non-repo, missing remote and detached HEAD without GitHub", async () => {
  const reader = new ThreadContextReader({ query: async () => { throw new Error("must not call GitHub"); } });
  assert.equal((await reader.read(tmpdir())).isRepo, false);
  assert.equal((await reader.read(gitRepo())).pullRequest.state, "no-remote");
  const repo = repository();
  execFileSync("git", ["checkout", "--detach", "-q"], { cwd: repo });
  const context = await reader.read(repo);
  assert.equal(context.branch, null);
  assert.equal(context.pullRequest.state, "detached");
});

test("maps PR lifecycle and constructs trusted links from the configured GitHub repository", async () => {
  const repo = repository();
  for (const [patch, state] of [[{}, "open"], [{ draft: true }, "draft"], [{ state: "closed" }, "closed"], [{ state: "closed", merged_at: "2026-10-06T00:00:00Z" }, "merged"]] as const) {
    const reader = new ThreadContextReader({ query: async (args) => {
      assert.ok(args.includes("--hostname"));
      assert.ok(args.includes("github.com"));
      assert.match(args[1]!, /head=TypeSafeAI%3Arelease%2Fsidebar/);
      assert.match(args[1]!, /state=all/);
      return JSON.stringify([pull({ ...patch, html_url: "https://attacker.invalid" })]);
    } });
    const result = await reader.read(repo);
    assert.equal(result.branch, "release/sidebar");
    assert.equal(result.pullRequest.state, state);
    assert.equal("url" in result.pullRequest && result.pullRequest.url, "https://github.com/TypeSafeAI/modex/pull/128");
  }
});

test("new worktrees tracking main query their own branch in the fork", async () => {
  const repo = repository("https://github.com/BunsDev/modex.git");
  execFileSync("git", ["remote", "add", "upstream", "https://github.com/TypeSafeAI/modex.git"], { cwd: repo });
  execFileSync("git", ["config", "branch.release/sidebar.remote", "origin"], { cwd: repo });
  execFileSync("git", ["config", "branch.release/sidebar.merge", "refs/heads/main"], { cwd: repo });
  const reader = new ThreadContextReader({ query: async (args) => {
    assert.match(args[1]!, /^repos\/TypeSafeAI\/modex\/pulls\?/);
    assert.match(args[1]!, /head=BunsDev%3Arelease%2Fsidebar/);
    return JSON.stringify([pull({ head: { ref: "release/sidebar", repo: { full_name: "BunsDev/modex" } } })]);
  } });
  assert.equal((await reader.read(repo)).pullRequest.state, "open");
});

test("uses the push URL owner while preserving the canonical fetch repository as the base", async () => {
  const repo = repository();
  execFileSync("git", ["remote", "set-url", "--push", "origin", "git@github.com:BunsDev/modex.git"], { cwd: repo });
  const reader = new ThreadContextReader({ query: async (args) => {
    assert.match(args[1]!, /^repos\/TypeSafeAI\/modex\/pulls\?/);
    assert.match(args[1]!, /head=BunsDev%3Arelease%2Fsidebar/);
    return JSON.stringify([pull({ head: { ref: "release/sidebar", repo: { full_name: "BunsDev/modex" } } })]);
  } });
  assert.equal((await reader.read(repo)).pullRequest.state, "open");
});

test("an active PR takes precedence over a recently updated closed PR for a reused branch", async () => {
  const reader = new ThreadContextReader({ query: async () => JSON.stringify([pull({ state: "closed", number: 127 }), pull()]) });
  const pr = (await reader.read(repository())).pullRequest;
  assert.equal(pr.state, "open");
  assert.equal("number" in pr && pr.number, 128);
});

test("a branch tracking a named fork uses that push destination and origin as the base", async () => {
  const repo = repository();
  execFileSync("git", ["remote", "add", "fork", "git@github.com:BunsDev/modex.git"], { cwd: repo });
  execFileSync("git", ["config", "branch.release/sidebar.remote", "fork"], { cwd: repo });
  execFileSync("git", ["config", "branch.release/sidebar.merge", "refs/heads/release/sidebar"], { cwd: repo });
  const reader = new ThreadContextReader({ query: async (args) => {
    assert.match(args[1]!, /^repos\/TypeSafeAI\/modex\/pulls\?/);
    assert.match(args[1]!, /head=BunsDev%3Arelease%2Fsidebar/);
    return JSON.stringify([pull({ head: { ref: "release/sidebar", repo: { full_name: "BunsDev/modex" } } })]);
  } });
  assert.equal((await reader.read(repo)).pullRequest.state, "open");
});

test("triangular remotes keep the tracked canonical base while pushDefault selects the fork", async () => {
  const repo = repository("https://github.com/BunsDev/modex.git");
  execFileSync("git", ["remote", "add", "canonical", "https://github.com/TypeSafeAI/modex.git"], { cwd: repo });
  execFileSync("git", ["config", "branch.release/sidebar.remote", "canonical"], { cwd: repo });
  execFileSync("git", ["config", "branch.release/sidebar.merge", "refs/heads/main"], { cwd: repo });
  execFileSync("git", ["config", "remote.pushDefault", "origin"], { cwd: repo });
  const reader = new ThreadContextReader({ query: async (args) => {
    assert.match(args[1]!, /^repos\/TypeSafeAI\/modex\/pulls\?/);
    assert.match(args[1]!, /head=BunsDev%3Arelease%2Fsidebar/);
    return JSON.stringify([pull({ head: { ref: "release/sidebar", repo: { full_name: "BunsDev/modex" } } })]);
  } });
  assert.equal((await reader.read(repo)).pullRequest.state, "open");
});

test("unavailable and disabled reads cannot masquerade as no PR", async () => {
  const repo = repository();
  assert.equal((await new ThreadContextReader({ query: async () => "[]" }).read(repo)).pullRequest.state, "none");
  for (const query of [async () => { throw new Error("sensitive auth error"); }, async () => "not json", async () => JSON.stringify([{ number: 1 }])]) {
    const result = await new ThreadContextReader({ query }).read(repo);
    assert.equal(result.pullRequest.state, "unavailable");
    assert.doesNotMatch(JSON.stringify(result), /sensitive/);
  }
  assert.equal((await new ThreadContextReader({ enabled: false, query: async () => { throw new Error("offline"); } }).read(repo)).pullRequest.state, "disabled");
  const unsupported = repository("https://github.com.attacker.invalid/owner/repo.git");
  assert.equal((await new ThreadContextReader({ query: async () => { throw new Error("unsupported host"); } }).read(unsupported)).pullRequest.state, "no-remote");
});

test("coalesces and caches requests but a checkout change cannot reuse the previous branch PR", async () => {
  const repo = repository();
  let calls = 0, now = 0;
  const reader = new ThreadContextReader({ now: () => now, query: async () => { calls++; return JSON.stringify([pull()]); } });
  await Promise.all([reader.read(repo), reader.read(repo)]);
  await reader.read(repo);
  assert.equal(calls, 1);
  now = 61_000;
  await reader.read(repo);
  assert.equal(calls, 2);
  execFileSync("git", ["switch", "-qc", "different-branch"], { cwd: repo });
  const changed = await reader.read(repo);
  assert.equal(calls, 3);
  assert.equal(changed.branch, "different-branch");
  assert.equal(changed.pullRequest.state, "none");
});
