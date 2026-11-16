import { useEffect, useId, useRef, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { currentConfirm, settleConfirm, subscribeConfirm, type ConfirmRequest } from "../confirm";
import { Icon } from "./ui/Icon";

/**
 * Shows the confirmation `confirmDialog` asked for (../confirm.ts). Rendered once, by `App`, so the
 * desktop app, the Store edition and the web demo all answer confirmations in the app instead of in
 * the browser's own confirm box.
 */
export function ConfirmHost() {
  const request = useSyncExternalStore(subscribeConfirm, currentConfirm);
  if (!request) return null;
  // A portal keeps the dialog above the content sheet, which isolates its own stacking context.
  return createPortal(<ConfirmDialog key={request.id} request={request} />, document.body);
}

/**
 * One confirmation: what is asked, what follows from it, and two buttons. Cancel has focus when it
 * opens, so Enter never accepts by default. Escape and the backdrop cancel.
 */
function ConfirmDialog({ request }: { request: ConfirmRequest }) {
  const titleId = useId();
  const bodyId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const tone = request.tone ?? "neutral";

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancel.current?.focus();
    // Capture on the window, ahead of every other handler: nothing behind the dialog (app shortcuts,
    // an open Settings dialog's own Escape and Tab handling) reacts to a key while it is open.
    // Default actions are left alone, so Enter and Space still press the focused button.
    const onKey = (event: KeyboardEvent) => {
      event.stopPropagation();
      if (event.key === "Escape") {
        event.preventDefault();
        settleConfirm(request.id, false);
        return;
      }
      if (event.key !== "Tab") return;
      const buttons = Array.from(dialog.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
      if (buttons.length === 0) return;
      event.preventDefault();
      const at = buttons.findIndex((button) => button === document.activeElement);
      buttons[(at + (event.shiftKey ? buttons.length - 1 : 1) + buttons.length) % buttons.length]?.focus();
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      // The opener may be gone (a menu row that closed with its menu); focus then stays where it falls.
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [request.id]);

  return (
    <div className="modal-backdrop confirm-backdrop" data-testid="confirm-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) settleConfirm(request.id, false); }}>
      <div ref={dialog} className={`modal confirm tone-${tone}`} role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={request.body ? bodyId : undefined} data-testid="confirm-dialog" data-tone={tone}>
        <div className="confirm-top">
          <span className="confirm-icon" aria-hidden="true"><Icon name={request.icon ?? "info"} size={18} /></span>
          <div className="confirm-text">
            <h2 id={titleId} data-testid="confirm-title">{request.title}</h2>
            {request.body && <p id={bodyId} className="confirm-body" data-testid="confirm-body">{request.body}</p>}
          </div>
        </div>
        {request.path && <code className="confirm-path" data-testid="confirm-path">{request.path}</code>}
        {request.facts && request.facts.length > 0 && (
          <ul className="confirm-facts">
            {request.facts.map((fact) => (
              <li key={fact.text} className={fact.kind} data-testid="confirm-fact" data-kind={fact.kind}>
                <Icon name={fact.kind === "lost" ? "close" : "check"} size={14} />
                <span>{fact.text}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="confirm-actions">
          <button ref={cancel} type="button" className="btn" data-testid="confirm-cancel" onClick={() => settleConfirm(request.id, false)}>Cancel</button>
          <button type="button" className={`btn ${tone === "neutral" ? "primary" : `solid-${tone}`}`} data-testid="confirm-accept" onClick={() => settleConfirm(request.id, true)}>{request.confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}
