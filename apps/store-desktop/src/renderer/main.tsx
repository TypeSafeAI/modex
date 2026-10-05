import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "../../../desktop/src/renderer/App";
import { restoreTheme } from "../../../desktop/src/renderer/theme";
import mark from "../../../desktop/src/renderer/assets/modex-mark.png";
import "../../../desktop/src/renderer/tokens.css";
import "../../../desktop/src/renderer/styles.css";
import "./store.css";

type Status = { state: "unpaired" | "connecting" | "connected" | "offline"; detail: string };
declare global {
  interface Window {
    modexHost: {
      status(): Promise<Status>;
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
  useEffect(() => {
    let sawEvent = false;
    let live = true;
    const update = (value: Status) => { if (!live) return; setStatus(value); if (value.state === "connected") setOpened(true); };
    const unsubscribe = window.modexHost.onStatus((value) => { sawEvent = true; update(value); });
    void window.modexHost.status().then((value) => { if (!sawEvent) update(value); }).catch((error: Error) => setError(error.message));
    return () => { live = false; unsubscribe(); };
  }, []);
  const connected = status.state === "connected";
  async function pair(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try { await window.modexHost.pair(uri.trim()); setUri(""); }
    catch (error) { setError((error as Error).message); }
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
          <p className="host-instructions">Open your Modex host on this Mac, choose <strong>Desktop access → Pair a desktop</strong>, then paste its connection link.</p>
          <form onSubmit={(event) => void pair(event)}>
            <label htmlFor="host-link">Connection link</label>
            <input id="host-link" type="password" autoComplete="off" spellCheck={false} value={uri} onChange={(event) => setUri(event.target.value)} placeholder="Paste the link from your Mac host" disabled={busy} />
            <button type="submit" disabled={busy || !uri.trim()}>{busy ? "Connecting…" : "Connect to my Mac"}<span aria-hidden="true">↗</span></button>
          </form>
          <p className="host-footnote">Pair once. Your connection stays saved until you or the host removes access.</p>
        </> : <>
          <div className="host-wait"><span />{status.state === "offline" ? "Reconnecting automatically" : "Connecting securely"}</div>
          <p className="host-footnote">Keep your Modex host open. Your projects and coding tools stay on the host.</p>
          <button className="host-forget" onClick={() => void window.modexHost.disconnect().catch((error: Error) => setError(error.message))}>Use a new connection link</button>
        </>}
        {error && <p className="host-error" role="alert">{error}</p>}
        <footer>Powered by Jev</footer>
      </section>
    </main>}
  </>;
}
restoreTheme();
createRoot(document.getElementById("root")!).render(<React.StrictMode><StoreShell /></React.StrictMode>);
