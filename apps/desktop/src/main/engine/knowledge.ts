import fs from "node:fs";
import { parse as parseYAML } from "yaml";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { KNOWLEDGE_VERSION, knowledgeBusy, type KnowledgeState } from "../../shared/knowledge.js";
import { pageTitle, type SpacePage } from "../../shared/space.js";

type Options = { runtimeDir?: string; env?: NodeJS.ProcessEnv; startupTimeoutMs?: number };

/** Owns a separate, pinned Open Knowledge CLI. Never imports or bundles its application code. */
export class KnowledgeService {
  private state: KnowledgeState = { status: "idle", installed: false, folder: null, url: null, error: null };
  private readonly runtime: string;
  private readonly config: string;
  private child: ChildProcess | null = null;
  private closed: Promise<void> = Promise.resolve();
  private operation: Promise<KnowledgeState> | null = null;
  private disposed = false;
  private generation = 0;
  constructor(private readonly home: string, private readonly options: Options = {}) {
    this.runtime = options.runtimeDir ?? path.join(home, "integrations", "open-knowledge");
    this.config = path.join(home, "app", "knowledge.json");
    try {
      const saved = JSON.parse(fs.readFileSync(this.config, "utf8"));
      if (saved.version !== 1 || typeof saved.folder !== "string" || !path.isAbsolute(saved.folder)) throw new Error("Invalid configuration");
      this.state.folder = saved.folder;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.state = { ...this.state, status: "error", error: "Could not read the saved knowledge folder. Choose it again to reconnect." };
    }
  }

  private get entry(): string { return path.join(this.runtime, "node_modules", "@inkeep", "open-knowledge", "dist", "cli.mjs"); }
  snapshot(): KnowledgeState {
    let installed = false;
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(path.dirname(this.entry), "..", "package.json"), "utf8"));
      installed = manifest.version === KNOWLEDGE_VERSION && fs.statSync(this.entry).isFile();
    } catch { /* Optional companion is not installed yet. */ }
    return { ...this.state, installed };
  }

  private environment(): NodeJS.ProcessEnv {
    const env = { ...(this.options.env ?? process.env) };
    // Runtime binding and exposure are Modex-owned, regardless of inherited shell preferences.
    for (const key of Object.keys(env)) if (key.startsWith("OK_") || key === "HOST" || key === "PORT" || key === "ELECTRON_RUN_AS_NODE") delete env[key];
    delete env.FORCE_COLOR;
    return { ...env, NO_COLOR: "1", OK_ALLOW_EXTERNAL: "false", OK_OPEN_BROWSER: "false", OK_RECLAIM_DISABLE: "1" };
  }

  private executable(name: string): string {
    for (const directory of (this.environment().PATH ?? "").split(path.delimiter).filter(path.isAbsolute)) {
      const file = path.join(directory, process.platform === "win32" && name === "node" ? "node.exe" : name);
      try { fs.accessSync(file, fs.constants.X_OK); if (fs.statSync(file).isFile()) return file; } catch { /* Try the next install location. */ }
    }
    throw new Error(`Open Knowledge needs ${name === "node" ? "Node.js 24 or newer" : "npm"}. Install Node.js, then retry.`);
  }

  private spawn(file: string, args: string[], cwd: string): ChildProcess {
    if (this.disposed) throw new Error("Knowledge is shutting down.");
    const child = spawn(file, args, { cwd, env: this.environment(), shell: false, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    this.child = child;
    this.closed = new Promise(resolve => child.once("close", () => { if (this.child === child) this.child = null; resolve(); }));
    return child;
  }

  private signal(child: ChildProcess, signal: NodeJS.Signals): void {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    try { if (process.platform === "win32") child.kill(signal); else process.kill(-child.pid, signal); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  }

  private async killChild(): Promise<void> {
    const child = this.child;
    if (!child) return;
    const closed = this.closed;
    this.signal(child, "SIGTERM");
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([closed, new Promise<void>(resolve => { timer = setTimeout(() => { this.signal(child, "SIGKILL"); resolve(); }, 8000); })]);
    clearTimeout(timer);
    await closed;
  }

  private async run(file: string, args: string[], cwd: string, timeoutMs = 30_000): Promise<string> {
    const child = this.spawn(file, args, cwd);
    let output = "";
    const collect = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-6000); };
    child.stdout?.on("data", collect); child.stderr?.on("data", collect);
    const timer = setTimeout(() => this.signal(child, "SIGKILL"), timeoutMs);
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", code => code === 0 ? resolve() : reject(new Error(output.trim() || "Open Knowledge stopped before the operation finished. Retry to continue.")));
      });
      return output;
    } finally { clearTimeout(timer); }
  }

  private async node(): Promise<string> {
    const node = this.executable("node");
    const version = await this.run(node, ["--version"], this.home);
    if (Number(version.match(/^v(\d+)\./)?.[1] ?? 0) < 24) throw new Error("Open Knowledge needs Node.js 24 or newer. Update Node.js, then retry.");
    return node;
  }

  private perform(status: "starting" | "installing", work: () => Promise<void>): Promise<KnowledgeState> {
    if (this.disposed) return Promise.reject(new Error("Knowledge is shutting down."));
    if (this.operation || knowledgeBusy(this.state)) return Promise.reject(new Error("Wait for the current knowledge operation to finish."));
    this.state = { ...this.state, status, error: null, url: null, external: false };
    this.operation = work().then(() => this.snapshot()).catch(async (error: Error) => {
      await this.killChild();
      this.state = { ...this.state, status: "error", url: null, error: error.message.slice(-2000) };
      throw error;
    }).finally(() => { this.operation = null; });
    return this.operation;
  }

  install(): Promise<KnowledgeState> {
    if (this.state.status === "ready") return Promise.reject(new Error("Stop the knowledge base before installing."));
    return this.perform("installing", async () => {
      await this.node();
      const npm = this.executable("npm");
      fs.mkdirSync(this.runtime, { recursive: true });
      await this.run(npm, ["install", "--prefix", this.runtime, "--no-audit", "--no-fund", "--ignore-scripts", "--save-exact", `@inkeep/open-knowledge@${KNOWLEDGE_VERSION}`], this.runtime, 180_000);
      if (!this.snapshot().installed) throw new Error("Open Knowledge installation could not be verified. Retry the installation.");
      this.state.status = "idle";
    });
  }

  async selectFolder(input: string): Promise<KnowledgeState> {
    if (this.operation || knowledgeBusy(this.state) || this.state.status === "ready") throw new Error("Stop the knowledge base before changing folders.");
    if (typeof input !== "string" || !path.isAbsolute(input)) throw new Error("Choose a local knowledge folder.");
    let folder: string;
    try { folder = fs.realpathSync(input); if (!fs.statSync(folder).isDirectory()) throw new Error(); fs.accessSync(folder, fs.constants.R_OK | fs.constants.W_OK); }
    catch { throw new Error("The knowledge folder is unavailable or not writable. Choose another folder."); }
    fs.mkdirSync(path.dirname(this.config), { recursive: true });
    const temporary = `${this.config}.${randomUUID()}.tmp`;
    try { fs.writeFileSync(temporary, JSON.stringify({ version: 1, folder }), { mode: 0o600, flag: "wx" }); fs.renameSync(temporary, this.config); }
    finally { fs.rmSync(temporary, { force: true }); }
    this.state = { ...this.state, folder, status: "idle", error: null, url: null };
    return this.snapshot();
  }

  start(): Promise<KnowledgeState> {
    if (this.state.status === "ready") return Promise.resolve(this.snapshot());
    return this.perform("starting", async () => {
      if (!this.snapshot().installed) throw new Error("Install Open Knowledge to open your knowledge base.");
      const folder = this.selectedFolder();
      const generation = ++this.generation;
      const node = await this.node();
      if (generation !== this.generation || this.disposed) throw new Error("Knowledge startup was cancelled.");
      // `ok init` can select an ancestor project. A local anchor keeps this exact folder authoritative.
      const configDir = path.join(folder, ".ok");
      if (fs.existsSync(configDir) && fs.realpathSync(configDir) !== configDir) throw new Error("The knowledge settings folder is a link. Choose another folder.");
      fs.mkdirSync(configDir, { recursive: true });
      const projectConfig = path.join(configDir, "config.yml");
      try { fs.writeFileSync(projectConfig, "content:\n  dir: .\nautoSync:\n  default: off\n", { flag: "wx", mode: 0o600 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      this.contentFolder();
      if (generation !== this.generation || this.disposed) throw new Error("Knowledge startup was cancelled.");
      const child = this.spawn(node, [this.entry, "--cwd", folder, "--no-color", "start", "--mode", "browser", "--bind", "127.0.0.1", "--port", "0", "--no-open-browser", "--idle-shutdown", "off"], folder);
      let output = "";
      let failed: Error | null = null;
      let url: string | undefined;
      let exited = false;
      let reused: { pid: number; url: string } | undefined;
      let verifiedReuse = false;
      const reuseBanner = () => output.match(/(?:^|\n)(?:An MCP-spawned OpenKnowledge server|OpenKnowledge) is already running on this project \(pid ([1-9]\d*)\)\.\s+(http:\/\/127\.0\.0\.1:[1-9]\d{0,4})(?=\s|$)/);
      const collect = (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-8000);
        const match = output.match(/http:\/\/127\.0\.0\.1:([1-9]\d{0,4})(?=[\s/\u001b]|$)/);
        if (match && Number(match[1]) <= 65535) url = `http://127.0.0.1:${match[1]}`;
      };
      child.stdout?.on("data", collect); child.stderr?.on("data", collect);
      child.once("error", error => { failed = error; });
      child.once("close", code => {
        exited = true;
        const match = reuseBanner();
        // The CLI exits successfully when another owner already serves this exact project.
        if (code === 0 && match && Number(match[2]!.split(":").at(-1)) <= 65535) {
          reused = { pid: Number(match[1]), url: match[2]! };
          return;
        }
        failed = new Error(output.trim() || `Open Knowledge exited (${code ?? "signal"}).`);
        if (generation === this.generation && this.state.status === "ready") this.state = { ...this.state, status: "error", url: null, error: "Open Knowledge stopped. Reopen the knowledge base to continue." };
      });
      const deadline = Date.now() + (this.options.startupTimeoutMs ?? 45_000);
      while (Date.now() < deadline) {
        if (generation !== this.generation || this.disposed) throw new Error("Knowledge startup was cancelled.");
        if (failed) throw failed;
        if (reused && !verifiedReuse) {
          const status = JSON.parse(await this.run(node, [this.entry, "--cwd", folder, "--no-color", "status", "--json"], folder));
          const port = Number(new URL(reused.url).port);
          if (status.server?.state !== "alive" || status.server.alive !== true || status.server.pid !== reused.pid || status.server.port !== port ||
              status.ui?.state !== "alive" || status.ui.alive !== true || status.ui.pid !== reused.pid || status.ui.port !== port || status.ui.servedByServer !== true) {
            throw new Error("The existing Open Knowledge server could not be verified for this folder, or does not serve the editor.");
          }
          url = reused.url;
          verifiedReuse = true;
        }
        if (url && (verifiedReuse || (!exited && !reuseBanner()))) {
          try {
            const response = await fetch(`${url}/readyz`, { signal: AbortSignal.timeout(1000), redirect: "error" });
            const data = await response.json() as { ready?: boolean };
            if (generation !== this.generation || this.disposed) throw new Error("Knowledge startup was cancelled.");
            if (response.ok && data.ready === true && (verifiedReuse || (child.exitCode === null && child.signalCode === null))) {
              this.state = { ...this.state, status: "ready", url, error: null, external: verifiedReuse };
              return;
            }
          } catch { /* The banner can precede readiness. */ }
        }
        await delay(100);
      }
      throw new Error("Open Knowledge took too long to become ready. Check the knowledge server, then retry.");
    });
  }

  private selectedFolder(): string {
    const folder = this.state.folder;
    if (!folder || !fs.statSync(folder, { throwIfNoEntry: false })?.isDirectory()) throw new Error("Choose an available knowledge folder first.");
    if (fs.realpathSync(folder) !== folder) throw new Error("The knowledge folder changed. Choose it again before continuing.");
    return folder;
  }

  private contentFolder(): string {
    const folder = this.selectedFolder();
    const config = path.join(folder, ".ok", "config.yml");
    let directory = ".";
    try {
      if (fs.realpathSync(config) !== config) throw new Error("The knowledge settings are linked outside the selected folder.");
      if (fs.statSync(config).size > 1_000_000) throw new Error("The knowledge configuration is too large.");
      const value = parseYAML(fs.readFileSync(config, "utf8")) as { content?: { dir?: unknown } } | null;
      if (value?.content?.dir !== undefined) {
        if (typeof value.content.dir !== "string") throw new Error("The knowledge content folder must be a path.");
        directory = value.content.dir;
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const content = fs.realpathSync(path.resolve(folder, directory));
    const relative = path.relative(folder, content);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("The knowledge content folder is outside the chosen folder. Choose its project root again.");
    if (!fs.statSync(content).isDirectory()) throw new Error("The knowledge content folder is unavailable.");
    return content;
  }

  copyPage(page: Pick<SpacePage, "id" | "title" | "markdown">): string {
    if (!this.state.folder) throw new Error("Choose a knowledge folder in Space → Knowledge base first.");
    if (!/^[a-z0-9-]{1,64}$/i.test(page.id) || typeof page.title !== "string" || page.title.length > 200 || typeof page.markdown !== "string" || page.markdown.length > 1_000_000) throw new Error("Invalid Space page.");
    const folder = this.contentFolder();
    const file = path.join(folder, `space-${page.id}.md`);
    try { fs.writeFileSync(file, `# ${pageTitle(page).replace(/[\r\n]/g, " ")}\n\n${page.markdown}\n`, { flag: "wx", mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("A copy of this page already exists in the knowledge base. Open it there to continue editing."); throw error; }
    return file;
  }

  async stop(): Promise<KnowledgeState> {
    ++this.generation;
    this.state = { ...this.state, status: "stopping", url: null };
    await this.killChild();
    await this.operation?.catch(() => {});
    this.state = { ...this.state, status: "idle", url: null, error: null, external: false };
    return this.snapshot();
  }

  async dispose(): Promise<void> { this.disposed = true; await this.stop(); }
}
