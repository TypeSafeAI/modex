import { test } from "node:test";
import assert from "node:assert/strict";
import { fillFrom1Password, matchingLogins } from "../src/main/engine/browser-credentials.js";

const id = "a".repeat(26), vault = "b".repeat(26);
const login = { id, title: "Example account", category: "LOGIN", vault: { id: vault }, urls: [{ href: "https://example.com/login" }] };
const secret = { ...login, fields: [{ purpose: "USERNAME", value: "val@example.com" }, { purpose: "PASSWORD", value: "secret-only-for-page" }] };

test("1Password matches only exact HTTPS origins, with metadata only", () => {
  assert.deepEqual(matchingLogins([login, { ...login, id: "c".repeat(26), urls: [{ href: "https://other.example.com" }] }], "https://example.com"), [{ id, vault, title: "Example account" }]);
  for (const origin of ["http://example.com", "https://example.com:444", "https://sub.example.com", "https://example.com.attacker.test"]) assert.deepEqual(matchingLogins([login], origin), []);
  assert.deepEqual(matchingLogins([{ ...login, urls: [{ href: "https://user:secret@example.com" }] }], "https://example.com"), []);
  assert.deepEqual(matchingLogins([{ ...login, urls: [{ href: "example.com" }] }], "https://example.com"), [{ id, vault, title: "Example account" }]);
  assert.deepEqual(matchingLogins([{ ...login, urls: [{ href: "http://example.com" }, { href: "ftp://example.com" }] }], "https://example.com"), []);
});

test("filling reads a password only after selection and delivers it only to the current page", async () => {
  const commands: string[][] = [];
  let filled: unknown;
  const result = await fillFrom1Password({ url: "https://example.com/login", isCurrent: () => true, fill: async fields => { filled = fields; return true; } }, {
    read: async args => { commands.push(args); return args[1] === "list" ? [login] : secret; },
    choose: async entries => { assert.equal(commands.length, 1); assert.deepEqual(entries, [{ id, vault, title: "Example account" }]); return 0; },
  });
  assert.equal(result, true);
  assert.deepEqual(filled, { username: "val@example.com", password: "secret-only-for-page" });
  assert.deepEqual(commands[1], ["item", "get", id, "--vault", vault, "--format=json"]);
});

test("cancelling or navigating while listing, selecting or unlocking never fills credentials", async () => {
  for (const phase of ["cancel", "list", "choose", "get"]) {
    let current = true, reads = 0, fills = 0;
    const run = fillFrom1Password({ url: "https://example.com/login", isCurrent: () => current, fill: async () => { fills++; return true; } }, {
      read: async args => { reads++; if (phase === args[1]) current = false; return args[1] === "list" ? [login] : secret; },
      choose: async () => { if (phase === "choose") current = false; return phase === "cancel" ? undefined : 0; },
    });
    if (phase === "cancel") assert.equal(await run, false); else await assert.rejects(run, /page changed/i);
    assert.equal(fills, 0);
    assert.equal(reads, phase === "get" ? 2 : 1);
  }
});

test("stale item origins, new-password-only logins and insecure pages fail without disclosure", async () => {
  const target = { url: "https://example.com/login", isCurrent: () => true, fill: async () => { throw new Error("must not fill"); } };
  for (const item of [{ ...secret, urls: [{ href: "https://elsewhere.test" }] }, { ...secret, id: "c".repeat(26) }, { ...secret, fields: [] }]) {
    await assert.rejects(fillFrom1Password(target, { read: async args => args[1] === "list" ? [login] : item, choose: async () => 0 }), /no longer|username or password/i);
  }
  await assert.rejects(fillFrom1Password({ ...target, url: "http://localhost:3000" }, { read: async () => { throw new Error("must not query vault"); }, choose: async () => 0 }), /HTTPS/);
  await assert.rejects(fillFrom1Password(target, { read: async () => { throw new Error("credential SECRET in stderr"); }, choose: async () => 0 }), error => error instanceof Error && !error.message.includes("SECRET"));
});
