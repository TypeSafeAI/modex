import type { BrowserBounds, BrowserSnapshot, WorkspaceShortcut } from "./browser.js";
import type { Theme } from "./theme.js";
/** Types shared between the Electron main process and the React renderer. */

export type Mode = "chat" | "agent" | "full-access";
/** Which CLI runs the thread. "mock" is the offline scripted engine used by the demo and tests. */
export type BackendId = "claude" | "codex" | "mock";
export type ThreadStatus = "idle" | "running" | "waiting" | "error";
export type ApprovalAnswer = "yes" | "no" | "always";
export type EffortLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export const EFFORT_LEVELS: EffortLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];
export type RoutingPosture = "economy" | "balanced" | "quality";

export interface Project {
  id: string;
  name: string;
  path: string;
  addedAt: string;
}

export interface Thread {
  id: string;
  projectId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** Directory the agent works in: the project path or a dedicated worktree. */
  cwd: string;
  /** `manager` records who created it: Modex's own `git worktree` under ~/.modex, or the project's `scripts/worktree.sh`. */
  worktree?: { path: string; branch: string; manager?: "modex" | "project-script" };
  backend: BackendId;
  mode: Mode;
  /** Plan mode: read-only investigation that ends in a plan instead of edits. */
  plan: boolean;
  model: string;
  /** Reasoning effort (Codex `effort`, Claude `--effort`). */
  effort?: string;
  /** Auto: Jev judges each request and Modex picks backend/model/effort/fast mode per turn. */
  auto?: boolean;
  /** Backend resume handle: Claude session id or Codex thread id. */
  sessionHandle?: string;
  /** Opaque identity binding; never credentials. Older Codex handles belong to CLI auth. */
  codexAccount?: string;
  status: ThreadStatus;
}

/** A CLI-reported delegated task. Unknown means the stream ended without a final state. */
export interface AgentActivity {
  id: string;
  label: string;
  state: "running" | "waiting" | "completed" | "failed" | "stopped" | "unknown";
  detail?: string;
}

export type ThreadItem =
  | { id: string; kind: "user"; text: string; at: string }
  | { id: string; kind: "assistant"; text: string; at: string }
  | { id: string; kind: "tool"; name: string; title: string; args: Record<string, unknown>; output?: string; ok?: boolean; status: "running" | "done"; durationMs?: number; at: string; agent?: AgentActivity }
  /** `title` is the action's short title ("$ npm test"), recorded when a rule answers it, for the compact receipt row. */
  | { id: string; kind: "approval"; question: string; detail?: string; canAlways?: boolean; title?: string; answer?: ApprovalAnswer; decidedBy?: ApprovalReceipt; at: string }
  /** `failure` is set on the error notice that ends a turn: it carries the CLI's message, a remedy, and debug context. */
  | { id: string; kind: "notice"; level: "info" | "warn" | "error"; text: string; at: string; failure?: TurnFailure }
  /** Model reasoning: Codex reasoning summaries or Claude extended thinking. Collapsible in the UI. */
  | { id: string; kind: "thinking"; text: string; status: "running" | "done"; durationMs?: number; at: string }
  /** An Auto routing decision made before a turn: what was picked and why. */
  | { id: string; kind: "route"; backend: BackendId; model: string; effort?: string; fast: boolean; source: "jev" | "heuristic"; task: string; confidence: number; complexity: number; pinned: boolean; blocked?: true; reasons: string[]; durationMs: number; at: string };

/** Why a turn did not complete, read from the CLI's own message (see shared/failures.ts). */
export type FailureCode = "auth" | "not_installed" | "rate_limited" | "network" | "crashed" | "unknown";

/** An in-app remedy: a sign-in command, model picker, retry, or the Settings dialog. */
export type TurnFix =
  | { kind: "login"; label: string; command: string }
  | { kind: "settings"; label: string }
  | { kind: "models"; label: string }
  | { kind: "retry"; label: string };

/** A turn that did not complete. Rendered as a card with Retry, the fix, and Copy details. */
export interface TurnFailure {
  code: FailureCode;
  backend: BackendId;
  /** The CLI's own words, verbatim. */
  message: string;
  /** One line in Modex's words; the transcript shows this. */
  summary: string;
  /** What to do next, when Modex knows. */
  hint?: string;
  /** Sending the same message again is worth a try. */
  retryable: boolean;
  fix?: TurnFix;
  /** What Modex already tried on its own before giving up, oldest first. */
  recovery?: string[];
  /** Research-level context for a bug report: versions, ids, exit codes, stderr, RPC details. */
  debug: Record<string, unknown>;
}

export type ThreadEvent =
  | { threadId: string; type: "item"; item: ThreadItem }
  | { threadId: string; type: "item_update"; id: string; patch: Partial<ThreadItem> }
  | { threadId: string; type: "status"; status: ThreadStatus }
  | { threadId: string; type: "thread"; thread: Thread };

export interface Settings {
  /** Saved desktop appearance. Older settings retain Jev. */
  theme: Theme;
  /** Backend for new threads. */
  default_backend: BackendId;
  default_mode: Mode;
  /** Default model per backend (empty = the CLI's own default). */
  default_model: Record<BackendId, string>;
  /** Executables; plain names resolve on PATH. */
  claude_bin: string;
  codex_bin: string;
  /** Scripted engine for the offline demo/tests. */
  mock_script?: string;
  /** Auto routing (Jev) policy and bounds. */
  routing: RoutingPolicy;
  /** Plain-language rules for which approvals the agent may get without asking. */
  approval_rules: ApprovalRule[];
  /** Whether and how the rules answer approvals before they reach a human. */
  approval_gate: ApprovalGateConfig;
}

export type RuleDecision = "allow" | "ask" | "never";

export interface ApprovalRule {
  id: string;
  /** Plain language: completes "When the agent wants to …" e.g. "run the test suite". */
  when: string;
  decision: RuleDecision;
  /** Optional deterministic matcher, works without Jev: "Bash: npm test*", "command: git status". */
  match?: string;
  /** Absent = every project; else absolute project root. */
  project?: string;
  enabled: boolean;
}

export interface ApprovalGateConfig {
  enabled: boolean;
  /** A rule judged by Jev applies when its probability is at least this. */
  threshold: number;
  /** How long the gate waits for Jev before falling back to exact-match rules only. */
  timeout_ms: number;
}

/** Off until the Settings UI ships; turning it on is a separate change. */
export const DEFAULT_APPROVAL_GATE: ApprovalGateConfig = { enabled: false, threshold: 0.8, timeout_ms: 3000 };

/** Why an approval was answered (or asked) by a rule rather than left to the user alone. */
export interface ApprovalReceipt {
  source: "rule";
  ruleId: string;
  when: string;
  decision: RuleDecision;
  via: "match" | "jev";
  p?: number;
  ms: number;
  /** Jev's probability that the action is destructive, when Jev was asked. */
  destructive?: number;
  downgraded?: "destructive" | "escalation" | "jev-unavailable";
}

/** A dry run against the rule draft. No action is executed or recorded. */
export interface ApprovalPreviewRequest {
  projectId: string;
  rules: ApprovalRule[];
  backend: "claude" | "codex";
  tool: string;
  title: string;
  mode: Mode;
  escalation: boolean;
}

export interface ApprovalPreview {
  decision: RuleDecision;
  rule?: ApprovalRule;
  source: "match" | "jev" | "none";
  p?: number;
  ms: number;
  destructive?: number;
  downgraded?: ApprovalReceipt["downgraded"];
  jevError?: string;
  gateEnabled: boolean;
  jevAvailable: boolean;
}

/**
 * How Auto turns Jev's judgments into a model choice. Jev only answers questions about the
 * request; this policy — and the per-task offsets Modex learns from your overrides — decide.
 */
export interface RoutingPolicy {
  /** New threads start with Auto on. */
  auto_by_default: boolean;
  /** Shifts every pick one tier down (economy) or up (quality). */
  posture: RoutingPosture;
  /** Backends Auto may move a thread to when `allow_backend_switch` is on. */
  allow_backends: BackendId[];
  /** Off by default: switching CLIs mid-thread drops that CLI's session context. */
  allow_backend_switch: boolean;
  /** Reasoning effort Auto may never exceed. */
  max_effort: EffortLevel;
  /** Let Auto use the CLI's fast mode for light, speed-sensitive turns. */
  allow_fast: boolean;
  /** Below this Jev confidence in the task kind, Auto keeps the thread's current model. */
  min_confidence: number;
  /** Daily cap on top-tier / xhigh+ turns Auto may spend; null = unlimited. */
  premium_turns_per_day: number | null;
  /** TypeSafe model id for the judge. */
  jev_model: string;
  /** How to reach Jev: the `jev` CLI when installed (auto), always the CLI, or Modex's own HTTPS call. */
  jev_transport: "auto" | "cli" | "http";
  /** Executable for the jev CLI; a plain name resolves on PATH. */
  jev_bin: string;
}

export const DEFAULT_ROUTING: RoutingPolicy = {
  auto_by_default: false,
  posture: "balanced",
  allow_backends: ["codex", "claude"],
  allow_backend_switch: false,
  max_effort: "xhigh",
  allow_fast: true,
  min_confidence: 0.6,
  premium_turns_per_day: null,
  jev_model: "jev-latest",
  jev_transport: "auto",
  jev_bin: "jev",
};

export type KeySource = "modex" | "env" | "jev-config" | "login-shell" | "none";

/** Result of a judge ping from Settings → "Test judge". Never carries the key. */
export interface RoutingTest {
  ok: boolean;
  message: string;
  code?: string;
  status?: number;
  transport: "cli" | "http" | "none";
  /** Effective identity of the explicitly tested setup. Never includes credentials. */
  tested?: { executable: string | null; model: string };
  /** False when settings changed while this test was running. */
  current?: boolean;
  ms: number;
}

export interface RoutingStatus {
  /** A judge is configured (key or CLI) and has not been rejected this session; otherwise the heuristic runs. */
  live: boolean;
  keySource: KeySource;
  /** Last four characters of the resolved key, for telling keys apart. */
  keyLast4: string | null;
  /** The op:// reference the key came from, when it did. */
  keyRef: string | null;
  /** Why Jev is not being used this session (no key, locked 1Password, rejected key, no credits). */
  detail?: string;
  transport: { kind: "cli" | "http" | "none"; bin?: string; version?: string };
  /** Modex's own encrypted store for a hand-entered key. */
  secrets: { backend: string; available: boolean; present: boolean; savedAt: string | null };
  model: string;
  /** Most recent explicit Settings test; status inspection never makes a provider call. */
  lastTest?: Omit<RoutingTest, "current"> & { at: number };
  questionSetVersion: number;
  fit: { tasks: Record<string, { offset: number; samples: number; overridesUp: number; overridesDown: number; failures: number }>; premiumToday: number; routes: number };
}

export type ThreadPatch = Partial<Pick<Thread, "mode" | "model" | "title" | "backend" | "plan" | "effort" | "auto">>;

/** A suggested next message for an idle thread, chosen by Jev or the built-in heuristic from typed facts about the last turn. */
export interface FollowUp {
  text: string;
  source: "jev" | "heuristic";
}

export interface ModelInfo {
  id: string;
  label: string;
  description?: string;
  isDefault?: boolean;
  efforts?: string[];
  defaultEffort?: string;
  /** Codex service tiers (e.g. "fast") the model offers. */
  serviceTiers?: string[];
  defaultServiceTier?: string;
}

export const BACKENDS: { id: BackendId; label: string; hint: string }[] = [
  { id: "codex", label: "Codex", hint: "OpenAI Codex CLI (codex app-server) — uses your `codex login`" },
  { id: "claude", label: "Claude", hint: "Claude Code CLI (claude -p) — uses your `claude` login" },
];

export interface AppState {
  version: 1;
  projects: Project[];
  threads: Thread[];
  settings: Settings;
}

export interface ChangedFile {
  path: string;
  /** Two-letter porcelain code, e.g. " M", "??", "A ", " D", "R ". */
  code: string;
  additions: number;
  deletions: number;
  original?: string;
}

export interface ChangesSnapshot {
  cwd: string;
  isRepo: boolean;
  branch: string | null;
  files: ChangedFile[];
}

export type PullRequestSummary =
  | { state: "open" | "draft" | "merged" | "closed"; number: number; title: string; url: string }
  | { state: "none" | "no-remote" | "detached" | "disabled" | "unavailable"; detail: string };

/** Live checkout context; never persisted on the thread or inferred from an old worktree name. */
export interface ThreadContext {
  isRepo: boolean;
  branch: string | null;
  pullRequest: PullRequestSummary;
}

export const MODES: { id: Mode; label: string; hint: string }[] = [
  { id: "chat", label: "Chat", hint: "Read-only. Asks before any command or edit." },
  { id: "agent", label: "Agent", hint: "Edits and runs commands inside the project; asks to go outside it." },
  { id: "full-access", label: "Agent (full access)", hint: "No sandbox, no prompts. Only in a trusted environment." },
];


/** What a (re)opened terminal panel needs to catch up: the session, its replayable output, and where the stream is. */
export interface TerminalSnapshot {
  sessionId: string;
  sequence: number;
  output: string;
  exitCode: number | null;
}

/** Pushed from main on `terminal:event`. `sequence` lets a panel drop events its snapshot already contains. */
export type TerminalEvent = { threadId: string; sessionId: string; sequence: number } & (
  | { type: "data"; data: string }
  | { type: "exit"; exitCode: number }
);

/** The API the preload exposes to the renderer as `window.modex`. */
export interface ModexBridge {
  onWorkspaceShortcut?(cb: (shortcut: WorkspaceShortcut) => void): () => void;
  invoke<K extends keyof BridgeCommands>(channel: K, payload: BridgeCommands[K]["req"]): Promise<BridgeCommands[K]["res"]>;
  onEvent(cb: (event: ThreadEvent) => void): () => void;
  onTerminalEvent(cb: (event: TerminalEvent) => void): () => void;
  platform: string;
  /** Optional host transport: refresh snapshots after reconnect without discarding drafts. */
  onReconnect?(cb: () => void): () => void;
}

export interface BackendHealth {
  /** Absolute executable selected for this app session. */
  resolvedPath?: string;
  executable: "available" | "missing" | "unknown";
  /** Parsed CLI version; raw --version output never crosses IPC. */
  version?: string;
  authentication: "authenticated" | "signed-out" | "unsupported" | "unknown" | "failed";
  /** A catalogue or account check does not demonstrate model entitlement. */
  access: "unverified";
  detail: string;
}

export interface ChatGPTStatus {
  available: boolean; active: string | null; signingIn: boolean;
  accounts: { id: string; label: string; registration: string; signedIn: boolean; planEnabled: boolean }[];
  detail: string;
}

export interface ClaudeLoginResult {
  status: "authenticated" | "busy" | "unsupported" | "failed" | "timeout" | "cancelled";
  detail: string;
}

export interface CompanionStatus {
  enabled: boolean;
  addresses: string[];
  port?: number;
  pairingUri?: string;
  qrDataUrl?: string;
}

export interface ReleaseUpdate { version: string; url: string; }

export interface BridgeCommands {
  "updates:check": { req: undefined; res: ReleaseUpdate | null };
  "state:get": { req: undefined; res: AppState };
  "project:add": { req: { path?: string } | undefined; res: Project | null };
  "project:remove": { req: { projectId: string }; res: AppState };
  "thread:create": { req: { projectId: string; worktree?: boolean; mode?: Mode; model?: string; backend?: BackendId; auto?: boolean }; res: Thread };
  "thread:items": { req: { threadId: string }; res: ThreadItem[] };
  "thread:followup": { req: { threadId: string }; res: FollowUp | null };
  "thread:send": { req: { threadId: string; text: string }; res: { ok: boolean; error?: string } };
  /** Runs the thread's last message again in place (no second user bubble); the Retry on a failure card. */
  "thread:retry": { req: { threadId: string }; res: { ok: boolean; error?: string } };
  "thread:stop": { req: { threadId: string }; res: void };
  "thread:answer": { req: { threadId: string; itemId: string; answer: ApprovalAnswer }; res: void };
  "thread:update": { req: { threadId: string; patch: ThreadPatch }; res: Thread };
  "routing:status": { req: undefined; res: RoutingStatus };
  "routing:reset": { req: undefined; res: RoutingStatus };
  /** Stores a hand-entered key (or op:// reference) in the OS keychain; never in state.json. */
  "routing:setKey": { req: { key: string }; res: RoutingStatus };
  "routing:clearKey": { req: undefined; res: RoutingStatus };
  /** One tiny judge request through the active transport. */
  "routing:test": { req: undefined; res: RoutingTest };
  "models:list": { req: { backend: BackendId }; res: { models: ModelInfo[]; error?: string } };
  "backends:health": { req: undefined; res: Record<BackendId, BackendHealth> };
  "chatgpt:status": { req: undefined; res: ChatGPTStatus };
  "chatgpt:signIn": { req: { accountId?: string }; res: ChatGPTStatus };
  "chatgpt:cancel": { req: undefined; res: void };
  "chatgpt:select": { req: { accountId: string | null }; res: ChatGPTStatus };
  "chatgpt:signOut": { req: { accountId: string }; res: { status: ChatGPTStatus; detail: string } };
  "claude:login": { req: undefined; res: ClaudeLoginResult };
  "claude:cancelLogin": { req: undefined; res: void };
  "companion:status": { req: undefined; res: CompanionStatus };
  "companion:start": { req: undefined; res: CompanionStatus };
  "companion:stop": { req: undefined; res: CompanionStatus };
  "companion:reset": { req: undefined; res: CompanionStatus };
  "thread:delete": { req: { threadId: string; removeWorktree?: boolean }; res: AppState };
  /** A project checkout's current branch, for a draft's context strip; null outside a git repository. */
  "project:branch": { req: { projectId: string }; res: string | null };
  "thread:context": { req: { threadId: string }; res: ThreadContext };
  /** Opens (or reattaches to) the thread's shell; cols/rows are the panel's current size. */
  "terminal:open": { req: { threadId: string; cols: number; rows: number }; res: TerminalSnapshot };
  "terminal:write": { req: { threadId: string; sessionId: string; data: string }; res: void };
  "terminal:resize": { req: { threadId: string; sessionId: string; cols: number; rows: number }; res: void };
  "terminal:close": { req: { threadId: string; sessionId: string }; res: void };
  "changes:status": { req: { threadId: string }; res: ChangesSnapshot };
  "changes:diff": { req: { threadId: string; path: string; original?: string; fullContext?: boolean }; res: string };
  "browser:command": { req: { id: string; action: "navigate" | "back" | "forward" | "reload" | "state" | "close"; url?: string }; res: BrowserSnapshot | null };
  "browser:show": { req: { id: string | null; bounds?: BrowserBounds; fullView?: boolean }; res: void };
  "files:list": { req: { threadId: string }; res: { paths: string[]; truncated: boolean } };
  "files:read": { req: { threadId: string; path: string }; res: string };
  "changes:revert": { req: { threadId: string; path: string }; res: ChangesSnapshot };
  "settings:update": { req: Partial<Settings>; res: Settings };
  "approvals:rules:get": { req: undefined; res: ApprovalRule[] };
  "approvals:rules:set": { req: { rules: ApprovalRule[] }; res: ApprovalRule[] };
  "approvals:try": { req: ApprovalPreviewRequest; res: ApprovalPreview };
  "shell:openPath": { req: { path: string }; res: void };
  "shell:openTerminal": { req: { path: string }; res: void };
  /** System clipboard via main: works whether or not the window has focus (the Web API needs focus). */
  "clipboard:write": { req: { text: string }; res: void };
}
