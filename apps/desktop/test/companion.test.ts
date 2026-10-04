import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import type { TLSSocket } from "node:tls";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { CompanionServer } from "../src/main/engine/companion.js";
import type { AppState, ApprovalAnswer, ThreadItem } from "../src/shared/types.js";

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
    send: async (_id, text) => { sent.push(text); status = "waiting"; return { ok: true }; },
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
    assert.equal((await request("/v1/threads/abcdef12/send", "POST", { text: "   " })).status, 400);
    assert.equal((await request("/v1/threads/abcdef12/send", "POST", { text: "Follow up" })).status, 202);
    assert.deepEqual(sent, ["Follow up"]);
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
