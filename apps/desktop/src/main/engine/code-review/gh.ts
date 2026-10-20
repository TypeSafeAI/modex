import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";

/**
 * One read through the person's own `gh` login (#320 decision 3): `gh api <path> --method GET --include`
 * on github.com. Modex never sees or stores the token, and nothing here writes.
 */
export interface GhCall {
  /** A path main built itself, every segment encoded; checked again here. */
  endpoint: string;
  accept: (typeof MEDIA_TYPES)[number];
  /** The ETag of the copy main holds, for a conditional read that GitHub does not charge. */
  etag: string | null;
  maxBytes: number;
  timeoutMs: number;
  signal: AbortSignal;
}

/** An HTTP answer, or why there is none. Nothing gh prints to stderr is kept: it can name accounts or tokens. */
export type GhAnswer =
  | { kind: "http"; status: number; headers: Record<string, string>; body: Buffer }
  | { kind: "no-cli" | "signed-out" | "offline" | "timeout" | "cancelled" | "too-large" | "failed" };

export type GhTransport = (call: GhCall) => Promise<GhAnswer>;

const MEDIA_TYPES = ["application/vnd.github+json", "application/vnd.github.raw"] as const;
const SEGMENT = "[A-Za-z0-9%_.~*'()!-]+";
const QUERY = "[A-Za-z0-9%=&+_.~*'()!-]+";
/** `user`, the issue search, or a path under `repos/`: no flag, host, placeholder, space or dot segment. */
const ENDPOINT = new RegExp(`^(?:user|search/issues\\?${QUERY}|repos(?:/${SEGMENT}){2,}(?:\\?${QUERY})?)$`);
const ETAG = /^(?:W\/)?"[\x21\x23-\x7e]{1,200}"$/;
/** What gh prints when it cannot reach the API at all. */
const NETWORK = /dial tcp|no such host|connection (?:refused|reset)|network is unreachable|i\/o timeout|TLS handshake|proxyconnect|EOF/i;

export function ghArgs(call: GhCall): string[] {
  const route = call.endpoint.split("?")[0]!;
  if (!ENDPOINT.test(call.endpoint) || route.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new Error("Code Review endpoint is not allowed.");
  }
  if (!MEDIA_TYPES.includes(call.accept)) throw new Error("Unsupported Code Review media type.");
  if (call.etag !== null && !ETAG.test(call.etag)) throw new Error("Invalid ETag.");
  return ["api", call.endpoint, "--hostname", "github.com", "--method", "GET", "--include", "-H", `Accept: ${call.accept}`,
    "-H", "X-GitHub-Api-Version: 2022-11-28", ...(call.etag ? ["-H", `If-None-Match: ${call.etag}`] : [])];
}

/** gh's `--include` output: a status line ending in LF, headers ending in CRLF, a blank line, then the body. */
export function parseIncluded(stdout: Buffer): { status: number; headers: Record<string, string>; body: Buffer } | null {
  const lineEnd = stdout.indexOf(0x0a);
  if (lineEnd < 0) return null;
  const match = /^HTTP\/\d(?:\.\d)? (\d{3})(?: [^\r\n]*)?$/.exec(stdout.subarray(0, lineEnd).toString("latin1").replace(/\r$/, ""));
  if (!match) return null;
  const rest = stdout.subarray(lineEnd + 1);
  let block: string, body: Buffer;
  if (rest.subarray(0, 2).toString("latin1") === "\r\n") {
    block = "";
    body = rest.subarray(2);
  } else {
    const end = rest.indexOf("\r\n\r\n");
    if (end < 0) return null;
    block = rest.subarray(0, end).toString("latin1");
    body = rest.subarray(end + 4);
  }
  const headers: Record<string, string> = {};
  for (const line of block ? block.split(/\r?\n/) : []) {
    const colon = line.indexOf(":");
    if (colon <= 0) return null;
    const name = line.slice(0, colon).trim().toLowerCase(), value = line.slice(colon + 1).trim();
    headers[name] = Object.hasOwn(headers, name) ? `${headers[name]}, ${value}` : value;
  }
  return { status: Number(match[1]), headers, body };
}

/** No shell, prompt, pager, colour, update check or debug output, and only absolute PATH entries. */
function environment(): NodeJS.ProcessEnv {
  const searchPath = [...new Set([...(process.env.PATH ?? "").split(path.delimiter).filter(path.isAbsolute), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"])].join(path.delimiter);
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: searchPath, GH_PROMPT_DISABLED: "1", GH_PAGER: "cat", NO_COLOR: "1", CLICOLOR: "0",
    GH_NO_UPDATE_NOTIFIER: "1", GH_SPINNER_DISABLED: "1" };
  delete env.GH_DEBUG;
  delete env.DEBUG;
  return env;
}

export function ghTransport(bin = "gh"): GhTransport {
  return (call) => {
    const args = ghArgs(call);
    return new Promise((resolve) => {
      execFile(bin, args, { cwd: os.homedir(), env: environment(), encoding: "buffer", timeout: call.timeoutMs, maxBuffer: call.maxBytes, signal: call.signal, windowsHide: true },
        (error, stdout, stderr) => {
          const failure = error as (Omit<NodeJS.ErrnoException, "code"> & { killed?: boolean; code?: string | number }) | null;
          if (call.signal.aborted) return resolve({ kind: "cancelled" });
          if (failure?.code === "ENOENT") return resolve({ kind: "no-cli" });
          if (failure?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return resolve({ kind: "too-large" });
          if (failure?.killed) return resolve({ kind: "timeout" });
          const answer = parseIncluded(stdout);
          if (answer) return resolve({ kind: "http", ...answer });
          if (failure?.code === 4) return resolve({ kind: "signed-out" });
          resolve({ kind: failure && NETWORK.test(stderr.toString("utf8")) ? "offline" : "failed" });
        });
    });
  };
}
