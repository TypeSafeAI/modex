/**
 * Files attached to a message. Main stages them under `<home>/attachments` the moment they are
 * dropped, pasted or picked, so every path (and the transcript's thumbnails) works the same way;
 * on send they move into the thread's own folder. Pure helpers here are shared by main and the
 * renderer and unit-tested from test/attachments.test.ts.
 */
export type AttachmentKind = "image" | "file";

export interface Attachment {
  id: string;
  name: string;
  mime: string;
  size: number;
  kind: AttachmentKind;
  /** Path under the attachments root: `staging/<id>-<name>` until sent, then `<threadId>/<id>-<name>`. */
  rel: string;
}

/** What the renderer hands main: a path the OS gave it (drop, picker) or base64 bytes it already holds (paste). */
export type StagedFile =
  | { name: string; mime?: string; size?: number; path: string; data?: undefined }
  | { name: string; mime?: string; size?: number; data: string; path?: undefined };

/** Image types the Claude API accepts inline; anything else travels by path. */
export const IMAGE_TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

export const LIMITS = {
  /** The API's per-image ceiling. */
  imageBytes: 5 * 1024 * 1024,
  fileBytes: 25 * 1024 * 1024,
  perTurn: 20,
};

const BY_EXTENSION: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  svg: "image/svg+xml", pdf: "application/pdf", json: "application/json", md: "text/markdown", txt: "text/plain",
  csv: "text/csv", html: "text/html", css: "text/css", js: "text/javascript", ts: "text/typescript", tsx: "text/typescript",
  jsx: "text/javascript", py: "text/x-python", rs: "text/x-rust", go: "text/x-go", swift: "text/x-swift", yml: "text/yaml", yaml: "text/yaml",
  toml: "text/toml", xml: "application/xml", zip: "application/zip", log: "text/plain", sh: "text/x-shellscript",
};

/** The file's type, from the OS hint when it is specific and from the extension otherwise. */
export function mimeFor(name: string, hint?: string): string {
  const h = (hint ?? "").toLowerCase().trim();
  if (h && h !== "application/octet-stream") return h;
  const ext = name.toLowerCase().split(".").pop() ?? "";
  return (ext && ext !== name.toLowerCase() ? BY_EXTENSION[ext] : undefined) ?? "application/octet-stream";
}

export function kindFor(mime: string): AttachmentKind {
  return mime in IMAGE_TYPES ? "image" : "file";
}

/** A name safe to write under the attachments root: no directories, no control characters, bounded. */
export function safeName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, "").replace(/^\.+/, "").trim();
  if (!clean) return "file";
  if (clean.length <= 120) return clean;
  const dot = clean.lastIndexOf(".");
  const ext = dot > 0 && clean.length - dot <= 12 ? clean.slice(dot) : "";
  return clean.slice(0, 120 - ext.length) + ext;
}

/** 980 B · 12 KB · 3.4 MB */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

/** Why a file cannot be attached, or null when it can. */
export function rejectReason(name: string, size: number, kind: AttachmentKind): string | null {
  const limit = kind === "image" ? LIMITS.imageBytes : LIMITS.fileBytes;
  if (size > limit) return `${name} is ${formatBytes(size)}; the limit for ${kind === "image" ? "images" : "files"} is ${formatBytes(limit)}.`;
  return null;
}

export const ATTACHMENT_SCHEME = "modex-attachment";

/** The URL the renderer loads a staged or sent attachment from (main serves only the attachments root). */
export function attachmentUrl(a: Pick<Attachment, "rel">): string {
  return `${ATTACHMENT_SCHEME}://attachment/${a.rel.split("/").map(encodeURIComponent).join("/")}`;
}

/** The `rel` an attachment URL names, or null when the URL is not one main should serve. */
export function relFromUrl(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== `${ATTACHMENT_SCHEME}:` || u.host !== "attachment") return null;
  const parts = u.pathname.split("/").filter(Boolean).map((p) => {
    try { return decodeURIComponent(p); } catch { return ""; }
  });
  if (parts.length !== 2 || parts.some((p) => !p || p === "." || p === ".." || p.includes("/") || p.includes("\\") || p.includes("\u0000"))) return null;
  return parts.join("/");
}

/**
 * The prompt the CLI receives: the user's words plus, for files that cannot travel inline, where
 * to read them. Images are not listed; they ride along as content blocks.
 */
export function describeAttachments(text: string, files: { name: string; path: string; kind: AttachmentKind }[]): string {
  const paths = files.filter((f) => f.kind === "file");
  if (!paths.length) return text;
  const list = paths.map((f) => `- ${f.path}`).join("\n");
  const intro = `Attached file${paths.length === 1 ? "" : "s"} (read as needed):\n${list}`;
  return text.trim() ? `${text}\n\n${intro}` : intro;
}
