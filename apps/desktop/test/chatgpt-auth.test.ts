import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateKeyPairSync, sign, createHash, randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { ChatGPTAuth } from "../src/main/engine/chatgpt-auth.js";
import { noCipher, type Cipher } from "../src/main/engine/secrets.js";

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...keys.publicKey.export({ format: "jwk" }), kid: "fixture", alg: "RS256", use: "sig" };
const issuer = "https://auth.openai.com";
const scopes = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
function token(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "fixture" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${header}.${body}.${sign("RSA-SHA256", Buffer.from(`${header}.${body}`), keys.privateKey).toString("base64url")}`;
}
function fixture(options: { claims?: Record<string, unknown>; scope?: string; refreshScope?: string; failRevoke?: boolean; tamper?: boolean; browser?: (url: URL) => Promise<void> } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "modex-chatgpt-"));
  const storageKey = randomBytes(32);
  const cipher: Cipher = { name: "fixture AES-GCM", available: () => true,
    encrypt: (plain) => { const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", storageKey, iv); const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), encrypted]); },
    decrypt: (blob) => { const decipher = createDecipheriv("aes-256-gcm", storageKey, blob.subarray(0, 12)); decipher.setAuthTag(blob.subarray(12, 28)); return Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]).toString(); },
  };
  let current = new URL(issuer); let now = Date.now(); let refreshCount = 0;
  const requests: { url: string; form: URLSearchParams }[] = [];
  const authorizations: URL[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); const form = new URLSearchParams(String(init?.body ?? "")); requests.push({ url, form });
    let result: unknown;
    if (url.endsWith("openid-configuration")) result = { issuer, jwks_uri: `${issuer}/keys`, revocation_endpoint: `${issuer}/revoke` };
    else if (url.endsWith("/keys")) result = { keys: [jwk] };
    else if (url.endsWith("/revoke")) return new Response("", { status: options.failRevoke ? 503 : 200 });
    else {
      const refresh = form.get("grant_type") === "refresh_token";
      if (refresh) { refreshCount++; await new Promise((resolve) => setTimeout(resolve, 10)); }
      result = { access_token: refresh ? "ROTATED_SECRET" : "ACCESS_SECRET", refresh_token: refresh ? "ROTATED_REFRESH" : "REFRESH_SECRET", token_type: "Bearer", expires_in: 3600, scope: (refresh ? options.refreshScope : undefined) ?? options.scope ?? scopes,
        id_token: token({ iss: issuer, aud: form.get("client_id"), sub: "fixture-subject", email: "same@example.test", exp: Math.floor(now / 1000) + 3600, nonce: current.searchParams.get("nonce"), ...options.claims }) };
    }
    if (options.tamper && result && typeof result === "object" && "id_token" in result) {
      const response = result as { id_token: string }; response.id_token = response.id_token.slice(0, -8) + "AAAAAAAA";
    }
    return new Response(JSON.stringify(result), { status: 200 });
  }) as typeof fetch;
  const auth = new ChatGPTAuth({ home, cipher, fetch: fetchImpl, now: () => now, timeoutMs: 1000, openBrowser: async (raw) => {
    current = new URL(raw); authorizations.push(current);
    if (options.browser) return options.browser(current);
    const callback = new URL(current.searchParams.get("redirect_uri")!);
    callback.search = new URLSearchParams({ state: current.searchParams.get("state")!, code: "CODE_SECRET", client_id: current.searchParams.get("client_id") === "dynamic_agent_client" ? "oaiapp_fixture" : current.searchParams.get("client_id")! }).toString();
    const response = await fetch(callback); assert.equal(response.status, 200);
  } });
  const cleanup = () => { auth.dispose(); fs.rmSync(home, { recursive: true, force: true }); };
  return { auth, home, cipher, requests, authorizations, cleanup, advance: () => { now += 3550000; }, refreshCount: () => refreshCount };
}

test("public registration binds issued client, identity, PKCE, host and protected storage", async () => {
  const f = fixture();
  try {
    await f.auth.signIn();
    const first = f.authorizations[0]!;
    assert.equal(first.searchParams.get("client_id"), "dynamic_agent_client");
    assert.equal(first.searchParams.get("agent_name_hint"), "modex");
    assert.equal(new URL(first.searchParams.get("redirect_uri")!).hostname, "127.0.0.1");
    assert.equal(new URL(first.searchParams.get("redirect_uri")!).pathname, "/auth/callback");
    const exchange = f.requests.find((request) => request.form.get("grant_type") === "authorization_code")!;
    assert.equal(exchange.form.get("client_id"), "oaiapp_fixture");
    assert.equal(exchange.form.get("redirect_uri"), first.searchParams.get("redirect_uri"));
    assert.equal(createHash("sha256").update(exchange.form.get("code_verifier")!).digest("base64url"), first.searchParams.get("code_challenge"));
    assert.equal(exchange.form.has("client_secret"), false);
    const status = f.auth.status(); assert.equal(status.accounts[0]!.planEnabled, true);
    assert.equal(fs.readFileSync(path.join(f.home, "app", "chatgpt.enc")).includes(Buffer.from("ACCESS_SECRET")), false);
    assert.equal(JSON.stringify(status).includes("SECRET"), false);
    await f.auth.signIn(status.active!);
    assert.equal(f.authorizations[1]!.searchParams.get("client_id"), "oaiapp_fixture");
    assert.equal(f.authorizations[1]!.searchParams.get("ext_agent_host_id"), first.searchParams.get("ext_agent_host_id"));
    assert.equal(f.authorizations[1]!.searchParams.has("agent_name_hint"), false);
    assert.equal(f.auth.status().accounts.length, 1);
  } finally { f.cleanup(); }
});

test("bad issuer, audience, nonce, expiry or returning identity cannot replace accounts", async () => {
  for (const claims of [{ iss: "https://evil.test" }, { aud: "wrong" }, { nonce: "wrong" }, { exp: 1 }, { sub: "" }]) {
    const f = fixture({ claims });
    try { await assert.rejects(f.auth.signIn()); assert.equal(f.auth.status().accounts.length, 0); }
    finally { f.cleanup(); }
  }
});

test("returning subject mismatch preserves the previous validated account", async () => {
  const claims: Record<string, unknown> = {}; const f = fixture({ claims });
  try {
    await f.auth.signIn(); const previous = f.auth.status(); claims.sub = "different-subject";
    await assert.rejects(f.auth.signIn(previous.active!));
    assert.deepEqual(f.auth.status(), previous);
  } finally { f.cleanup(); }
});

test("tampered ID-token signature never activates an account", async () => {
  const f = fixture({ tamper: true });
  try { await assert.rejects(f.auth.signIn(), /signature/); assert.equal(f.auth.status().accounts.length, 0); }
  finally { f.cleanup(); }
});

test("same email with distinct issued client registrations remains separate", async () => {
  let issued = 0;
  const f = fixture({ browser: async (url) => {
    const callback = new URL(url.searchParams.get("redirect_uri")!);
    callback.search = new URLSearchParams({ state: url.searchParams.get("state")!, code: "code", client_id: `oaiapp_workspace_${++issued}` }).toString();
    await fetch(callback);
  } });
  try {
    await f.auth.signIn(); await f.auth.signIn(); const status = f.auth.status();
    assert.equal(status.accounts.length, 2); assert.equal(status.accounts[0]!.label, status.accounts[1]!.label);
    assert.notEqual(status.accounts[0]!.id, status.accounts[1]!.id);
  } finally { f.cleanup(); }
});

test("replayed callback cannot exchange the same code twice", async () => {
  const f = fixture({ browser: async (url) => {
    const callback = new URL(url.searchParams.get("redirect_uri")!);
    callback.search = new URLSearchParams({ state: url.searchParams.get("state")!, code: "code", client_id: "oaiapp_fixture" }).toString();
    const responses = await Promise.allSettled([fetch(callback), fetch(callback)]);
    assert.equal(responses.filter((result) => result.status === "fulfilled" && result.value.status === 200).length, 1);
  } });
  try { await f.auth.signIn(); assert.equal(f.requests.filter((request) => request.form.has("code")).length, 1); }
  finally { f.cleanup(); }
});

test("wrong state and callback path do not exchange codes; callback is consumed once", async () => {
  let exchanges = 0;
  const f = fixture({ browser: async (url) => {
    const callback = new URL(url.searchParams.get("redirect_uri")!);
    callback.search = new URLSearchParams({ state: "wrong", code: "code", client_id: "oaiapp_fixture" }).toString();
    assert.equal((await fetch(callback)).status, 400);
    callback.pathname = "/callback"; assert.equal((await fetch(callback)).status, 404);
    f.auth.cancel();
  } });
  try { await assert.rejects(f.auth.signIn()); exchanges = f.requests.filter((request) => request.form.has("code")).length; assert.equal(exchanges, 0); }
  finally { f.cleanup(); }
});

test("identity-only scopes never authorize model execution", async () => {
  const f = fixture({ scope: "openid profile email offline_access" });
  try { await f.auth.signIn(); assert.equal(f.auth.status().accounts[0]!.planEnabled, false); await assert.rejects(f.auth.grant(f.auth.status().active!), /plan usage/); }
  finally { f.cleanup(); }
});

test("concurrent consumers serialize rotating refresh and use issued client registration", async () => {
  const f = fixture();
  try {
    await f.auth.signIn(); const id = f.auth.status().active!; f.advance();
    const [left, right] = await Promise.all([f.auth.grant(id), f.auth.grant(id)]);
    assert.equal(left.token, "ROTATED_SECRET"); assert.deepEqual(left, right); assert.equal(f.refreshCount(), 1);
    const refresh = f.requests.find((request) => request.form.get("grant_type") === "refresh_token")!;
    assert.equal(refresh.form.get("client_id"), "oaiapp_fixture"); assert.equal(refresh.form.has("scope"), false);
  } finally { f.cleanup(); }
});

test("plan labels and execution both require resource.invoke", async () => {
  const f = fixture({ scope: "openid profile email offline_access chatgpt.tokens.use.direct" });
  try {
    await f.auth.signIn();
    assert.equal(f.auth.status().accounts[0]!.planEnabled, false);
    await assert.rejects(f.auth.grant(f.auth.status().active!), /plan usage/);
  } finally { f.cleanup(); }
});

test("reduced refresh permissions preserve rotation without allowing execution", async () => {
  const f = fixture({ refreshScope: "openid profile email offline_access" });
  try {
    await f.auth.signIn(); const id = f.auth.status().active!; f.advance();
    await assert.rejects(f.auth.grant(id), /permission is missing/);
    assert.equal(f.auth.status().accounts[0]!.planEnabled, false);
    await assert.rejects(f.auth.grant(id), /plan usage/);
    assert.equal(f.refreshCount(), 1);
    await f.auth.signOut(id);
    assert.equal(f.requests.find((request) => request.url.endsWith("/revoke"))!.form.get("token"), "ROTATED_REFRESH");
  } finally { f.cleanup(); }
});

test("sign-out revokes renewable session; offline sign-out clearly reports unconfirmed revocation", async () => {
  for (const failRevoke of [false, true]) {
    const f = fixture({ failRevoke });
    try {
      await f.auth.signIn(); const id = f.auth.status().active!;
      const message = await f.auth.signOut(id);
      assert.equal(message.includes("not confirmed"), failRevoke);
      assert.equal(f.auth.status().accounts[0]!.signedIn, false);
      assert.equal(f.auth.identity(), "cli");
      assert.equal(f.requests.find((request) => request.url.endsWith("/revoke"))!.form.get("token_type_hint"), "refresh_token");
      await assert.rejects(f.auth.grant(id));
      await f.auth.signIn(id); assert.equal(f.authorizations[1]!.searchParams.has("id_token_hint"), false);
    } finally { f.cleanup(); }
  }
});

test("unavailable cipher refuses browser authorization and concurrent instances cannot refresh", async () => {
  const f = fixture(); let browser = false;
  const unavailable = new ChatGPTAuth({ home: path.join(f.home, "unavailable"), cipher: noCipher, openBrowser: async () => { browser = true; } });
  try {
    await assert.rejects(unavailable.signIn()); assert.equal(browser, false);
    await f.auth.signIn();
    const other = new ChatGPTAuth({ home: f.home, cipher: f.cipher, openBrowser: async () => {} });
    await assert.rejects(other.grant(f.auth.status().active!), /Another Modex/);
    other.dispose();
  } finally { unavailable.dispose(); f.cleanup(); }
});
