import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { cliSpawn } from "./cli-launch.js";
import { readFile, readdir, realpath, mkdir, writeFile, rename, lstat, open, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import type { NativePlugin, PluginAction, PluginCapabilities, PluginCommands, PluginContext, PluginDetail, PluginInventory, PluginMutationResult, PluginSourceInventory, PluginSkill } from "../../shared/plugins.js";

export interface PluginTarget { bin: string; cwd: string; env: NodeJS.ProcessEnv }
export type PluginExecution = (target: PluginTarget, argv: string[], stdin?: string, signal?: AbortSignal) => Promise<string>;
export interface PluginServiceOptions {
  resolve(context: PluginContext): PluginTarget | Promise<PluginTarget>;
  busy(context: PluginContext): boolean;
  beforeMutation?(context: PluginContext): void;
  execute?: PluginExecution;
  /** Main-owned cache path; never accept this from the renderer. */
  cacheFile?: string;
  /** Main-owned storage for imported package snapshots. */
  localRoot?: string;
}
export function createNativePluginExecution(options: { timeoutMs?: number; terminationGraceMs?: number; maxOutputBytes?: number } = {}): PluginExecution {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const terminationGraceMs = options.terminationGraceMs ?? 1_000;
  const maxOutputBytes = options.maxOutputBytes ?? 8_000_000;
  return (target, argv, stdin, abortSignal) => new Promise((resolve, reject) => {
    if (abortSignal?.aborted) { reject(new Error("Plugin service is disposed.")); return; }
    // cliSpawn uses a kill-on-close Windows Job supervisor; POSIX children own a
    // process group so cancellation also reaches inherited native subprocesses.
    const child = cliSpawn(target.bin, argv, { cwd: target.cwd, env: target.env, shell: false, stdio: "pipe", detached: process.platform !== "win32" });
    let output = "", error = "", closed = false, settled = false, forced = false;
    let failure: Error | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const groupExists = () => {
      if (process.platform === "win32" || !child.pid) return !closed;
      try { process.kill(-child.pid, 0); return true; }
      catch (err) { return (err as NodeJS.ErrnoException).code !== "ESRCH"; }
    };
    const signal = (name: NodeJS.Signals) => {
      if (process.platform !== "win32" && child.pid) {
        try { process.kill(-child.pid, name); return true; }
        catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ESRCH") { failure ??= err as Error; return false; }
          return true;
        }
      }
      return closed || child.kill(name);
    };
    const finish = () => {
      if (settled || !closed || failure && !forced) return;
      settled = true;
      abortSignal?.removeEventListener("abort", abort);
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      failure ? reject(failure) : resolve(output);
    };
    const terminate = (reason: Error) => {
      if (failure) return;
      failure = reason;
      clearTimeout(timer);
      killTimer = setTimeout(() => { forced = signal("SIGKILL"); finish(); }, terminationGraceMs);
      signal("SIGTERM");
    };
    const timer = setTimeout(() => terminate(new Error("Native plugin command timed out.")), timeoutMs);
    const abort = () => terminate(new Error("Plugin service is disposed."));
    abortSignal?.addEventListener("abort", abort, { once: true });
    child.stdout!.on("data", chunk => {
      if (failure) return;
      if (Buffer.byteLength(output) + chunk.length > maxOutputBytes) { terminate(new Error("Native plugin output exceeds the supported size.")); return; }
      output += String(chunk);
    });
    child.stderr!.on("data", chunk => { error = (error + String(chunk)).slice(-16_000); });
    child.on("error", err => {
      if (!child.pid) { failure ??= err; forced = true; clearTimeout(timer); }
      else terminate(err);
    });
    child.on("close", code => {
      closed = true;
      if (!failure && code !== 0) terminate(new Error(error.trim() || output.trim() || `Native plugin command exited ${code}.`));
      // If the leader exits during graceful shutdown, keep its mutation fence
      // until surviving members of the process group have also been killed.
      if (failure && !groupExists()) forced = true;
      finish();
    });
    child.stdin!.on("error", () => {});
    child.stdin!.end(stdin);
  });
}
const executeNative = createNativePluginExecution();
function record(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Malformed native plugin response."); return value as Record<string, unknown>; }
function str(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function pluginComponents(row: Record<string, unknown>): string[] {
  const components = row.components;
  const map = components && typeof components === "object" && !Array.isArray(components) ? components as Record<string, unknown> : {};
  const array = Array.isArray(components) ? components : [];
  const present = (value: unknown) => Array.isArray(value) ? value.length > 0 : value && typeof value === "object" ? Object.keys(value).length > 0 : Boolean(value);
  return ["skills", "mcp", "hooks", "agents", "commands"].filter(key => present(row[key]) || present(map[key]) || array.some(value => value === key || !!value && typeof value === "object" && !Array.isArray(value) && (value as Record<string, unknown>).type === key) || (key === "skills" && typeof row.skillText === "string"));
}
function selector(value: string): string { if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._@+/-]{0,511}$/.test(value) || value.includes("..")) throw new Error("Invalid plugin or marketplace identifier."); return value; }
function contextKey(context: PluginContext) { return JSON.stringify([context.runtime, context.account ?? "cli", context.projectId ?? "", context.scope]); }
function validateContext(context: PluginContext) {
  if (!context || !["claude", "codex"].includes(context.runtime) || !["user", "project", "local"].includes(context.scope)) throw new Error("Invalid native plugin context.");
  if (context.account && context.account !== "cli") throw new Error("Native plugins use the shared CLI installation. App-owned accounts cannot manage a separate native plugin scope.");
  if (context.scope !== "user" && !context.projectId) throw new Error("Select a project for project or local scope.");
  if (context.runtime === "codex" && context.scope !== "user") throw new Error("This Codex CLI exposes user plugin scope only.");
}
const LOCAL_IMPORT_MAX_FILES = 10_000;
const LOCAL_IMPORT_MAX_BYTES = 128 * 1024 * 1024;
interface LocalImportFile { relative: string; mode: number; size: number }
async function inspectLocalDirectory(source: string): Promise<{ root: string; files: LocalImportFile[] }> {
  if (typeof source !== "string" || !path.isAbsolute(source) || /[\0\r\n]/.test(source)) throw new Error("Select a local directory in the native folder picker.");
  const selected = path.resolve(source);
  const stat = await lstat(selected);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Local imports require a real directory, not a symlink.");
  const root = await realpath(selected), files: LocalImportFile[] = [];
  let bytes = 0, entries = 0;
  const walk = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++entries > LOCAL_IMPORT_MAX_FILES) throw new Error("Local import exceeds the 10,000-entry limit.");
      const filename = path.join(directory, entry.name), info = await lstat(filename);
      if (info.isSymbolicLink()) throw new Error("Local imports cannot contain symlinks.");
      if (entry.name === ".git") continue;
      const resolved = await realpath(filename);
      if (!resolved.startsWith(root + path.sep)) throw new Error("Local import path escapes the selected directory.");
      if (info.isDirectory()) await walk(filename);
      else if (info.isFile()) {
        bytes += info.size;
        if (bytes > LOCAL_IMPORT_MAX_BYTES) throw new Error("Local import exceeds the 128 MiB size limit.");
        files.push({ relative: path.relative(root, filename), mode: info.mode & 0o777, size: info.size });
      } else throw new Error("Local imports may contain only regular files and directories.");
    }
  };
  await walk(root);
  return { root, files };
}
async function readLocalFile(root: string, file: LocalImportFile): Promise<Buffer> {
  const filename = path.join(root, file.relative), resolved = await realpath(filename);
  if (!resolved.startsWith(root + path.sep)) throw new Error("Local import path escapes the selected directory.");
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== file.size) throw new Error("Local plugin changed during import. Select it again.");
    const data = Buffer.alloc(file.size + 1);
    let offset = 0;
    while (offset < data.length) { const { bytesRead } = await handle.read(data, offset, data.length - offset, offset); if (!bytesRead) break; offset += bytesRead; }
    if (offset !== file.size) throw new Error("Local plugin changed during import. Select it again.");
    return data.subarray(0, offset);
  } finally { await handle.close(); }
}
interface StoredPlugin { plugin: NativePlugin; root?: string; skillText?: string }
export class PluginService {
  private inventories = new Map<string, PluginInventory>();
  private sourceInventories = new Map<string, PluginSourceInventory>();
  private plugins = new Map<string, StoredPlugin[]>();
  private helps = new Map<string, string>();
  private pending = new Set<string>();
  private execute: PluginExecution;
  private controller = new AbortController();
  private operations = new Set<Promise<unknown>>();
  private disposal?: Promise<void>;
  private assertOpen() {
    if (this.controller.signal.aborted) throw new Error("Plugin service is disposed.");
  }
  private admit<T>(run: () => Promise<T>): Promise<T> {
    try { this.assertOpen(); } catch (error) { return Promise.reject(error); }
    const operation = Promise.resolve().then(() => { this.assertOpen(); return run(); });
    this.operations.add(operation);
    void operation.then(() => this.operations.delete(operation), () => this.operations.delete(operation));
    return operation;
  }
  dispose(): Promise<void> {
    if (!this.disposal) {
      this.controller.abort();
      this.disposal = Promise.allSettled([...this.operations]).then(async () => { await this.saving; });
    }
    return this.disposal;
  }
  private loaded?: Promise<void>;
  private saving = Promise.resolve();
  private loadCache() {
    return this.loaded ??= (async () => {
      if (!this.options.cacheFile) return;
      try {
        const data = record(JSON.parse(await readFile(this.options.cacheFile, "utf8")));
        if (data.schema !== 1 || !Array.isArray(data.inventories) || !Array.isArray(data.sources)) return;
        for (const pair of data.inventories) if (Array.isArray(pair) && typeof pair[0] === "string") {
          const value = record(pair[1]);
          if (Array.isArray(value.plugins) && value.plugins.every(plugin => { const row = record(plugin); return typeof row.id === "string" && typeof row.name === "string" && typeof row.installed === "boolean"; }) && typeof value.fetchedAt === "string" && value.capabilities) this.inventories.set(pair[0], pair[1] as PluginInventory);
        }
        for (const pair of data.sources) if (Array.isArray(pair) && typeof pair[0] === "string") {
          const value = record(pair[1]);
          if (Array.isArray(value.sources) && value.sources.every(source => typeof record(source).name === "string") && typeof value.fetchedAt === "string") this.sourceInventories.set(pair[0], pair[1] as PluginSourceInventory);
        }
      } catch { /* A damaged cache never prevents a fresh native inventory. */ }
    })();
  }
  private saveCache() {
    const file = this.options.cacheFile;
    if (!file) return Promise.resolve();
    const json = JSON.stringify({ schema: 1, inventories: [...this.inventories], sources: [...this.sourceInventories] });
    this.saving = this.saving.then(async () => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file + ".tmp", json, { mode: 0o600 }); await rename(file + ".tmp", file); }).catch(() => {});
    return this.saving;
  }
  constructor(private options: PluginServiceOptions) { const execute = options.execute ?? executeNative;
    this.execute = (target, argv, stdin) => {
      this.assertOpen();
      return execute(target, argv, stdin, this.controller.signal);
    }; }
  private async target(context: PluginContext) { validateContext(context); return this.options.resolve(context); }
  private async help(target: PluginTarget, args: string[]) {
    const key = JSON.stringify([target.bin, target.cwd, target.env.CLAUDE_CONFIG_DIR, target.env.CODEX_HOME, args]);
    if (!this.helps.has(key)) this.helps.set(key, await this.execute(target, ["plugin", ...args, "--help"]));
    return this.helps.get(key)!;
  }
  private async command(target: PluginTarget, args: string[], value?: string, scope?: PluginContext["scope"], stdin?: string, mutationContext?: PluginContext) {
    const help = await this.help(target, args);
    if (!help.includes("--json")) throw new Error("This native CLI does not support structured output for this operation.");
    if (scope && !help.includes("--scope")) throw new Error("This native operation cannot target the requested scope.");
    const argv = ["plugin", ...args, ...(value ? [value] : []), "--json", ...(scope ? ["--scope", scope] : []), ...(stdin !== undefined ? ["--values-stdin"] : [])];
    if (mutationContext && this.options.busy(mutationContext)) throw new Error("Wait for affected native turns to finish before changing plugins.");
    if (mutationContext) this.options.beforeMutation?.(mutationContext);
    return this.execute(target, argv, stdin);
  }
  private async capabilities(target: PluginTarget, context: PluginContext): Promise<PluginCapabilities> {
    const help = await this.help(target, []), listHelp = await this.help(target, ["list"]);
    const has = (name: string) => new RegExp(`^\\s+${name}(?:[ |]|$)`, "m").test(help);
    const actions: PluginAction[] = [];
    for (const action of ["install", "update", "enable", "disable", "remove", "configure"] as const) {
      const name = action === "install" && context.runtime === "codex" ? "add" : action === "remove" && context.runtime === "claude" ? "uninstall" : action;
      if (has(name)) actions.push(action);
    }
    let sources: PluginCapabilities["sources"] = [];
    if (has("marketplace")) { const sourceHelp = await this.help(target, ["marketplace"]); sources = (["add", "update", "remove"] as const).filter(action => new RegExp(`^\\s+${action === "update" && context.runtime === "codex" ? "upgrade" : action}(?:[ |]|$)`, "m").test(sourceHelp)); }
    return { actions, sources, discover: listHelp.includes("--available"), configuration: actions.includes("configure"), notes: ["Uses the shared native CLI identity and installation. Start a new chat after changing plugins. Existing resumed sessions require recreation.", ...(context.runtime === "codex" ? ["Codex exposes user scope only. Enable, disable, update and configuration are unavailable unless the native CLI supports them."] : [])] };
  }
  list(request: PluginCommands["plugins:list"]["req"]): Promise<PluginInventory> { return this.admit(() => this.listAdmitted(request)); }
  private async listAdmitted({ context, available = false }: PluginCommands["plugins:list"]["req"]): Promise<PluginInventory> {
    validateContext(context); await this.loadCache();
    const key = contextKey(context) + (available ? ":available" : ":installed");
    try {
      const target = await this.target(context);
      const capabilities = await this.capabilities(target, context);
      if (available && !capabilities.discover) throw new Error("This native CLI does not expose plugin discovery.");
      const help = await this.help(target, ["list"]);
      if (!help.includes("--json")) throw new Error("This native CLI does not expose structured plugin inventory.");
      const data: unknown = JSON.parse(await this.execute(target, ["plugin", "list", "--json", ...(available ? ["--available"] : [])]));
      const rows = this.rows(data);
      const stored = rows.map(({ row, installed, marketplace }) => {
        const name = str(row.name), rawId = str(row.id) ?? str(row.pluginId) ?? name;
        if (!rawId) throw new Error("Malformed native plugin identity.");
        const market = str(row.marketplace) ?? str(row.marketplaceName) ?? marketplace;
        const id = selector(rawId.includes("@") || !market ? rawId : `${rawId}@${market}`);
        const plugin: NativePlugin = { components: pluginComponents(row), id, name: name ?? id.split("@")[0]!, description: str(row.description), version: str(row.version), marketplace: market ?? id.split("@")[1], installed: typeof row.installed === "boolean" ? row.installed : installed, enabled: typeof row.enabled === "boolean" ? row.enabled : undefined, scope: str(row.scope) ?? (context.runtime === "codex" ? "user" : undefined) };
        const source = row.source && typeof row.source === "object" && !Array.isArray(row.source) ? row.source as Record<string, unknown> : undefined;
        const nativeRoot = str(row.installPath) ?? str(row.install_path) ?? str(row.path) ?? (source?.source === "local" ? str(source.path) : undefined);
        const cachedRoot = context.runtime === "codex" && plugin.installed && plugin.marketplace && plugin.version && /^[a-zA-Z0-9._-]+$/.test(plugin.marketplace) && /^[a-zA-Z0-9._-]+$/.test(plugin.name) && /^[a-zA-Z0-9._-]+$/.test(plugin.version) ? path.join(target.env.CODEX_HOME ?? path.join(homedir(), ".codex"), "plugins", "cache", plugin.marketplace, plugin.name, plugin.version) : undefined;
        return { plugin, root: nativeRoot ?? cachedRoot, skillText: str(row.skillText) };
      });
      const scoped = stored.filter(({ plugin }) => !plugin.installed || !plugin.scope || plugin.scope === context.scope);
      this.plugins.set(contextKey(context), [...(this.plugins.get(contextKey(context)) ?? []).filter(old => !scoped.some(item => item.plugin.id === old.plugin.id)), ...scoped]);
      const inventory = { plugins: scoped.map(item => item.plugin), capabilities, stale: false, fetchedAt: new Date().toISOString() };
      this.inventories.set(key, inventory); await this.saveCache(); return inventory;
    } catch (error) { const previous = this.inventories.get(key); if (previous) return { ...previous, stale: true, error: (error as Error).message }; throw error; }
  }
  private rows(data: unknown): Array<{ row: Record<string, unknown>; installed: boolean; marketplace?: string }> {
    if (Array.isArray(data)) return data.map(row => ({ row: record(row), installed: true }));
    const obj = record(data), result: ReturnType<PluginService["rows"]> = [];
    let found = false;
    for (const key of ["installed", "available", "plugins"] as const) if (Array.isArray(obj[key])) { found = true; for (const row of obj[key]) result.push({ row: record(row), installed: key !== "available" }); }
    if (Array.isArray(obj.marketplaces)) { found = true; for (const value of obj.marketplaces) { const market = record(value); if (!Array.isArray(market.plugins)) throw new Error("Malformed marketplace plugins."); for (const row of market.plugins) result.push({ row: record(row), installed: false, marketplace: str(market.name) }); } }
    if (!found) throw new Error("Unrecognized native plugin inventory. Update Modex or the native CLI.");
    return result;
  }
  details(request: PluginCommands["plugins:details"]["req"]): Promise<PluginDetail> { return this.admit(() => this.detailsAdmitted(request)); }
  private async detailsAdmitted({ context, id }: PluginCommands["plugins:details"]["req"]): Promise<PluginDetail> {
    selector(id); const target = await this.target(context);
    const stored = this.plugins.get(contextKey(context))?.find(item => item.plugin.id === id);
    if (!stored) throw new Error("Refresh the plugin inventory before opening details.");
    const notes: string[] = [], skills: PluginSkill[] = [];
    let text = stored.plugin.description ?? "", configuration: unknown;
    const help = await this.help(target, []);
    if (/^\s+details\s/m.test(help)) { try { text = await this.execute(target, ["plugin", "details", id]); } catch (error) { notes.push((error as Error).message); } }
    if (stored.root && path.isAbsolute(stored.root)) {
      try {
        const root = await realpath(stored.root), skillsRoot = path.join(root, "skills");
        const read = async (filename: string, name: string) => { const resolved = await realpath(filename); if (resolved !== root && !resolved.startsWith(root + path.sep)) throw new Error("Skill path escapes the native plugin installation."); skills.push({ name, entrypoint: `${stored.plugin.name}:${name}`, text: await readFile(resolved, "utf8") }); };
        for (const entry of await readdir(skillsRoot, { withFileTypes: true })) { if (entry.isDirectory()) { try { await read(path.join(skillsRoot, entry.name, "SKILL.md"), entry.name); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") notes.push((error as Error).message); } } else if (entry.name === "SKILL.md") await read(path.join(skillsRoot, entry.name), stored.plugin.name); }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") notes.push((error as Error).message); }
    }
    if (stored.skillText) skills.push({ name: stored.plugin.name, entrypoint: stored.plugin.name, text: stored.skillText });
    if (!skills.length) notes.push("The native CLI has not provided local skill text. Install the plugin to inspect its complete bundled skills.");
    if (stored.plugin.installed && /^\s+configure\s/m.test(help)) { try { configuration = JSON.parse(await this.command(target, ["configure"], id)); } catch (error) { notes.push((error as Error).message); } }
    return { plugin: stored.plugin, text, skills, configuration, notes };
  }
  private async mutation(context: PluginContext, run: (target: PluginTarget) => Promise<string>): Promise<PluginMutationResult> {
    const target = await this.target(context), key = context.runtime;
    this.assertOpen();
    if (this.options.busy(context)) throw new Error("Wait for affected native turns to finish before changing plugins.");
    if (this.pending.has(key)) throw new Error("A native plugin change is already running.");
    this.pending.add(key);
    try {
      const output = (await run(target)).trim();
      let result: unknown;
      try { result = JSON.parse(output); } catch { try { result = JSON.parse(output.split("\n").at(-1) ?? ""); } catch { throw new Error("The native command returned an unrecognized result. Refresh inventory before retrying."); } }
      const value = record(result);
      if (value.shownCommand || value.requiresConfirmation || value.needsConfirmation || value.status === "requires_confirmation") throw new Error("This plugin requires command approval in the native CLI. Review and confirm it there, then refresh inventory.");
      if (value.success === false || value.error || value.status === "error" || value.status === "failed") throw new Error(typeof value.error === "string" ? value.error : "The native plugin command reported a failure.");
      return { message: "Native plugin change completed.", restartRequired: true };
    }
    finally { this.pending.delete(key); }
  }
  mutate(request: PluginCommands["plugins:mutate"]["req"]): Promise<PluginMutationResult> { return this.admit(() => this.mutateAdmitted(request)); }
  private async mutateAdmitted({ context, action, id, values }: PluginCommands["plugins:mutate"]["req"]): Promise<PluginMutationResult> {
    selector(id);
    return this.mutation(context, async target => {
      const capabilities = await this.capabilities(target, context);
      if (!capabilities.actions.includes(action)) throw new Error(`The native ${context.runtime} CLI does not support ${action}.`);
      const verb = action === "install" && context.runtime === "codex" ? "add" : action === "remove" && context.runtime === "claude" ? "uninstall" : action;
      if (action === "configure") {
        if (!values || typeof values !== "object" || Array.isArray(values) || Object.entries(values).some(([key, value]) => !/^[a-zA-Z0-9_.-]+$/.test(key) || typeof value !== "string" || /[\r\n\0]/.test(value))) throw new Error("Configuration must contain named, single-line string values.");
        if (!(await this.help(target, [verb])).includes("--values-stdin")) throw new Error("This CLI cannot save configuration non-interactively.");
        return this.command(target, [verb], id, undefined, JSON.stringify(values), context);
      }
      return this.command(target, [verb], id, context.runtime === "claude" ? context.scope : undefined, undefined, context);
    });
  }
  sources(request: PluginCommands["plugins:sources"]["req"]): Promise<PluginSourceInventory> { return this.admit(() => this.sourcesAdmitted(request)); }
  private async sourcesAdmitted({ context }: PluginCommands["plugins:sources"]["req"]): Promise<PluginSourceInventory> {
    validateContext(context); await this.loadCache();
    const key = contextKey(context);
    try {
      const target = await this.target(context);
      const data: unknown = JSON.parse(await this.command(target, ["marketplace", "list"]));
      const rows = Array.isArray(data) ? data : record(data).marketplaces;
      if (!Array.isArray(rows)) throw new Error("Malformed native marketplace response.");
      const sources = rows.map(value => { const row = record(value), name = str(row.name); if (!name) throw new Error("Malformed marketplace identity."); return { name: selector(name), source: str(row.repo) ?? str(row.url) ?? str(row.path) ?? str(row.root) ?? str(row.source) }; });
      const result = { sources, actions: (await this.capabilities(target, context)).sources, stale: false, fetchedAt: new Date().toISOString() }; this.sourceInventories.set(key, result); await this.saveCache(); return result;
    } catch (error) { const previous = this.sourceInventories.get(key); if (previous) return { ...previous, stale: true, error: (error as Error).message }; throw error; }
  }
  /** Main-only: source must come from the native folder picker, never an IPC path field. */
  importLocal(request: { context: PluginContext; source: string }): Promise<PluginMutationResult> { return this.admit(() => this.importLocalAdmitted(request)); }
  private async importLocalAdmitted({ context, source }: { context: PluginContext; source: string }): Promise<PluginMutationResult> {
    let importedName = "";
    const result = await this.mutation(context, async target => {
      if (!(await this.capabilities(target, context)).sources.includes("add")) throw new Error("This native CLI does not support local marketplace imports.");
      const { root, files } = await inspectLocalDirectory(source);
      const file = (relative: string) => files.find(item => item.relative === relative.split("/").join(path.sep));
      const manifest = async (relative: string) => { const entry = file(relative); return entry ? record(JSON.parse((await readLocalFile(root, entry)).toString("utf8"))) : undefined; };
      const marketplace = (context.runtime === "codex" ? await manifest(".agents/plugins/marketplace.json") : undefined) ?? await manifest(".claude-plugin/marketplace.json");
      let marketplaceRoot = root;
      if (marketplace) {
        if (typeof marketplace.name !== "string" || !Array.isArray(marketplace.plugins)) throw new Error("Local marketplace must declare a name and plugins array.");
        importedName = selector(marketplace.name);
      } else {
        const nativeManifest = context.runtime === "codex" ? (await manifest(".codex-plugin/plugin.json")) ?? (await manifest(".claude-plugin/plugin.json")) : await manifest(".claude-plugin/plugin.json");
        const portable = context.runtime === "codex" && !nativeManifest ? await manifest("plugin.json") : undefined;
        const plugin = nativeManifest ?? (portable?.$schema === "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json" ? portable : undefined);
        if (!plugin || typeof plugin.name !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(plugin.name)) throw new Error(`Select a compatible ${context.runtime} marketplace or plugin package with a valid manifest name.`);
        if (!this.options.localRoot) throw new Error("Local package storage is not configured by this Modex host.");
        const localRoot = this.options.localRoot;
        const intendedLocalRoot = path.resolve(localRoot);
        if (intendedLocalRoot === root || intendedLocalRoot.startsWith(root + path.sep)) throw new Error("Select a plugin outside Modex's local import storage.");
        await mkdir(localRoot, { recursive: true });
        const canonicalLocalRoot = await realpath(localRoot);
        if (canonicalLocalRoot === root || canonicalLocalRoot.startsWith(root + path.sep)) throw new Error("Select a plugin outside Modex's local import storage.");
        const staging = await mkdtemp(path.join(canonicalLocalRoot, ".import-"));
        importedName = `modex-local-${plugin.name.toLowerCase()}-${randomUUID().slice(0, 8)}`;
        const destination = path.join(canonicalLocalRoot, importedName);
        try {
          for (const entry of files) {
            const output = path.join(staging, "plugins", plugin.name, entry.relative);
            await mkdir(path.dirname(output), { recursive: true });
            await writeFile(output, await readLocalFile(root, entry), { mode: entry.mode, flag: "wx" });
          }
          // Documented schemas: code.claude.com/docs/en/plugin-marketplaces and
          // developers.openai.com/plugins/build/plugins#marketplace-metadata.
          const catalog = context.runtime === "claude"
            ? { name: importedName, owner: { name: "Modex local imports" }, plugins: [{ name: plugin.name, source: `./plugins/${plugin.name}` }] }
            : { name: importedName, plugins: [{ name: plugin.name, source: { source: "local", path: `./plugins/${plugin.name}` }, policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" } }] };
          const catalogPath = path.join(staging, context.runtime === "claude" ? ".claude-plugin" : ".agents/plugins", "marketplace.json");
          await mkdir(path.dirname(catalogPath), { recursive: true });
          await writeFile(catalogPath, JSON.stringify(catalog, null, 2) + "\n", { mode: 0o600, flag: "wx" });
          await rename(staging, destination);
          marketplaceRoot = destination;
        } catch (error) { await rm(staging, { recursive: true, force: true }); throw error; }
      }
      return this.command(target, ["marketplace", "add"], marketplaceRoot, context.runtime === "claude" ? context.scope : undefined, undefined, context);
    });
    return { ...result, message: `Imported ${importedName} into ${context.runtime} / ${context.scope} scope. Browse Discover to install a plugin explicitly.` };
  }
  mutateSource(request: PluginCommands["plugins:source:mutate"]["req"]): Promise<PluginMutationResult> { return this.admit(() => this.mutateSourceAdmitted(request)); }
  private async mutateSourceAdmitted({ context, action, source }: PluginCommands["plugins:source:mutate"]["req"]): Promise<PluginMutationResult> {
    if (action === "add") {
      if (typeof source !== "string" || source.length > 2048 || !(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+(?:@[a-zA-Z0-9_.\/-]+)?$/.test(source) || /^https:\/\/[^\s]+$/.test(source)) || /[\0\r\n]/.test(source)) throw new Error("Enter an HTTPS marketplace URL or owner/repository. Use Import local to select a local marketplace or plugin package.");
      if (source.startsWith("https:")) { const url = new URL(source); if (url.username || url.password) throw new Error("Marketplace URLs must not contain credentials."); }
    } else selector(source);
    return this.mutation(context, async target => {
      if (!(await this.capabilities(target, context)).sources.includes(action)) throw new Error("This native CLI does not support the requested marketplace operation.");
      const verb = action === "update" && context.runtime === "codex" ? "upgrade" : action;
      return this.command(target, ["marketplace", verb], source, context.runtime === "claude" && action !== "update" ? context.scope : undefined, undefined, context);
    });
  }
}
