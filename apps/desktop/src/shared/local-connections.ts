import type { ConnectionRef, LocalModelRef } from "./local-models.js";
export type { ConnectionRef } from "./local-models.js";

/**
 * Local-model connections and discovery as the renderer sees them (#378). Main owns the profiles,
 * the tokens and every request; these views carry no secret and no address beyond the origin the
 * person typed. Model identity follows the schema-1 shared #377 contract: the
 * same id on two connections, or on two revisions of one, is two different targets.
 */

/** Metadata adapter. "responses" covers llama.cpp, vLLM and other servers listing `/v1/models`. */
export type LocalRuntime = "ollama" | "lmstudio" | "responses";
export const LOCAL_RUNTIMES: readonly LocalRuntime[] = ["ollama", "lmstudio", "responses"];

export interface LocalConnectionView extends ConnectionRef {
  label: string;
  runtime: LocalRuntime;
  origin: string;
  basePath: "" | "/v1";
  /** Model IDs the person typed, for servers whose listing is incomplete. Exact, never normalized. */
  manualModels: string[];
  /** Presence only: never the token, never its last characters. */
  credential: { present: boolean; storage: string };
  createdAt: string;
  updatedAt: string;
}

export interface LocalConnectionInput {
  label: string;
  runtime: LocalRuntime;
  url: string;
  /** Omitted keeps the saved token (unless the address changes), null clears it. */
  token?: string | null;
  manualModels?: string[];
}

/** What a metadata field said, or "unknown" when the runtime didn't say. Never a test result. */
export type Advertised = "advertised" | "not-advertised" | "unknown";

export type ModelKind = "generative" | "embedding" | "other" | "unknown";

export interface LocalModelDescriptor {
  model: LocalModelRef;
  /** Where this entry came from: the runtime's listing, or typed by the person. */
  source: "discovered" | "manual";
  kind: ModelKind;
  installed: "yes" | "unknown";
  loaded: "yes" | "no" | "unknown";
  /** Runtime-reported metadata only. Coding qualification is a separate, tested fact (#377). */
  advertised: { tools: Advertised; vision: Advertised; reasoning: Advertised };
  /** The runtime's advertised maximum context, not an effective or tested one. */
  advertisedContext: number | null;
  /**
   * "cloud" when the runtime itself marks the model as served elsewhere; otherwise unverified:
   * loopback alone does not prove inference stays on this machine.
   */
  locality: "cloud" | "unverified";
  /** False for known embedding-only and cloud-routed models; unknown kinds stay selectable for explicit tests. */
  selectable: boolean;
  unselectableReason?: "embedding" | "cloud" | "other";
}

export type DiscoveryFailure = "invalid" | "not-loopback" | "redirect" | "too-large" | "timeout" | "cancelled" | "unauthorized" | "not-found" | "http-error" | "malformed" | "unavailable" | "reflected-credential";

export type DiscoveryResult =
  | { state: "ready"; connection: ConnectionRef; requestId: string; models: LocalModelDescriptor[]; truncated: boolean; checkedAt: string }
  | { state: "unavailable"; connection: ConnectionRef; requestId: string; reason: DiscoveryFailure; detail: string; models: LocalModelDescriptor[]; checkedAt: string }
  /** The profile changed or was deleted while this ran; the answer was dropped, not shown. */
  | { state: "stale"; connection: ConnectionRef; requestId: string };

/** The one `local-models:command` channel. Unknown fields are refused, never ignored. */
export type LocalModelsRequest =
  | { op: "list" }
  | { op: "create"; input: LocalConnectionInput }
  | { op: "update"; id: string; revision: number; patch: Partial<LocalConnectionInput> }
  | { op: "delete"; id: string; revision: number }
  | { op: "discover"; connection: ConnectionRef; requestId: string }
  | { op: "cancel"; id: string };

export type LocalModelsReply =
  | { op: "list"; connections: LocalConnectionView[] }
  | { op: "create" | "update"; connection: LocalConnectionView }
  | { op: "delete" | "cancel" }
  | { op: "discover"; result: DiscoveryResult };

const OP_KEYS: Record<LocalModelsRequest["op"], string[]> = {
  list: ["op"], create: ["op", "input"], update: ["op", "id", "revision", "patch"], delete: ["op", "id", "revision"],
  discover: ["op", "connection", "requestId"], cancel: ["op", "id"],
};
const INPUT_KEYS = ["label", "runtime", "url", "token", "manualModels"];

const plain = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const onlyKeys = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).every(k => keys.includes(k));
const shortString = (v: unknown, max = 128): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
const revision = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 1;

/** Shape only; main's store validates every value again. */
export function validateLocalModelsRequest(input: unknown): LocalModelsRequest | null {
  if (!plain(input) || typeof input.op !== "string" || !Object.hasOwn(OP_KEYS, input.op)) return null;
  const op = input.op as LocalModelsRequest["op"];
  if (!onlyKeys(input, OP_KEYS[op]) || !OP_KEYS[op].every(k => k in input)) return null;
  switch (op) {
    case "list": return { op };
    case "create": return plain(input.input) && onlyKeys(input.input, INPUT_KEYS) ? { op, input: input.input as unknown as LocalConnectionInput } : null;
    case "update": return shortString(input.id) && revision(input.revision) && plain(input.patch) && onlyKeys(input.patch, INPUT_KEYS)
      ? { op, id: input.id, revision: input.revision, patch: input.patch as Partial<LocalConnectionInput> } : null;
    case "delete": return shortString(input.id) && revision(input.revision) ? { op, id: input.id, revision: input.revision } : null;
    case "discover": {
      const c = input.connection;
      return plain(c) && onlyKeys(c, ["id", "revision"]) && shortString(c.id) && revision(c.revision) && shortString(input.requestId, 64)
        ? { op, connection: { id: c.id, revision: c.revision }, requestId: input.requestId } : null;
    }
    case "cancel": return shortString(input.id) ? { op, id: input.id } : null;
  }
}
