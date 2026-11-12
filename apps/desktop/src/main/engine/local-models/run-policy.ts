/**
 * Local-run policy, slice 1 (#380): admission of a local Codex child by its *effective* configuration.
 *
 * Naming a provider on `thread/start` and having Codex confirm it does not prove where requests go: a
 * managed layer (an MDM profile, `/etc/codex`, an enterprise bundle), the child's own user file or a
 * project `.codex` could set the provider's `base_url`, swap the model, re-enable web search or add MCP
 * servers above Modex's session flags, and Codex has no setting that constrains redirects. So before any
 * turn content is sent, main reads `config/read` (the effective configuration and the layer that set each
 * key) and `configRequirements/read` (admin-enforced requirements) from the child itself, and admits the
 * child only when every governed key comes from Modex's session flags, the effective values are the ones
 * Modex passed, the private user configuration is empty or contains only the exact current-workspace trust mark, no project layer is loaded and no managed requirements apply.
 * Anything else is refused with the layer and key named; nothing is bypassed or rewritten (#379 AC6).
 *
 * What this cannot prove: that the loopback server keeps the request local. Codex follows an HTTP
 * redirect from the configured server with the full request body (the token is dropped), exactly as a
 * server could forward it; see docs/reviews/2026-10-27-lm5-destination-policy.md.
 */
import path from "node:path";

/**
 * Whether a thread is local-only (#380): it carries a local target, valid or not. Main keeps every
 * auxiliary model call and cloud fallback off for such a thread at the point that would make it (Jev,
 * credit fallback, naming, unattended runs), not only at the caller, so a new caller cannot leak it.
 */
export function localOnly(thread: { localTarget?: unknown } | undefined): boolean {
  return thread !== undefined && thread.localTarget !== undefined;
}

export interface ConfigLayerSource { type: string; file?: string; domain?: string; key?: string; id?: string; name?: string; dotCodexFolder?: string; profile?: string | null }
export interface ConfigLayer { name: ConfigLayerSource; version: string; config: unknown; disabledReason?: string | null }
export interface ConfigRead { config: Record<string, unknown>; origins: Record<string, { name: ConfigLayerSource; version: string }>; layers?: ConfigLayer[] | null }
export interface RequirementsRead { requirements: unknown }

/** What Modex passed as session flags for this child (execution.ts), to be found again in the effective configuration. */
export interface ExpectedLocalConfiguration { provider: string; origin: string; contextTokens: number; tokenEnv: string | null; privateWorkspace?: { directory: string; configFile: string } }

/** Main-owned assertion of an already enforced host boundary, never a thread or renderer setting. */
export interface LocalHostSandbox {
  readonly type: "externalSandbox";
  readonly networkAccess: "restricted";
  readonly boundaryId: string;
}

/** The configuration a child was admitted on, kept with the child for diagnostics; no secrets. */
export interface LocalConfigurationProvenance {
  /** Codex's hash of the session-flags layer: the configuration Modex passed, as Codex read it. */
  sessionFlags: string;
  layers: { source: string; version: string; file?: string }[];
  managedRequirements: false;
  /** Only this child's current-workspace trust metadata was admitted; no project layer or other user setting. */
  privateWorkspaceTrust?: { scope: "current-workspace"; level: "trusted" };
  /** The caller owns enforcing this boundary before spawning Codex; its hash binds process identity. */
  hostSandbox?: LocalHostSandbox;
  /** Set by the caller that knows where the window came from (execution.ts). */
  context?: LocalContextEvidence;
}

/**
 * The context window a local child runs with, each source kept apart (#380 AC6). Modex never inherits a
 * cloud model's default: the window is the person's explicit choice, checked against what the runtime
 * advertised when that is known. What the runtime actually loaded the model with is not reported to
 * Modex by any supported runtime, so it stays unknown rather than assumed equal.
 */
export interface LocalContextEvidence {
  /** The window Modex passed to Codex: the person's explicit setting. */
  configured: number;
  source: "person";
  /** What the child's `config/read` reported in effect; admission requires it to equal `configured`. */
  effective: number;
  /** The runtime's advertised maximum from the last ready listing (`tokens: null` when it advertised none), or not checked. */
  advertised: { tokens: number | null; checkedAt: string } | "not-checked";
  loaded: "unknown";
}

/** Keys a layer other than Modex's session flags may not set: the inference destination, the model, its context and the tools reaching it. */
const GOVERNED = ["model", "model_provider", "model_providers", "openai_base_url", "oss_provider", "model_catalog_json", "model_context_window", "model_auto_compact_token_limit",
  // Native compaction: what it sends the provider and when it runs (#380 AC1; key names from codex-cli 0.166.0).
  "compact_prompt", "model_auto_compact_token_limit_scope", "model_post_turn_compact_threshold_percent", "model_async_compact_threshold_percent",
  "model_reasoning_summary", "model_reasoning_effort", "service_tier", "web_search", "features", "mcp_servers", "shell_environment_policy", "plugins", "hooks", "marketplaces",
  "profile", "profiles", "projects", "notify", "otel", "tools", "developer_instructions", "model_instructions_file", "agents", "cloud"];
const MANAGED = new Set(["mdm", "system", "enterpriseManaged", "legacyManagedConfigTomlFromFile", "legacyManagedConfigTomlFromMdm"]);

export function governed(key: string): boolean {
  return key.startsWith("experimental_") || GOVERNED.some(prefix => key === prefix || key.startsWith(`${prefix}.`));
}

export function describeLayer(source: ConfigLayerSource): string {
  switch (source.type) {
    case "sessionFlags": return "Modex's session settings";
    case "packagedDefaults": return "Codex's packaged defaults";
    case "mdm": return `a managed preferences profile (${source.domain ?? "MDM"})`;
    case "system": return `the system configuration${source.file ? ` at ${source.file}` : ""}`;
    case "enterpriseManaged": return `an enterprise-managed configuration${source.name ? ` (${source.name})` : ""}`;
    case "legacyManagedConfigTomlFromFile": return `the managed configuration${source.file ? ` at ${source.file}` : ""}`;
    case "legacyManagedConfigTomlFromMdm": return "a managed configuration profile";
    case "user": return `the child's user configuration${source.file ? ` at ${source.file}` : ""}`;
    case "project": return `a project configuration${source.dotCodexFolder ? ` at ${source.dotCodexFolder}` : ""}`;
    default: return `a ${source.type} configuration layer`;
  }
}

function refuse(reason: string): never {
  throw new Error(`Local execution refused: ${reason} Local execution under that configuration is not qualified; Modex did not change it and sent nothing.`);
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** A native child may persist this one trust mark after opening its workspace. It grants no exception for other configuration. */
function currentWorkspaceTrust(value: unknown, directory: string): boolean {
  const projects = record(value);
  if (!projects || Object.keys(projects).length !== 1 || !Object.hasOwn(projects, directory)) return false;
  const project = record(projects[directory]);
  return project !== null && Object.keys(project).length === 1 && project.trust_level === "trusted";
}

function privateTrustLayer(read: ConfigRead, expected: ExpectedLocalConfiguration): ConfigLayer | undefined {
  const bound = expected.privateWorkspace;
  if (!bound || !path.isAbsolute(bound.directory) || !path.isAbsolute(bound.configFile)) return;
  const users = read.layers?.filter(layer => layer?.name?.type === "user") ?? [];
  if (users.length !== 1) return;
  const layer = users[0]!;
  if (layer.name.file !== bound.configFile || layer.name.profile != null || layer.disabledReason != null || typeof layer.version !== "string") return;
  const contents = record(layer.config);
  if (!contents || Object.keys(contents).length !== 1 || !currentWorkspaceTrust(contents.projects, bound.directory)
    || !currentWorkspaceTrust(read.config.projects, bound.directory)) return;
  const origin = read.origins[`projects.${bound.directory}.trust_level`];
  if (origin?.name?.type !== "user" || origin.name.file !== bound.configFile || origin.name.profile != null || origin.version !== layer.version) return;
  return layer;
}

/** Admits the child or throws with the layer and key that disqualify it. Pure: nothing is read or written here. */
export function admitLocalConfiguration(read: ConfigRead, requirements: RequirementsRead, expected: ExpectedLocalConfiguration): LocalConfigurationProvenance {
  const config = record(read?.config);
  const origins = record(read?.origins);
  if (!config || !origins) refuse("Codex did not report its effective configuration.");
  if (requirements?.requirements !== null && requirements?.requirements !== undefined) refuse("Codex is under managed requirements on this Mac.");
  const layers = Array.isArray(read.layers) ? read.layers : null;
  if (!layers) refuse("Codex did not report its configuration layers.");
  const privateTrust = privateTrustLayer(read, expected);
  // Every governed key stays pinned to Modex, except the validated single-workspace trust mark in its own private child.
  for (const [key, origin] of Object.entries(origins)) {
    const source = record(origin)?.name as ConfigLayerSource | undefined;
    if (!source?.type) refuse(`Codex did not say which configuration sets \`${key}\`.`);
    const retainedTrust = privateTrust && key === `projects.${expected.privateWorkspace!.directory}.trust_level`
      && source.type === "user" && source.file === privateTrust.name.file && source.profile == null
      && record(origin)?.version === privateTrust.version;
    if (governed(key) && source.type !== "sessionFlags" && !retainedTrust) refuse(`${describeLayer(source)} sets \`${key}\`.`);
  }
  let sessionFlags: string | undefined;
  const summary: LocalConfigurationProvenance["layers"] = [];
  for (const layer of layers) {
    const source = layer?.name;
    if (!source?.type || typeof layer.version !== "string") refuse("Codex reported a configuration layer it did not name.");
    const contents = record(layer.config);
    const keys = contents ? Object.keys(contents) : [];
    if (source.type === "sessionFlags") sessionFlags = layer.version;
    else if (source.type === "project") refuse(`${describeLayer(source)} is loaded.`);
    else if (source.type === "user" && keys.length && layer !== privateTrust) refuse(`${describeLayer(source)} is not empty (${keys.join(", ")}).`);
    else if (MANAGED.has(source.type) && keys.some(governed)) refuse(`${describeLayer(source)} sets ${keys.filter(governed).map(k => `\`${k}\``).join(", ")}.`);
    summary.push({ source: source.type, version: layer.version, ...(source.file ? { file: source.file } : {}) });
  }
  if (!sessionFlags) refuse("Codex did not load Modex's session settings.");
  // The effective values themselves: the destination, wire, credential reference, context and tools Modex asked for.
  const provider = record(record(config.model_providers)?.[expected.provider]);
  const want = (name: string, actual: unknown, wanted: unknown) => { if (actual !== wanted) refuse(`the effective \`${name}\` is ${JSON.stringify(actual ?? null)}, not ${JSON.stringify(wanted ?? null)}.`); };
  want("model_provider", config.model_provider, expected.provider);
  if (!provider) refuse(`the effective configuration has no \`model_providers.${expected.provider}\`.`);
  want(`model_providers.${expected.provider}.base_url`, provider.base_url, `${expected.origin}/v1`);
  want(`model_providers.${expected.provider}.wire_api`, provider.wire_api, "responses");
  want(`model_providers.${expected.provider}.requires_openai_auth`, provider.requires_openai_auth, false);
  want(`model_providers.${expected.provider}.env_key`, provider.env_key ?? null, expected.tokenEnv);
  want(`model_providers.${expected.provider}.request_max_retries`, provider.request_max_retries, 0);
  // A dropped stream is otherwise re-sent whole: the turn reports the drop instead (#380 AC4).
  want(`model_providers.${expected.provider}.stream_max_retries`, provider.stream_max_retries, 0);
  for (const name of ["experimental_bearer_token", "auth", "http_headers", "env_http_headers", "query_params"]) want(`model_providers.${expected.provider}.${name}`, provider[name] ?? null, null);
  want("model_context_window", config.model_context_window, expected.contextTokens);
  want("web_search", config.web_search, "disabled");
  want("openai_base_url", config.openai_base_url ?? null, null);
  want("model_reasoning_summary", config.model_reasoning_summary ?? null, null);
  const features = record(config.features);
  want("features.view_image", features?.view_image ?? null, false);
  want("features.multi_agent", features?.multi_agent ?? null, false);
  want("features.multi_agent_v2", features?.multi_agent_v2 ?? null, false);
  const servers = record(config.mcp_servers);
  if (servers && Object.keys(servers).length) refuse(`MCP servers are configured (${Object.keys(servers).join(", ")}).`);
  return { sessionFlags, layers: summary, managedRequirements: false, ...(privateTrust ? { privateWorkspaceTrust: { scope: "current-workspace", level: "trusted" } as const } : {}) };
}
