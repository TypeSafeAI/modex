import type { DiscoveryResult, LocalConnectionInput, LocalConnectionView, LocalModelDescriptor, LocalModelsReply, LocalModelsRequest, LocalRuntime } from "../shared/local-connections.js";

export interface LocalEntry {
  connection: LocalConnectionView;
  /** The last listing for this exact revision, if any. */
  result?: Exclude<DiscoveryResult, { state: "stale" }>;
  checking: boolean;
  /** A window operation failed; this is not a statement about the inference server's health. */
  error?: string;
}

export interface LocalModelsState {
  loaded: boolean;
  /** Listing the profiles failed: main's channel refused or is unavailable. */
  error?: string;
  entries: LocalEntry[];
}

/** Where each runtime listens by default. The person can change the address; main validates it. */
export const RUNTIME_DEFAULTS: Record<LocalRuntime, { label: string; url: string }> = {
  lmstudio: { label: "LM Studio", url: "http://127.0.0.1:1234" },
  ollama: { label: "Ollama", url: "http://127.0.0.1:11434" },
  responses: { label: "Compatible server", url: "http://127.0.0.1:8080" },
};

export const RUNTIME_NAMES: Record<LocalRuntime, string> = { lmstudio: "LM Studio", ollama: "Ollama", responses: "Responses-compatible server" };

/** Plain-language reasons for a failed listing (`DiscoveryFailure`). */
export const FAILURE_WORDS: Record<string, string> = {
  invalid: "The address is not valid.",
  "not-loopback": "Only addresses on this Mac are allowed.",
  redirect: "The server redirected the request, which Modex refuses.",
  "too-large": "The model list was too large to read.",
  timeout: "The server did not answer in time. Is it running?",
  cancelled: "The check was cancelled.",
  unauthorized: "The server refused the token.",
  "not-found": "The server has no model list at this address.",
  "http-error": "The server answered with an error.",
  malformed: "The server's model list could not be read.",
  unavailable: "Nothing is listening at this address. Start the server and refresh.",
  "reflected-credential": "The server echoed the token back, so its answer was discarded.",
  "credential-unavailable": "The saved token could not be read from secure storage.",
};

/** Context windows the person can pick, within main's 4,096–262,144 range. */
export const CONTEXT_CHOICES = [8_192, 16_384, 32_768, 65_536, 131_072, 262_144];
export const CONTEXT_MIN = 4_096;
export const CONTEXT_MAX = 262_144;

/** The windows offered for a model: never more than its advertised maximum, which main also refuses. */
export function contextChoices(advertised: number | null): number[] {
  const cap = Math.min(advertised ?? CONTEXT_MAX, CONTEXT_MAX);
  const choices = CONTEXT_CHOICES.filter(n => n <= cap);
  if (advertised !== null && advertised >= CONTEXT_MIN && advertised <= CONTEXT_MAX && !choices.includes(advertised)) choices.push(advertised);
  if (!choices.length && cap >= CONTEXT_MIN) choices.push(cap);
  return choices;
}

export function tokensLabel(n: number): string {
  return n % 1024 === 0 ? `${n / 1024}K` : n.toLocaleString();
}

/** Models a person can pick from this entry: the last listing's, plus typed IDs main keeps as manual entries. */
export function entryModels(entry: LocalEntry): LocalModelDescriptor[] {
  return entry.result?.state === "ready" ? entry.result.models : [];
}

export type LocalModelsTransport = (request: LocalModelsRequest) => Promise<LocalModelsReply>;

/** Metadata-only window state, isolated from React so late-response ordering can be verified. */
export function createLocalModelStore(invoke: LocalModelsTransport) {
  let state: LocalModelsState = { loaded: false, entries: [] };
  const listeners = new Set<() => void>();
  let generation = 0;
  let nextList = 0;
  let listing: { generation: number; id: number; promise: Promise<void> } | null = null;
  const lastChecked = new Map<string, number>();
  const pending = new Map<string, string>();

  function set(next: LocalModelsState) { state = next; for (const listener of listeners) listener(); }
  function patchEntry(id: string, revision: number, change: (entry: LocalEntry) => LocalEntry) {
    set({ ...state, entries: state.entries.map(entry => entry.connection.id === id && entry.connection.revision === revision ? change(entry) : entry) });
  }
  const key = (c: { id: string; revision: number }) => `${c.id}#${c.revision}`;
  const requestId = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`).slice(0, 64);

  /** Reads the saved profiles again, keeping each revision's last listing. Makes no network request. */
  function loadConnections(): Promise<void> {
    if (listing?.generation === generation) return listing.promise;
    const version = generation, id = ++nextList;
    const promise = (async () => {
      try {
        const reply = await invoke({ op: "list" });
        if (version !== generation) return;
        if (reply.op !== "list") throw new Error("Unexpected reply from main.");
        const previous = new Map(state.entries.map(entry => [key(entry.connection), entry]));
        const current = new Set(reply.connections.map(key));
        for (const old of lastChecked.keys()) if (!current.has(old)) lastChecked.delete(old);
        for (const old of pending.keys()) if (!current.has(old)) pending.delete(old);
        set({ loaded: true, entries: reply.connections.map(connection => ({ connection, result: previous.get(key(connection))?.result,
          checking: previous.get(key(connection))?.checking ?? false, error: previous.get(key(connection))?.error })) });
      } catch (error) {
        if (version === generation) set({ ...state, loaded: true, error: (error as Error).message });
      } finally { if (listing?.id === id) listing = null; }
    })();
    listing = { generation: version, id, promise };
    return promise;
  }

  /** A mutation acknowledgement outranks every profile list started before it. */
  function acceptConnection(connection: LocalConnectionView) {
    generation++;
    const previous = state.entries.find(entry => key(entry.connection) === key(connection));
    const entries = state.entries.filter(entry => entry.connection.id !== connection.id);
    entries.push({ ...previous, connection, checking: false });
    set({ ...state, entries });
  }

  /** Asks main to list one connection's models. A listing for an older revision is dropped by main. */
  async function discover(connection: { id: string; revision: number }): Promise<void> {
    const id = requestId();
    pending.set(key(connection), id);
    patchEntry(connection.id, connection.revision, entry => ({ ...entry, checking: true, error: undefined }));
    lastChecked.set(key(connection), Date.now());
    try {
      const reply = await invoke({ op: "discover", connection: { id: connection.id, revision: connection.revision }, requestId: id });
      if (pending.get(key(connection)) !== id) return;
      if (reply.op !== "discover") throw new Error("Unexpected reply from main.");
      const result = reply.result;
      if (result.state === "stale") {
        patchEntry(connection.id, connection.revision, entry => ({ ...entry, checking: false }));
        await loadConnections(); return;
      }
      patchEntry(connection.id, connection.revision, entry => ({ ...entry, result, checking: false }));
    } catch (error) {
      if (pending.get(key(connection)) !== id) return;
      patchEntry(connection.id, connection.revision, entry => ({ ...entry, checking: false, result: { state: "unavailable", connection, requestId: "", reason: "unavailable", detail: (error as Error).message, models: entry.result?.models ?? [], checkedAt: new Date().toISOString() } }));
    } finally {
      if (pending.get(key(connection)) === id) pending.delete(key(connection));
    }
  }

  async function cancelDiscovery(connection: { id: string; revision: number }): Promise<void> {
    const id = requestId();
    pending.set(key(connection), id);
    try {
      const reply = await invoke({ op: "cancel", id: connection.id });
      if (reply.op !== "cancel") throw new Error("Unexpected reply from main.");
      if (pending.get(key(connection)) !== id) return;
      patchEntry(connection.id, connection.revision, entry => ({ ...entry, checking: false, error: undefined,
        result: { state: "unavailable", connection, requestId: id, reason: "cancelled", detail: "The check was cancelled.", models: [], checkedAt: new Date().toISOString() } }));
    } catch (error) {
      if (pending.get(key(connection)) === id) patchEntry(connection.id, connection.revision, entry => ({ ...entry, checking: false,
        result: undefined, error: "Cancellation could not be confirmed. Refresh to check again." }));
      throw error;
    } finally { if (pending.get(key(connection)) === id) pending.delete(key(connection)); }
  }

  /** Reads the saved profiles again, then lists every connection not checked in the last `maxAgeMs`. */
  async function discoverAll(maxAgeMs = 0): Promise<void> {
    await loadConnections();
    const now = Date.now();
    await Promise.all(state.entries
      .filter(entry => !entry.checking && now - (lastChecked.get(key(entry.connection)) ?? 0) >= maxAgeMs)
      .map(entry => discover(entry.connection)));
  }

  async function addConnection(input: LocalConnectionInput): Promise<LocalConnectionView> {
    const reply = await invoke({ op: "create", input });
    if (reply.op !== "create") throw new Error("Unexpected reply from main.");
    acceptConnection(reply.connection);
    await loadConnections();
    void discover(reply.connection);
    return reply.connection;
  }

  async function updateConnection(connection: LocalConnectionView, patch: Partial<LocalConnectionInput>): Promise<LocalConnectionView> {
    const reply = await invoke({ op: "update", id: connection.id, revision: connection.revision, patch });
    if (reply.op !== "update") throw new Error("Unexpected reply from main.");
    pending.delete(key(connection));
    lastChecked.delete(key(connection));
    acceptConnection(reply.connection);
    await loadConnections();
    void discover(reply.connection);
    return reply.connection;
  }

  async function removeConnection(connection: LocalConnectionView): Promise<void> {
    await invoke({ op: "delete", id: connection.id, revision: connection.revision });
    generation++;
    pending.delete(key(connection));
    lastChecked.delete(key(connection));
    set({ ...state, entries: state.entries.filter(entry => entry.connection.id !== connection.id) });
    await loadConnections();
  }

  function reset() { generation++; listing = null; state = { loaded: false, entries: [] }; pending.clear(); lastChecked.clear(); for (const listener of listeners) listener(); }

  return { getState: () => state, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, loadConnections, discover, cancelDiscovery, discoverAll, addConnection, updateConnection, removeConnection, reset };
}
