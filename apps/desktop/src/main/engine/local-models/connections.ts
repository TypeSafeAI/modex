import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { SecretStore } from "../secrets.js";
import { LOCAL_RUNTIMES, type ConnectionRef, type LocalConnectionInput, type LocalConnectionView, type LocalRuntime } from "../../../shared/local-connections.js";
import { parseLocalEndpoint, type LocalEndpoint } from "./endpoint-policy.js";

/**
 * The person's local-model server profiles (#378), owned by main and kept in
 * `<home>/app/local-connections.json` beside, never inside, the encrypted secrets file.
 *
 * A profile's revision moves whenever what it points at changes (runtime, address or token), so a
 * discovery answer, qualification or run bound to an older revision can be told apart from the
 * current one. A token belongs to the address it was saved for: changing the address drops it.
 * Deleting a profile keeps a tombstone so history still reads, but nothing resolves through it.
 */

interface StoredConnection {
  id: string;
  label: string;
  runtime: LocalRuntime;
  origin: string;
  basePath: "" | "/v1";
  revision: number;
  manualModels: string[];
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

interface ConnectionsFile {
  version: 1;
  connections: StoredConnection[];
}

/** Main-only: what discovery and execution need to reach one revision of a profile. */
export interface ResolvedConnection {
  ref: ConnectionRef;
  runtime: LocalRuntime;
  endpoint: LocalEndpoint;
  token: string | null;
  manualModels: string[];
}

const MAX_CONNECTIONS = 32;
const MAX_MANUAL = 50;
const MAX_MODEL_ID = 512;
const MAX_TOKEN = 4096;
const ID = /^lc_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CONTROL = /[\x00-\x1f\x7f]/;
const INPUT_KEYS = new Set(["label", "runtime", "url", "token", "manualModels"]);

const secretName = (id: string) => `local_connection:${id}` as const;

function label(value: unknown): string {
  if (typeof value !== "string") throw new Error("Name the connection.");
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 80 || CONTROL.test(trimmed)) throw new Error("Use a name of 1–80 characters.");
  return trimmed;
}

function runtime(value: unknown): LocalRuntime {
  if (!LOCAL_RUNTIMES.includes(value as LocalRuntime)) throw new Error("Choose Ollama, LM Studio or a Responses-compatible server.");
  return value as LocalRuntime;
}

/** Exact IDs: inner spaces, slashes, colons and case are kept as typed; controls are refused. */
export function modelIds(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_MANUAL) throw new Error(`Add at most ${MAX_MANUAL} model IDs.`);
  const out: string[] = [];
  for (const id of value) {
    if (typeof id !== "string" || !id.trim() || id.length > MAX_MODEL_ID || CONTROL.test(id)) throw new Error("A model ID can't be empty, longer than 512 characters or contain control characters.");
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/** A bearer token goes in an HTTP header: printable ASCII without spaces, nothing to inject. */
function token(value: unknown): string {
  if (typeof value !== "string" || !/^[\x21-\x7e]+$/.test(value.trim()) || value.trim().length > MAX_TOKEN) throw new Error("A token must be printable characters without spaces.");
  return value.trim();
}

function endpointFor(rt: LocalRuntime, url: unknown): LocalEndpoint {
  const parsed = parseLocalEndpoint(url, { allowV1: rt === "responses" });
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.endpoint;
}

function validStored(raw: unknown): StoredConnection | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  try {
    if (typeof c.id !== "string" || !ID.test(c.id)) return null;
    if (!Number.isSafeInteger(c.revision) || (c.revision as number) < 1) return null;
    const rt = runtime(c.runtime);
    if (c.basePath !== "" && c.basePath !== "/v1") return null;
    const endpoint = endpointFor(rt, `${c.origin}${c.basePath}`);
    if (endpoint.origin !== c.origin) return null;
    return {
      id: c.id, label: label(c.label), runtime: rt, origin: endpoint.origin, basePath: endpoint.basePath, revision: c.revision as number,
      manualModels: modelIds(c.manualModels ?? []), createdAt: String(c.createdAt ?? ""), updatedAt: String(c.updatedAt ?? ""),
      ...(typeof c.deletedAt === "string" ? { deletedAt: c.deletedAt } : {}),
    };
  } catch {
    return null;
  }
}

export class LocalConnectionStore {
  readonly file: string;

  constructor(home: string, private readonly secrets: SecretStore, private readonly now: () => Date = () => new Date()) {
    this.file = path.join(home, "app", "local-connections.json");
  }

  private read(): ConnectionsFile {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<ConnectionsFile>;
      const seen = new Set<string>();
      const connections = (Array.isArray(raw.connections) ? raw.connections : []).map(validStored).filter((c): c is StoredConnection => {
        if (!c || seen.has(c.id)) return false;
        seen.add(c.id);
        return true;
      });
      return { version: 1, connections };
    } catch {
      return { version: 1, connections: [] };
    }
  }

  private write(data: ConnectionsFile): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  private view(c: StoredConnection): LocalConnectionView {
    return {
      id: c.id, revision: c.revision, label: c.label, runtime: c.runtime, origin: c.origin, basePath: c.basePath,
      manualModels: [...c.manualModels], credential: { present: this.secrets.has(secretName(c.id)), storage: this.secrets.backend },
      createdAt: c.createdAt, updatedAt: c.updatedAt,
    };
  }

  private saveToken(id: string, value: string): void {
    if (!this.secrets.available()) throw new Error(`Can't save the token: ${this.secrets.backend} encryption is unavailable on this machine.`);
    this.secrets.set(secretName(id), value);
  }

  list(): LocalConnectionView[] {
    return this.read().connections.filter(c => !c.deletedAt).map(c => this.view(c));
  }

  create(input: LocalConnectionInput): LocalConnectionView {
    if (!input || typeof input !== "object" || Object.keys(input).some(k => !INPUT_KEYS.has(k))) throw new Error("Modex can't read that connection.");
    const rt = runtime(input.runtime);
    const endpoint = endpointFor(rt, input.url);
    const name = label(input.label);
    const manualModels = modelIds(input.manualModels);
    const secret = input.token === undefined || input.token === null ? null : token(input.token);
    const data = this.read();
    if (data.connections.filter(c => !c.deletedAt).length >= MAX_CONNECTIONS) throw new Error(`Modex keeps at most ${MAX_CONNECTIONS} local connections.`);
    const at = this.now().toISOString();
    const stored: StoredConnection = { id: `lc_${crypto.randomUUID()}`, label: name, runtime: rt, origin: endpoint.origin, basePath: endpoint.basePath, revision: 1, manualModels, createdAt: at, updatedAt: at };
    if (secret) this.saveToken(stored.id, secret);
    data.connections.push(stored);
    this.write(data);
    return this.view(stored);
  }

  /** `expected` is the revision the editor was showing; an edit of anything older is refused. */
  update(id: string, expected: number, patch: Partial<LocalConnectionInput>): LocalConnectionView {
    if (!patch || typeof patch !== "object" || Object.keys(patch).some(k => !INPUT_KEYS.has(k))) throw new Error("Modex can't read that change.");
    const data = this.read();
    const current = data.connections.find(c => c.id === id);
    if (!current || current.deletedAt) throw new Error("That connection no longer exists.");
    if (current.revision !== expected) throw new Error("That connection changed. Review it and try again.");
    const rt = patch.runtime === undefined ? current.runtime : runtime(patch.runtime);
    const endpoint = endpointFor(rt, patch.url === undefined ? `${current.origin}${current.basePath}` : patch.url);
    const name = patch.label === undefined ? current.label : label(patch.label);
    const manualModels = patch.manualModels === undefined ? current.manualModels : modelIds(patch.manualModels);
    const secret = patch.token === undefined || patch.token === null ? patch.token : token(patch.token);
    const moved = endpoint.origin !== current.origin || endpoint.basePath !== current.basePath;
    const hadToken = this.secrets.has(secretName(id));
    // A token stays with the address it was saved for unless the person enters it again.
    const clearsToken = secret === null || (moved && secret === undefined && hadToken);
    const targetChanged = rt !== current.runtime || moved || typeof secret === "string" || (clearsToken && hadToken);
    if (typeof secret === "string") this.saveToken(id, secret);
    else if (clearsToken) this.secrets.clear(secretName(id));
    const next: StoredConnection = {
      ...current, label: name, runtime: rt, origin: endpoint.origin, basePath: endpoint.basePath, manualModels,
      revision: targetChanged ? current.revision + 1 : current.revision, updatedAt: this.now().toISOString(),
    };
    data.connections = data.connections.map(c => (c.id === id ? next : c));
    this.write(data);
    return this.view(next);
  }

  delete(id: string, expected: number): void {
    const data = this.read();
    const current = data.connections.find(c => c.id === id);
    if (!current || current.deletedAt) throw new Error("That connection no longer exists.");
    if (current.revision !== expected) throw new Error("That connection changed. Review it and try again.");
    this.secrets.clear(secretName(id));
    data.connections = data.connections.map(c => (c.id === id ? { ...c, manualModels: [], deletedAt: this.now().toISOString() } : c));
    this.write(data);
  }

  /** Exactly this revision of a live profile, or null: never a newer revision, never a replacement. */
  resolve(ref: ConnectionRef): ResolvedConnection | null {
    const c = this.read().connections.find(x => x.id === ref.id);
    if (!c || c.deletedAt || c.revision !== ref.revision) return null;
    const endpoint = endpointFor(c.runtime, `${c.origin}${c.basePath}`);
    return { ref: { id: c.id, revision: c.revision }, runtime: c.runtime, endpoint, token: this.secrets.get(secretName(c.id)), manualModels: [...c.manualModels] };
  }

  /** What history may show about a connection, deleted or not. */
  provenance(id: string): { label: string; runtime: LocalRuntime; origin: string; deleted: boolean } | null {
    const c = this.read().connections.find(x => x.id === id);
    return c ? { label: c.label, runtime: c.runtime, origin: c.origin, deleted: Boolean(c.deletedAt) } : null;
  }
}
