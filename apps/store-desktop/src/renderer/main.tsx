import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "../../../desktop/src/renderer/App";
import { restoreTheme } from "../../../desktop/src/renderer/theme";
import mark from "../../../desktop/src/renderer/assets/modex-mark.png";
import "../../../desktop/src/renderer/tokens.css";
import "../../../desktop/src/renderer/styles.css";
import "./store.css";

type Status = { state: "unpaired" | "authorizing" | "connecting" | "connected" | "offline"; detail: string; confirmationCode?: string };
type Discovery = { available: boolean; installed: boolean; detail: string };
declare global {
  interface Window {
    modexHost: {
      status(): Promise<Status>;
      discover(): Promise<Discovery>;
      connect(): Promise<void>;
      pair(uri: string): Promise<void>;
      disconnect(): Promise<void>;
      onStatus(cb: (status: Status) => void): () => void;
    };
  }
}
function StoreShell() {
  const [status, setStatus] = useState<Status>({ state: "connecting", detail: "Opening your workspace…" });
  const [opened, setOpened] = useState(false);
  const [uri, setUri] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [discovery, setDiscovery] = useState<Discovery | null>(null);
  useEffect(() => {
    let sawEvent = false;
    let live = true;
    const update = (value: Status) => { if (!live) return; setStatus(value); if (value.state === "connected") setOpened(true); };
    const unsubscribe = window.modexHost.onStatus((value) => { sawEvent = true; update(value); });
    void window.modexHost.status().then((value) => { if (!sawEvent) update(value); }).catch((error: Error) => setError(error.message));
    return () => { live = false; unsubscribe(); };
  }, []);
  useEffect(() => {
    if (status.state !== "unpaired") return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const check = async () => {
      try { const result = await window.modexHost.discover(); if (live) setDiscovery(result); }
      catch { if (live) setDiscovery({ available: false, installed: false, detail: "Could not check this Mac. You can still use a connection link below." }); }
      finally { if (live) timer = setTimeout(() => void check(), 5000); }
    };
    void check();
    return () => { live = false; clearTimeout(timer); };
  }, [status.state]);
  const connected = status.state === "connected";
  async function pair(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try { await window.modexHost.pair(uri.trim()); setUri(""); }
    catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  }
  async function connect() {
    setBusy(true); setError("");
    try { await window.modexHost.connect(); }
    catch (error) { setError((error as Error).message.replace(/^Error invoking remote method '[^']+': Error: /, "")); }
    finally { setBusy(false); }
  }
  return <>
    {opened && <div className="store-workspace" inert={!connected}><App /></div>}
    {!connected && <main className="host-connection" aria-labelledby="host-title">
      <div className="host-titlebar" />
      <section className="host-card">
        <div className="host-brand"><img src={mark} alt="" /><span>Modex</span><span className="host-preview">Store preview</span></div>
        <p className="host-eyebrow">YOUR WORKSPACE. YOUR MAC.</p>
        <h1 id="host-title">{status.state === "offline" ? "Your work is still here." : "Make yourself at home."}</h1>
        <p className="host-description" role="status">{status.detail}</p>
        {status.state === "unpaired" ? <>
          <div className="host-detected" role="status"><span className={discovery?.available ? "host-ready" : ""} />{discovery?.detail ?? "Looking for Modex on this Mac…"}</div>
          <button className="host-connect" disabled={busy || !discovery || (!discovery.available && !discovery.installed)} onClick={() => void connect()}>{busy ? "Opening your host…" : discovery?.installed ? "Open Modex and connect" : "Connect to this Mac"}<span aria-hidden="true">↗</span></button>
          <p className="host-footnote">Confirm access once in the host. Modex then uses the accounts already signed in on your Mac.</p>
          <details className="host-manual"><summary>Use a connection link instead</summary>
          <p className="host-instructions">Open your Modex host on this Mac, choose <strong>Desktop access → Pair a desktop</strong>, then paste its connection link.</p>
          <form onSubmit={(event) => void pair(event)}>
            <label htmlFor="host-link">Connection link</label>
            <input id="host-link" type="password" autoComplete="off" spellCheck={false} value={uri} onChange={(event) => setUri(event.target.value)} placeholder="Paste the link from your Mac host" disabled={busy} />
            <button type="submit" disabled={busy || !uri.trim()}>{busy ? "Connecting…" : "Connect to my Mac"}<span aria-hidden="true">↗</span></button>
          </form>
          </details>
          <p className="host-footnote">Pair once. Your connection stays saved until you or the host removes access.</p>
        </> : <>
          {status.state === "authorizing" && <div className="host-code" aria-label="Connection confirmation code">{status.confirmationCode}</div>}
          <div className="host-wait"><span />{status.state === "authorizing" ? "Waiting for your host's approval" : status.state === "offline" ? "Reconnecting automatically" : "Connecting securely"}</div>
          <p className="host-footnote">Keep your Modex host open. Your projects and coding tools stay on the host.</p>
          <button className="host-forget" onClick={() => void window.modexHost.disconnect().catch((error: Error) => setError(error.message))}>{status.state === "authorizing" ? "Cancel connection" : "Use a new connection link"}</button>
        </>}
        {error && <p className="host-error" role="alert">{error}</p>}
        <footer>Powered by Jev</footer>
      </section>
    </main>}
  </>;
}
restoreTheme();
createRoot(document.getElementById("root")!).render(<React.StrictMode><StoreShell /></React.StrictMode>);
