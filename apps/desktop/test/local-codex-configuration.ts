/** Scripted native configuration, shared by unit and Electron fixtures. Not native evidence. */
export function effectiveConfiguration(args: string[]): { config: Record<string, any>; origins: Record<string, unknown>; layers: unknown[] } {
  const flags: Record<string, any> = {};
  const origins: Record<string, unknown> = {};
  const origin = { name: { type: "sessionFlags" }, version: "sha256:flags" };
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "-c") continue;
    const setting = args[++i]!; const eq = setting.indexOf("=");
    const path = setting.slice(0, eq).split("."); const value = JSON.parse(setting.slice(eq + 1));
    let node = flags; for (const part of path.slice(0, -1)) node = node[part] ??= {}; node[path.at(-1)!] = value;
    origins[path.join(".")] = origin;
  }
  const config: Record<string, any> = { model: null, model_reasoning_summary: null, openai_base_url: null, mcp_servers: {}, ...structuredClone(flags) };
  for (const provider of Object.values(config.model_providers ?? {}) as Record<string, unknown>[]) Object.assign(provider, { experimental_bearer_token: null, auth: null, http_headers: null, env_http_headers: null, query_params: null, ...provider });
  return { config, origins, layers: [{ name: { type: "sessionFlags" }, version: "sha256:flags", config: flags }, { name: { type: "user", file: "/private/home/.codex/config.toml", profile: null }, version: "sha256:empty", config: {} }, { name: { type: "system", file: "/etc/codex/config.toml" }, version: "sha256:empty", config: {} }] };
}
