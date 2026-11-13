import type { TurnRef } from "../../shared/conversation-events.js";
import type { TaskContextConnection, TaskContextProposal, TaskContextProposalResult } from "../../shared/task-context-tools.js";
import type { Store } from "./store.js";
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { copyTaskContextEvidence, type ContextTarget } from "../../shared/task-context-evidence.js";

export interface TaskContextBinding {
  turn: TurnRef; projectId: string; cwd: string; isCurrent(): boolean;
  accept(proposal: TaskContextProposal): TaskContextProposalResult;
}
export interface TaskContextLease { connection: TaskContextConnection; close(): Promise<void> }
interface Active {
  token: string; leaseId: string; binding: TaskContextBinding; identity: string; closed: AbortController;
  requests: Set<http.IncomingMessage>; records: Map<string, { canonical: string; result: Promise<TaskContextProposalResult> }>; bytes: number;
  detach?(): void;
}
const BODY_BYTES = 64 * 1024, LEASE_BYTES = 2 * 1024 * 1024;
const uuid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const denied = () => new Error("Proposal scope is unavailable or no longer belongs to this attempt.");
const inside = (root: string, file: string) => { const rel = path.relative(root, file); return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel); };

/** Bounded metadata reads only. No Notes open/refresh/repair, Markdown, plain-file body or mutation API. */
function metadata(file: string, root: string, limit: number): unknown {
  if (!inside(root, file) || fs.realpathSync(file) !== file) throw denied();
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.size > limit) throw denied();
    const buffer = Buffer.alloc(before.size + 1); let bytes = 0;
    while (bytes < buffer.length) { const read = fs.readSync(fd, buffer, bytes, buffer.length - bytes, bytes); if (!read) break; bytes += read; }
    const after = fs.fstatSync(fd);
    if (bytes !== before.size || after.ino !== before.ino || after.dev !== before.dev || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw denied();
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytes)));
  } finally { fs.closeSync(fd); }
}
function notesInScope(notesRoot: string, projectId: string, targets: Exclude<ContextTarget, { kind: "file" }>[]): void {
  if (!targets.length) return;
  const root = fs.realpathSync(notesRoot);
  if (root !== path.resolve(notesRoot)) throw denied();
  const index = metadata(path.join(root, ".modex", "index.json"), root, 8 * 1024 * 1024);
  if (!record(index) || index.version !== 1 || !record(index.notes)) throw denied();
  const markers = new Map<string, unknown>();
  for (const target of targets) {
    const entries = target.kind === "note" ? index.notes : index.files, id = target.kind === "note" ? target.pageId : target.id;
    const entry = record(entries) && Object.hasOwn(entries, id) ? entries[id] : undefined;
    if (!record(entry) || typeof entry.rel !== "string" || !Number.isSafeInteger(entry.ino) || entry.trash || !entry.rel || /[\\\u0000-\u001f\u007f]/.test(entry.rel)
      || path.isAbsolute(entry.rel) || entry.rel.split("/").some(part => !part || part === "." || part === "..")) throw denied();
    const file = path.join(root, entry.rel);
    if (!inside(root, file) || fs.realpathSync(file) !== file) throw denied();
    const stat = fs.lstatSync(file); if (!stat.isFile() || stat.ino !== entry.ino) throw denied();
    let directory = path.dirname(file), found = false;
    for (let depth = 0; depth <= 30 && directory !== root; depth++, directory = path.dirname(directory)) {
      let marker = markers.get(directory);
      if (!markers.has(directory)) {
        try { marker = metadata(path.join(directory, ".modex-project.json"), root, 64 * 1024); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; marker = null; }
        markers.set(directory, marker);
      }
      if (marker !== null) { if (!record(marker) || marker.modexProjectId !== projectId) throw denied(); found = true; break; }
    }
    if (!found) throw denied();
  }
}

/** A dedicated loopback capability: records uninspected relevance proposals only. */
export class TaskContextAgents {
  private readonly routes = new Map<string, Active>();
  private readonly server: http.Server;
  private listening?: Promise<string>;
  private disposed = false;
  constructor(private readonly options: { store: Store }) {
    this.server = http.createServer((req, res) => { void this.handle(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); }); });
  }
  private identity(binding: TaskContextBinding): string {
    const thread = this.options.store.thread(binding.turn.thread), project = this.options.store.project(binding.projectId);
    const account = thread?.backend === "claude" ? thread.claudeAccount ?? "cli" : thread?.backend === "codex" ? thread.codexAccount ?? "cli" : undefined;
    if (!thread || !project || thread.retired || thread.localTarget || !["claude", "codex"].includes(thread.backend) || thread.backend !== binding.turn.backend
      || thread.projectId !== project.id || thread.cwd !== binding.cwd || account !== binding.turn.account) throw denied();
    return JSON.stringify([project.id, project.path, project.addedAt, thread.id, thread.createdAt, thread.cwd, thread.backend, account]);
  }
  private current(active: Active, signal?: AbortSignal): void {
    if (this.disposed || active.closed.signal.aborted || signal?.aborted || !active.binding.isCurrent() || this.identity(active.binding) !== active.identity) throw denied();
  }
  async prepare(binding: TaskContextBinding, signal: AbortSignal): Promise<TaskContextLease> {
    const bound = { ...binding, turn: structuredClone(binding.turn) }, identity = this.identity(bound);
    // Validate the same public turn identity persisted in proposal provenance, before opening any route.
    copyTaskContextEvidence({ revision: 0, refs: [{ id: "identity", target: { kind: "file", path: "identity" }, captureIds: [], relations: [{ kind: "relevant", provenance: "model-proposed",
      source: { kind: "model-proposal", turn: bound.turn, leaseId: "identity", receiptId: "identity", requestId: "identity", at: new Date().toISOString() } }] }], captures: [], checks: [] });
    const active: Active = { token: randomUUID(), leaseId: randomUUID(), binding: bound, identity, closed: new AbortController(), requests: new Set(), records: new Map(), bytes: 0 };
    const close = () => { active.closed.abort(); this.routes.delete(active.token); for (const req of active.requests) req.destroy(); active.records.clear(); signal.removeEventListener("abort", close); };
    active.detach = () => signal.removeEventListener("abort", close);
    signal.addEventListener("abort", close, { once: true });
    try {
      this.current(active, signal);
      const base = await (this.listening ??= new Promise<string>((resolve, reject) => {
        this.server.once("error", reject); this.server.listen(0, "127.0.0.1", () => { this.server.removeListener("error", reject); resolve(`http://127.0.0.1:${(this.server.address() as import("node:net").AddressInfo).port}`); });
      }));
      this.current(active, signal);
      this.routes.set(active.token, active);
      return { connection: { url: `${base}/mcp/${active.token}`, instructions: "modex_task_context.propose_refs records candidate project file/test/Note references as model-proposed relevance only. It reads no bodies, runs no tools, verifies no checks and grants no permissions. Supply refs with target and role only; omit raw content, rationale, origins and private paths." }, close: async () => { close(); } };
    } catch (error) { close(); throw error; }
  }
  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const port = (this.server.address() as import("node:net").AddressInfo | null)?.port;
    if (req.headers.origin !== undefined || req.headers.host !== `127.0.0.1:${port}`) { res.writeHead(403).end(); return; }
    const active = [...this.routes.values()].find(route => req.url === `/mcp/${route.token}`);
    if (!active || this.disposed) { res.writeHead(404).end(); return; }
    active.requests.add(req); res.once("close", () => active.requests.delete(req));
    const mcp = new Server({ name: "modex-task-context", version: "1" }, { capabilities: { tools: {} } });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => { void transport.close(); void mcp.close(); });
    mcp.setRequestHandler(ListToolsRequestSchema, async () => {
      this.current(active);
      return { tools: [{ name: "propose_refs", description: "Propose uninspected context relevance; no reads, writes, execution, verification or permission changes.", inputSchema: { type: "object", additionalProperties: false, required: ["refs"], properties: { refs: { type: "array", minItems: 1, maxItems: 100, items: { type: "object", additionalProperties: false, required: ["target", "role"], properties: { target: { oneOf: [
        { type: "object", additionalProperties: false, required: ["kind", "path"], properties: { kind: { const: "file" }, path: { type: "string", minLength: 1, maxLength: 4096 } } },
        { type: "object", additionalProperties: false, required: ["kind", "pageId"], properties: { kind: { const: "note" }, pageId: { type: "string", minLength: 1, maxLength: 512 } } },
        { type: "object", additionalProperties: false, required: ["kind", "id"], properties: { kind: { const: "notes-file" }, id: { type: "string", minLength: 1, maxLength: 512 } } },
      ] }, role: { type: "string", enum: ["file", "test", "note"] } } } } } } }] };
    });
    mcp.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      try {
        if (request.params.name !== "propose_refs") throw new Error("Only propose_refs is available.");
        const result = await this.propose(active, request.params.arguments, extra.requestId, extra.signal);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (error) { return { isError: true, content: [{ type: "text", text: (error as Error).message }] }; }
    });
    try {
      this.current(active);
      if (Number(req.headers["content-length"]) > BODY_BYTES) { res.writeHead(413).end(); req.resume(); return; }
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of req) { bytes += chunk.length; if (bytes > BODY_BYTES) { res.writeHead(413).end(); return; } chunks.push(Buffer.from(chunk)); }
      this.current(active);
      const body = chunks.length ? JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))) : undefined;
      // JSON-RPC echoes request IDs even in errors. Reject a private token before the SDK can reflect it.
      if (body !== undefined && JSON.stringify(body).includes(active.token)) { res.writeHead(400).end(); return; }
      await mcp.connect(transport); await transport.handleRequest(req, res, body);
    } catch { if (!res.headersSent && !res.destroyed) res.writeHead(400).end(); }
  }
  private async propose(active: Active, args: unknown, requestId: string | number, signal: AbortSignal): Promise<TaskContextProposalResult> {
    this.current(active, signal);
    if ((typeof requestId !== "string" && typeof requestId !== "number") || (typeof requestId === "string" && (!requestId || requestId.length > 512 || /[\u0000-\u001f\u007f\ud800-\udfff]/u.test(requestId) || /^(?:[\\/]|[A-Za-z]:[\\/])/.test(requestId) || requestId.includes(active.token)))
      || (typeof requestId === "number" && !Number.isSafeInteger(requestId))) throw new Error("Invalid proposal request identity.");
    if (!record(args) || !exact(args, ["refs"]) || !Array.isArray(args.refs) || !args.refs.length || args.refs.length > 100) throw new Error("Invalid proposal arguments.");
    const refs: TaskContextProposal["refs"] = args.refs.map(ref => {
      if (!record(ref) || !exact(ref, ["target", "role"]) || !["file", "test", "note"].includes(ref.role as string)) throw new Error("Invalid proposal reference.");
      try { copyTaskContextEvidence({ revision: 0, refs: [{ id: "target", target: ref.target as ContextTarget, relations: [], captureIds: [] }], captures: [], checks: [] }); }
      catch { throw new Error("Invalid proposal target."); }
      const target = ref.target as ContextTarget;
      if ((target.kind === "file") === (ref.role === "note") || /[\ud800-\udfff]/u.test(JSON.stringify(target)) || JSON.stringify(target).includes(active.token)) throw new Error("Invalid proposal target or role.");
      return { target: target.kind === "file" ? { kind: "file", path: target.path } : target.kind === "note" ? { kind: "note", pageId: target.pageId } : { kind: "notes-file", id: target.id }, role: ref.role as "file" | "test" | "note" };
    });
    const canonical = JSON.stringify(refs), key = JSON.stringify(requestId), prior = active.records.get(key);
    if (prior) { if (prior.canonical !== canonical) throw new Error("Proposal request identity was reused with changed references."); return prior.result; }
    const proposal: TaskContextProposal = { receiptId: randomUUID(), leaseId: active.leaseId, requestId, at: new Date().toISOString(), refs };
    const reservation = Buffer.byteLength(JSON.stringify(proposal)) + 512 + refs.length * 40;
    if (active.bytes + reservation > LEASE_BYTES) throw new Error("This attempt's proposal metadata budget is exhausted.");
    active.bytes += reservation;
    const result = (async () => {
      try {
        const root = await fsp.realpath(active.binding.cwd);
        for (const ref of refs) if (ref.target.kind === "file") {
          let candidate = path.join(root, ref.target.path);
          while (true) {
            try { if (!inside(root, await fsp.realpath(candidate))) throw denied(); break; }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" || candidate === root) throw error; candidate = path.dirname(candidate); }
          }
        }
        if (await fsp.realpath(active.binding.cwd) !== root) throw denied();
        this.current(active, signal);
        notesInScope(this.options.store.space.root, active.binding.projectId, refs.flatMap(ref => ref.target.kind === "file" ? [] : [ref.target]));
      } catch { throw denied(); }
      this.current(active, signal);
      let accepted: TaskContextProposalResult;
      try { accepted = active.binding.accept(structuredClone(proposal)); }
      catch { throw new Error("Proposal could not be recorded; its outcome is unknown. Do not resend automatically."); }
      if (!accepted || accepted.receiptId !== proposal.receiptId || !Array.isArray(accepted.refIds) || !accepted.refIds.every(uuid) || new Set(accepted.refIds).size !== accepted.refIds.length
        || accepted.accepted !== accepted.refIds.length || accepted.accepted > refs.length) throw new Error("Proposal result is unavailable; do not resend automatically.");
      return { receiptId: accepted.receiptId, refIds: [...accepted.refIds], accepted: accepted.accepted };
    })();
    active.records.set(key, { canonical, result }); void result.catch(() => {}); return result;
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    for (const active of this.routes.values()) { active.closed.abort(); active.detach?.(); active.records.clear(); for (const req of active.requests) req.destroy(); }
    this.routes.clear(); this.server.closeAllConnections();
    if (this.listening) await new Promise<void>(resolve => this.server.close(() => resolve()));
  }
}
