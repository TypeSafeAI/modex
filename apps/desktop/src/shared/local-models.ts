import type { BackendId } from "./types.js";

/** Data contracts only. These do not admit a turn, grant authority or select a backend. */
export type NativeHarness = Extract<BackendId, "codex" | "claude">;
export interface ConnectionRef { readonly id: string; readonly revision: number }
export interface LocalModelRef {
  readonly schema: 1;
  readonly connection: ConnectionRef;
  /** Exact runtime-served identifier: never trim, case-fold, split or infer a brand. */
  readonly id: string;
}
/** Metadata protocol only; this is neither a harness nor a compatibility claim. */
export type LocalMetadataRuntime = "ollama" | "lmstudio" | "responses";
export type LocalConnectionProfile = "ollama" | "lmstudio" | "llamacpp" | "vllm" | "custom";

export function metadataRuntimeForProfile(profile: LocalConnectionProfile): LocalMetadataRuntime {
  return profile === "ollama" || profile === "lmstudio" ? profile : "responses";
}

/** A generic listing never establishes which server implementation is behind it. */
export function connectionProfileForRuntime(runtime: LocalMetadataRuntime): LocalConnectionProfile {
  return runtime === "responses" ? "custom" : runtime;
}

/** Main validates the connection and exact ID before constructing a reference. */
export function localModelRef(connection: ConnectionRef, id: string): LocalModelRef {
  return { schema: 1, connection: { id: connection.id, revision: connection.revision }, id };
}
export interface LocalConnection {
  readonly schema: 1;
  readonly ref: ConnectionRef;
  readonly label: string;
  readonly profile: LocalConnectionProfile;
  /** Validated by main in LM-2; no credentials, query, fragment or non-loopback destination. */
  readonly endpoint: string;
  readonly wire: "responses";
  /** Opaque main-owned secret-store reference, never a token or URL. Not renderer data. */
  readonly credentialRef: string | null;
}
export type ConnectionHealth =
  | { readonly state: "unknown" }
  | { readonly state: "reachable" | "unreachable" | "unauthorized"; readonly checkedAt: string };
export type Capability = "tools" | "images" | "structuredOutputs" | "reasoning" | "resume" | "cancellation";
export type Support = "supported" | "unsupported" | "unknown";
/** Allowlisted non-secret settings, captured by main after native configuration precedence. */
export interface EffectiveLocalSettings {
  readonly providerId: string;
  readonly reasoningEffort: string | null;
  readonly reasoningSummary: string | null;
  readonly serviceTier: string | null;
  readonly approvalPolicy: string;
  readonly sandbox: "read-only" | "workspace-write" | "danger-full-access";
  readonly networkAccess: boolean;
  readonly writableRoots: readonly string[];
  readonly toolsetRevision: string;
}
export interface QualificationConfiguration {
  readonly schema: 1;
  readonly harness: NativeHarness;
  readonly cliVersion: string;
  readonly model: LocalModelRef;
  readonly runtime: {
    readonly name: string;
    readonly version: string | null;
    readonly modelRevision: string | null;
    readonly templateRevision: string | null;
    readonly toolParserRevision: string | null;
  };
  /** Main-owned revision of all effective non-secret settings, including tool/sandbox policy. */
  readonly settingsRevision: string;
  readonly effectiveContextTokens: number | null;
  readonly effectiveSettings: EffectiveLocalSettings;
}
export interface CapabilityEvidence {
  readonly capability: Capability;
  readonly status: Support;
  readonly source: "metadata" | "native-test";
  readonly configuration: QualificationConfiguration;
  readonly receipt: string;
  readonly observedAt: string;
}
export interface ModelMetadata {
  readonly model: LocalModelRef;
  readonly advertisedContextTokens: number | null;
  readonly capabilities: readonly CapabilityEvidence[];
}
export interface LocalRunProvenance {
  readonly schema: 1;
  readonly configuration: QualificationConfiguration;
  /** Opaque generations only: never credential material or a digest of a secret. */
  readonly credentialGeneration: string;
  readonly accountGeneration: string;
  readonly processConfigurationRevision: string;
  readonly processGeneration: string;
  readonly connectionSnapshot: { readonly ref: ConnectionRef; readonly profile: LocalConnection["profile"]; readonly wire: "responses" };
  readonly native: { readonly thread: string; readonly turn: string };
  readonly startedAt: string;
  /** Loopback alone does not establish local inference or network-denied execution. */
  readonly locality: "unverified" | "local-inference-observed" | "offline-verified";
  readonly localityReceipt: string | null;
}

export function modelKey(model: LocalModelRef): string {
  return JSON.stringify([model.schema, model.connection.id, model.connection.revision, model.id]);
}

/** Unknown runtime revisions cannot provide a reusable qualification, even if both are null. */
function configurationKey(c: QualificationConfiguration): string | null {
  const settings = c.effectiveSettings;
  const revisions = [settings.providerId, settings.toolsetRevision, c.cliVersion, c.runtime.name, c.runtime.version, c.runtime.modelRevision, c.runtime.templateRevision, c.runtime.toolParserRevision, c.settingsRevision];
  if (revisions.some(value => !value) || !Number.isSafeInteger(c.effectiveContextTokens) || c.effectiveContextTokens! <= 0) return null;
  return JSON.stringify([c.schema, c.harness, modelKey(c.model), ...revisions, c.effectiveContextTokens, settings.reasoningEffort, settings.reasoningSummary, settings.serviceTier, settings.approvalPolicy, settings.sandbox, settings.networkAccess, settings.writableRoots]);
}

/** Metadata is not observed support; conflicting observations require requalification. */
export function capabilityStatus(capability: Capability, configuration: QualificationConfiguration, evidence: readonly CapabilityEvidence[]): Support {
  const key = configurationKey(configuration);
  if (!key) return "unknown";
  const matching = evidence.filter(e => e.capability === capability && e.source === "native-test" && e.receipt.trim() && Number.isFinite(Date.parse(e.observedAt)) && configurationKey(e.configuration) === key);
  const statuses = new Set(matching.map(e => e.status));
  return statuses.size === 1 ? matching[0]!.status : "unknown";
}

export interface LocalThreadTarget {
  readonly schema: 1;
  readonly harness: NativeHarness;
  readonly model: LocalModelRef;
}

/** Pure migration reader for downstream adoption. Production admission is still gated by LM-3. */
export function threadTarget(thread: { backend: BackendId; model?: string; codexAccount?: string; sessionHandle?: string; localTarget?: unknown }) {
  if (!("localTarget" in thread)) return { kind: "legacy" as const, backend: thread.backend, model: thread.model, account: thread.codexAccount, resume: thread.sessionHandle };
  const target = thread.localTarget as Partial<LocalThreadTarget> | null;
  const model = target?.model;
  if (!target || target.schema !== 1 || !["codex", "claude"].includes(target.harness ?? "") || target.harness !== thread.backend ||
      model?.schema !== 1 || typeof model.id !== "string" || !model.id.length ||
      typeof model.connection?.id !== "string" || !model.connection.id.length ||
      !Number.isSafeInteger(model.connection.revision) || model.connection.revision < 1) throw new Error("Invalid local target; execution is unavailable.");
  // Deliberately omit legacy resume/account handles: LM-3 must validate provenance before resume.
  return { kind: "local" as const, target: { schema: 1 as const, harness: target.harness as NativeHarness,
    model: { schema: 1 as const, id: model.id, connection: { id: model.connection.id, revision: model.connection.revision } } } };
}
