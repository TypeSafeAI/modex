/// <reference types="vite/client" />
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
    async invoke(channel, payload) {
      if (channel === "clipboard:write") {
        await navigator.clipboard.writeText((payload as BridgeCommands["clipboard:write"]["req"]).text);
        return undefined as never;
      }
      if (!token) throw new Error("Start the browser bridge with npm run desktop:dev, then refresh this page.");
      if (channel === "thread:send" || channel === "thread:retry" || channel === "terminal:open") await ready();
      const response = await fetch("/__modex/invoke", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Modex-Token": token },
        body: JSON.stringify({ channel, payload }),
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
