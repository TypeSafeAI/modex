import { test, expect } from "@playwright/test";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { launch, seedHome } from "./support.js";
import type { LocalModelsReply, LocalModelsRequest } from "../src/shared/local-connections.js";

// #378 AC1/AC3: production preload, ipcMain registration, store, secret store (test cipher under
// MODEX_E2E) and HTTP transport. Only the runtime is synthetic: an LM Studio-shaped server on
// loopback that records every request. No handler is replaced and no service is called directly.
test("real Electron IPC saves a local connection, discovers its models and keeps the token out of the renderer", async () => {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url} ${req.headers.authorization ?? "-"}`);
    if (req.headers.authorization !== "Bearer e2e-local-TOKEN") { res.writeHead(401); res.end(); return; }
    if (req.url !== "/api/v0/models") { res.writeHead(404); res.end(); return; }
    res.end(JSON.stringify({ data: [
      { id: "qwen/qwen3-coder-30b", type: "llm", state: "loaded", max_context_length: 262144, capabilities: ["tool_use"] },
      { id: "text-embedding-nomic-embed-text-v1.5", type: "embeddings", state: "not-loaded" },
    ] }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const { home } = seedHome();
  const { app, page } = await launch(home);
  try {
    const invoke = (request: LocalModelsRequest) => page.evaluate(r => window.modex!.invoke("local-models:command", r) as Promise<LocalModelsReply>, request);
    await expect(invoke({ op: "create", input: { label: "x", runtime: "lmstudio", url: "http://192.168.1.2:1234" } })).rejects.toThrow(/this Mac/);
    await expect(page.evaluate(() => window.modex!.invoke("local-models:command", { op: "discover", connection: { id: "x", revision: 1 }, requestId: "r", url: "http://10.0.0.1" } as never))).rejects.toThrow(/Invalid local model request/);

    const created = await invoke({ op: "create", input: { label: "LM Studio", runtime: "lmstudio", url, token: "e2e-local-TOKEN" } });
    if (created.op !== "create") throw new Error("Expected a created connection");
    expect(created.connection.credential.present).toBe(true);
    const result = await invoke({ op: "discover", connection: { id: created.connection.id, revision: created.connection.revision }, requestId: "r1" });
    if (result.op !== "discover" || result.result.state !== "ready") throw new Error(`Expected ready discovery, got ${JSON.stringify(result)}`);
    expect(result.result.models.map(m => [m.model.id, m.kind, m.loaded, m.advertised.tools, m.selectable])).toEqual([
      ["qwen/qwen3-coder-30b", "generative", "yes", "advertised", true],
      ["text-embedding-nomic-embed-text-v1.5", "embedding", "no", "unknown", false],
    ]);
    expect(hits).toEqual(["GET /api/v0/models Bearer e2e-local-TOKEN"]);

    const listed = await invoke({ op: "list" });
    const renderer = JSON.stringify([created, result, listed]);
    expect(renderer).not.toContain("e2e-local-TOKEN");
    const profiles = fs.readFileSync(path.join(home, "app", "local-connections.json"), "utf8");
    expect(profiles).not.toContain("e2e-local-TOKEN");
    expect(fs.readFileSync(path.join(home, "app", "secrets.json"), "utf8")).not.toContain("e2e-local-TOKEN");

    expect(await invoke({ op: "delete", id: created.connection.id, revision: created.connection.revision })).toEqual({ op: "delete" });
    const stale = await invoke({ op: "discover", connection: { id: created.connection.id, revision: created.connection.revision }, requestId: "r2" });
    expect(stale.op === "discover" && stale.result.state).toBe("stale");
    expect(hits).toHaveLength(1);
  } finally {
    await app.close();
    server.closeAllConnections();
    server.close();
  }
});
