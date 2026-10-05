import { useState } from "react";
import type { BackendHealth, ChatGPTStatus } from "../../shared/types";
import { bridge } from "../bridge";
import { Icon } from "./ui/Icon";

export function ConnectionStatus({ health, failed, busy, busyLabel = "Signing in…", account }: { health?: BackendHealth; failed: boolean; busy: boolean; busyLabel?: string; account?: ChatGPTStatus["accounts"][number] }) {
  const signedIn = account ? account.signedIn : health?.authentication === "authenticated";
  const text = busy ? busyLabel : health?.executable === "missing" ? "CLI not found"
    : account ? account.signedIn ? account.planEnabled ? "Plan authorized" : "Identity verified" : "Sign in needed"
    : signedIn ? "Signed in" : health?.authentication === "signed-out" ? "Sign in needed"
    : health ? "Check account" : failed ? "Check unavailable" : "Checking…";
  return <span className={`connection-badge${signedIn && !busy && health?.executable !== "missing" ? " connected" : ""}`}><span aria-hidden="true" />{text}</span>;
}

/** Copy only; the user decides when to run the saved CLI's login in their terminal. */
export function TerminalLogin({ backend, path, disabled }: { backend: "claude" | "codex"; path?: string; disabled: boolean }) {
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const executable = path ? `'${path.replaceAll("'", "'\\''")}'` : backend;
  const command = `${executable} ${backend === "claude" ? "auth login" : "login"}`;
  return (
    <details className="connection-details">
      <summary>Use terminal login</summary>
      <p>Run this in Terminal, finish sign-in, then refresh account status here.</p>
      <div className="connection-command"><code>{command}</code><button type="button" className="btn small" disabled={disabled} onClick={async () => {
        setError(false);
        try { await bridge.invoke("clipboard:write", { text: command }); setCopied(command); }
        catch { setError(true); }
      }}>{copied === command ? <><Icon name="check" /> Copied</> : "Copy command"}</button></div>
      <span role="status" className={error ? "warn" : "sr-only"}>{error ? "Could not copy. Select the command to copy it manually." : copied === command ? "Login command copied" : ""}</span>
    </details>
  );
}
