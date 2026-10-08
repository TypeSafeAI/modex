import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { WorkOSAuth, workosConfig } from "../src/main/engine/workos-auth.js";
import { testCipher, noCipher } from "../src/main/engine/secrets.js";

function fixture(options: { browser?: (url: URL) => Promise<void>; changedIdentity?: boolean; changedSession?: boolean; fail?: boolean; timeoutMs?: number } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "modex-workos-"));
  const requests: Record<string, string>[] = []; const urls: URL[] = [];
  let now = Date.now();
  const auth = new WorkOSAuth({ home, cipher: testCipher, config: workosConfig("staging"), now: () => now, timeoutMs: options.timeoutMs ?? 5000,
    openBrowser: async (raw) => { const url = new URL(raw); urls.push(url); if (url.pathname.endsWith("logout")) return;
      if (options.browser) return options.browser(url);
      const callback = new URL(url.searchParams.get("redirect_uri")!);
      callback.search = new URLSearchParams({ state: url.searchParams.get("state")!, code: "code-secret" }).toString();
      assert.equal((await fetch(callback)).status, 200);
    },
    fetch: (async (url, init) => {
      assert.equal(String(url), "https://api.workos.com/user_management/authenticate");
      assert.equal(init?.redirect, "error");
      const request = JSON.parse(String(init?.body)); requests.push(request);
      if (options.fail) return new Response("secret-error", { status: 400 });
      const subject = options.changedIdentity && request.grant_type === "refresh_token" ? "user_other" : "user_fixture";
      const access = `header.${Buffer.from(JSON.stringify({ sub: subject, sid: options.changedSession && request.grant_type === "refresh_token" ? "session_other" : "session_fixture", exp: Math.floor(now / 1000) + 3600 })).toString("base64url")}.signature`;
      return Response.json({ user: { id: subject, email: "val@example.test" }, access_token: access, refresh_token: `refresh-secret-${requests.length}`, oauth_tokens: { access_token: "github-secret" } });
    }) as typeof fetch,
  });
  return { auth, home, requests, urls, advance: () => { now += 3600000; }, cleanup: () => { auth.dispose(); fs.rmSync(home, { recursive: true, force: true }); } };
}

test("public GitHub PKCE sign-in persists only renewable identity and exposes no tokens", async () => {
  const f = fixture(); try {
    await f.auth.signIn();
    const url = f.urls[0]!; const req = f.requests[0]!;
    assert.equal(url.searchParams.get("provider"), "GitHubOAuth");
    assert.equal(url.searchParams.get("code_challenge"), createHash("sha256").update(req.code_verifier!).digest("base64url"));
    assert.equal(req.client_secret, undefined); assert.equal(url.searchParams.get("scope"), null);
    assert.equal(f.auth.status().user?.email, "val@example.test");
    assert.doesNotMatch(JSON.stringify(f.auth.status()), /secret|signature/);
    const files = fs.readdirSync(path.join(f.home, "app"));
    const content = testCipher.decrypt(fs.readFileSync(path.join(f.home, "app", files.find((x) => x.endsWith(".enc"))!)));
    assert.doesNotMatch(content, /github-secret|signature|access_token/);
    const reopened = new WorkOSAuth({ home: f.home, cipher: testCipher, config: workosConfig("staging"), openBrowser: async () => {} });
    assert.equal(reopened.status().user?.id, "user_fixture");
    await assert.rejects(reopened.refresh(), /instance/);
    reopened.dispose();
  } finally { f.cleanup(); }
});

test("callback rejects wrong state, duplicate parameters, method and host before accepting valid code", async () => {
  const f = fixture({ browser: async (url) => {
    const callback = new URL(url.searchParams.get("redirect_uri")!);
    callback.search = new URLSearchParams({ state: "wrong", code: "x" }).toString();
    assert.equal((await fetch(callback)).status, 400);
    callback.searchParams.set("state", url.searchParams.get("state")!);
    callback.searchParams.append("code", "duplicate");
    assert.equal((await fetch(callback)).status, 400);
    callback.searchParams.delete("code"); callback.searchParams.set("code", "valid");
    assert.equal((await fetch(callback, { method: "POST" })).status, 404);
    assert.equal((await fetch(callback, { headers: { host: "evil.test" } })).status, 404);
    assert.equal((await fetch(callback)).status, 200);
  } }); try { await f.auth.signIn(); assert.equal(f.requests.length, 1); } finally { f.cleanup(); }
});

test("refresh serializes rotation and rejects a changed identity", async () => {
  const f = fixture(); try { await f.auth.signIn(); f.advance(); await Promise.all([f.auth.refresh(), f.auth.refresh()]); assert.equal(f.requests.length, 2); assert.equal(f.requests[1]!.grant_type, "refresh_token"); } finally { f.cleanup(); }
  const changed = fixture({ changedIdentity: true }); try { await changed.auth.signIn(); changed.advance(); await assert.rejects(changed.auth.refresh(), /identity/); assert.equal(changed.auth.status().user?.id, "user_fixture"); } finally { changed.cleanup(); }
});

test("cancel, timeout and provider failure preserve a clean signed-out state and hide raw errors", async () => {
  const f = fixture({ browser: async () => { f.auth.cancel(); } }); try { await assert.rejects(f.auth.signIn(), /cancelled/); assert.equal(f.auth.status().user, null); } finally { f.cleanup(); }
  const timed = fixture({ browser: async () => {}, timeoutMs: 25 }); try { await assert.rejects(timed.auth.signIn(), /timed out/); } finally { timed.cleanup(); }
  const failed = fixture({ fail: true }); try { await assert.rejects(failed.auth.signIn(), (error: Error) => !error.message.includes("secret-error")); } finally { failed.cleanup(); }
});

test("sign-out clears local session and opens remote logout; production and staging stay isolated", async () => {
  const f = fixture(); try {
    await f.auth.signIn();
    const production = new WorkOSAuth({ home: f.home, cipher: testCipher, config: workosConfig(), openBrowser: async () => {} });
    assert.equal(production.status().user, null); production.dispose();
    const detail = await f.auth.signOut(); assert.match(detail, /locally/);
    assert.equal(f.auth.status().user, null); assert.equal(f.urls[1]!.searchParams.get("session_id"), "session_fixture");
  } finally { f.cleanup(); }
});

test("unavailable OS storage fails closed before opening a browser", async () => {
  const f = fixture(); try {
    const auth = new WorkOSAuth({ home: f.home, cipher: noCipher, config: workosConfig(), openBrowser: async () => { assert.fail("opened browser"); } });
    assert.equal(auth.status().available, false); await assert.rejects(auth.signIn(), /storage/); auth.dispose();
  } finally { f.cleanup(); }
});


test("refresh cannot replace the authenticated session even for the same user", async () => {
  const f = fixture({ changedSession: true }); try {
    await f.auth.signIn(); f.advance(); await assert.rejects(f.auth.refresh(), /identity/);
  } finally { f.cleanup(); }
});

test("corrupt storage is preserved and failed browser launch does not create a session", async () => {
  const f = fixture(); try {
    const file = path.join(f.home, "app", "workos-staging.enc");
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "corrupt");
    await assert.rejects(f.auth.signIn(), /preserved/); assert.equal(fs.readFileSync(file, "utf8"), "corrupt");
    assert.equal(f.urls.length, 0);
  } finally { f.cleanup(); }
  const failed = fixture({ browser: async () => { throw new Error("browser-secret-error"); } }); try {
    await assert.rejects(failed.auth.signIn(), /Could not open the system browser/); assert.equal(failed.auth.status().user, null);
  } finally { failed.cleanup(); }
});

test("shutdown cancels a listener and prevents later credential writes", async () => {
  const f = fixture({ browser: async () => { f.auth.dispose(); } }); try {
    await assert.rejects(f.auth.signIn(), /cancelled/); assert.equal(f.auth.status().user, null);
    await assert.rejects(f.auth.signIn(), /shutting down/);
  } finally { f.cleanup(); }
});

test("valid-state provider denial ends the attempt without token exchange", async () => {
  const f = fixture({ browser: async (url) => {
    const callback = new URL(url.searchParams.get("redirect_uri")!);
    callback.search = new URLSearchParams({ state: url.searchParams.get("state")!, error: "access_denied", error_description: "provider-secret" }).toString();
    assert.equal((await fetch(callback)).status, 400);
  } }); try { await assert.rejects(f.auth.signIn(), /denied/); assert.equal(f.requests.length, 0); } finally { f.cleanup(); }
});

test("dead unique process claims are recovered while live and unknown owners are preserved", async () => {
  const f = fixture(); try {
    const lock = path.join(f.home, "app", "workos-staging.enc.lock"); fs.mkdirSync(lock, { recursive: true });
    const dead = "2147483647-00000000-0000-0000-0000-000000000001.owner";
    fs.writeFileSync(path.join(lock, dead), "dead owner");
    await f.auth.signIn(); assert.equal(fs.existsSync(path.join(lock, dead)), false);
    assert.equal(fs.readdirSync(lock).length, 1); f.auth.dispose(); assert.equal(fs.readdirSync(lock).length, 0);
  } finally { f.cleanup(); }
  const uncertain = fixture(); try {
    const lock = path.join(uncertain.home, "app", "workos-staging.enc.lock"); fs.mkdirSync(lock, { recursive: true });
    fs.writeFileSync(path.join(lock, "unknown-owner"), "preserve");
    await assert.rejects(uncertain.auth.signIn(), /instance/);
    assert.deepEqual(fs.readdirSync(lock), ["unknown-owner"]);
  } finally { uncertain.cleanup(); }
});

test("completed callback cannot be replayed and the listener is released", async () => {
  const f = fixture(); try {
    await f.auth.signIn();
    const authorize = f.urls[0]!;
    const replay = new URL(authorize.searchParams.get("redirect_uri")!);
    replay.search = new URLSearchParams({ state: authorize.searchParams.get("state")!, code: "code-secret" }).toString();
    await assert.rejects(fetch(replay));
    assert.equal(f.requests.length, 1);
    assert.equal(f.auth.status().signingIn, false);
  } finally { f.cleanup(); }
});
