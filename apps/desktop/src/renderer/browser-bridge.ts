/// <reference types="vite/client" />
import { IMAGE_TYPES, LIMITS } from "../shared/attachments";
import type { BridgeCommands, ModexBridge, ThreadEvent, TerminalEvent } from "../shared/types";

/** Same-origin dev transport. The Electron preload continues to take precedence. */
export function createBrowserBridge(): ModexBridge {
  const token = document.querySelector<HTMLMetaElement>('meta[name="modex-browser-token"]')?.content ?? "";
  const threads = new Set<(event: ThreadEvent) => void>();
  const terminals = new Set<(event: TerminalEvent) => void>();
  let stream: EventSource | null = null;
  const connect = () => {
    if (stream) return stream;
    stream = new EventSource(`/__modex/events?token=${encodeURIComponent(token)}`);
    stream.addEventListener("thread", (event) => { for (const cb of threads) cb(JSON.parse(event.data)); });
    stream.addEventListener("terminal", (event) => { for (const cb of terminals) cb(JSON.parse(event.data)); });
    return stream;
  };
  const disconnect = () => { stream?.close(); stream = null; };
  const ready = async () => {
    const source = connect();
    if (source.readyState === EventSource.OPEN) return;
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timeout); source.removeEventListener("open", opened); source.removeEventListener("error", failed); };
      const opened = () => { cleanup(); resolve(); };
      const failed = () => { cleanup(); reject(new Error("Browser bridge disconnected. Refresh after restarting the dev server.")); };
      const timeout = setTimeout(failed, 10_000);
      source.addEventListener("open", opened);
      source.addEventListener("error", failed);
    });
  };
  if (import.meta.hot) import.meta.hot.dispose(disconnect);
  return {
    platform: "web",
    pickFiles: () => new Promise<File[]>((resolve, reject) => {
      const input = document.createElement("input");
      input.type = "file"; input.multiple = true; input.hidden = true;
      const done = (files: File[]) => { input.remove(); resolve(files); };
      input.addEventListener("change", () => done(Array.from(input.files ?? [])), { once: true });
      input.addEventListener("cancel", () => done([]), { once: true });
      document.body.append(input);
      try { input.click(); } catch (error) { input.remove(); reject(error); }
    }),
    async attachmentThumbnail(rel, signal) {
      const response = await fetch(`/__modex/attachments/image?rel=${encodeURIComponent(rel)}`, {
        headers: { "X-Modex-Token": token }, signal,
      });
      if (!response.ok || !Object.hasOwn(IMAGE_TYPES, response.headers.get("Content-Type") ?? "")) throw new Error("Attachment image unavailable.");
      const blob = await response.blob();
      if (blob.size > LIMITS.imageBytes) throw new Error("Attachment image unavailable.");
      return blob;
    },
    async invoke(channel, payload) {
      if (channel === "clipboard:write") {
        await navigator.clipboard.writeText((payload as BridgeCommands["clipboard:write"]["req"]).text);
        return undefined as never;
      }
      if (!token) throw new Error("Start the browser bridge with npm run desktop:dev, then refresh this page.");
      if (channel === "thread:send" || channel === "thread:retry" || channel === "terminal:open") await ready();
      const staging = channel === "attachments:stage";
      const response = await fetch(staging ? "/__modex/attachments/stage" : "/__modex/invoke", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Modex-Token": token },
        body: JSON.stringify(staging ? payload : { channel, payload }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? `Browser bridge failed (${response.status}).`);
      return result.value;
    },
    onEvent(cb) {
      threads.add(cb);
      connect();
      return () => { threads.delete(cb); if (!threads.size && !terminals.size) disconnect(); };
    },
    onTerminalEvent(cb) {
      terminals.add(cb);
      connect();
      return () => { terminals.delete(cb); if (!threads.size && !terminals.size) disconnect(); };
    },
  };
}
