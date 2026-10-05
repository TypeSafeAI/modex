import { useEffect, useRef, useState } from "react";
import type { CompanionStatus } from "../../shared/types";
import { bridge } from "../bridge";
import { Icon } from "./ui/Icon";

export function CompanionDialog({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<CompanionStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    void bridge.invoke("companion:status", undefined).then(setStatus).catch((err: Error) => setError(err.message));
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onCloseRef.current(); }
      if (event.key !== "Tab") return;
      const controls = [...(dialogRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
      const first = controls[0], last = controls.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey, true);
    return () => { document.removeEventListener("keydown", onKey, true); previous?.focus(); };
  }, []);
  const act = async (channel: "companion:start" | "companion:stop" | "companion:reset") => {
    setBusy(true);
    setError(null);
    try { setStatus(await bridge.invoke(channel, undefined)); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  };
  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section ref={dialogRef} className="modal companion-modal" role="dialog" aria-modal="true" aria-labelledby="companion-title" data-testid="companion-dialog">
        <div className="companion-heading">
          <div className="companion-mark"><Icon name="phone" size={23} /></div>
          <button ref={closeRef} className="companion-close" onClick={onClose} aria-label="Close companion pairing"><Icon name="close" /></button>
        </div>
        <p className="companion-eyebrow">MODEX FOR IPHONE</p>
        <h2 id="companion-title">Your work, within reach.</h2>
        <p className="companion-intro">Review live threads, send a follow-up, and answer approvals while your Mac runs the coding work.</p>
        {status?.enabled && status.qrDataUrl ? (
          <div className="companion-pairing">
            <div className="companion-qr"><img src={status.qrDataUrl} alt="Pairing code for Modex on iPhone" data-testid="companion-qr" /></div>
            <p>Open Modex on your iPhone and scan this code.</p>
            <span className="companion-address">Mac on {status.addresses[0]} · local network</span>
          </div>
        ) : (
          <div className="companion-idle">
            <Icon name="phone" size={30} />
            <strong>{status?.enabled ? "Connect your Mac to a local network" : "Ready when you are"}</strong>
            <span>{status?.enabled ? "A local address is needed to pair your iPhone." : "Turn on the companion to show a private pairing code."}</span>
          </div>
        )}
        {error && <p className="companion-error" role="alert">{error}</p>}
        <div className="companion-actions">
          {status?.enabled ? (
            <>
              <button className="btn" disabled={busy} onClick={() => void act("companion:reset")}>Forget paired phones</button>
              <button className="btn" disabled={busy} onClick={() => void act("companion:stop")}>Turn off</button>
            </>
          ) : <button className="btn primary" data-testid="companion-start" disabled={busy || !status} onClick={() => void act("companion:start")}>Turn on companion</button>}
        </div>
        <p className="companion-note">Your Mac and iPhone must share a network. Only phones paired with this code can access your threads. Turn off or reset access here at any time.</p>
      </section>
    </div>
  );
}
