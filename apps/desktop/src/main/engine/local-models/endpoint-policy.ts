import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";

/**
 * Where a local-model connection may point (#378): a same-machine HTTP(S) origin the person typed,
 * nothing else. Hosts are loopback IP literals or `localhost`, and every address `localhost`
 * resolves to is checked again when the socket connects, so a resolver answer that changes after
 * the profile was saved cannot move a request off the machine. Redirects are never followed, and
 * paths are fixed by the metadata adapter, never by the renderer.
 *
 * Loopback is a destination, not a privacy claim: a server on 127.0.0.1 may still forward to the
 * cloud. That locality stays unverified here (#376 privacy invariants).
 */

export interface LocalEndpoint {
  protocol: "http:" | "https:";
  /** Normalized, e.g. `http://127.0.0.1:11434` or `http://[::1]:8000`. No path, no credentials. */
  origin: string;
  /** Host as it goes on the socket: an IP literal without brackets, or `localhost`. */
  host: string;
  port: number;
  /** "" or "/v1" (Responses-compatible servers that are configured with their API prefix). */
  basePath: "" | "/v1";
}

export type EndpointParse = { ok: true; endpoint: LocalEndpoint } | { ok: false; reason: string };

const MAX_URL = 2048;

/** Never echoes the input: a refused URL can carry a password. */
function refuse(reason: string): EndpointParse {
  return { ok: false, reason };
}

export function parseLocalEndpoint(input: unknown, options: { allowV1?: boolean } = {}): EndpointParse {
  if (typeof input !== "string") return refuse("Enter the server's address, like http://127.0.0.1:11434.");
  const raw = input.trim();
  if (!raw || raw.length > MAX_URL) return refuse("Enter the server's address, like http://127.0.0.1:11434.");
  // Whitespace, controls, backslashes, `@`, `%`, queries and fragments are where parsers disagree.
  if (/[\s\x00-\x1f\x7f\\@%?#]/.test(raw)) return refuse("Use a plain address without a user name, query or special characters.");
  const parts = /^(https?):\/\/([^/]+)(\/.*)?$/i.exec(raw);
  if (!parts) return refuse("Use an http:// or https:// address.");
  const rawPath = parts[3] ?? "";
  const paths = options.allowV1 ? ["", "/", "/v1", "/v1/"] : ["", "/"];
  if (!paths.includes(rawPath)) return refuse(options.allowV1 ? "Use the server's root address or its /v1 path." : "Use the server's root address, without a path.");
  let url: URL;
  try { url = new URL(raw); } catch { return refuse("That isn't a valid address."); }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return refuse("Use an http:// or https:// address.");
  const hostname = url.hostname;
  const bare = hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;
  if (hostname !== "localhost" && !isLoopbackAddress(bare)) return refuse("Only servers on this Mac are supported: localhost, 127.0.0.1 or [::1].");
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return refuse("Use a port between 1 and 65535.");
  return { ok: true, endpoint: { protocol: url.protocol, origin: url.origin, host: bare, port, basePath: rawPath.startsWith("/v1") ? "/v1" : "" } };
}

/** 127.0.0.0/8, ::1 and IPv4-mapped 127.0.0.0/8. Not 0.0.0.0, not `::`, not link-local. */
export function isLoopbackAddress(address: string): boolean {
  if (net.isIPv4(address)) return address.split(".")[0] === "127";
  if (!net.isIPv6(address)) return false;
  let normal: string;
  try { normal = new URL(`http://[${address}]/`).hostname; } catch { return false; }
  return normal === "[::1]" || /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(normal);
}

type LookupAddress = { address: string; family: number };
export type BaseLookup = (host: string, options: dns.LookupAllOptions, done: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void) => void;
type Lookup = (host: string, options: { all?: boolean; family?: number | string }, done: (err: NodeJS.ErrnoException | null, address?: string | LookupAddress[], family?: number) => void) => void;

/** A socket `lookup` that answers only when every resolved address is loopback. */
export function loopbackLookup(base: BaseLookup = dns.lookup as unknown as BaseLookup): Lookup {
  return (host, options, done) => {
    base(host, { ...(options as object), all: true } as dns.LookupAllOptions, (err, addresses) => {
      if (err) return done(err);
      if (!addresses?.length || !addresses.every(a => isLoopbackAddress(a.address))) {
        return done(Object.assign(new Error("not a loopback address"), { code: "ENOTLOOPBACK" }));
      }
      if (options.all) return done(null, addresses);
      done(null, addresses[0]!.address, addresses[0]!.family);
    });
  };
}

export type LocalGetReason = "invalid" | "not-loopback" | "redirect" | "too-large" | "timeout" | "cancelled" | "unauthorized" | "not-found" | "http-error" | "malformed" | "unavailable" | "reflected-credential" | "credential-unavailable";

/** Messages are fixed: a local server's own text can contain the token it was sent. */
const DETAIL: Record<LocalGetReason, string> = {
  invalid: "Modex refused that request.",
  "not-loopback": "The address no longer points at this Mac.",
  redirect: "The server tried to redirect Modex elsewhere.",
  "too-large": "The server's answer was too large.",
  timeout: "The server took too long to answer.",
  cancelled: "Cancelled.",
  unauthorized: "The server refused the saved token.",
  "not-found": "The server doesn't offer that information.",
  "http-error": "The server answered with an error.",
  malformed: "The server's answer could not be read.",
  unavailable: "Nothing answered at that address.",
  "reflected-credential": "The server repeated the saved token in its answer, so Modex ignored the answer.",
  "credential-unavailable": "Modex can't read the saved token right now, so it didn't contact the server.",
};

export class LocalGetFailure extends Error {
  constructor(readonly reason: LocalGetReason) {
    super(DETAIL[reason]);
  }
}

export interface LocalGetOptions {
  maxBytes: number;
  /** Whole-request deadline, not an idle timeout. */
  timeoutMs: number;
  signal?: AbortSignal;
  /** Sent as a bearer token to this endpoint only. */
  token?: string;
  /** Test seam for the resolver behind `localhost`. Always wrapped by `loopbackLookup`, never instead of it. */
  lookup?: BaseLookup;
}

const PATH = /^(?:\/[A-Za-z0-9._~-]+)+\/?$/;

export function localGet(endpoint: LocalEndpoint, path: string, options: LocalGetOptions): Promise<unknown> {
  return request(endpoint, "GET", path, undefined, options);
}

/** Metadata reads some runtimes only offer as POST (Ollama's /api/show). Never an inference route. */
export function localPost(endpoint: LocalEndpoint, path: string, body: unknown, options: LocalGetOptions): Promise<unknown> {
  return request(endpoint, "POST", path, JSON.stringify(body), options);
}

function request(endpoint: LocalEndpoint, method: "GET" | "POST", path: string, body: string | undefined, options: LocalGetOptions): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!PATH.test(path) || path.split("/").some(s => s === "." || s === "..")) return reject(new LocalGetFailure("invalid"));
    if (options.signal?.aborted) return reject(new LocalGetFailure("cancelled"));
    let settled = false;
    const finish = (error: LocalGetFailure | null, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (error) { req.destroy(); reject(error); } else resolve(value);
    };
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) { headers["content-type"] = "application/json"; headers["content-length"] = String(Buffer.byteLength(body)); }
    if (options.token) headers.authorization = `Bearer ${options.token}`;
    const transport = endpoint.protocol === "https:" ? https : http;
    const req = transport.request({
      host: endpoint.host, port: endpoint.port, path: endpoint.basePath + path, method, headers,
      agent: false, lookup: loopbackLookup(options.lookup) as never,
    }, (res) => {
      const remote = res.socket?.remoteAddress;
      if (!remote || !isLoopbackAddress(remote)) return finish(new LocalGetFailure("not-loopback"));
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400) return finish(new LocalGetFailure("redirect"));
      if (status === 401 || status === 403) return finish(new LocalGetFailure("unauthorized"));
      if (status === 404) return finish(new LocalGetFailure("not-found"));
      if (status < 200 || status >= 300) return finish(new LocalGetFailure("http-error"));
      if (Number(res.headers["content-length"] ?? 0) > options.maxBytes) return finish(new LocalGetFailure("too-large"));
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > options.maxBytes) return finish(new LocalGetFailure("too-large"));
        chunks.push(chunk);
      });
      res.on("end", () => {
        try { finish(null, JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { finish(new LocalGetFailure("malformed")); }
      });
      res.on("error", () => finish(new LocalGetFailure("unavailable")));
    });
    const onAbort = () => finish(new LocalGetFailure("cancelled"));
    const timer = setTimeout(() => finish(new LocalGetFailure("timeout")), options.timeoutMs);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    req.on("error", (err: NodeJS.ErrnoException) => finish(new LocalGetFailure(err.code === "ENOTLOOPBACK" ? "not-loopback" : "unavailable")));
    req.end(body);
  });
}
