import { test, expect } from "@playwright/test";
import http from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { launch, seedHome } from "./support.js";
import type { LocalModelsRequest, LocalModelsReply } from "../src/shared/local-connections.js";

// Production Electron preload/main/IPC/service; only the metadata server is synthetic.
for (const kind of ["empty", "malformed", "delayed"] as const) {
  test(`production local-model IPC handles ${kind} metadata without inference`, async () => {
    const hits: { method: string | undefined; url: string | undefined; auth: boolean; owner: string }[] = [];
    let arrival!: () => void;
    const arrived = new Promise<void>(resolve => { arrival = resolve; });
    let release: (() => void) | undefined;
    const respond = (owner: string) => (req: http.IncomingMessage, res: http.ServerResponse) => {
      hits.push({ method: req.method, url: req.url, auth: Boolean(req.headers.authorization), owner });
      if (req.method !== "GET" || req.url !== "/v1/models") { res.writeHead(400); res.end(); return; }
      if (kind === "malformed") { res.end("<html>not model metadata</html>"); return; }
      if (kind === "empty") { res.end(JSON.stringify({ data: [] })); return; }
      if (hits.length === 1) {
        release = () => { if (!res.destroyed) res.end(JSON.stringify({ data: [{ id: "late-must-not-appear" }] })); };
        arrival();
        return;
      }
      res.end(JSON.stringify({ data: [{ id: "current-model" }] }));
    };
    const server = http.createServer(respond("primary"));
    const replacement = kind === "delayed" ? http.createServer(respond("replacement")) : undefined;
    const endpoint = (s: http.Server) => `http://127.0.0.1:${(s.address() as AddressInfo).port}/v1`;
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    if (replacement) { replacement.listen(0, "127.0.0.1"); await once(replacement, "listening"); }
    const { home } = seedHome();
    let opened: Awaited<ReturnType<typeof launch>> | undefined;
    try {
      opened = await launch(home);
      const page = opened.page;
      const invoke = (request: LocalModelsRequest) => page.evaluate(r => window.modex!.invoke("local-models:command", r) as Promise<LocalModelsReply>, request);
      const created = await invoke({ op: "create", input: { label: `IPC ${kind}`, runtime: "responses", url: endpoint(server) } });
      if (created.op !== "create") throw new Error("Expected created profile");
      const ref = { id: created.connection.id, revision: created.connection.revision };
      if (kind === "delayed") {
        const pending = invoke({ op: "discover", connection: ref, requestId: "delayed-old" });
        await Promise.race([arrived, pending.then(() => { throw new Error("Delayed request completed before server barrier"); })]);
        // A new endpoint changes execution identity; a label-only edit correctly does not.
        const updated = await invoke({ op: "update", id: ref.id, revision: ref.revision, patch: { url: endpoint(replacement!) } });
        if (updated.op !== "update") throw new Error("Expected updated profile");
        expect(updated.connection.revision).toBeGreaterThan(ref.revision);
        release!();
        const old = await pending;
        expect(old.op === "discover" && old.result.state).toBe("stale");
        expect(JSON.stringify(old)).not.toContain("late-must-not-appear");
        const current = await invoke({ op: "discover", connection: { id: ref.id, revision: updated.connection.revision }, requestId: "delayed-current" });
        if (current.op !== "discover" || current.result.state !== "ready") throw new Error("Expected current ready discovery");
        expect(current.result.models.map(m => m.model.id)).toEqual(["current-model"]);
        expect(hits.map(hit => hit.owner)).toEqual(["primary", "replacement"]);
      } else {
        const reply = await invoke({ op: "discover", connection: ref, requestId: `matrix-${kind}` });
        if (reply.op !== "discover") throw new Error("Expected discovery reply");
        if (kind === "empty") {
          expect(reply.result.state).toBe("ready");
          expect(reply.result.state === "ready" && reply.result.models).toEqual([]);
        } else {
          expect(reply.result.state).toBe("unavailable");
          expect(reply.result.state === "unavailable" && reply.result.reason).toBe("malformed");
        }
        expect(hits).toHaveLength(1);
      }
      expect(hits.every(hit => hit.method === "GET" && hit.url === "/v1/models" && !hit.auth)).toBe(true);
    } finally {
      release?.();
      try { await opened?.app.close(); }
      finally {
        await Promise.all([server, replacement].filter((s): s is http.Server => Boolean(s)).map(s => {
          s.closeAllConnections();
          return new Promise<void>(resolve => s.close(() => resolve()));
        }));
      }
    }
  });
}
