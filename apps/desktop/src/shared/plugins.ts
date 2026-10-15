/** Native installations belong to the runtime's CLI identity, not a Modex login. */
export interface PluginContext { runtime: "claude" | "codex"; account?: string; projectId?: string; scope: "user" | "project" | "local" }
export type PluginAction = "install" | "update" | "enable" | "disable" | "remove" | "configure";
export interface NativePlugin {
  id: string; name: string; description?: string; version?: string; marketplace?: string;
  components?: string[];
  installed: boolean; enabled?: boolean; scope?: string;
}
export interface PluginCapabilities { actions: PluginAction[]; sources: Array<"add" | "update" | "remove">; discover: boolean; configuration: boolean; notes: string[] }
export interface PluginInventory { plugins: NativePlugin[]; capabilities: PluginCapabilities; stale: boolean; fetchedAt: string; error?: string }
export interface PluginSkill { name: string; entrypoint: string; text: string }
export interface PluginDetail { plugin: NativePlugin; text: string; skills: PluginSkill[]; configuration?: unknown; notes: string[] }
export interface PluginSource { name: string; source?: string }
export interface PluginSourceInventory { sources: PluginSource[]; actions?: Array<"add" | "update" | "remove">; stale: boolean; fetchedAt: string; error?: string }
export interface PluginMutationResult { message: string; restartRequired: boolean }
export interface PluginCommands {
  "plugins:importLocal": { req: { context: PluginContext }; res: PluginMutationResult };
  "plugins:list": { req: { context: PluginContext; available?: boolean }; res: PluginInventory };
  "plugins:details": { req: { context: PluginContext; id: string }; res: PluginDetail };
  "plugins:mutate": { req: { context: PluginContext; action: PluginAction; id: string; values?: Record<string, string> }; res: PluginMutationResult };
  "plugins:sources": { req: { context: PluginContext }; res: PluginSourceInventory };
  "plugins:source:mutate": { req: { context: PluginContext; action: "add" | "update" | "remove"; source: string }; res: PluginMutationResult };
}
