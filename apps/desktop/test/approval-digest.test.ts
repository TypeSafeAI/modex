import { test } from "node:test";
import assert from "node:assert/strict";
import { digestAction, digestClipped, scrubSecrets, MAX_COMMAND, MAX_TITLE, REDACTED } from "../src/main/engine/approvals/digest.js";
import type { ApprovalAction } from "../src/main/engine/backends/types.js";

const ctx = { project: { name: "modex", branch: "approval-rules" }, mode: "agent" as const };

test("Claude Edit: no old_string/new_string in the state; the path is kept", () => {
  const action: ApprovalAction = {
    backend: "claude", tool: "Edit", title: "edit apps/desktop/src/main/engine/runner.ts", cwd: "/Users/me/modex",
    input: { file_path: "apps/desktop/src/main/engine/runner.ts", old_string: "const OLD_BODY = 1;", new_string: "const NEW_BODY = 2;", replace_all: true },
  };
  const d = digestAction(action, ctx);
  const json = JSON.stringify(d);
  for (const leak of ["OLD_BODY", "NEW_BODY", "old_string", "new_string", "replace_all"]) assert.ok(!json.includes(leak), `${leak} leaked`);
  assert.deepEqual(d, {
    action: { backend: "claude", tool: "Edit", title: "edit apps/desktop/src/main/engine/runner.ts", cwd_name: "modex" },
    paths: ["apps/desktop/src/main/engine/runner.ts"],
    project: { name: "modex", branch: "approval-rules" },
    mode: "agent",
  });
});

test("Claude Write and MultiEdit: content and per-edit strings never appear", () => {
  const write = digestAction({ backend: "claude", tool: "Write", title: "write a.txt", input: { file_path: "a.txt", content: "TOP SECRET CONTENT" } }, ctx);
  assert.ok(!JSON.stringify(write).includes("TOP SECRET"));
  assert.deepEqual(write.paths, ["a.txt"]);
  const multi = digestAction({ backend: "claude", tool: "MultiEdit", title: "edit b.ts", input: { file_path: "b.ts", edits: [{ old_string: "AAA", new_string: "BBB" }, { file_path: "c.ts", old_string: "CCC", new_string: "DDD" }] } }, ctx);
  const json = JSON.stringify(multi);
  for (const leak of ["AAA", "BBB", "CCC", "DDD", "edits"]) assert.ok(!json.includes(leak), `${leak} leaked`);
  assert.deepEqual(multi.paths, ["b.ts", "c.ts"]);
});

test("Codex fileChange: no patch body, only paths and the escalation flag", () => {
  const d = digestAction({ backend: "codex", tool: "fileChange", title: "apply file changes", input: { paths: ["src/a.ts"], grantRoot: "/etc", patch: "*** Begin Patch\n+BODY", diff: "+BODY", changes: [{ path: "x", diff: "+BODY" }] }, escalation: true }, ctx);
  const json = JSON.stringify(d);
  for (const leak of ["BODY", "\"patch\"", "\"diff\"", "\"changes\""]) assert.ok(!json.includes(leak), `${leak} leaked`);
  assert.deepEqual(d.paths, ["/etc", "src/a.ts"]);
  assert.equal(d.action.escalation, true);
});

test("only allow-listed keys survive: an unknown field is absent", () => {
  const action = { backend: "claude", tool: "Bash", title: "$ ls", input: { command: "ls", description: "LIST THE THINGS", unknown_field: "SHOULD NOT PASS", nested: { secret: "NOPE" } }, extra_top: "NOPE_TOP" } as unknown as ApprovalAction;
  const d = digestAction(action, ctx);
  const json = JSON.stringify(d);
  for (const leak of ["LIST THE THINGS", "SHOULD NOT PASS", "NOPE", "unknown_field", "description", "extra_top"]) assert.ok(!json.includes(leak), `${leak} leaked`);
  assert.deepEqual(Object.keys(d).sort(), ["action", "command", "mode", "project"]);
  assert.deepEqual(Object.keys(d.action).sort(), ["backend", "title", "tool"]);
  assert.equal(d.command, "ls");
});

test("command text is clipped to 500 characters and the title carries the scrubbed command", () => {
  const long = "echo " + "x".repeat(800);
  const d = digestAction({ backend: "codex", tool: "command", title: long, input: { command: long } }, ctx);
  assert.equal(d.command!.length, MAX_COMMAND + 1, "500 characters plus an ellipsis");
  const s = digestAction({ backend: "claude", tool: "Bash", title: "$ GITHUB_TOKEN=abc123 gh pr list", input: { command: "GITHUB_TOKEN=abc123 gh pr list" } }, ctx);
  assert.equal(s.command, `GITHUB_TOKEN=${REDACTED} gh pr list`);
  assert.equal(s.action.title, `$ GITHUB_TOKEN=${REDACTED} gh pr list`);
  assert.ok(!JSON.stringify(s).includes("abc123"));
});

test("secret scrubber", () => {
  const cases: [string, string][] = [
    ["curl --token=abc123 https://x", `curl --token=${REDACTED} https://x`],
    ["cli --api-key sekrit run", `cli --api-key ${REDACTED} run`],
    ["mysql --password='p@ss word' db", `mysql --password=${REDACTED} db`],
    [`curl -H "Authorization: Bearer abc.def" https://api`, `curl -H "Authorization: ${REDACTED}" https://api`],
    ["echo sk-ant-api03-ABCDEFGHIJKLMNOP", `echo ${REDACTED}`],
    ["git clone https://ghp_ABCDEFGHIJKLMNOPQRST@github.com/x", `git clone https://${REDACTED}@github.com/x`],
    ["OPENAI_API_KEY=sk-xyz12345678 npm start", `OPENAI_API_KEY=${REDACTED} npm start`],
    ["FOO=1 BAR=two npm test", `FOO=${REDACTED} BAR=${REDACTED} npm test`],
    ["cd x && TOKEN=t0k node a.js", `cd x && TOKEN=${REDACTED} node a.js`],
    ["git push https://user:hunter2@example.com/repo.git", `git push https://user:${REDACTED}@example.com/repo.git`],
    ["aws s3 ls # AKIAABCDEFGHIJKLMNOP", `aws s3 ls # ${REDACTED}`],
    ["npm test -- --watch=false", "npm test -- --watch=false"],
    ["git status", "git status"],
    ["rm -rf dist", "rm -rf dist"],
  ];
  for (const [input, want] of cases) assert.equal(scrubSecrets(input), want, input);
});

test("no branch and no cwd: those keys are simply absent", () => {
  const d = digestAction({ backend: "mock", tool: "shell", title: "$ ls", input: { command: "ls" } }, { project: { name: "p", branch: null }, mode: "chat" });
  assert.deepEqual(d, { action: { backend: "mock", tool: "shell", title: "$ ls" }, command: "ls", project: { name: "p" }, mode: "chat" });
});

test("digestClipped: true exactly when Jev would see a clipped command, or a clipped title that is not the command", () => {
  const bash = (command: string): ApprovalAction => ({ backend: "claude", tool: "Bash", title: `$ ${command}`, input: { command } });
  const atLimit = "echo " + "x".repeat(MAX_COMMAND - 5);
  assert.equal(digestClipped(bash(atLimit)), false, "exactly MAX_COMMAND is not clipped");
  assert.equal(digestClipped(bash(atLimit + "x")), true);
  assert.equal(digestClipped({ backend: "codex", tool: "command", title: atLimit + "x" }), true, "Codex title-only command");
  // Scrubbing happens before clipping: a long secret that shrinks to «redacted» leaves the rest visible.
  assert.equal(digestClipped(bash(`curl --token=${"t".repeat(MAX_COMMAND)} https://x`)), false);
  // A Bash title over MAX_TITLE adds nothing while the command fits.
  assert.equal(digestClipped(bash("echo " + "x".repeat(MAX_TITLE))), false);
  assert.equal(digestClipped({ backend: "claude", tool: "WebFetch", title: "fetch " + "u".repeat(MAX_TITLE), input: { url: "u" } }), true);
  assert.equal(digestClipped({ backend: "claude", tool: "Edit", title: "edit a.ts", input: { file_path: "d/".repeat(MAX_TITLE / 2) + "a.ts" } }), true, "rebuilt edit titles count");
  assert.equal(digestClipped({ backend: "claude", tool: "Edit", title: "edit a.ts", input: { file_path: "a.ts" } }), false);
  for (const action of [bash(atLimit + "x"), bash("echo " + "x".repeat(MAX_TITLE))]) {
    const d = digestAction(action, ctx);
    assert.equal(d.command!.endsWith("…"), digestClipped(action), "agrees with what digestAction sends");
  }
});
