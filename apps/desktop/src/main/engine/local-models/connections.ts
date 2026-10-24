import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { SecretName, SecretStore } from "../secrets.js";
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
 *
 * Each saved token gets its own secret entry and the profile names the entry it uses. A change
 * writes any new token first, then the profile, and only then removes entries no profile names, so
 * a failed write leaves the old revision resolving exactly the token it was saved with, and a token
 * left behind by a crash or a failed clear goes with the next successful save.
 *
 * A file Modex can't read is reported and never overwritten, and an entry this build can't validate
 * (hand-edited, or written by a newer Modex) is written back exactly as found but never resolved.
 */

interface StoredConnection {
  id: string;
  label: string;
  runtime: LocalRuntime;
  origin: string;
  basePath: "" | "/v1";
  revision: number;
  manualModels: string[];
  /** The secret entry holding this revision's token, or null when it has none. */
  credential: SecretName | null;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

interface ConnectionsFile {
  version: 1;
  connections: StoredConnection[];
  /** Entries this build can't validate: kept as found, never listed or resolved. */
  foreign: unknown[];
}

/** Main-only: what discovery and execution need to reach one revision of a profile. */
export interface ResolvedConnection {
  ref: ConnectionRef;
  runtime: LocalRuntime;
  endpoint: LocalEndpoint;
  token: string | null;
  /** A token is saved for this revision but can't be read now; never send a request without it. */
  credentialUnavailable: boolean;
  manualModels: string[];
}

const MAX_CONNECTIONS = 32;
const MAX_MANUAL = 50;
const MAX_MODEL_ID = 512;
const MAX_TOKEN = 4096;
const ID = /^lc_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CONTROL = /[\x00-\x1f\x7f]/;
const INPUT_KEYS = new Set(["label", "runtime", "url", "token", "manualModels"]);

/** A fresh entry per saved token: `local_connection:<id>:<uuid>`. */
const newCredential = (id: string): SecretName => `local_connection:${id}:${crypto.randomUUID()}`;
const CREDENTIAL = /^local_connection:(lc_[0-9a-f-]{36}):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A stored reference counts only when it names an entry of the same connection. */
function credentialRef(id: string, value: unknown): SecretName | null {
  return typeof value === "string" && CREDENTIAL.exec(value)?.[1] === id ? value as SecretName : null;
}

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

/** The token never goes into the plain-text profile: not in its name, not in a model ID. */
function refuseCopies(secret: string | null, name: string, manualModels: string[]): void {
  if (secret && [name, ...manualModels].some(value => value.includes(secret))) throw new Error("A connection's name and model IDs can't contain its token.");
}

const unreadable = () => new Error("Modex can't read its local connections file, so it left the file unchanged.");

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
      manualModels: modelIds(c.manualModels ?? []), credential: credentialRef(c.id, c.credential), createdAt: String(c.createdAt ?? ""), updatedAt: String(c.updatedAt ?? ""),
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

  /** Only a missing file reads as empty; anything else Modex can't read throws rather than being replaced. */
  private read(): ConnectionsFile {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, connections: [], foreign: [] };
      throw unreadable();
    }
    const file = raw as Partial<ConnectionsFile> | null;
    if (!file || typeof file !== "object" || file.version !== 1 || !Array.isArray(file.connections)) throw unreadable();
    const seen = new Set<string>();
    const connections: StoredConnection[] = [];
    const foreign: unknown[] = [];
    for (const entry of file.connections) {
      const c = validStored(entry);
      if (c && !seen.has(c.id)) { seen.add(c.id); connections.push(c); } else foreign.push(entry);
    }
    return { version: 1, connections, foreign };
  }

  /** Reads for main's own requests: a file Modex can't read resolves nothing. */
  private readOrNull(): ConnectionsFile | null {
    try { return this.read(); } catch { return null; }
  }

  private write(data: ConnectionsFile): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, connections: [...data.connections, ...data.foreign] }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  private view(c: StoredConnection): LocalConnectionView {
    return {
      id: c.id, revision: c.revision, label: c.label, runtime: c.runtime, origin: c.origin, basePath: c.basePath,
      manualModels: [...c.manualModels], credential: { present: Boolean(c.credential && this.secrets.has(c.credential)), storage: this.secrets.backend },
      createdAt: c.createdAt, updatedAt: c.updatedAt,
    };
  }

  /** Saves a token under a new entry and returns its name; nothing refers to it yet. */
  private saveToken(id: string, value: string): SecretName {
    if (!this.secrets.available()) throw new Error(`Can't save the token: ${this.secrets.backend} encryption is unavailable on this machine.`);
    const name = newCredential(id);
    this.secrets.set(name, value);
    return name;
  }

  /**
   * Makes `data` durable, then drops every token entry it no longer names. If the write fails, the
   * new entry is dropped instead and the stored profile, still naming its old entry, is left as it was.
   */
  private commit(data: ConnectionsFile, added: SecretName | null): void {
    try {
      this.write(data);
    } catch (err) {
      if (added) this.forget(added);
      throw err;
    }
    this.sweep(data);
  }

  /** Best effort, like `forget`: removes local-connection entries no profile, live or foreign, names. */
  private sweep(data: ConnectionsFile): void {
    const named = new Set<string>(data.connections.flatMap(c => (c.credential ? [c.credential] : [])));
    for (const entry of data.foreign) {
      const ref = entry && typeof entry === "object" ? (entry as Record<string, unknown>).credential : undefined;
      if (typeof ref === "string") named.add(ref);
    }
    let names: SecretName[];
    try { names = this.secrets.names(); } catch { return; }
    for (const name of names) if (name.startsWith("local_connection:") && !named.has(name)) this.forget(name);
  }

  /** Best effort: a leftover entry is unreachable because no profile names it. */
  private forget(name: SecretName): void {
    try { this.secrets.clear(name); } catch { /* unreferenced either way */ }
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
    refuseCopies(secret, name, manualModels);
    const data = this.read();
    if (data.connections.filter(c => !c.deletedAt).length >= MAX_CONNECTIONS) throw new Error(`Modex keeps at most ${MAX_CONNECTIONS} local connections.`);
    const at = this.now().toISOString();
    const id = `lc_${crypto.randomUUID()}`;
    const credential = secret ? this.saveToken(id, secret) : null;
    const stored: StoredConnection = { id, label: name, runtime: rt, origin: endpoint.origin, basePath: endpoint.basePath, revision: 1, manualModels, credential, createdAt: at, updatedAt: at };
    data.connections.push(stored);
    this.commit(data, credential);
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
    const hadToken = current.credential !== null;
    // A token stays with the address it was saved for unless the person enters it again.
    const clearsToken = secret === null || (moved && secret === undefined && hadToken);
    const targetChanged = rt !== current.runtime || moved || typeof secret === "string" || (clearsToken && hadToken);
    const kept = typeof secret === "string" ? secret : clearsToken || !current.credential ? null : this.secrets.get(current.credential);
    refuseCopies(kept, name, manualModels);
    const added = typeof secret === "string" ? this.saveToken(id, secret) : null;
    const credential = added ?? (clearsToken ? null : current.credential);
    const next: StoredConnection = {
      ...current, label: name, runtime: rt, origin: endpoint.origin, basePath: endpoint.basePath, manualModels, credential,
      revision: targetChanged ? current.revision + 1 : current.revision, updatedAt: this.now().toISOString(),
    };
    data.connections = data.connections.map(c => (c.id === id ? next : c));
    this.commit(data, added);
    return this.view(next);
  }

  delete(id: string, expected: number): void {
    const data = this.read();
    const current = data.connections.find(c => c.id === id);
    if (!current || current.deletedAt) throw new Error("That connection no longer exists.");
    if (current.revision !== expected) throw new Error("That connection changed. Review it and try again.");
    data.connections = data.connections.map(c => (c.id === id ? { ...c, manualModels: [], credential: null, deletedAt: this.now().toISOString() } : c));
    this.commit(data, null);
  }

  /** Exactly this revision of a live profile, or null: never a newer revision, never a replacement. */
  resolve(ref: ConnectionRef): ResolvedConnection | null {
    const c = this.readOrNull()?.connections.find(x => x.id === ref.id);
    if (!c || c.deletedAt || c.revision !== ref.revision) return null;
    const endpoint = endpointFor(c.runtime, `${c.origin}${c.basePath}`);
    const token = c.credential ? this.secrets.get(c.credential) : null;
    return { ref: { id: c.id, revision: c.revision }, runtime: c.runtime, endpoint, token, credentialUnavailable: c.credential !== null && token === null, manualModels: [...c.manualModels] };
  }

  /** What history may show about a connection, deleted or not. */
  provenance(id: string): { label: string; runtime: LocalRuntime; origin: string; deleted: boolean } | null {
    const c = this.readOrNull()?.connections.find(x => x.id === id);
    return c ? { label: c.label, runtime: c.runtime, origin: c.origin, deleted: Boolean(c.deletedAt) } : null;
  }
}
