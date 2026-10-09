import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import type { TLSSocket } from "node:tls";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { CompanionServer } from "../src/main/engine/companion.js";
import { DEFAULT_SETTINGS } from "../src/main/engine/store.js";
import type { CompanionAdvertisement } from "../src/main/engine/companion-discovery.js";
import type { AppState, ApprovalAnswer, ThreadItem } from "../src/shared/types.js";

test("companion preserves pairing across offline startup, network recovery and port changes", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "modex-companion-reconnect-"));
  let addresses = ["127.0.0.1"];
  const advertised: CompanionAdvertisement[] = [];
  let withdrawn = 0;
  const source = { state: () => ({ version: 1 as const, projects: [], threads: [], settings: DEFAULT_SETTINGS }),
    items: () => [], status: () => "idle", send: async () => ({ ok: true }), answer: () => {} };
  const publisher = (service: CompanionAdvertisement) => { advertised.push(service); return () => { withdrawn++; }; };
  let server = new CompanionServer(home, source, () => addresses, publisher);
  const decode = (uri: string) => JSON.parse(Buffer.from(new URL(uri).searchParams.get("data")!, "base64url").toString());
  const blocker = net.createServer();
  try {
    const first = await server.start();
    const original = decode(first.pairingUri!);
    await server.dispose();
    assert.equal(withdrawn, 1);
    addresses = [];
    server = new CompanionServer(home, source, () => addresses, publisher);
    assert.equal(server.shouldStart, true);
    await assert.rejects(server.start(), /local network/);
    assert.equal(server.shouldStart, true, "an offline launch must not forget the enabled service");
    await new Promise<void>((resolve) => blocker.listen(first.port, "127.0.0.1", resolve));
    addresses = ["127.0.0.1"];
    await server.refreshNetwork();
    const restored = decode(server.status().pairingUri!);
    assert.notEqual(restored.url, original.url);
    assert.equal(restored.token, original.token);
    assert.equal(restored.fingerprint, original.fingerprint);
    assert.equal(advertised.at(-1)?.port, server.status().port);
    assert.ok(!JSON.stringify(advertised).includes(original.token), "Bonjour must never advertise credentials");
    addresses = [];
    await server.refreshNetwork();
    assert.equal(server.status().pairingUri, undefined);
    assert.equal(server.shouldStart, true);
    addresses = ["127.0.0.1"];
    await server.refreshNetwork();
    assert.equal(decode(server.status().pairingUri!).token, original.token);
    server.resetAccess();
    const revoked = decode(server.status().pairingUri!);
    assert.notEqual(revoked.token, original.token);
    await server.dispose();
    server = new CompanionServer(home, source, () => addresses, publisher);
    assert.equal(decode((await server.start()).pairingUri!).token, revoked.token, "revocation survives a Mac restart");
    await server.stop();
    await server.refreshNetwork();
    assert.equal(server.shouldStart, false, "reconnection cannot undo the Mac's Turn off action");
  } finally {
    await server.stop();
    if (blocker.listening) await new Promise<void>((resolve) => blocker.close(() => resolve()));
    fs.rmSync(home, { recursive: true, force: true });
  }
});

for (const shutdown of ["stop", "dispose"] as const) {
  test(`${shutdown} cancels companion startup before it finishes listening`, async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "modex-companion-start-"));
    const server = new CompanionServer(home, {
      state: () => ({ version: 1, projects: [], threads: [], settings: DEFAULT_SETTINGS }),
      items: () => [], status: () => "idle", send: async () => ({ ok: true }), answer: () => {},
    }, () => ["127.0.0.1"]);
    try {
      const starting = server.start();
      const stopping = server[shutdown]();
      await Promise.all([starting, stopping]);
      assert.equal(server.status().enabled, false);
      assert.equal(server.shouldStart, false);
    } finally {
      await server.stop();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
}

for (const revoke of ["resetAccess", "stop"] as const) {
  for (const action of ["send", "answer"] as const) {
    test(`${revoke} rejects an authenticated ${action} whose body is still arriving`, { timeout: 5000 }, async () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "modex-companion-revoke-"));
      const actions: string[] = [];
      let reached!: () => void;
      const authorized = new Promise<void>((resolve) => { reached = resolve; });
      const server = new CompanionServer(home, {
        state: () => {
          reached();
          return { version: 1, projects: [], threads: [{ id: "abcdef12", projectId: "p1", title: "Example", backend: "mock", status: "idle", cwd: "/tmp", mode: "chat", model: "mock", plan: false, createdAt: "now", updatedAt: "now" }], settings: DEFAULT_SETTINGS };
        },
        items: () => [{ id: "approval-1", kind: "approval", question: "Apply?", at: "now" }],
        status: () => action === "answer" ? "waiting" : "idle",
        send: async () => { actions.push("send"); return { ok: true }; },
        answer: () => { actions.push("answer"); },
      }, () => ["127.0.0.1"]);
      let req: ReturnType<typeof https.request> | undefined;
      try {
        const pairing = await server.start();
        const data = new URL(pairing.pairingUri!).searchParams.get("data")!;
        const credentials = JSON.parse(Buffer.from(data, "base64url").toString()) as { url: string; token: string };
        const response = new Promise<number>((resolve, reject) => {
          req = https.request(`${credentials.url}/v1/threads/abcdef12/${action}`, {
            method: "POST", rejectUnauthorized: false,
            headers: { authorization: `Bearer ${credentials.token}`, "content-type": "application/json" },
          }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode!)); });
          req.on("error", (error: NodeJS.ErrnoException) => {
            if (revoke === "stop" && error.code === "ECONNRESET") resolve(0);
            else reject(error);
          });
          req.write("{");
        });
        await authorized;
        const revoked = server[revoke]();
        req!.end(action === "send" ? '"text":"follow up"}' : '"itemId":"approval-1","answer":"yes"}');
        const status = await response;
        assert.ok(status === 401 || (revoke === "stop" && status === 0), `revoked request returned ${status}`);
        await revoked;
        assert.deepEqual(actions, []);
      } finally {
        req?.destroy();
        await server.stop();
        fs.rmSync(home, { recursive: true, force: true });
      }
    });
  }
}

test("companion pairing works with the OpenSSL shipped by macOS", { skip: process.platform !== "darwin" }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "modex-companion-system-ssl-"));
  const server = new CompanionServer(home, {
    state: () => ({ version: 1, projects: [], threads: [], settings: DEFAULT_SETTINGS }),
    items: () => [], status: () => "idle", send: async () => ({ ok: true }), answer: () => {},
  }, () => ["127.0.0.1"]);
  const previousPath = process.env.PATH;
  process.env.PATH = "/usr/bin:/bin";
  try {
    assert.equal((await server.start()).enabled, true);
    const cert = execFileSync("/usr/bin/openssl", ["x509", "-in", path.join(home, "companion", "cert.pem"), "-text", "-noout"], { encoding: "utf8" });
    assert.match(cert, /ASN1 OID: prime256v1/, "iOS TLS requires named rather than explicit EC parameters");
  } finally {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    await server.stop();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("paired HTTPS companion reads live threads, sends a turn, and answers only a pending approval", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "modex-companion-"));
  const sent: string[] = [];
  const answered: ApprovalAnswer[] = [];
  let status = "idle";
  const items: ThreadItem[] = [{ id: "approval-1", kind: "approval", question: "Apply this patch?", at: new Date().toISOString() }];
  const state = { projects: [{ id: "p1", name: "example", path: "/private/source", addedAt: "now" }], threads: [{ id: "abcdef12", projectId: "p1", title: "Build feature", backend: "mock", status: "idle", cwd: "/private/source", mode: "chat", model: "mock", plan: false, createdAt: "now", updatedAt: "now" }], version: 1, settings: {} } as AppState;
  const server = new CompanionServer(home, {
    state: () => state,
    items: () => items,
    status: () => status,
    send: async (_id, text) => {
      sent.push(text);
      if (text === "Fail safely") return { ok: false, error: "working directory is missing: /private/source" };
      status = "waiting";
      return { ok: true };
    },
    answer: (_id, _item, value) => { answered.push(value); (items[0] as Extract<ThreadItem, { kind: "approval" }>).answer = value; status = "running"; },
  }, () => ["127.0.0.1"]);
  try {
    const pairing = await server.start();
    assert.equal(pairing.enabled, true);
    const data = new URL(pairing.pairingUri!).searchParams.get("data")!;
    const credentials = JSON.parse(Buffer.from(data, "base64url").toString()) as { url: string; token: string; fingerprint: string };
    const request = (route: string, method = "GET", body?: unknown, token = credentials.token) => new Promise<{ status: number; body: any; fingerprint: string }>((resolve, reject) => {
      const req = https.request(`${credentials.url}${route}`, { method, rejectUnauthorized: false, headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) } }, (res) => {
        const cert = (res.socket as TLSSocket).getPeerCertificate(true);
        const fingerprint = crypto.createHash("sha256").update(cert.raw).digest("hex");
        let text = "";
        res.on("data", (chunk) => { text += chunk; });
        res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(text), fingerprint }));
      });
      req.on("error", reject);
      req.end(body ? JSON.stringify(body) : undefined);
    });
    const unauthorized = await request("/v1/snapshot", "GET", undefined, "0".repeat(64));
    assert.equal(unauthorized.status, 401);
    const snapshot = await request("/v1/snapshot?threadId=abcdef12");
    assert.equal(snapshot.fingerprint, credentials.fingerprint);
    assert.equal(snapshot.status, 200);
    assert.equal(snapshot.body.projects[0].name, "example");
    assert.equal(JSON.stringify(snapshot.body).includes("/private/source"), false);
    assert.equal(snapshot.body.items[0].question, "Apply this patch?");
    const removed = await request("/v1/snapshot?threadId=deadbeef");
    assert.equal(removed.status, 200, "a deleted selection still returns the current thread list");
    assert.deepEqual(removed.body.items, []);
    assert.equal(removed.body.threads[0].id, "abcdef12");
    assert.equal((await request("/v1/threads/abcdef12/send", "POST", { text: "   " })).status, 400);
    const failedFollowUp = await request("/v1/threads/abcdef12/send", "POST", { text: "Fail safely" });
    assert.equal(failedFollowUp.status, 409);
    assert.equal(JSON.stringify(failedFollowUp.body).includes("/private/source"), false);
    assert.equal((await request("/v1/threads/abcdef12/send", "POST", { text: "Follow up" })).status, 202);
    assert.deepEqual(sent, ["Fail safely", "Follow up"]);
    assert.equal((await request("/v1/threads/abcdef12/send", "POST", { text: "duplicate" })).status, 409);
    assert.equal((await request("/v1/threads/abcdef12/answer", "POST", { itemId: "approval-1", answer: "yes" })).status, 200);
    assert.deepEqual(answered, ["yes"]);
    assert.equal((await request("/v1/threads/abcdef12/answer", "POST", { itemId: "approval-1", answer: "yes" })).status, 409);
    server.resetAccess();
    assert.equal((await request("/v1/snapshot")).status, 401);
    const rotated = server.status().pairingUri;
    await server.stop();
    assert.equal((await server.start()).pairingUri, rotated, "a paired phone keeps the same local address after the Mac restarts");
    await server.stop();
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(pairing.port, "127.0.0.1", resolve));
    try {
      const moved = await server.start();
      assert.notEqual(moved.port, pairing.port, "an occupied old port does not prevent the companion from starting");
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  } finally {
    await server.stop();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("paired companion creates a local or worktree thread and starts its first turn", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "modex-companion-create-"));
  const created: Array<{ projectId: string; worktree: boolean; backend?: string; auto?: boolean }> = [];
  const sent: Array<{ id: string; text: string }> = [];
  let releaseCreate: (() => void) | undefined;
  let markCreateStarted: (() => void) | undefined;
  const createStarted = new Promise<void>((resolve) => { markCreateStarted = resolve; });
  const createGate = new Promise<void>((resolve) => { releaseCreate = resolve; });
  const state = { projects: [{ id: "p1", name: "example", path: "/private/source", addedAt: "now" }], threads: [], version: 1, settings: DEFAULT_SETTINGS } as AppState;
  const server = new CompanionServer(home, {
    state: () => state,
    items: () => [],
    status: () => "idle",
    create: async (projectId, options) => {
      created.push({ projectId, ...options });
      if (!options.worktree) { markCreateStarted?.(); await createGate; }
      const thread = { id: "feedface", projectId, title: "New thread", backend: "codex" as const, status: "idle" as const, cwd: "/private/source", mode: "agent" as const, model: "", plan: false, createdAt: "now", updatedAt: "now" };
      state.threads.push(thread);
      return thread;
    },
    send: async (id, text) => {
      sent.push({ id, text });
      return text === "Fail safely" ? { ok: false, error: "working directory is missing: /private/source" } : { ok: true };
    },
    answer: () => {},
  }, () => ["127.0.0.1"]);
  try {
    const pairing = await server.start();
    const data = new URL(pairing.pairingUri!).searchParams.get("data")!;
    const credentials = JSON.parse(Buffer.from(data, "base64url").toString()) as { url: string; token: string };
    const request = (body: unknown) => new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req = https.request(`${credentials.url}/v1/threads`, { method: "POST", rejectUnauthorized: false, headers: { authorization: `Bearer ${credentials.token}`, "content-type": "application/json" } }, (res) => {
        let text = "";
        res.on("data", (chunk) => { text += chunk; });
        res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(text) }));
      });
      req.on("error", reject);
      req.end(JSON.stringify(body));
    });
    assert.equal((await request({ projectId: "missing", text: "Build it", worktree: false })).status, 404);
    assert.equal((await request({ projectId: "p1", text: "   ", worktree: false })).status, 400);
    const response = await request({ projectId: "p1", text: "Build it", worktree: true, backend: "claude", auto: false });
    assert.equal(response.status, 201);
    assert.equal(response.body.thread.id, "feedface");
    assert.equal(JSON.stringify(response.body).includes("/private/source"), false);
    assert.deepEqual(created, [{ projectId: "p1", worktree: true, backend: "claude", auto: false }]);
    assert.deepEqual(sent, [{ id: "feedface", text: "Build it" }]);
    const failed = await request({ projectId: "p1", text: "Fail safely", worktree: true, backend: "codex", auto: false });
    assert.equal(failed.status, 409);
    assert.equal(JSON.stringify(failed.body).includes("/private/source"), false);
    const revoked = request({ projectId: "p1", text: "Must not run", worktree: false, backend: "codex", auto: false });
    await createStarted;
    server.resetAccess();
    releaseCreate?.();
    assert.equal((await revoked).status, 401);
    assert.equal(sent.some((entry) => entry.text === "Must not run"), false);
  } finally {
    await server.stop();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("companion sets a thread's approval policy, and 'Always allow' answers the request after setting it", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "modex-companion-policy-"));
  const calls: string[] = [];
  const items: ThreadItem[] = [{ id: "approval-1", kind: "approval", question: "Run it?", at: "now" }, { id: "approval-2", kind: "approval", question: "Ran it", answer: "yes", decidedBy: { source: "policy", ruleId: "policy:yolo", when: "YOLO", decision: "allow", via: "policy", ms: 0 }, at: "now" }];
  const state = { projects: [{ id: "p1", name: "example", path: "/private/source", addedAt: "now" }], threads: [{ id: "abcdef12", projectId: "p1", title: "Build", backend: "mock", status: "waiting", cwd: "/private/wt", worktree: { path: "/private/wt", branch: "modex-abcdef12" }, approvals: "yolo", mode: "chat", model: "mock", plan: false, createdAt: "now", updatedAt: "now" }], version: 1, settings: {} } as AppState;
  const server = new CompanionServer(home, {
    state: () => state, items: () => items, status: () => "waiting", send: async () => ({ ok: true }),
    answer: (_id, item, value) => { calls.push(`answer:${item}:${value}`); },
    setApprovals: (_id, policy) => { calls.push(`policy:${policy}`); },
    pullRequest: () => ({ state: "open", number: 7, title: "private title", url: "https://github.com/o/r/pull/7" }),
  }, () => ["127.0.0.1"]);
  try {
    const pairing = await server.start();
    const credentials = JSON.parse(Buffer.from(new URL(pairing.pairingUri!).searchParams.get("data")!, "base64url").toString()) as { url: string; token: string };
    const request = (route: string, method = "GET", body?: unknown) => new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req = https.request(`${credentials.url}${route}`, { method, rejectUnauthorized: false, headers: { authorization: `Bearer ${credentials.token}`, ...(body ? { "content-type": "application/json" } : {}) } }, (res) => {
        let text = "";
        res.on("data", (chunk) => { text += chunk; });
        res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(text) }));
      });
      req.on("error", reject);
      req.end(body ? JSON.stringify(body) : undefined);
    });
    const snapshot = await request("/v1/snapshot?threadId=abcdef12");
    assert.deepEqual(snapshot.body.threads[0].approvals, "yolo");
    assert.deepEqual([snapshot.body.threads[0].worktree, snapshot.body.threads[0].pr], [true, { number: 7, state: "open" }]);
    assert.ok(!JSON.stringify(snapshot.body).includes("private title"), "the phone gets the PR's number and state, not its title");
    assert.equal(snapshot.body.items[1].auto, "yolo");
    assert.equal(snapshot.body.items[0].auto, undefined);
    assert.equal((await request("/v1/threads/abcdef12/policy", "POST", { policy: "sudo" })).status, 400);
    assert.equal((await request("/v1/threads/abcdef12/policy", "POST", { policy: "always" })).status, 200);
    assert.equal((await request("/v1/threads/abcdef12/answer", "POST", { itemId: "approval-1", answer: "no", policy: "always" })).status, 400, "Always allow cannot ride on a denial");
    assert.equal((await request("/v1/threads/abcdef12/answer", "POST", { itemId: "approval-1", answer: "yes", policy: "yolo" })).status, 400, "YOLO is set on its own, never as a side effect of answering");
    assert.equal((await request("/v1/threads/abcdef12/answer", "POST", { itemId: "approval-1", answer: "yes", policy: "always" })).status, 200);
    assert.deepEqual(calls, ["policy:always", "policy:always", "answer:approval-1:yes"]);
  } finally {
    await server.stop();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
