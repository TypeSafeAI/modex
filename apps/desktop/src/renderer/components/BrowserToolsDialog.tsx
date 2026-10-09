import { useEffect, useRef, useState } from "react";
import type { BrowserToolsSnapshot } from "../../shared/browser";
import { bridge } from "../bridge";
import { Icon } from "./ui/Icon";

export function BrowserToolsDialog({ onClose }: { onClose(): void }) {
  const [state, setState] = useState<BrowserToolsSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const dialog = useRef<HTMLElement>(null);
  const pending = useRef(false);
  const close = useRef(onClose); close.current = onClose;
  useEffect(() => {
    let live = true;
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLButtonElement>("button")?.focus();
    void bridge.invoke("browser:extensions", undefined).then(value => { if (live) setState(value); }, () => { if (live) setError("Browser tools are available in the Modex desktop app."); });
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (!pending.current) close.current(); }
      if (event.key !== "Tab") return;
      const controls = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href]') ?? [])];
      const first = controls[0], last = controls.at(-1);
      if (!first || !last) { event.preventDefault(); dialog.current?.focus(); return; }
      if (!controls.includes(document.activeElement as HTMLElement) || (event.shiftKey ? document.activeElement === first : document.activeElement === last)) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
    };
    document.addEventListener("keydown", key, true);
    return () => { live = false; document.removeEventListener("keydown", key, true); if (previous?.isConnected) previous.focus(); };
  }, []);
  const act = async (operation: () => Promise<BrowserToolsSnapshot>) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(""); setNotice("");
    try { setState(await operation()); setNotice("Reload open browser tabs to apply extension changes."); }
    catch (error) { setError((error as Error).message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, "")); }
    finally { pending.current = false; setBusy(false); }
  };
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !pending.current) onClose(); }}>
    <section ref={dialog} tabIndex={-1} className="modal browser-tools-modal" role="dialog" aria-modal="true" aria-labelledby="browser-tools-title">
      <header><h2 id="browser-tools-title">Browser extensions and sign-in</h2><button className="btn" aria-label="Close browser tools" disabled={busy} onClick={onClose}><Icon name="close" /></button></header>
      <section aria-labelledby="browser-extensions-title">
        <h3 id="browser-extensions-title">Custom extensions</h3>
        <p>Install selected page scripts and styles from an unpacked extension folder. Review its site access before adding it.</p>
        {!state && !error && <p role="status">Loading extensions…</p>}
        {state && !state.extensions.length && <p className="hint">No extensions installed.</p>}
        {state?.extensions.map(extension => <div className="browser-extension" key={extension.id}>
          <div><strong>{extension.name}</strong><span className="hint"> · {extension.version} · {extension.enabled ? "Enabled" : "Disabled"}</span><p className="browser-extension-sites">{extension.sites.join(", ")}</p>{extension.error && <p role="alert">{extension.error}</p>}</div>
          <div className="browser-extension-actions"><button className="btn" disabled={busy} aria-label={`${extension.enabled ? "Disable" : "Enable"} ${extension.name}`} onClick={() => void act(() => bridge.invoke("browser:extensionUpdate", { id: extension.id, action: extension.enabled ? "disable" : "enable" }))}>{extension.enabled ? "Disable" : "Enable"}</button><button className="btn" disabled={busy} aria-label={`Remove ${extension.name}`} onClick={() => void act(() => bridge.invoke("browser:extensionUpdate", { id: extension.id, action: "remove" }))}>Remove</button></div>
        </div>)}
        <button className="btn" disabled={busy || !state || Boolean(state.error)} onClick={() => void act(() => bridge.invoke("browser:extensionInstall", undefined))}>{busy ? "Updating…" : "Add extension"}</button>
        <p className="hint">Manifest V3 page scripts, styles and local storage are supported. Chrome Web Store packages and extensions requiring background tasks or native messaging are unavailable.</p>
      </section>
      <section aria-labelledby="browser-signin-title">
        <h3 id="browser-signin-title">1Password and passkeys</h3>
        <p>Install the <a href="https://developer.1password.com/docs/cli/get-started/" target="_blank" rel="noreferrer">1Password CLI</a>, then enable <strong>Integrate with 1Password CLI</strong> in 1Password’s Developer settings.</p>
        <p>On an HTTPS login page, choose <strong>Page options → Fill with 1Password</strong>. Select a matching login to fill its fields, then submit the form yourself.</p>
        <p>{state?.touchID ? "Touch ID passkeys are enabled. Choose the website’s passkey sign-in option to continue." : "Touch ID passkeys require a signed Modex release and Touch ID configured on this Mac."} These passkeys stay on this Mac.</p>
        <p>For existing 1Password or iCloud passkeys, choose <strong>Page options → Open in system browser</strong>. Your browser keeps that sign-in; its session is separate from Modex.</p>
      </section>
      {(error || state?.error) && <p className="workspace-error" role="alert">{error || state?.error}</p>}
      {notice && <p role="status">{notice}</p>}
    </section>
  </div>;
}
