import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { workspaceRel } from "./git.js";
import { CANVAS_SCHEME, canvasFile } from "../../shared/canvas.js";
import { tokenizeInline, type InlineToken } from "../../shared/inline.js";

const TYPES: Record<string, string> = {
  ".html": "text/html", ".htm": "text/html", ".svg": "image/svg+xml",
  ".md": "text/html", ".markdown": "text/html", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".ico": "image/x-icon",
  ".woff": "font/woff", ".woff2": "font/woff2",
};
const MAX_BYTES = 1024 * 1024;
const POLICY = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
const escape = (text: string) => text.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const inline = (tokens: InlineToken[]): string => tokens.map(t => t.type === "text" ? escape(t.text) : t.type === "code" ? `<code>${escape(t.text)}</code>` : t.type === "bold" ? `<strong>${inline(t.children)}</strong>` : `<a href="${escape(t.href)}" rel="noreferrer">${inline(t.children)}</a>`).join("");

/** The same small Markdown subset as transcript previews; source HTML is always text. */
function markdown(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: string[] = [];
  for (let i = 0; i < lines.length;) {
    const line = lines[i++]!;
    if (!line.trim()) continue;
    if (line.startsWith("```")) {
      const code: string[] = [];
      while (i < lines.length && !lines[i]!.startsWith("```")) code.push(lines[i++]!);
      i++;
      blocks.push(`<pre><code>${escape(code.join("\n"))}</code></pre>`);
    } else if (/^#{1,6}\s/.test(line)) {
      const [, prefix, content] = /^(#{1,6})\s+(.*)$/.exec(line)!;
      blocks.push(`<h${prefix!.length}>${inline(tokenizeInline(content!))}</h${prefix!.length}>`);
    } else if (/^\s*([-*]|\d+\.)\s/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const pattern = ordered ? /^\s*\d+\.\s+/ : /^\s*[-*]\s+/;
      const items = [line.replace(pattern, "")];
      while (i < lines.length && pattern.test(lines[i]!)) items.push(lines[i++]!.replace(pattern, ""));
      blocks.push(`<${ordered ? "ol" : "ul"}>${items.map(s => `<li>${inline(tokenizeInline(s))}</li>`).join("")}</${ordered ? "ol" : "ul"}>`);
    } else blocks.push(`<p>${inline(tokenizeInline(line))}</p>`);
  }
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{font:16px/1.6 system-ui;margin:24px;color:#202124;background:#fff;overflow-wrap:anywhere}pre{padding:16px;background:#f1f3f5;overflow:auto}code{font-family:monospace}img{max-width:100%}</style></head><body>${blocks.join("\n")}</body></html>`;
}

/** One unguessable origin per preview. Only supported regular files under the thread root are served. */
export class CanvasResources {
  readonly origin = `${CANVAS_SCHEME}://${randomUUID()}`;
  readonly url: string;
  private fingerprints = new Map<string, string>();
  constructor(private root: string, readonly selected: string) {
    if (!canvasFile(selected)) throw new Error("Choose an HTML, SVG or Markdown file.");
    workspaceRel(root, selected);
    this.url = `${this.origin}/${selected.split(/[\\/]/).map(encodeURIComponent).join("/")}`;
  }
  allows(value: string): boolean {
    try { const u = new URL(value); return `${u.protocol}//${u.host}` === this.origin && !u.username && !u.password; } catch { return false; }
  }
  private async read(relative: string): Promise<Buffer> {
    if (!TYPES[path.extname(relative).toLowerCase()] || relative.split(/[\\/]/).some(p => p.startsWith("."))) throw new Error("Unsupported preview resource.");
    const root = await fs.realpath(this.root);
    const { abs } = workspaceRel(root, relative);
    const real = await fs.realpath(abs);
    const canonical = workspaceRel(root, real).relative;
    if (!TYPES[path.extname(canonical).toLowerCase()] || canonical.split("/").some(p => p.startsWith("."))) throw new Error("Unsupported preview resource.");
    const file = await fs.open(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error("Canvas supports regular files up to 1 MB.");
      const buffer = Buffer.alloc(MAX_BYTES + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_BYTES) throw new Error("Canvas supports regular files up to 1 MB.");
      return buffer.subarray(0, bytesRead);
    } finally { await file.close(); }
  }
  async validate(): Promise<void> { await this.read(this.selected); }
  private fingerprint(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
  async changed(): Promise<boolean> {
    let changed = false;
    for (const [relative, previous] of this.fingerprints) {
      const next = await this.read(relative).then(b => this.fingerprint(b), () => "missing");
      if (previous !== next) { this.fingerprints.set(relative, next); changed = true; }
    }
    return changed;
  }
  async respond(request: Request): Promise<Response> {
    const headers = { "Content-Security-Policy": POLICY, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };
    if (!this.allows(request.url)) return new Response("Preview unavailable.", { status: 403, headers });
    if (request.method !== "GET") return new Response("Read-only preview.", { status: 405, headers });
    let relative = "";
    try {
      relative = decodeURIComponent(new URL(request.url).pathname.slice(1));
      if (!this.fingerprints.has(relative) && this.fingerprints.size >= 128) throw new Error("Too many preview resources.");
      const bytes = await this.read(relative);
      this.fingerprints.set(relative, this.fingerprint(bytes));
      const ext = path.extname(relative).toLowerCase();
      const body = ext === ".md" || ext === ".markdown" ? markdown(bytes.toString("utf8")) : new Uint8Array(bytes);
      return new Response(body, { headers: { ...headers, "Content-Type": TYPES[ext]! + (TYPES[ext]!.startsWith("text/") || ext === ".svg" ? "; charset=utf-8" : "") } });
    } catch {
      // Track missing assets too: a generated file can appear after the document that references it.
      if (relative && this.fingerprints.size < 128) this.fingerprints.set(relative, "missing");
      return new Response("This preview resource is unavailable or unsupported (1 MB limit).", { status: 404, headers });
    }
  }
}
