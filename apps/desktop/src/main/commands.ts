import { cliHealth } from "./engine/cli-path.js";
import { ThreadContextReader } from "./engine/thread-context.js";
import type { BackendId, BridgeCommands, ThreadEvent } from "../shared/types.js";
import type { Store } from "./engine/store.js";
import type { ThreadRunner } from "./engine/runner.js";
import type { TerminalManager } from "./engine/terminal.js";
import * as gitx from "./engine/git.js";
import { listWorkspaceFiles, readWorkspaceFile } from "./engine/workspace-files.js";
import { saveSettings } from "./engine/settings-update.js";
import { previewApproval, validateRules } from "./engine/approvals/preview.js";
import { describeFailure } from "../shared/failures.js";

export type CommandHandler<K extends keyof BridgeCommands> = (req: BridgeCommands[K]["req"]) => Promise<BridgeCommands[K]["res"]> | BridgeCommands[K]["res"];
export type RegisterCommand = <K extends keyof BridgeCommands>(channel: K, handler: CommandHandler<K>) => void;

/** Desktop IPC and browser dev use the same runner, persistence, and command semantics. */
export function registerCommands(handle: RegisterCommand, {
  store, runner, terminals, emit, pickDirectory, openPath, openTerminal,
}: {
  store: Store;
  runner: ThreadRunner;
  terminals: TerminalManager;
  emit: (event: ThreadEvent) => void;
  pickDirectory: () => Promise<string | null>;
  openPath: (path: string) => Promise<void>;
  openTerminal: (path: string) => Promise<void>;
}): void {
  const sessionCliSettings = store.settings;
  const threadContexts = new ThreadContextReader({ enabled: false });
  function cwdFor(threadId: string): string {
    const thread = store.thread(threadId);
    if (!thread) throw new Error(`unknown thread ${threadId}`);
    return thread.cwd;
  }
  async function startTurn(threadId: string, run: Promise<void>): Promise<{ ok: boolean; error?: string }> {
    let accepting = true;
    let earlyError: string | undefined;
    run.catch((error: Error) => {
      if (accepting) { earlyError = error.message; return; }
      const thread = store.thread(threadId);
      const failure = describeFailure({ backend: thread?.backend ?? "mock", message: error.message, context: { at: new Date().toISOString(), modex: process.env.MODEX_VERSION, platform: `${process.platform} ${process.arch}`, threadId, cwd: thread?.cwd } });
      emit({ threadId, type: "item", item: { id: `err-${Date.now()}`, kind: "notice", level: "error", text: failure.summary, failure: { ...failure, retryable: false }, at: new Date().toISOString() } });
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    accepting = false;
    return earlyError !== undefined ? { ok: false, error: earlyError } : { ok: true };
  }
  handle("updates:check", () => null); // Browser development stays offline.
  handle("space:list", () => store.space.list());
  handle("space:create", (input) => store.space.create(input));
  handle("space:save", (page) => store.space.save(page));
  handle("space:trash", ({ id, trash }) => store.space.trash(id, trash));
  handle("state:get", () => {
    const state = store.snapshot();
    return { ...state, threads: state.threads.map((t) => ({ ...t, status: runner.status(t.id) })) };
  });
  handle("project:add", async (req) => {
    let dir = req?.path;
    if (!dir) {
      dir = await pickDirectory() ?? undefined;
      if (!dir) return null;
    }
    return store.addProject(dir);
  });
  handle("project:remove", async ({ projectId }) => {
    await runner.removeProject(projectId);
    return store.snapshot();
  });
  handle("thread:create", ({ projectId, worktree, mode, model, backend, auto }) => runner.createThread(projectId, { worktree, mode, model, backend, auto }));
  handle("thread:items", ({ threadId }) => runner.items(threadId));
  handle("thread:followup", ({ threadId }) => runner.followUp(threadId));
  handle("thread:send", ({ threadId, text }) => startTurn(threadId, runner.send(threadId, text)));
  handle("thread:retry", ({ threadId }) => startTurn(threadId, runner.retry(threadId)));
  handle("thread:stop", ({ threadId }) => runner.stop(threadId));
  handle("thread:answer", ({ threadId, itemId, answer }) => runner.answer(threadId, itemId, answer));
  handle("thread:update", ({ threadId, patch }) => runner.updateThread(threadId, patch));
  handle("thread:delete", async ({ threadId, removeWorktree }) => {
    await runner.deleteThread(threadId, removeWorktree);
    return store.snapshot();
  });
  handle("project:branch", async ({ projectId }) => {
    const p = store.project(projectId);
    return p && (await gitx.isRepo(p.path)) ? gitx.currentBranch(p.path) : null;
  });
  handle("files:list", ({ threadId }) => listWorkspaceFiles(cwdFor(threadId)));
  handle("thread:context", ({ threadId }) => threadContexts.read(cwdFor(threadId)));
  handle("files:read", ({ threadId, path }) => readWorkspaceFile(cwdFor(threadId), path));
  handle("changes:status", ({ threadId }) => gitx.status(cwdFor(threadId)));
  handle("changes:diff", ({ threadId, path: rel, original, fullContext }) => gitx.diff(cwdFor(threadId), rel, original, fullContext));
  handle("changes:revert", async ({ threadId, path: rel }) => {
    const cwd = cwdFor(threadId);
    await gitx.revert(cwd, rel);
    return gitx.status(cwd);
  });
  handle("settings:update", (patch) => saveSettings(store, runner.router, {
    ...patch,
    ...(patch.approval_rules !== undefined ? { approval_rules: validateRules(patch.approval_rules) } : {}),
  }));
  handle("approvals:rules:get", () => store.snapshot().settings.approval_rules);
  handle("approvals:rules:set", ({ rules }) => store.updateSettings({ approval_rules: validateRules(rules) }).approval_rules);
  handle("approvals:try", (req) => previewApproval(req, {
    project: (id) => store.project(id), config: store.snapshot().settings.approval_gate,
    jev: () => runner.router.jev(),
  }));
  handle("models:list", ({ backend }) => runner.listModels(backend));
  handle("routing:status", () => runner.router.status());
  handle("routing:reset", () => {
    runner.router.fit.reset();
    return runner.router.status();
  });
  handle("routing:setKey", ({ key }) => runner.router.setKey(key));
  handle("routing:clearKey", () => runner.router.clearKey());
  handle("routing:test", () => runner.router.test());
  handle("backends:health", async () => {
    const entries = await Promise.all((["claude", "codex", "mock"] as BackendId[]).map(async (id) => {
      const backend = runner.backend(id);
      const status = backend.health ? await (id === "mock" ? backend.health() : cliHealth(id, sessionCliSettings[`${id}_bin`], () => backend.health!())) : { executable: "available" as const, authentication: "unknown" as const, access: "unverified" as const, detail: "Offline demo · no account" };
      return [id, status] as const;
    }));
    return Object.fromEntries(entries) as BridgeCommands["backends:health"]["res"];
  });
  const unavailable = () => ({ available: false, active: null, signingIn: false, accounts: [], detail: "Manage ChatGPT accounts in the Modex desktop app." });
  handle("chatgpt:status", unavailable);
  handle("chatgpt:signIn", unavailable);
  handle("chatgpt:cancel", () => {});
  handle("chatgpt:select", unavailable);
  handle("chatgpt:signOut", () => ({ status: unavailable(), detail: "Manage ChatGPT accounts in the Modex desktop app." }));
  handle("claude:login", () => ({ status: "unsupported", detail: "Sign in to Claude from a terminal on this Mac." }));
  handle("claude:cancelLogin", () => {});
  handle("shell:openPath", ({ path: p }) => openPath(p));
  handle("shell:openTerminal", ({ path: p }) => openTerminal(p));
  handle("terminal:open", ({ threadId, cols, rows }) => terminals.open(threadId, cols, rows));
  handle("terminal:write", ({ threadId, sessionId, data }) => terminals.write(threadId, sessionId, data));
  handle("terminal:resize", ({ threadId, sessionId, cols, rows }) => terminals.resize(threadId, sessionId, cols, rows));
  handle("terminal:close", ({ threadId, sessionId }) => terminals.close(threadId, sessionId));
}
