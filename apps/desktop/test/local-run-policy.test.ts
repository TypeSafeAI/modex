import { test } from "node:test";
import assert from "node:assert/strict";
import { admitLocalConfiguration, describeLayer, governed, type ConfigRead } from "../src/main/engine/local-models/run-policy.js";

const EXPECTED = { provider: "modex_local", origin: "http://127.0.0.1:18501", contextTokens: 32768, tokenEnv: "MODEX_LOCAL_TOKEN" };
const FLAGS = "sha256:b3932b4abe963781145150a5f8db02bf0afb5fe03385d52c15122db85463fce3";
const EMPTY = "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a";

/** The shape codex-cli 0.164.0 returned for an LM-3 child on 2026-10-27 (docs/reviews/2026-10-27-lm5-destination-policy.md), trimmed to what the policy reads. */
function read(): ConfigRead {
  const flags = {
    model_provider: "modex_local",
    model_providers: { modex_local: { name: "Modex local", base_url: "http://127.0.0.1:18501/v1", wire_api: "responses", requires_openai_auth: false, env_key: "MODEX_LOCAL_TOKEN", request_max_retries: 0 } },
    model_context_window: 32768, web_search: "disabled", features: { view_image: false }, shell_environment_policy: { exclude: ["MODEX_LOCAL_TOKEN"] },
  };
  const origin = { name: { type: "sessionFlags" }, version: FLAGS };
  return {
    config: { model: null, model_provider: "modex_local", model_context_window: 32768, web_search: "disabled", model_reasoning_summary: null, openai_base_url: null, mcp_servers: {},
      model_providers: { modex_local: { ...flags.model_providers.modex_local, experimental_bearer_token: null, auth: null, http_headers: null, env_http_headers: null, query_params: null } },
      features: { view_image: false, mentions_v2: true, remote_control: false }, file_opener: "vscode" },
    origins: Object.fromEntries(["model_provider", "model_providers.modex_local.name", "model_providers.modex_local.base_url", "model_providers.modex_local.wire_api", "model_providers.modex_local.requires_openai_auth",
      "model_providers.modex_local.env_key", "model_providers.modex_local.request_max_retries", "model_context_window", "web_search", "features.view_image", "shell_environment_policy.exclude.0"].map(k => [k, origin])),
    layers: [{ name: { type: "sessionFlags" }, version: FLAGS, config: flags }, { name: { type: "user", file: "/tmp/process-x/.codex/config.toml", profile: null }, version: EMPTY, config: {} }, { name: { type: "system", file: "/etc/codex/config.toml" }, version: EMPTY, config: {} }],
  };
}

test("a child whose governed keys all come from Modex's session flags is admitted, with its layers recorded", () => {
  const provenance = admitLocalConfiguration(read(), { requirements: null }, EXPECTED);
  assert.equal(provenance.sessionFlags, FLAGS);
  assert.deepEqual(provenance.layers.map(l => l.source), ["sessionFlags", "user", "system"]);
  assert.equal(provenance.layers[2]!.file, "/etc/codex/config.toml");
  assert.equal(provenance.managedRequirements, false);
  assert.equal(JSON.stringify(provenance).includes("MODEX_LOCAL_TOKEN"), false, "provenance names no credential variable");
});

test("a managed layer that sets a governed key is refused by name, whatever the effective value", () => {
  for (const [source, text] of [[{ type: "system", file: "/etc/codex/config.toml" }, "the system configuration at /etc/codex/config.toml"], [{ type: "mdm", domain: "com.openai.codex", key: "config_toml_base64" }, "a managed preferences profile (com.openai.codex)"],
    [{ type: "enterpriseManaged", id: "l1", name: "Acme" }, "an enterprise-managed configuration (Acme)"], [{ type: "legacyManagedConfigTomlFromFile", file: "/etc/codex/managed_config.toml" }, "the managed configuration at /etc/codex/managed_config.toml"]] as const) {
    const r = read();
    r.origins["model_providers.modex_local.base_url"] = { name: source, version: "sha256:managed" };
    assert.throws(() => admitLocalConfiguration(r, { requirements: null }, EXPECTED), new RegExp(`${text.replace(/[()./]/g, "\\$&")} sets \`model_providers.modex_local.base_url\``));
  }
  // A managed layer may set keys outside the governed set (an update preference, say); they are Codex's to enforce.
  const r = read();
  r.origins["check_for_update_on_startup"] = { name: { type: "system", file: "/etc/codex/config.toml" }, version: "sha256:managed" };
  r.layers![2]!.config = { check_for_update_on_startup: false };
  assert.ok(admitLocalConfiguration(r, { requirements: null }, EXPECTED));
  // But a managed layer whose contents touch a governed key is refused even when its value happens to lose.
  r.layers![2]!.config = { model_providers: { other: { base_url: "https://example.com" } }, check_for_update_on_startup: false };
  assert.throws(() => admitLocalConfiguration(r, { requirements: null }, EXPECTED), /the system configuration at \/etc\/codex\/config.toml sets `model_providers`/);
});

test("managed requirements, a loaded project layer and a non-empty private home are refused", () => {
  assert.throws(() => admitLocalConfiguration(read(), { requirements: { allowedSandboxModes: ["read-only"] } }, EXPECTED), /managed requirements/);
  const project = read();
  project.layers!.splice(1, 0, { name: { type: "project", dotCodexFolder: "/repo/.codex" }, version: "sha256:p", config: {} });
  assert.throws(() => admitLocalConfiguration(project, { requirements: null }, EXPECTED), /a project configuration at \/repo\/.codex is loaded/);
  const user = read();
  user.layers![1]!.config = { model_reasoning_effort: "high" };
  assert.throws(() => admitLocalConfiguration(user, { requirements: null }, EXPECTED), /user configuration at \/tmp\/process-x\/.codex\/config.toml is not empty \(model_reasoning_effort\)/);
});

test("effective values that differ from what Modex passed are refused, naming the key", () => {
  const cases: [string, (r: ConfigRead) => void, RegExp][] = [
    ["base_url", r => { (r.config.model_providers as any).modex_local.base_url = "https://api.openai.com/v1"; }, /`model_providers.modex_local.base_url` is "https:\/\/api.openai.com\/v1", not "http:\/\/127.0.0.1:18501\/v1"/],
    ["provider", r => { r.config.model_provider = "openai"; }, /`model_provider` is "openai"/],
    ["context", r => { r.config.model_context_window = 128000; }, /`model_context_window` is 128000, not 32768/],
    ["web search", r => { r.config.web_search = "live"; }, /`web_search` is "live"/],
    ["reasoning summary", r => { r.config.model_reasoning_summary = "detailed"; }, /`model_reasoning_summary` is "detailed", not null/],
    ["headers", r => { (r.config.model_providers as any).modex_local.http_headers = { "x-forward": "1" }; }, /`model_providers.modex_local.http_headers`/],
    ["env key", r => { (r.config.model_providers as any).modex_local.env_key = "OPENAI_API_KEY"; }, /`model_providers.modex_local.env_key` is "OPENAI_API_KEY"/],
    ["mcp", r => { r.config.mcp_servers = { github: { url: "https://mcp.example" } }; }, /MCP servers are configured \(github\)/],
    ["view image", r => { (r.config.features as any).view_image = true; }, /`features.view_image` is true/],
    ["openai base url", r => { r.config.openai_base_url = "https://proxy.example/v1"; }, /`openai_base_url`/],
    ["no provider", r => { r.config.model_providers = {}; }, /has no `model_providers.modex_local`/],
    ["no layers", r => { r.layers = null; }, /did not report its configuration layers/],
    ["no session flags", r => { r.layers = r.layers!.slice(1); }, /did not load Modex's session settings/],
  ];
  for (const [name, mutate, pattern] of cases) {
    const r = read(); mutate(r);
    assert.throws(() => admitLocalConfiguration(r, { requirements: null }, EXPECTED), pattern, name);
  }
  // A child without a token expects no env_key at all.
  const bare = read(); (bare.config.model_providers as any).modex_local.env_key = null;
  assert.ok(admitLocalConfiguration(bare, { requirements: null }, { ...EXPECTED, tokenEnv: null }));
  assert.throws(() => admitLocalConfiguration(read(), { requirements: null }, { ...EXPECTED, tokenEnv: null }), /`model_providers.modex_local.env_key` is "MODEX_LOCAL_TOKEN", not null/);
  assert.throws(() => admitLocalConfiguration({} as ConfigRead, { requirements: null }, EXPECTED), /did not report its effective configuration/);
});

test("governed keys and layer descriptions", () => {
  for (const key of ["model", "model_providers.x.base_url", "features.web_search_request", "mcp_servers.github.url", "experimental_use_unified_exec_tool", "hooks.PreModelRequest"]) assert.equal(governed(key), true, key);
  for (const key of ["check_for_update_on_startup", "file_opener", "history.persistence", "modeling", "sandbox_mode", "approval_policy"]) assert.equal(governed(key), false, key);
  assert.equal(describeLayer({ type: "sessionFlags" }), "Modex's session settings");
  assert.equal(describeLayer({ type: "something_new" }), "a something_new configuration layer");
});
