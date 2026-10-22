/**
 * Local-model connections and discovery as the renderer sees them (#378). Main owns the profiles,
 * the tokens and every request; these views carry no secret and no address beyond the origin the
 * person typed. Model identity (`connection` + exact `id`) follows the #377 contract draft: the
 * same id on two connections, or on two revisions of one, is two different targets.
 */

/** Metadata adapter. "responses" covers llama.cpp, vLLM and other servers listing `/v1/models`. */
export type LocalRuntime = "ollama" | "lmstudio" | "responses";
export const LOCAL_RUNTIMES: readonly LocalRuntime[] = ["ollama", "lmstudio", "responses"];

export interface ConnectionRef {
  id: string;
  revision: number;
}

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
  model: { connection: ConnectionRef; id: string };
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

export type DiscoveryFailure = "invalid" | "not-loopback" | "redirect" | "too-large" | "timeout" | "cancelled" | "unauthorized" | "not-found" | "http-error" | "malformed" | "unavailable";

export type DiscoveryResult =
  | { state: "ready"; connection: ConnectionRef; requestId: string; models: LocalModelDescriptor[]; truncated: boolean; checkedAt: string }
  | { state: "unavailable"; connection: ConnectionRef; requestId: string; reason: DiscoveryFailure; detail: string; models: LocalModelDescriptor[]; checkedAt: string }
  /** The profile changed or was deleted while this ran; the answer was dropped, not shown. */
  | { state: "stale"; connection: ConnectionRef; requestId: string };
