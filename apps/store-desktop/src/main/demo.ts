import { DEFAULT_APPROVAL_GATE, DEFAULT_ROUTING, type AppState, type BridgeCommands, type RoutingStatus, type TerminalEvent, type TerminalSnapshot, type Thread, type ThreadEvent, type ThreadItem } from "../../../desktop/src/shared/types.js";

type Handlers = { [K in keyof BridgeCommands]: (request: BridgeCommands[K]["req"]) => BridgeCommands[K]["res"] };
const unavailable = () => { throw new Error("This is an offline demo. Leave the demo and connect your Mac to use accounts, external pages or system tools."); };
const stamp = () => new Date().toISOString();
const original = "# Demo project\n\nWelcome to Modex.\n";
const edited = "# Demo project\n\nWelcome to Modex. Review approvals and send a follow-up.\n";

/** Disposable, in-memory bridge. Never imports a host, filesystem, shell or network client. */
export class StoreDemo {
  readonly id = `demo-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  private sequence = 0;
  private disposed = false;
  private transcripts = new Map<string, ThreadItem[]>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private terminals = new Map<string, TerminalSnapshot>();
  private changed = new Set<string>();
  private state: AppState;
  private handlers: Handlers;

  constructor(private emit: (event: ThreadEvent) => void, private terminal: (event: TerminalEvent) => void) {
    const project = { id: this.nextId(), name: "Modex demo", path: "/Demo/Modex", addedAt: stamp() };
    this.state = {
      version: 1, projects: [project], threads: [],
      settings: { theme: "jev", default_backend: "claude", default_mode: "chat", default_model: { claude: "demo", codex: "demo", mock: "demo" }, claude_bin: "claude", codex_bin: "codex", routing: structuredClone(DEFAULT_ROUTING), approval_rules: [], approval_gate: { ...DEFAULT_APPROVAL_GATE } },
    };
    const launch = this.createThread({ projectId: project.id, backend: "claude" });
    launch.title = "Review launch changes";
    launch.status = "waiting";
    this.transcripts.set(launch.id, [
      { id: this.nextId(), kind: "notice", level: "info", text: "Offline demo: providers, files, approvals and replies are simulated. No host or account is connected.", at: stamp() },
      { id: this.nextId(), kind: "user", text: "Add a short introduction to the demo README.", at: stamp() },
      { id: this.nextId(), kind: "assistant", text: "I can add a sentence explaining approvals and follow-ups. Review the proposed edit below.", at: stamp() },
      { id: this.nextId(), kind: "approval", question: "Apply the sample README change?", detail: "Only the in-memory demo file changes. Nothing runs on your Mac.", canAlways: false, at: stamp() },
    ]);
    const scroll = this.createThread({ projectId: project.id, backend: "codex" });
    scroll.title = "Fix scroll jump in thread view";
    this.transcripts.set(scroll.id, [{ id: this.nextId(), kind: "assistant", text: "Sample completed thread: the transcript now stays anchored when you are at the bottom. This is a scripted example, not a real code change.", at: stamp() }]);
    const notes = this.createThread({ projectId: project.id, backend: "claude" });
    notes.title = "Draft release notes";
    this.append(notes, { id: this.nextId(), kind: "user", text: "Draft the release notes for this demo project.", at: stamp() });
    this.run(notes, "Draft the release notes");

    const routing = (): RoutingStatus => ({ live: false, keySource: "none", keyLast4: null, keyRef: null, detail: "Offline demo: no judge or credentials are used.", transport: { kind: "none" }, secrets: { backend: "demo", available: false, present: false, savedAt: null }, model: "demo", questionSetVersion: 1, fit: { tasks: {}, premiumToday: 0, routes: 0 } });
    const account = () => ({ available: false, active: null, signingIn: false, accounts: [], detail: "Offline demo: no account is connected. Leave the demo to sign in through your host." });
    const companion = () => ({ enabled: false, addresses: [] });
    const health = { executable: "unknown" as const, authentication: "unknown" as const, access: "unverified" as const, detail: "Offline demo: no CLI is installed or executed by this workspace." };
    this.handlers = {
      "state:get": () => this.state,
      "updates:check": () => null,
      "knowledge:state": unavailable,
      "knowledge:choose": unavailable,
      "knowledge:install": unavailable,
      "knowledge:start": unavailable,
      "knowledge:stop": unavailable,
      "knowledge:show": unavailable,
      "knowledge:reload": unavailable,
      "knowledge:external": unavailable,
      "knowledge:copy": unavailable,
      "knowledge:open": unavailable,
      "project:knowledge": unavailable,
      "project:pages": unavailable,
      "space:history": unavailable,
      "space:revert": unavailable,
      "space:export": unavailable,
      "space:list": () => { throw new Error("Space is available in the full Modex desktop app."); },
      "space:create": () => { throw new Error("Space is unavailable in the review demo."); },
      "space:save": () => { throw new Error("Space is unavailable in the review demo."); },
      "space:trash": () => { throw new Error("Space is unavailable in the review demo."); },
      "project:add": () => {
        const project = { id: this.nextId(), name: "Another demo project", path: "/Demo/Sample", addedAt: stamp() };
        this.state.projects.push(project); return project;
      },
      "project:remove": ({ projectId }) => {
        for (const thread of this.state.threads.filter(t => t.projectId === projectId)) this.removeThread(thread.id);
        this.state.projects = this.state.projects.filter(p => p.id !== projectId); return this.state;
      },
      "project:branch": ({ projectId }) => { this.project(projectId); return "demo/review"; },
      "thread:create": request => this.createThread(request),
      "thread:items": ({ threadId }) => { this.thread(threadId); return this.transcripts.get(threadId)!; },
      "thread:followup": ({ threadId }) => { this.thread(threadId); return { text: "Summarize the demo change", source: "heuristic" }; },
      "thread:send": ({ threadId, text }) => {
        const thread = this.thread(threadId);
        if (thread.status !== "idle") return { ok: false, error: "Finish or stop this demo turn first." };
        if (typeof text !== "string" || !text.trim() || text.length > 100_000) return { ok: false, error: "Enter a shorter demo message." };
        if (!this.transcripts.get(threadId)!.length) { thread.title = text.trim().slice(0, 80); this.emit({ type: "thread", threadId, thread }); }
        this.append(thread, { id: this.nextId(), kind: "user", text, at: stamp() });
        this.run(thread, text); return { ok: true };
      },
      "thread:retry": () => ({ ok: false, error: "Send a new follow-up to continue the demo." }),
      "thread:stop": ({ threadId }) => {
        const thread = this.thread(threadId); this.cancel(threadId);
        for (const item of this.transcripts.get(threadId)!) if (item.kind === "approval" && !item.answer) {
          item.answer = "no"; this.emit({ type: "item_update", threadId, id: item.id, patch: { answer: "no" } });
        }
        this.status(thread, "idle");
      },
      "thread:answer": ({ threadId, itemId, answer }) => {
        const thread = this.thread(threadId);
        const item = this.transcripts.get(threadId)!.find(i => i.id === itemId);
        if (thread.status !== "waiting" || item?.kind !== "approval" || item.answer || !["yes", "no"].includes(answer)) throw new Error("That demo approval is no longer available.");
        item.answer = answer; this.emit({ type: "item_update", threadId, id: item.id, patch: { answer } });
        if (answer === "yes") this.changed.add(threadId);
        this.append(thread, { id: this.nextId(), kind: "assistant", text: answer === "yes" ? "Applied to the demo README in memory. Open Review or Files to inspect the sample change. No real files were modified." : "Denied. The demo README is unchanged. Send a follow-up to continue.", at: stamp() });
        this.status(thread, "idle");
      },
      "thread:update": ({ threadId, patch }) => {
        const thread = this.thread(threadId);
        for (const key of ["title", "backend", "model", "mode", "plan", "effort", "auto"] as const) if (patch[key] !== undefined) Object.assign(thread, { [key]: patch[key] });
        this.emit({ type: "thread", threadId, thread }); return thread;
      },
      "thread:delete": ({ threadId }) => { this.thread(threadId); this.removeThread(threadId); return this.state; },
      "thread:context": ({ threadId }) => { this.thread(threadId); return { isRepo: true, branch: "demo/review", pullRequest: { state: "disabled", detail: "Demo workspace: no remote repository or pull request." } }; },
      "changes:status": ({ threadId }) => this.changes(threadId),
      "changes:diff": ({ threadId, path }) => {
        this.file(threadId, path);
        return this.changed.has(threadId) ? "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1,3 +1,3 @@\n # Demo project\n \n-Welcome to Modex.\n+Welcome to Modex. Review approvals and send a follow-up.\n" : "";
      },
      "changes:revert": ({ threadId, path }) => { this.file(threadId, path); this.changed.delete(threadId); return this.changes(threadId); },
      "files:list": ({ threadId }) => { this.thread(threadId); return { paths: ["README.md"], truncated: false }; },
      "files:read": ({ threadId, path }) => this.file(threadId, path),
      "terminal:open": ({ threadId }) => {
        this.thread(threadId);
        let session = this.terminals.get(threadId);
        if (!session) { session = { sessionId: this.nextId(), sequence: 0, output: "Offline demo terminal. Input is echoed; no shell or commands run.\r\n$ ", exitCode: null }; this.terminals.set(threadId, session); }
        return session;
      },
      "terminal:write": ({ threadId, sessionId, data }) => {
        const session = this.session(threadId, sessionId);
        if (typeof data !== "string" || data.length > 4096) throw new Error("Demo terminal input is too long.");
        // Echo printable text only; do not interpret escapes or execute pasted commands.
        const output = data.replace(/[^\x20-\x7e\r\n]/g, "").replace(/\r/g, "\r\n[demo: nothing executed]\r\n$ ");
        session.output = (session.output + output).slice(-20_000);
        this.terminal({ type: "data", threadId, sessionId, sequence: ++session.sequence, data: output });
      },
      "terminal:resize": ({ threadId, sessionId }) => { this.session(threadId, sessionId); },
      "terminal:close": ({ threadId, sessionId }) => { this.session(threadId, sessionId); this.terminals.delete(threadId); },
      "browser:command": ({ id, action }) => action === "close" ? null : { id, url: "", title: "Offline demo", back: false, forward: false, loading: false, error: "External pages require a connected workspace. Explore the sample README in Files or Review while offline." },
      "browser:show": () => {},
      "models:list": () => ({ models: [{ id: "demo", label: "Scripted demo", isDefault: true, description: "No model request is sent." }] }),
      "backends:health": () => ({ claude: health, codex: health, mock: health }),
      "settings:update": patch => { this.state.settings = { ...this.state.settings, ...patch }; return this.state.settings; },
      "routing:status": routing, "routing:reset": routing, "routing:clearKey": routing, "routing:setKey": unavailable,
      "routing:test": () => ({ ok: false, message: "Offline demo: no judge request was sent.", transport: "none", ms: 0 }),
      "modexAccount:status": () => ({ available: false, environment: "production", signingIn: false, user: null, expiresAt: null, detail: "Manage your Modex account in the full desktop app." }),
      "modexAccount:signIn": () => { throw new Error("Manage your Modex account in the full desktop app."); },
      "modexAccount:refresh": () => { throw new Error("Manage your Modex account in the full desktop app."); },
      "modexAccount:cancel": () => {},
      "modexAccount:signOut": () => { throw new Error("Manage your Modex account in the full desktop app."); },
      "chatgpt:status": account, "chatgpt:select": unavailable, "chatgpt:signIn": unavailable,
      "chatgpt:signOut": unavailable, "chatgpt:cancel": () => {},
      "claude:login": () => ({ status: "unsupported", detail: "Offline demo: connect your host to sign in to Claude." }), "claude:cancelLogin": () => {},
      "companion:status": companion, "companion:stop": companion, "companion:start": unavailable, "companion:reset": unavailable,
      "approvals:rules:get": () => this.state.settings.approval_rules,
      "approvals:rules:set": ({ rules }) => { this.state.settings.approval_rules = rules; return rules; },
      "approvals:try": unavailable,
      "shell:openPath": unavailable, "shell:openTerminal": unavailable, "clipboard:write": unavailable,
    };
  }

  invoke(channel: string, payload?: unknown): unknown {
    if (this.disposed) throw new Error("The demo workspace has ended.");
    if (!Object.hasOwn(this.handlers, channel)) throw new Error("Unknown demo action.");
    const handler = this.handlers[channel as keyof BridgeCommands] as (value: unknown) => unknown;
    // Keep callers and emitted objects from mutating internal state outside a command.
    return structuredClone(handler(structuredClone(payload)));
  }
  dispose(): void { this.disposed = true; for (const id of this.timers.keys()) this.cancel(id); this.terminals.clear(); }
  private nextId(): string { return `${this.id}-${++this.sequence}`; }
  private project(id: string) { const project = this.state.projects.find(p => p.id === id); if (!project) throw new Error("That demo project no longer exists."); return project; }
  private thread(id: string): Thread { const thread = this.state.threads.find(t => t.id === id); if (!thread) throw new Error("That demo thread no longer exists."); return thread; }
  private createThread(request: BridgeCommands["thread:create"]["req"]): Thread {
    const project = this.project(request.projectId);
    const thread: Thread = { id: this.nextId(), projectId: project.id, title: "New demo thread", createdAt: stamp(), updatedAt: stamp(), cwd: project.path, backend: request.backend ?? "claude", mode: request.mode ?? "chat", model: request.model ?? "demo", plan: false, auto: request.auto, status: "idle" };
    if (request.worktree) thread.worktree = { path: "/Demo/Worktree", branch: "demo/review" };
    this.state.threads.push(thread); this.transcripts.set(thread.id, []); return thread;
  }
  private append(thread: Thread, item: ThreadItem): void { this.transcripts.get(thread.id)!.push(item); this.emit({ type: "item", threadId: thread.id, item: structuredClone(item) }); }
  private status(thread: Thread, status: Thread["status"]): void { thread.status = status; thread.updatedAt = stamp(); this.emit({ type: "status", threadId: thread.id, status }); }
  private cancel(id: string): void { clearTimeout(this.timers.get(id)); this.timers.delete(id); }
  private run(thread: Thread, text: string): void {
    this.status(thread, "running");
    this.timers.set(thread.id, setTimeout(() => {
      this.timers.delete(thread.id);
      if (this.disposed) return;
      this.append(thread, { id: this.nextId(), kind: "assistant", text: `Demo reply to “${text.slice(0, 300)}”: your follow-up reached this sample thread. In a connected workspace, the selected CLI would continue the work on your Mac.`, at: stamp() });
      this.status(thread, "idle");
    }, 800));
  }
  private removeThread(id: string): void { this.cancel(id); this.transcripts.delete(id); this.terminals.delete(id); this.changed.delete(id); this.state.threads = this.state.threads.filter(t => t.id !== id); }
  private file(threadId: string, path: string): string { this.thread(threadId); if (path !== "README.md") throw new Error("Only the in-memory demo README is available."); return this.changed.has(threadId) ? edited : original; }
  private changes(threadId: string) { const thread = this.thread(threadId); return { cwd: thread.cwd, isRepo: true, branch: "demo/review", files: this.changed.has(threadId) ? [{ path: "README.md", code: " M", additions: 1, deletions: 1 }] : [] }; }
  private session(threadId: string, sessionId: string): TerminalSnapshot { this.thread(threadId); const session = this.terminals.get(threadId); if (!session || session.sessionId !== sessionId) throw new Error("That demo terminal has ended."); return session; }
}
