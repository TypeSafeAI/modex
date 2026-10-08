import { useEffect, useRef, useState } from "react";
import type { ModexAccountStatus } from "../../shared/types";
import { bridge } from "../bridge";

/** Modex identity is separate from the accounts used to run coding tools. */
export function ModexAccount() {
  const [account, setAccount] = useState<ModexAccountStatus | null>(null);
  const [operation, setOperation] = useState<"signIn" | "refresh" | "signOut" | null>(null);
  const [detail, setDetail] = useState("");
  const busy = useRef(false);
  const signingIn = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    void bridge.invoke("modexAccount:status", undefined).then(async (status) => {
      if (!mounted.current) return;
      setAccount(status);
      if (status.available && status.user) {
        busy.current = true; setOperation("refresh");
        try { const refreshed = await bridge.invoke("modexAccount:refresh", undefined); if (mounted.current) setAccount(refreshed); }
        catch { if (mounted.current) setDetail("Could not refresh your Modex session. Retry or sign in again."); }
        finally { busy.current = false; if (mounted.current) setOperation(null); }
      }
    }).catch(() => { if (mounted.current) setDetail("Manage your Modex account in the desktop app."); });
    return () => {
      mounted.current = false;
      if (signingIn.current) void bridge.invoke("modexAccount:cancel", undefined).catch(() => {});
    };
  }, []);
  async function act(action: "signIn" | "refresh" | "signOut") {
    if (busy.current) return;
    busy.current = true; signingIn.current = action === "signIn"; setOperation(action);
    setDetail(action === "signIn" ? "Complete GitHub sign-in in your browser, then return to Modex." : "Updating Modex account…");
    try {
      if (action === "signOut") {
        const result = await bridge.invoke("modexAccount:signOut", undefined);
        if (mounted.current) { setAccount(result.status); setDetail(result.detail); }
      } else {
        const result = await bridge.invoke(action === "signIn" ? "modexAccount:signIn" : "modexAccount:refresh", undefined);
        if (mounted.current) { setAccount(result); setDetail(result.detail); }
      }
    } catch (error) {
      if (mounted.current) setDetail(error instanceof Error && error.message.includes("Another Modex instance")
        ? "Another Modex instance may own this account. Close it and retry. After a crash, follow the account recovery steps in the Modex sign-in documentation."
        : "Modex account update did not complete. Check protected storage and your connection, or retry sign-in.");
    }
    finally { busy.current = false; signingIn.current = false; if (mounted.current) setOperation(null); }
  }
  return <div className="connection-card" data-testid="modex-account" role="group" aria-labelledby="modex-account-title">
    <div className="connection-card-head"><h4 id="modex-account-title">Modex account{account?.environment === "staging" ? " · Staging" : ""}</h4></div>
    <p>{account?.user ? account.user.email : "Use your GitHub identity to sign in to Modex."}</p>
    <div className="connection-actions">
      <button type="button" className="btn primary" disabled={!!operation || !account?.available} onClick={() => { void act("signIn"); }}>{operation === "signIn" ? "Waiting for GitHub…" : account?.user ? "Sign in again with GitHub" : "Continue with GitHub"}</button>
      {operation === "signIn" && <button type="button" className="btn" onClick={() => { void bridge.invoke("modexAccount:cancel", undefined).catch(() => setDetail("Could not cancel sign-in. Try again.")); }}>Cancel GitHub sign-in</button>}
      {account?.user && <>
        <button type="button" className="btn small" disabled={!!operation} onClick={() => { void act("refresh"); }}>Refresh Modex session</button>
        <button type="button" className="btn small ghost" disabled={!!operation} onClick={() => { void act("signOut"); }}>Sign out of Modex</button>
      </>}
    </div>
    <p className="connection-feedback" role="status">{detail || account?.detail || "Checking protected account storage…"}</p>
    <p className="connection-footnote">Sign-in changes apply immediately. This account does not connect repositories or change your coding tool accounts.</p>
  </div>;
}
