import { normalizeTheme } from "../../shared/theme.js";
import { NotesStore } from "./notes-store.js";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { ApprovalGateConfig, ApprovalRule, AppState, BackendId, EffortLevel, Project, RoutingPolicy, Settings, Thread, ThreadItem } from "../../shared/types.js";
import { DEFAULT_APPROVAL_GATE, DEFAULT_ROUTING, EFFORT_LEVELS } from "../../shared/types.js";

export const DEFAULT_SETTINGS: Settings = {
  theme: "graphite",
  default_backend: "codex",
  default_mode: "agent",
  default_model: { codex: "", claude: "", mock: "mock" },
  claude_bin: "claude",
  codex_bin: "codex",
  routing: { ...DEFAULT_ROUTING },
  approval_rules: [],
  approval_gate: { ...DEFAULT_APPROVAL_GATE },
  auto_retire: true,
};

/** Keeps only well-formed rules; a malformed rule is dropped rather than guessed at. */
export function migrateApprovalRules(raw: unknown): ApprovalRule[] {
  if (!Array.isArray(raw)) return [];
  const out: ApprovalRule[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    if (typeof o.id !== "string" || !o.id.trim() || seen.has(o.id)) continue;
    if (typeof o.when !== "string" || !o.when.trim()) continue;
    if (o.decision !== "allow" && o.decision !== "ask" && o.decision !== "never") continue;
    seen.add(o.id);
    out.push({
      id: o.id,
      when: o.when.trim(),
      decision: o.decision,
      ...(typeof o.match === "string" && o.match.trim() ? { match: o.match.trim() } : {}),
      ...(typeof o.project === "string" && o.project.trim() ? { project: o.project.trim() } : {}),
      enabled: typeof o.enabled === "boolean" ? o.enabled : true,
    });
  }
  return out;
}

/** Fills in and range-checks the gate settings; anything odd falls back to the default. */
export function migrateApprovalGate(raw: unknown): ApprovalGateConfig {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_APPROVAL_GATE;
  return {
    enabled: typeof r.enabled === "boolean" ? r.enabled : d.enabled,
    threshold: typeof r.threshold === "number" && Number.isFinite(r.threshold) && r.threshold > 0 && r.threshold <= 1 ? r.threshold : d.threshold,
    timeout_ms: typeof r.timeout_ms === "number" && Number.isFinite(r.timeout_ms) && r.timeout_ms >= 100 && r.timeout_ms <= 60_000 ? Math.floor(r.timeout_ms) : d.timeout_ms,
  };
}

/** Fills in and type-checks the routing policy; anything odd falls back to the default. */
export function migrateRouting(raw: unknown): RoutingPolicy {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_ROUTING;
  const isBackend = (b: unknown): b is BackendId => b === "claude" || b === "codex" || b === "mock";
  const num = (v: unknown, lo: number, hi: number, fallback: number) => (typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? v : fallback);
  return {
    auto_by_default: typeof r.auto_by_default === "boolean" ? r.auto_by_default : d.auto_by_default,
    posture: r.posture === "economy" || r.posture === "balanced" || r.posture === "quality" ? r.posture : d.posture,
    allow_backends: Array.isArray(r.allow_backends) ? (r.allow_backends.filter(isBackend) as BackendId[]) : [...d.allow_backends],
    allow_backend_switch: typeof r.allow_backend_switch === "boolean" ? r.allow_backend_switch : d.allow_backend_switch,
    max_effort: EFFORT_LEVELS.includes(r.max_effort as EffortLevel) ? (r.max_effort as EffortLevel) : d.max_effort,
    allow_fast: typeof r.allow_fast === "boolean" ? r.allow_fast : d.allow_fast,
    min_confidence: num(r.min_confidence, 0, 1, d.min_confidence),
    premium_turns_per_day: r.premium_turns_per_day === null ? null : typeof r.premium_turns_per_day === "number" && r.premium_turns_per_day >= 0 ? Math.floor(r.premium_turns_per_day) : d.premium_turns_per_day,
    jev_model: typeof r.jev_model === "string" && r.jev_model.trim() ? r.jev_model.trim() : d.jev_model,
    jev_transport: r.jev_transport === "auto" || r.jev_transport === "cli" || r.jev_transport === "http" ? r.jev_transport : d.jev_transport,
    jev_bin: typeof r.jev_bin === "string" && r.jev_bin.trim() ? r.jev_bin.trim() : d.jev_bin,
  };
}

/** Accepts older state files (pre-CLI-backend settings) and fills in defaults. */
export function migrateSettings(raw: unknown): Settings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const model = r.default_model;
  return {
    ...DEFAULT_SETTINGS,
    theme: normalizeTheme(r.theme),
    default_backend: r.default_backend === "claude" || r.default_backend === "codex" || r.default_backend === "mock" ? r.default_backend : DEFAULT_SETTINGS.default_backend,
    default_mode: r.default_mode === "chat" || r.default_mode === "agent" || r.default_mode === "full-access" ? r.default_mode : DEFAULT_SETTINGS.default_mode,
    default_model: model && typeof model === "object" ? { ...DEFAULT_SETTINGS.default_model, ...(model as Record<string, string>) } : { ...DEFAULT_SETTINGS.default_model },
    claude_bin: typeof r.claude_bin === "string" && r.claude_bin ? r.claude_bin : DEFAULT_SETTINGS.claude_bin,
    codex_bin: typeof r.codex_bin === "string" && r.codex_bin ? r.codex_bin : DEFAULT_SETTINGS.codex_bin,
    ...(typeof r.mock_script === "string" ? { mock_script: r.mock_script } : {}),
    routing: migrateRouting(r.routing),
    approval_rules: migrateApprovalRules(r.approval_rules),
    approval_gate: migrateApprovalGate(r.approval_gate),
    auto_retire: typeof r.auto_retire === "boolean" ? r.auto_retire : DEFAULT_SETTINGS.auto_retire,
  };
}

export function newId(): string {
  return crypto.randomUUID().slice(0, 8);
}

/** JSON-file persistence for the app shell: projects, threads, settings, and per-thread UI items. */
export class Store {
  readonly dir: string;
  /** Space pages, as Markdown files under `home/notes/` (docs/notes.md); `app/space.json` is migrated once. */
  readonly space: NotesStore;
  private state: AppState;
  private storageUncertain = false;
  private readonly directories = new Map<string, { dev: number; ino: number; real: string }>();

  constructor(readonly home: string) {
    this.dir = path.join(home, "app");
    this.space = new NotesStore(path.join(home, "notes"), { legacySpaceFile: path.join(this.dir, "space.json"), projects: () => this.state.projects });
    fs.mkdirSync(path.join(this.dir, "threads"), { recursive: true });
    for (const directory of [this.dir, path.join(this.dir, "threads")]) {
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("App storage directory is not a regular directory.");
      this.directories.set(directory, { dev: stat.dev, ino: stat.ino, real: fs.realpathSync(directory) });
    }
    this.state = this.read();
  }

  private get file(): string {
    return path.join(this.dir, "state.json");
  }

  private read(): AppState {
    if (!fs.existsSync(this.file)) return { version: 1, projects: [], threads: [], settings: { ...DEFAULT_SETTINGS } };
    const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<AppState>;
    return {
      version: 1,
      projects: raw.projects ?? [],
      // Nothing is running when the app starts.
      threads: (raw.threads ?? []).map((t) => ({ ...t, backend: (t as Partial<Thread>).backend ?? ("codex" as const), plan: (t as Partial<Thread>).plan ?? false, status: "idle" as const })),
      settings: migrateSettings(raw.settings),
    };
  }

  /** Only platforms with a synced parent directory may acknowledge the strong
   * persistence required to retire a pending native send intent. Windows keeps
   * manual updates; its atomic file replacement is not this stronger receipt. */
  get supportsDurableAdmission(): boolean { return process.platform !== "win32" && !this.storageUncertain; }

  /** Main-only proof before binding an existing or newly created native target.
   * Sync every creation ancestor: syncing app alone does not persist its entry
   * in home, and a recursively created home may have new ancestors of its own. */
  checkpointThread(threadId: string): Readonly<Thread> {
    if (!this.supportsDurableAdmission) throw new Error("Durable native message admission is unavailable.");
    const thread = this.thread(threadId);
    if (!thread) throw new Error("Unknown thread.");
    this.write();
    try {
      this.assertDirectory(this.dir);
      this.assertDirectory(path.join(this.dir, "threads"));
      let directory = fs.realpathSync(path.join(this.dir, "threads"));
      while (true) {
        const before = fs.lstatSync(directory);
        if (!before.isDirectory() || before.isSymbolicLink()) throw new Error("App storage ancestor changed.");
        const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try {
          const opened = fs.fstatSync(fd);
          if (opened.dev !== before.dev || opened.ino !== before.ino) throw new Error("App storage ancestor changed.");
          fs.fsyncSync(fd);
        } finally { fs.closeSync(fd); }
        const parent = path.dirname(directory);
        if (parent === directory) break;
        directory = parent;
      }
      this.assertDirectory(this.dir);
      this.assertDirectory(path.join(this.dir, "threads"));
    } catch (error) { this.storageUncertain = true; throw error; }
    return Object.freeze(structuredClone(thread));
  }

  private assertDirectory(directory: string): { dev: number; ino: number } {
    const expected = this.directories.get(directory), stat = fs.lstatSync(directory);
    if (!expected || !stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== expected.dev || stat.ino !== expected.ino
      || fs.realpathSync(directory) !== expected.real) throw new Error("App storage directory changed.");
    return expected;
  }

  private replaceFile(file: string, body: string): void {
    if (this.storageUncertain) throw new Error("App storage requires recovery before further writes.");
    const directory = path.dirname(file), temporary = `${file}.${crypto.randomUUID()}.tmp`;
    let fd: number | undefined, parent: number | undefined;
    let original: fs.Stats | undefined;
    let preflight = false, candidateOpened = false;
    const identity = (left: { dev: number; ino: number }, right: { dev: number; ino: number }) => left.dev === right.dev && left.ino === right.ino;
    const current = (): fs.Stats | undefined => {
      try { const stat = fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("App storage file is not regular."); return stat; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    };
    try {
      const owner = this.assertDirectory(directory);
      original = current(); preflight = true;
      // Windows directory durability has not been established by this adapter.
      // Do not claim a durable native admission on that platform.
      if (process.platform !== "win32") {
        parent = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        if (!identity(fs.fstatSync(parent), owner)) throw new Error("App storage directory changed.");
      }
      fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      candidateOpened = true;
      const created = fs.fstatSync(fd);
      fs.writeFileSync(fd, body);
      fs.fsyncSync(fd);
      fs.closeSync(fd); fd = undefined;
      this.assertDirectory(directory);
      const next = current(), staged = fs.lstatSync(temporary);
      if ((original ? !next || !identity(original, next) : next !== undefined)
        || !staged.isFile() || staged.isSymbolicLink() || !identity(created, staged)) throw new Error("App storage changed before replacement.");
      fs.renameSync(temporary, file);
      this.assertDirectory(directory);
      const written = current();
      if (!written || !identity(created, written)) throw new Error("App storage changed after replacement.");
      if (parent !== undefined) fs.fsyncSync(parent);
    } catch (error) {
      // Preserve the old file and any candidate temporary before rename; after
      // rename preserve the replacement. Never guess a rollback after fsync.
      // An exclusive-open refusal before obtaining a candidate fd cannot have
      // written the record. Permit retry only while its directory and original
      // identity/metadata still match. All later failures remain uncertain.
      let unchanged = preflight && !candidateOpened;
      if (unchanged) {
        try {
          this.assertDirectory(directory);
          const now = current();
          unchanged = original ? !!now && identity(original, now) && original.size === now.size
            && original.mtimeMs === now.mtimeMs && original.ctimeMs === now.ctimeMs : now === undefined;
          try { fs.lstatSync(temporary); unchanged = false; }
          catch (probe) { if ((probe as NodeJS.ErrnoException).code !== "ENOENT") unchanged = false; }
        } catch { unchanged = false; }
      }
      if (!unchanged) this.storageUncertain = true;
      throw error;
    } finally {
      let closeFailure: unknown;
      for (const descriptor of [fd, parent]) {
        if (descriptor === undefined) continue;
        try { fs.closeSync(descriptor); } catch (error) { closeFailure ??= error; }
      }
      if (closeFailure) { this.storageUncertain = true; throw closeFailure; }
    }
  }

  private write(state: AppState = this.state): void {
    this.replaceFile(this.file, JSON.stringify(state, null, 2));
  }

  snapshot(): AppState {
    return structuredClone(this.state);
  }

  get settings(): Settings {
    return { ...this.state.settings };
  }

  updateSettings(patch: Partial<Settings>): Settings {
    const settings = {
      ...this.state.settings,
      ...patch,
      theme: normalizeTheme(patch.theme ?? this.state.settings.theme),
      ...(patch.routing ? { routing: migrateRouting({ ...this.state.settings.routing, ...patch.routing }) } : {}),
      ...(patch.approval_rules ? { approval_rules: migrateApprovalRules(patch.approval_rules) } : {}),
      ...(patch.auto_retire !== undefined ? { auto_retire: patch.auto_retire === true } : {}),
      ...(patch.approval_gate ? { approval_gate: migrateApprovalGate({ ...this.state.settings.approval_gate, ...patch.approval_gate }) } : {}),
    };
    this.write({ ...this.state, settings });
    this.state.settings = settings;
    return this.settings;
  }

  addProject(dir: string): Project {
    const abs = path.resolve(dir);
    const existing = this.state.projects.find((p) => p.path === abs);
    if (existing) return existing;
    const project: Project = { id: newId(), name: path.basename(abs), path: abs, addedAt: new Date().toISOString() };
    this.state.projects.push(project);
    this.write();
    // Notes never stand in the way of a project: a failure leaves it to be linked the next time notes open.
    try { this.space.linkProject(project); } catch (error) { console.error("[modex] notes for", project.name, "unavailable:", error); }
    return project;
  }

  removeProject(projectId: string): void {
    this.state.projects = this.state.projects.filter((p) => p.id !== projectId);
    for (const t of this.state.threads.filter((t) => t.projectId === projectId)) this.deleteThreadFiles(t.id);
    this.state.threads = this.state.threads.filter((t) => t.projectId !== projectId);
    this.write();
    // Its notes stay in Space, unlinked; adding the folder again links them back.
    try { this.space.detachProject(projectId); } catch (error) { console.error("[modex] notes of a removed project:", error); }
  }

  setKnowledgeMaintenance(projectId: string, enabled: boolean): Project {
    if (typeof enabled !== "boolean") throw new Error("Knowledge maintenance must be a boolean.");
    const project = this.project(projectId);
    if (!project) throw new Error("Unknown project.");
    const updated = { ...project, knowledgeMaintenance: enabled };
    const projects = this.state.projects.map(p => p.id === projectId ? updated : p);
    this.write({ ...this.state, projects });
    this.state.projects = projects;
    return { ...updated };
  }
  setPagesMaintenance(projectId: string, enabled: boolean): Project {
    if (typeof enabled !== "boolean") throw new Error("Pages maintenance must be a boolean.");
    const project = this.project(projectId);
    if (!project) throw new Error("Unknown project.");
    const updated = { ...project, pagesMaintenance: enabled };
    const projects = this.state.projects.map(p => p.id === projectId ? updated : p);
    this.write({ ...this.state, projects });
    this.state.projects = projects;
    return { ...updated };
  }

  project(projectId: string): Project | undefined {
    return this.state.projects.find((p) => p.id === projectId);
  }

  thread(threadId: string): Thread | undefined {
    return this.state.threads.find((t) => t.id === threadId);
  }

  addThread(thread: Thread): Thread {
    const threads = [thread, ...this.state.threads];
    this.write({ ...this.state, threads });
    this.state.threads = threads;
    return thread;
  }

  updateThread(threadId: string, patch: Partial<Thread>): Thread {
    const t = this.thread(threadId);
    if (!t) throw new Error(`unknown thread ${threadId}`);
    const updated = { ...t, ...patch, updatedAt: new Date().toISOString() };
    this.write({ ...this.state, threads: this.state.threads.map(thread => thread === t ? updated : thread) });
    Object.assign(t, updated);
    return { ...t };
  }

  deleteThread(threadId: string): void {
    this.state.threads = this.state.threads.filter((t) => t.id !== threadId);
    this.deleteThreadFiles(threadId);
    this.write();
  }

  private itemsFile(threadId: string): string {
    return path.join(this.dir, "threads", `${threadId}.json`);
  }

  items(threadId: string): ThreadItem[] {
    const f = this.itemsFile(threadId);
    return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, "utf8")) as ThreadItem[]) : [];
  }

  saveItems(threadId: string, items: ThreadItem[]): void {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(threadId)) throw new Error("Invalid thread id.");
    this.replaceFile(this.itemsFile(threadId), JSON.stringify(items));
  }

  private deleteThreadFiles(threadId: string): void {
    fs.rmSync(this.itemsFile(threadId), { force: true });
  }
}
