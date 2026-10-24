import type { Advertised, ConnectionRef, DiscoveryResult, LocalModelDescriptor, ModelKind } from "../../../shared/local-connections.js";
import type { LocalConnectionStore, ResolvedConnection } from "./connections.js";
import { LocalGetFailure, localGet, localPost, type LocalGetOptions } from "./endpoint-policy.js";

/**
 * Bounded model discovery for one local connection (#378). Every request is a metadata read on the
 * profile's own origin: Ollama's tags/ps/show, LM Studio's model listing, or `/v1/models`. Nothing
 * here generates, embeds, pulls, loads or unloads a model, scans files or tries other ports.
 *
 * What a runtime reports is recorded as reported: "installed"/"loaded" only where the runtime says
 * so, "unknown" otherwise; advertised capabilities are metadata, not coding qualification (#377).
 * A listing that repeats the saved token anywhere in a model ID is dropped whole rather than
 * redacted, since a redacted ID would name a different model; manual IDs holding it are left out.
 * Answers are bound to the profile revision they were read under. An answer that arrives after
 * the profile was edited, deleted or re-read is returned as `stale` and never as current.
 * A whole discovery ends within DEADLINES_PER_DISCOVERY per-request deadlines: per-model detail
 * still unread by then is left unknown rather than holding the answer.
 */

export interface DiscoveryOptions {
  /** Per-request deadline; the whole discovery gets DEADLINES_PER_DISCOVERY of them. */
  timeoutMs?: number;
  /** Test seam for `localhost` resolution. */
  lookup?: LocalGetOptions["lookup"];
  now?: () => Date;
}

const LIST_BYTES = 2 * 1024 * 1024;
const SHOW_BYTES = 1024 * 1024;
const MAX_MODELS = 500;
/** Ollama answers capabilities per model; read at most this many, a few at a time. */
const MAX_SHOW = 32;
const SHOW_CONCURRENCY = 4;
/** At most two listing reads (LM Studio's fallback, Ollama's tags and ps), then per-model reads in what remains. */
const DEADLINES_PER_DISCOVERY = 3;
const MAX_ID = 512;
const CONTROL = /[\x00-\x1f\x7f]/;

type Partial = Omit<LocalModelDescriptor, "model" | "source" | "selectable" | "unselectableReason">;
interface Listing { entries: { id: string; facts: Partial }[]; truncated: boolean }

const UNKNOWN: Partial = { kind: "unknown", installed: "unknown", loaded: "unknown", advertised: { tools: "unknown", vision: "unknown", reasoning: "unknown" }, advertisedContext: null, locality: "unverified" };

const record = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null);
const validId = (v: unknown): v is string => typeof v === "string" && v.trim() !== "" && v.length <= MAX_ID && !CONTROL.test(v);
const positive = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : null);
const has = (list: string[] | null, value: string): Advertised => (list ? (list.includes(value) ? "advertised" : "not-advertised") : "unknown");

function list(raw: unknown, key: "models" | "data"): unknown[] {
  const items = record(raw)?.[key];
  if (!Array.isArray(items)) throw new LocalGetFailure("malformed");
  return items;
}

/** Keeps the first MAX_MODELS distinct valid IDs in the runtime's order. */
function collect(items: unknown[], idOf: (item: Record<string, unknown>) => unknown, facts: (item: Record<string, unknown>) => Partial): Listing {
  const entries: Listing["entries"] = [];
  const seen = new Set<string>();
  let truncated = false;
  for (const raw of items) {
    const item = record(raw);
    const id = item ? idOf(item) : undefined;
    if (!item || !validId(id) || seen.has(id)) continue;
    if (entries.length >= MAX_MODELS) { truncated = true; break; }
    seen.add(id);
    entries.push({ id, facts: facts(item) });
  }
  return { entries, truncated };
}

async function responsesListing(c: ResolvedConnection, get: (path: string) => Promise<unknown>): Promise<Listing> {
  const items = list(await get(c.endpoint.basePath === "/v1" ? "/models" : "/v1/models"), "data");
  // vLLM reports its serving limit as max_model_len; nothing else is knowable from this route.
  return collect(items, i => i.id, i => ({ ...UNKNOWN, advertisedContext: positive(i.max_model_len) }));
}

function lmStudioFacts(i: Record<string, unknown>): Partial {
  const type = typeof i.type === "string" ? i.type : null;
  const kind: ModelKind = type === "llm" || type === "vlm" ? "generative" : type === "embeddings" ? "embedding" : type ? "other" : "unknown";
  const caps = Array.isArray(i.capabilities) ? i.capabilities.filter((x): x is string => typeof x === "string") : null;
  return {
    kind, installed: "yes",
    loaded: i.state === "loaded" ? "yes" : i.state === "not-loaded" ? "no" : "unknown",
    advertised: { tools: has(caps, "tool_use"), vision: type === "vlm" ? "advertised" : type === "llm" ? "not-advertised" : "unknown", reasoning: "unknown" },
    advertisedContext: positive(i.max_context_length), locality: "unverified",
  };
}

async function lmStudioListing(c: ResolvedConnection, get: (path: string) => Promise<unknown>): Promise<Listing> {
  let raw: unknown;
  try {
    raw = await get("/api/v0/models");
  } catch (err) {
    // Builds without the native REST listing still serve the OpenAI-compatible one.
    if (err instanceof LocalGetFailure && err.reason === "not-found") return responsesListing(c, get);
    throw err;
  }
  return collect(list(raw, "data"), i => i.id, lmStudioFacts);
}

/** Ollama marks models it forwards to ollama.com with remote_host, and names them `…-cloud`/`…:cloud`. */
const ollamaCloud = (i: Record<string, unknown>, id: string) => typeof i.remote_host === "string" || typeof i.remote_model === "string" || /[:-]cloud$/.test(id);

async function ollamaListing(get: (path: string) => Promise<unknown>, show: (model: string, signal: AbortSignal) => Promise<unknown>, signal: AbortSignal, deadline: number): Promise<Listing> {
  const tags = list(await get("/api/tags"), "models");
  let loaded: Set<string> | null = null;
  try {
    loaded = new Set(list(await get("/api/ps"), "models").map(m => record(m)?.name).filter(validId));
  } catch (err) {
    if (err instanceof LocalGetFailure && err.reason === "cancelled") throw err;
  }
  const listing = collect(tags, i => i.name ?? i.model, i => {
    const id = (validId(i.name) ? i.name : i.model) as string;
    const cloud = ollamaCloud(i, id);
    return { ...UNKNOWN, installed: cloud ? "unknown" : "yes", loaded: loaded ? (loaded.has(id) ? "yes" : "no") : "unknown", locality: cloud ? "cloud" : "unverified" };
  });
  const queue = listing.entries.filter(e => e.facts.locality !== "cloud").slice(0, MAX_SHOW);
  // Out of time is not a failure: what was read is kept and the rest stays unknown.
  const outOfTime = AbortSignal.timeout(Math.max(0, deadline - Date.now()));
  const reads = AbortSignal.any([signal, outOfTime]);
  const worker = async () => {
    for (let entry = queue.shift(); entry && !outOfTime.aborted; entry = queue.shift()) {
      if (signal.aborted) throw new LocalGetFailure("cancelled");
      let info: Record<string, unknown> | null;
      try { info = record(await show(entry.id, reads)); } catch {
        if (signal.aborted) throw new LocalGetFailure("cancelled");
        continue;
      }
      const caps = Array.isArray(info?.capabilities) ? (info.capabilities as unknown[]).filter((x): x is string => typeof x === "string") : null;
      if (!caps) continue;
      const modelInfo = record(info?.model_info) ?? {};
      const context = Object.entries(modelInfo).find(([k]) => k.endsWith(".context_length"))?.[1];
      entry.facts = {
        ...entry.facts,
        kind: caps.includes("completion") ? "generative" : caps.includes("embedding") ? "embedding" : caps.length ? "other" : "unknown",
        advertised: { tools: has(caps, "tools"), vision: has(caps, "vision"), reasoning: has(caps, "thinking") },
        advertisedContext: positive(context),
      };
    }
  };
  await Promise.all(Array.from({ length: SHOW_CONCURRENCY }, worker));
  return listing;
}

function descriptor(connection: ConnectionRef, id: string, source: LocalModelDescriptor["source"], facts: Partial): LocalModelDescriptor {
  const reason = facts.locality === "cloud" ? "cloud" : facts.kind === "embedding" ? "embedding" : facts.kind === "other" ? "other" : undefined;
  return { model: { schema: 1, connection: { ...connection }, id }, source, ...facts, advertised: { ...facts.advertised }, selectable: !reason, ...(reason ? { unselectableReason: reason } : {}) };
}

export class LocalModelDiscovery {
  private readonly inflight = new Map<string, { controller: AbortController; requestId: string }>();
  private readonly timeoutMs: number;
  private readonly now: () => Date;

  constructor(private readonly store: LocalConnectionStore, private readonly options: DiscoveryOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.now = options.now ?? (() => new Date());
  }

  /** Drops any read in flight for a connection; call on edit and delete. Its caller sees `stale`. */
  invalidate(connectionId: string): void {
    this.inflight.get(connectionId)?.controller.abort();
  }

  cancel(connectionId: string): void {
    this.invalidate(connectionId);
  }

  async discover(ref: ConnectionRef, requestId: string): Promise<DiscoveryResult> {
    const stale: DiscoveryResult = { state: "stale", connection: { ...ref }, requestId };
    const resolved = this.store.resolve(ref);
    if (!resolved) return stale;
    // A newer read supersedes existing work even when its credential is unavailable.
    this.inflight.get(ref.id)?.controller.abort();
    const unavailableCredential = (): DiscoveryResult => {
      const reason = "credential-unavailable";
      // Without the saved token, manual IDs cannot be checked for reflected credentials.
      return { state: "unavailable", connection: { ...ref }, requestId, reason, detail: new LocalGetFailure(reason).message, models: [], checkedAt: this.now().toISOString() };
    };
    if (resolved.credentialUnavailable) return unavailableCredential();
    const deadline = Date.now() + DEADLINES_PER_DISCOVERY * this.timeoutMs;
    const entry = { controller: new AbortController(), requestId };
    this.inflight.set(ref.id, entry);
    const signal = entry.controller.signal;
    const opts = (maxBytes: number): LocalGetOptions => ({ maxBytes, timeoutMs: this.timeoutMs, signal, ...(resolved.token ? { token: resolved.token } : {}), ...(this.options.lookup ? { lookup: this.options.lookup } : {}) });
    const get = (path: string) => localGet(resolved.endpoint, path, opts(LIST_BYTES));
    const show = (model: string, reads: AbortSignal) => localPost(resolved.endpoint, "/api/show", { model }, { ...opts(SHOW_BYTES), signal: reads });
    let listing: Listing | null = null;
    let failure: LocalGetFailure | null = null;
    try {
      listing = resolved.runtime === "ollama" ? await ollamaListing(get, show, signal, deadline)
        : resolved.runtime === "lmstudio" ? await lmStudioListing(resolved, get)
          : await responsesListing(resolved, get);
    } catch (err) {
      failure = err instanceof LocalGetFailure ? err : new LocalGetFailure("malformed");
    } finally {
      if (this.inflight.get(ref.id) === entry) this.inflight.delete(ref.id);
    }
    // Superseded, cancelled, edited or deleted while this ran: the answer is not current.
    const current = this.store.resolve(ref);
    if (signal.aborted || failure?.reason === "cancelled" || !current) return stale;
    if (current.credentialUnavailable) return unavailableCredential();
    const reflects = (id: string) => resolved.token !== null && id.includes(resolved.token);
    if (listing?.entries.some(e => reflects(e.id))) {
      listing = null;
      failure = new LocalGetFailure("reflected-credential");
    }
    const discovered = (listing?.entries ?? []).map(e => descriptor(ref, e.id, "discovered", e.facts));
    const ids = new Set(discovered.map(d => d.model.id));
    const manual = resolved.manualModels.filter(id => !ids.has(id) && !reflects(id)).map(id => descriptor(ref, id, "manual", UNKNOWN));
    const models = [...discovered, ...manual];
    const checkedAt = this.now().toISOString();
    if (failure) return { state: "unavailable", connection: { ...ref }, requestId, reason: failure.reason, detail: failure.message, models, checkedAt };
    return { state: "ready", connection: { ...ref }, requestId, models, truncated: listing!.truncated, checkedAt };
  }
}
