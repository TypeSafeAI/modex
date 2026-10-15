import fs from "node:fs";
import path from "node:path";
import type { UsageLedger } from "./usage-ledger.js";

export const ANALYTICS_SCHEME = "modex-analytics";
export const ANALYTICS_ORIGIN = `${ANALYTICS_SCHEME}://app`;
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2", ".woff": "font/woff", ".svg": "image/svg+xml", ".png": "image/png", ".txt": "text/plain; charset=utf-8",
};
// The dashboard is a separate document: its global styles and the app's never meet. It reads only itself and usage.json.
export const ANALYTICS_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

const notFound = () => new Response("Not found", { status: 404 });

/**
 * One request on `modex-analytics://app/`: a file of the built dashboard under `root` (regular files of
 * known types only, never outside it), or `usage.json` with the ledger's rows. Anything else is a 404.
 */
export async function respondAnalytics(root: string, ledger: Pick<UsageLedger, "list">, request: Request): Promise<Response> {
  let url: URL;
  try { url = new URL(request.url); } catch { return new Response("Bad request", { status: 400 }); }
  if (url.protocol !== `${ANALYTICS_SCHEME}:` || url.host !== "app" || request.method !== "GET") return notFound();
  if (url.pathname === "/usage.json") {
    return new Response(JSON.stringify(ledger.list()), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
  }
  let relative: string;
  try { relative = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname).replace(/^\/+/, ""); } catch { return notFound(); }
  const file = path.resolve(root, relative);
  const inside = path.relative(root, file);
  const type = TYPES[path.extname(file)];
  if (!inside || inside.startsWith("..") || path.isAbsolute(inside) || !type) return notFound();
  try {
    if (!(await fs.promises.lstat(file)).isFile()) return notFound();
    const body = await fs.promises.readFile(file);
    return new Response(body, { headers: { "content-type": type, "cache-control": "no-store", ...(type.startsWith("text/html") ? { "content-security-policy": ANALYTICS_CSP } : {}) } });
  } catch { return notFound(); }
}
