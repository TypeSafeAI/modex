import { useEffect, useRef, useState, type ReactNode } from "react";
import { errorReport } from "../../../shared/error-report";
import { bridge } from "../../bridge";
import { useRedact } from "../../streamer";

export interface ErrorAction {
  label: string;
  onClick: () => void;
}

interface Props {
  /** What went wrong, as the surface received it. Streamer Mode redacts it for display and copy. */
  message: string;
  /** Where in Modex it happened, for the copied report: "Terminal", "Changes · diff", "Settings · save". */
  where: string;
  /** Runs the failed action again. Omit when there is nothing safe to repeat. */
  onRetry?: () => void;
  retryLabel?: string;
  /** A remedy other than repeating the action: open Settings, pick another file, reload. */
  fix?: ErrorAction;
  onDismiss?: () => void;
  /** Facts for the copied report (thread id, path, project). Undefined values are left out. */
  context?: Record<string, unknown>;
  /** The surface's own class, for its colours and spacing. */
  className?: string;
  testId?: string;
  /** Extra guidance shown after the message ("Your draft is still here."), not copied. */
  children?: ReactNode;
}

/**
 * An inline error with the ways out: Retry when the action can run again, a fix when there is a
 * better remedy, and Copy details, which puts the message, where and when it happened, and the
 * app version on the clipboard for a bug report.
 */
export function ErrorNotice({ message, where, onRetry, retryLabel, fix, onDismiss, context, className, testId, children }: Props) {
  const redact = useRedact();
  const shown = redact(message);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = () => {
    // Streamer Mode redacts the whole report, context included (a page URL can carry a token).
    void bridge.invoke("clipboard:write", { text: redact(errorReport({ where, message, context })), appInfo: true }).then(() => {
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  };
  return (
    <div className={`error-notice${className ? ` ${className}` : ""}`} role="alert" data-testid={testId}>
      <span className="error-notice-text" data-testid="error-text">{shown}{children}</span>
      <span className="error-notice-actions">
        {onRetry && <button type="button" className="btn small" data-testid="error-retry" onClick={onRetry}>{retryLabel ?? "Retry"}</button>}
        {fix && <button type="button" className="btn small" data-testid="error-fix" onClick={fix.onClick}>{fix.label}</button>}
        <button type="button" className="btn small ghost" data-testid="error-copy" title="Copy the error with where and when it happened" onClick={copy}>{copied ? "Copied" : "Copy details"}</button>
        {onDismiss && <button type="button" className="btn small ghost" data-testid="error-dismiss" aria-label="Dismiss" onClick={onDismiss}>Dismiss</button>}
      </span>
    </div>
  );
}
