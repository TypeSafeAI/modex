import type { BackendId, FailureCode, TurnFailure, TurnFix } from "./types.js";

/**
 * Turns a CLI's failure message into something a person can act on: what went wrong in Modex's
 * words, what to do next, whether a retry is worth it, an in-app fix when there is one, and a
 * research-level report for "Copy details". Pure, shared by main (which builds the failure) and
 * the renderer (which formats the report), and unit-tested from test/failures.test.ts.
 */

export const BACKEND_NAMES: Record<BackendId, string> = { codex: "Codex", claude: "Claude Code", mock: "The mock backend" };

/** The CLI command that signs the backend in. Typed into the thread's terminal by the failure card's fix. */
export const LOGIN_COMMANDS: Partial<Record<BackendId, string>> = { codex: "codex login", claude: "claude auth login" };

/** First match wins, so the more specific families come first. Patterns are the CLIs' own wording. */
const RULES: { code: FailureCode; test: RegExp }[] = [
  { code: "not_installed", test: /is (?:the )?(?:codex cli|claude code) installed|could not start |\bENOENT\b|not found on PATH|command not found/i },
  {
    code: "auth",
    test: /could not be refreshed|sign in again|log ?in again|not logged in|not signed in|please run \/login|login (?:is )?required|logged out|unauthori[sz]ed|\b401\b|invalid api key|incorrect api key|authentication[_ ](?:error|failed|required)|invalid[_ ]token|token (?:has |is )?(?:expired|invalid)|oauth token|refresh token|api key is currently being used|no api key|not authenticated/i,
  },
  { code: "rate_limited", test: /rate[ _-]?limit|too many requests|\b429\b|usage limit|hit your (?:usage )?limit|quota|out of credits|billing|overloaded|\b529\b|at capacity/i },
  {
    code: "network",
    test: /\bE(?:CONNRESET|CONNREFUSED|TIMEDOUT|NOTFOUND|AI_AGAIN|PIPE|HOSTUNREACH|NETUNREACH)\b|socket hang up|fetch failed|network|connection (?:reset|refused|closed|error|lost|failed)|stream disconnected|error sending request|timed out|\b50[234]\b|bad gateway|service unavailable|gateway timeout|\btls\b|certificate/i,
  },
  { code: "crashed", test: /app-server exited|exited with code|exited \(\d+\)|force-stopped|disposed|is not running|was killed|SIG(?:KILL|TERM|SEGV|ABRT)/i },
];

export function classifyFailure(message: string): FailureCode {
  for (const rule of RULES) if (rule.test.test(message)) return rule.code;
  return "unknown";
}

export interface FailureInput {
  backend: BackendId;
  message: string;
  /** Backend-specific facts: exit code, stderr tail, RPC method and code, CLI build, ids. */
  detail?: Record<string, unknown>;
  /** What Modex already tried on its own, oldest first. */
  recovery?: string[];
  /** Where it happened: thread, cwd, model, mode, app version, platform. */
  context?: Record<string, unknown>;
}

export function describeFailure(input: FailureInput): TurnFailure {
  const message = (input.message || "The turn failed.").trim();
  const code = classifyFailure(message);
  const name = BACKEND_NAMES[input.backend];
  const login = LOGIN_COMMANDS[input.backend];
  let summary: string;
  let hint: string | undefined;
  let fix: TurnFix | undefined;
  switch (code) {
    case "auth":
      summary = `${name} is signed out, or its sign-in changed since it started.`;
      hint = login ? `Sign in to ${name} again (${login}), then retry.` : "Sign in again, then retry.";
      if (login) fix = { kind: "login", label: `Sign in to ${name}`, command: login };
      break;
    case "not_installed":
      summary = `${name} could not be started.`;
      hint = "Install the CLI, or point Settings at its executable, then retry.";
      fix = { kind: "settings", label: "Open Settings" };
      break;
    case "rate_limited":
      summary = `${name} is rate-limited or out of quota.`;
      hint = "Wait a moment, or pick another model, then retry.";
      break;
    case "network":
      summary = `${name} lost its connection.`;
      hint = "Check the network, then retry.";
      break;
    case "crashed":
      summary = `${name} stopped unexpectedly.`;
      hint = "Retry starts it again.";
      break;
    default:
      summary = firstLine(message);
      break;
  }
  const retryable = !/shutting down|being deleted|being removed/i.test(message);
  return {
    code,
    backend: input.backend,
    message,
    summary,
    ...(hint ? { hint } : {}),
    retryable,
    ...(fix ? { fix } : {}),
    ...(input.recovery?.length ? { recovery: input.recovery } : {}),
    debug: { ...input.context, ...input.detail },
  };
}

/** The text behind "Copy details" and the card's Details disclosure: everything a bug report needs. */
export function failureReport(f: TurnFailure): string {
  const lines = [`Modex: ${BACKEND_NAMES[f.backend]} turn failed (${f.code})`, `Summary: ${f.summary}`];
  if (f.hint) lines.push(`Next step: ${f.hint}`);
  lines.push("", "CLI said:", indent(f.message));
  if (f.recovery?.length) lines.push("", "Recovery attempted:", ...f.recovery.map((step) => `  - ${step}`));
  lines.push("", "Details:", JSON.stringify(f.debug, null, 2));
  return lines.join("\n");
}

function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim()) ?? text;
  return line.length > 300 ? line.slice(0, 299) + "…" : line;
}

function indent(text: string): string {
  return text.split("\n").map((l) => `  ${l}`).join("\n");
}
