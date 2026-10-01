import path from "node:path";
import type { Mode } from "../../../shared/types.js";
import type { ApprovalAction } from "../backends/types.js";

/**
 * What Jev sees about a pending approval. Built from an allow-list: tool, title, command text
 * (scrubbed and clipped), file paths, project name and branch, and the thread's mode. File contents,
 * edit strings, patches, diffs, and any field not named here never leave the machine.
 */
export interface ApprovalDigest {
  action: { backend: string; tool: string; title: string; cwd_name?: string; escalation?: boolean };
  command?: string;
  paths?: string[];
  project: { name: string; branch?: string };
  mode: Mode;
}

export interface DigestContext {
  project: { name: string; branch?: string | null };
  mode: Mode;
}

export const MAX_COMMAND = 500;
const MAX_TITLE = 200;
const MAX_PATHS = 20;
const MAX_PATH = 300;
export const REDACTED = "«redacted»";

/** Input keys that hold a command line. */
const COMMAND_KEYS = ["command", "cmd"] as const;
/** Input keys that hold one file path. */
const PATH_KEYS = ["file_path", "notebook_path", "path", "grantRoot"] as const;
/** Input keys that hold a list of file paths. */
const PATH_LIST_KEYS = ["paths", "files"] as const;
/** Tools whose title embeds file content or other free text and must not be sent. Titles are rebuilt for these. */
const TITLE_FROM_TOOL = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/**
 * Removes obvious secrets from a command line: `--token=…`/`--password …` flags, Authorization headers,
 * provider-shaped keys (sk-…, ghp_…, github_pat_…, xox…-, AKIA…), and `KEY=value` env prefixes.
 */
export function scrubSecrets(text: string): string {
  let s = text;
  // Authorization / auth-ish headers: everything after the header name up to the closing quote or end of line.
  s = s.replace(/((?:Proxy-)?Authorization\s*:\s*)[^'"\n]+/gi, `$1${REDACTED}`);
  s = s.replace(/((?:X-Api-Key|Api-Key|X-Auth-Token|Cookie)\s*:\s*)[^'"\n]+/gi, `$1${REDACTED}`);
  // Secret-looking flags: --token=x, --token x, --api-key=x, --password x, -p is too ambiguous to touch.
  s = s.replace(/(--?[\w-]*(?:token|secret|password|passwd|api[-_]?key|apikey|auth|credential)[\w-]*)(=|\s+)("[^"]*"|'[^']*'|\S+)/gi, `$1$2${REDACTED}`);
  // Provider-shaped keys anywhere in the text.
  s = s.replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, REDACTED);
  s = s.replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{8,}/g, REDACTED);
  s = s.replace(/\bgithub_pat_[A-Za-z0-9_]{8,}/g, REDACTED);
  s = s.replace(/\bxox[abposr]-[A-Za-z0-9-]{8,}/g, REDACTED);
  s = s.replace(/\bAKIA[0-9A-Z]{12,}/g, REDACTED);
  s = s.replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, REDACTED);
  // URL credentials: https://user:pass@host
  s = s.replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, `$1${REDACTED}@`);
  // KEY=value env prefixes (at the start or after a separator): FOO_TOKEN=abc npm run x → FOO_TOKEN=«redacted» npm run x
  s = s.replace(/(^|[\s;&|(])([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|[^\s;&|)]+)/g, (_m, pre: string, name: string, value: string) => (value === REDACTED ? `${pre}${name}=${value}` : `${pre}${name}=${REDACTED}`));
  return s;
}

const clip = (s: string, max: number) => (s.length > max ? s.slice(0, max) + "…" : s);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);

function commandOf(action: ApprovalAction): string | undefined {
  const input = action.input ?? {};
  for (const k of COMMAND_KEYS) {
    const v = str(input[k]);
    if (v) return v;
  }
  // Codex command approvals carry the command line as the title.
  if (action.tool === "command") return str(action.title);
  return undefined;
}

function pathsOf(action: ApprovalAction): string[] {
  const input = action.input ?? {};
  const out: string[] = [];
  const add = (v: unknown) => {
    const s = str(v);
    if (s && !out.includes(s)) out.push(clip(s, MAX_PATH));
  };
  for (const k of PATH_KEYS) add(input[k]);
  for (const k of PATH_LIST_KEYS) {
    const v = input[k];
    if (Array.isArray(v)) for (const x of v) add(x);
  }
  // MultiEdit-style: only `file_path` of each edit, never its strings.
  if (Array.isArray(input.edits)) for (const e of input.edits) if (e && typeof e === "object") add((e as Record<string, unknown>).file_path);
  return out.slice(0, MAX_PATHS);
}

function titleOf(action: ApprovalAction, command: string | undefined, paths: string[]): string {
  if (TITLE_FROM_TOOL.has(action.tool)) return clip(`${action.tool === "Write" ? "write" : "edit"} ${paths[0] ?? ""}`.trim(), MAX_TITLE);
  // A title that repeats the command gets the scrubbed command, never the raw one.
  if (command && action.title.includes(command)) return clip(action.title.replace(command, scrubSecrets(command)), MAX_TITLE);
  return clip(scrubSecrets(action.title), MAX_TITLE);
}

/** Builds the state Jev sees for one approval. Pure: same action, same digest. */
export function digestAction(action: ApprovalAction, ctx: DigestContext): ApprovalDigest {
  const rawCommand = commandOf(action);
  const command = rawCommand ? clip(scrubSecrets(rawCommand), MAX_COMMAND) : undefined;
  const paths = pathsOf(action);
  const digest: ApprovalDigest = {
    action: {
      backend: action.backend,
      tool: action.tool,
      title: titleOf(action, rawCommand, paths),
      ...(action.cwd ? { cwd_name: path.basename(action.cwd) } : {}),
      ...(action.escalation ? { escalation: true } : {}),
    },
    project: { name: ctx.project.name, ...(ctx.project.branch ? { branch: ctx.project.branch } : {}) },
    mode: ctx.mode,
  };
  if (command) digest.command = command;
  if (paths.length) digest.paths = paths;
  return digest;
}
