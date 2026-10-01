import { Agent, MockProvider, defaultConfig, systemPrompt, type ModexConfig, type UI } from "@modex/core";
import type { ApprovalAction, Backend, ModelInfo, TurnOptions, TurnResult, TurnSink } from "./types.js";

/**
 * Offline backend: the bundled @modex/core engine driven by a scripted MockProvider.
 * Used by `--demo`, screenshots, and tests. It never talks to any model service.
 */
export class MockBackend implements Backend {
  readonly id = "mock" as const;
  /** Conversation memory per resume handle so multi-turn threads keep context. */
  private readonly histories = new Map<string, Agent["messages"]>();
  constructor(private readonly scriptPath: () => string | undefined, private readonly home: string, private readonly streamDelayMs = 30) {}

  async listModels(): Promise<ModelInfo[]> {
    return [{ id: "mock", label: "Scripted mock", description: "Replays apps/desktop/demo/mock-script.json", isDefault: true }];
  }

  async dispose(): Promise<void> {}

  async runTurn(text: string, opts: TurnOptions, sink: TurnSink, signal: AbortSignal): Promise<TurnResult> {
    const script = this.scriptPath();
    if (!script) return { status: "failed", error: "Mock backend selected but no mock script is configured (Settings → Mock script)." };
    const provider = MockProvider.fromFile(script);
    provider.streamDelayMs = this.streamDelayMs;
    const policy: Pick<ModexConfig, "approval_policy" | "sandbox_mode"> =
      opts.plan || opts.mode === "chat" ? { approval_policy: "untrusted", sandbox_mode: "read-only" } : opts.mode === "agent" ? { approval_policy: "on-request", sandbox_mode: "workspace-write" } : { approval_policy: "never", sandbox_mode: "danger-full-access" };
    const cfg: ModexConfig = { ...defaultConfig({ MODEX_HOME: this.home }), ...policy, model: "mock", home: this.home, writable_roots: opts.addDirs ?? [] };
    const handle = opts.resume ?? `mock-${Date.now().toString(36)}`;
    sink.session(handle);
    const ui: UI = {
      info: (m) => sink.notice("info", m),
      assistant: () => {},
      tool: () => {},
      warn: (m) => sink.notice("warn", m),
      error: (m) => sink.notice("error", m),
      confirm: (question, detail) => sink.approval({ question, detail, canAlways: true, action: mockAction(question, opts.cwd) }),
      prompt: async () => null,
      close: () => {},
    };
    let thinkingId: string | null = null;
    let thinkingSeq = 0;
    const agent = new Agent({
      cfg, provider, ui, cwd: opts.cwd, signal, history: this.histories.get(handle),
      systemPrompt: systemPrompt(cfg, opts.cwd, ""),
      onEvent: (e) => {
        if (e.type === "thinking_delta") {
          thinkingId ??= `think-${handle}-${++thinkingSeq}`;
          sink.thinkingDelta(thinkingId, e.text);
        } else if (e.type === "thinking_done") {
          if (thinkingId) sink.thinkingDone(thinkingId);
          thinkingId = null;
        } else if (e.type === "assistant_delta") sink.delta(e.text);
        else if (e.type === "assistant") sink.assistant(e.content);
        else if (e.type === "tool_start") sink.toolStart({ id: e.id, name: e.name, title: e.title, args: e.args });
        else if (e.type === "tool_end") sink.toolUpdate(e.id, { output: e.output, ok: e.ok, status: "done", durationMs: e.durationMs });
      },
    });
    try {
      const r = await agent.run(opts.plan ? `PLAN MODE (read-only, propose a plan, do not edit):\n\n${text}` : text);
      this.histories.set(handle, agent.messages);
      return signal.aborted ? { status: "interrupted" } : r.finalMessage.includes("max_turns") ? { status: "failed", error: r.finalMessage } : { status: "completed" };
    } catch (err) {
      return signal.aborted ? { status: "interrupted" } : { status: "failed", error: (err as Error).message };
    }
  }
}

/**
 * The scripted engine only hands its UI a question string, so the action is recovered from the
 * shapes @modex/core asks in: "Allow shell: <cmd>?", "Allow <op> <path>?", and the sandbox retry.
 */
export function mockAction(question: string, cwd?: string): ApprovalAction {
  const base = { backend: "mock" as const, ...(cwd ? { cwd } : {}) };
  const retry = /^The sandbox blocked "(.*)"\. Retry without the sandbox\?$/s.exec(question);
  if (retry) return { ...base, tool: "shell", title: `$ ${retry[1]}`, input: { command: retry[1] }, escalation: true };
  const shell = /^Allow shell: (.*)\?$/s.exec(question);
  if (shell) return { ...base, tool: "shell", title: `$ ${shell[1]}`, input: { command: shell[1] } };
  const file = /^Allow (write|add|update|delete|move) (.*)\?$/s.exec(question);
  if (file) {
    const target = file[2]!.split(" → ")[0]!;
    return { ...base, tool: file[1]!, title: `${file[1]} ${file[2]}`, input: { path: target } };
  }
  return { ...base, tool: "unknown", title: question.replace(/^Allow /, "").replace(/\?$/, "") };
}
